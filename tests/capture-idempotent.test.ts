// AUDIT-2026-07-01 rank1：situation_log 采集幂等（治 resume / rewind 整段重采、永久重复落库）。
// 根因：situation_log 无唯一约束、裸 INSERT，去重全靠 transcript_path 游标；resume 换新路径（游标查不到）
// 或 rewind 删掉游标那条（文件里找不到）→ entriesAfter 退化全量 → 同事件原样重插。A区#4 的 CAS 只挡
// 「同路径并发」，这两个触发它管不着；且重复 file_read/command_run 抬高 work-cap 现存计数 → 挤掉真 Read。
// 修：每事件挂稳定指纹 dedup_key（用户消息=msg:<uuid> / 工具=tool:<tool_use_id>:<kind>）+ (session_id,
//   dedup_key) 局部唯一索引 + 采集前剔已采过的（治名额）+ appendSituation INSERT OR IGNORE（治并发）。
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { appendSituation } from "../src/situation";

const SID = "sess-A";
const CWD = "/home/tester/Projects/anima";
const clock = frozenClock("2026-06-30T04:00:00Z");

const tmpDirs: string[] = [];
function tmpEnv() {
  const d = mkdtempSync(join(tmpdir(), "anima-capidem-"));
  tmpDirs.push(d);
  return { db: openDb(join(d, "anima.db")), dir: d };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一条 user 文本条目（content 为字符串 → extractEvents 出一条 user_message） */
function userLine(uuid: string, text: string, ts: string) {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: SID,
    cwd: CWD,
    timestamp: ts,
    message: { role: "user", content: text },
  });
}
/** 造一对 assistant(tool_use Read) + user(tool_result) → extractEvents 出一条 file_read */
function readPair(callUuid: string, resultUuid: string, toolId: string, path: string, ts: string) {
  return [
    JSON.stringify({
      type: "assistant",
      uuid: callUuid,
      sessionId: SID,
      cwd: CWD,
      timestamp: ts,
      message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: path } }] },
    }),
    JSON.stringify({
      type: "user",
      uuid: resultUuid,
      sessionId: SID,
      cwd: CWD,
      timestamp: ts,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "file body" }] },
    }),
  ];
}
function writeJsonl(path: string, lines: string[]) {
  writeFileSync(path, lines.join("\n") + "\n");
}
function countKind(db: any, kind: string): number {
  return (db.query("SELECT count(*) AS c FROM situation_log WHERE kind=?").get(kind) as { c: number }).c;
}
function userUuids(db: any): string[] {
  const rows = db.query("SELECT payload FROM situation_log WHERE kind='user_message' ORDER BY id").all() as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload).uuid);
}

describe("rank1：situation_log 采集幂等", () => {
  test("rewind：删掉游标那条再续写 → 不重复采集已采过的", () => {
    const { db, dir } = tmpEnv();
    const p = join(dir, "t.jsonl");
    const ts = "2026-06-30T03:00:00.000Z";
    writeJsonl(p, [userLine("u1", "hello one", ts), userLine("u2", "hello two", ts), userLine("u3", "hello three", ts)]);
    expect(captureTranscript(db, p, { clock }).captured).toBe(3);
    expect(countKind(db, "user_message")).toBe(3);

    // rewind：删游标 u3、追加 u4 → 游标 u3 在文件里找不到 → 旧码 entriesAfter 退化全量重采 u1/u2
    writeJsonl(p, [userLine("u1", "hello one", ts), userLine("u2", "hello two", ts), userLine("u4", "hello four", ts)]);
    captureTranscript(db, p, { clock });
    expect(countKind(db, "user_message")).toBe(4); // u1,u2,u3,u4 各一条——不是 6
    expect(userUuids(db).sort()).toEqual(["u1", "u2", "u3", "u4"]);
  });

  test("resume：换新 transcript_path（游标查不到）→ 整段旧会话不重复落库", () => {
    const { db, dir } = tmpEnv();
    const ts = "2026-06-30T03:00:00.000Z";
    const pA = join(dir, "A.jsonl");
    writeJsonl(pA, [userLine("u1", "one", ts), userLine("u2", "two", ts), userLine("u3", "three", ts)]);
    expect(captureTranscript(db, pA, { clock }).captured).toBe(3);

    // resume：新文件 B 把 u1/u2/u3 原样复制 + 追加 u4；getCursor(B)=null → 全量重扫
    const pB = join(dir, "B.jsonl");
    writeJsonl(pB, [userLine("u1", "one", ts), userLine("u2", "two", ts), userLine("u3", "three", ts), userLine("u4", "four", ts)]);
    captureTranscript(db, pB, { clock });
    expect(countKind(db, "user_message")).toBe(4); // 不是 7
    expect(userUuids(db).sort()).toEqual(["u1", "u2", "u3", "u4"]);
  });

  test("工具事件（file_read）同样幂等：rewind 真重采不产生第二条", () => {
    const { db, dir } = tmpEnv();
    const p = join(dir, "t.jsonl");
    const ts = "2026-06-30T03:00:00.000Z";
    // 读对 + 一条尾部消息当游标
    writeJsonl(p, [...readPair("a1", "r1", "tool_1", "/x/y.ts", ts), userLine("u8", "cursor", ts)]);
    captureTranscript(db, p, { clock });
    expect(countKind(db, "file_read")).toBe(1);
    // rewind：删掉游标 u8、换 u9 → 游标找不到 → 整段重采（读对被再扫一遍）
    writeJsonl(p, [...readPair("a1", "r1", "tool_1", "/x/y.ts", ts), userLine("u9", "later", ts)]);
    captureTranscript(db, p, { clock });
    expect(countKind(db, "file_read")).toBe(1); // 还是 1，不是 2
  });

  test("非采集 caller（无 dedup_key 的 marker）不受去重影响——同内容照插两条", () => {
    const { db } = tmpEnv();
    // digest/selfReview 等写 marker 不传 dedupKey → dedup_key 为 NULL → 不进唯一索引 → 老行为
    appendSituation(db, { sessionId: "sx", kind: "digest_late_reclaim", payload: { night: "2026-06-30" } }, clock);
    appendSituation(db, { sessionId: "sx", kind: "digest_late_reclaim", payload: { night: "2026-06-30" } }, clock);
    expect(countKind(db, "digest_late_reclaim")).toBe(2); // NULL dedup_key 各自独立，不去重
  });
});

// ── v8 二审收口（codex NO-GO 三点）：空session写层去重 / overflow标记不重复 / ON CONFLICT 不误吞别的约束 ──
describe("rank1 v8 收口", () => {
  test("空 sessionId 也在写层强制去重（dedup_key 单列唯一，不再靠 session 区分）", () => {
    const { db } = tmpEnv();
    // 原 (session_id, dedup_key) 索引：session=NULL 时 NULL 各不相同 → 两条都落（codex/考官同点的缝）。
    // v8 改单列 dedup_key → 空 session 也被 DB 层挡下。
    appendSituation(db, { sessionId: null, kind: "user_message", payload: { text: "x" }, dedupKey: "msg:UU1" }, clock);
    appendSituation(db, { sessionId: null, kind: "user_message", payload: { text: "x" }, dedupKey: "msg:UU1" }, clock);
    expect(countKind(db, "user_message")).toBe(1);
  });

  test("work_capture_overflow：触顶后 rewind 重采，诊断标记不重复（每会话一条）", () => {
    const { db, dir } = tmpEnv();
    const p = join(dir, "t.jsonl");
    const ts = "2026-06-30T03:00:00.000Z";
    // 55 个不同路径的读（>SESSION_READ_CAP=50）+ 尾部游标 → 触发 overflow
    const lines: string[] = [];
    for (let i = 0; i < 55; i++) lines.push(...readPair(`a${i}`, `r${i}`, `tool_${i}`, `/x/f${i}.ts`, ts));
    lines.push(userLine("uc", "cursor", ts));
    writeJsonl(p, lines);
    captureTranscript(db, p, { clock });
    expect(countKind(db, "work_capture_overflow")).toBe(1);
    // rewind：删游标 uc、换 ud → 整段重采（被丢的读再次触顶）
    writeJsonl(p, [...lines.slice(0, -1), userLine("ud", "later", ts)]);
    captureTranscript(db, p, { clock });
    expect(countKind(db, "work_capture_overflow")).toBe(1); // 还是 1，不是 2
  });

  test("ON CONFLICT(dedup_key) 精确定向：不误吞别的约束（NOT NULL 违规照样抛）", () => {
    const { db } = tmpEnv();
    // kind 是 NOT NULL；传 null 应抛错 → 证明不是宽 INSERT OR IGNORE 把它静默吞掉
    expect(() =>
      appendSituation(db, { sessionId: "s", kind: null as unknown as string, dedupKey: "k1" }, clock),
    ).toThrow();
  });

  test("护栏：含重复 dedup_key 的 v7 库 → v8 迁移消重、CREATE UNIQUE 成功、不静默吞（codex Q3 + 框架吞错）", () => {
    const d = mkdtempSync(join(tmpdir(), "anima-v7dup-"));
    tmpDirs.push(d);
    const dbPath = join(d, "anima.db");
    // 手搓 v7 形态：meta + 最小 situation_log(含 dedup_key) + 旧 (session_id,dedup_key) 索引 + 2 条同指纹空 session 行
    // （v7 索引在 session=NULL 时 NULL 各不相同 → 允许重复落库，正是上一轮的空-session 洞留下的产物）
    const raw = new Database(dbPath, { create: true });
    raw.exec("PRAGMA busy_timeout=5000;");
    raw.exec("PRAGMA journal_mode=WAL;");
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    raw.exec(
      "CREATE TABLE situation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, project TEXT, kind TEXT NOT NULL, payload TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, dedup_key TEXT);",
    );
    raw.exec("CREATE UNIQUE INDEX idx_sit_dedup ON situation_log (session_id, dedup_key) WHERE dedup_key IS NOT NULL;");
    const ins = raw.query(
      "INSERT INTO situation_log (session_id, kind, payload, occurred_at, created_at, dedup_key) VALUES (NULL, 'user_message', '{}', ?, ?, 'msg:DUP')",
    );
    ins.run("2026-06-30T00:00:00Z", "2026-06-30T00:00:00Z");
    ins.run("2026-06-30T00:01:00Z", "2026-06-30T00:01:00Z"); // 同 dedup_key、空 session，v7 允许
    raw.exec("INSERT INTO meta (key,value) VALUES ('schema_version','7');");
    raw.close();

    // 用真 openDb 迁移 v7→v8
    const db = openDb(dbPath);
    expect(db.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "8" });
    // 护栏消重 → msg:DUP 只剩 1 行
    expect((db.query("SELECT count(*) c FROM situation_log WHERE dedup_key='msg:DUP'").get() as { c: number }).c).toBe(1);
    // 单列唯一索引真建成（若被静默吞，这里会是 null / 旧两列）
    const idx = db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sit_dedup'").get() as {
      sql: string;
    } | null;
    expect(idx?.sql).toContain("(dedup_key)");
    expect(idx?.sql).not.toContain("session_id");
    db.close();
  });
});
