// D2-quarantine（用户拍板：启发式不配销毁权，铁证可以）——红灯先行 → 转绿。
//
// 现状（改前）：写侧 isSyntheticUserTurn 两条路一视同仁"销毁"（user_message 不落库）：
//   ① promptSource==='system' —— 权威元数据**铁证**，确定合成，销毁没毛病；
//   ② promptSource 缺失 + isWriteFallbackSyntheticText 文本长相命中 —— **启发式**（实测 33% 真人轮缺
//      promptSource=热路径），一旦误判即 append-only 永久丢真人原话、零翻案余地。
// 改法（隔离不销毁）：铁证照旧不落库；启发式命中不再跳过，改落 kind='user_message_suspect'
// （正文 payload 原样全存、dedup_key 照旧 msg:<uuid>）。situation_log 无 invalid_at 列，而全部读路
// （searchRawReceipts/listReceiptsChrono/renderMemoryDetail/CHRONO_RECEIPT_KINDS）与素材
// （selfReview EVENT_ACTIVITY_KINDS）都按 kind 白名单取行 → 嫌疑行天然对读侧/素材/注入不可见，
// 零新读侧逻辑。翻案=一条 UPDATE 改回 kind='user_message' 原位复活（数据层）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { captureTranscript, TRANSCRIPT_ACTIVITY_KINDS } from "../src/capture";
import { listSituations } from "../src/situation";
import { searchRawReceipts, listReceiptsChrono, renderMemoryDetail, CHRONO_RECEIPT_KINDS } from "../src/recall";
import { buildMaterial } from "../src/selfReview";
import { frozenClock } from "../src/clock";

const SX = "sess-d2q";
const CWD = "/proj";
const clock = frozenClock("2026-06-21T12:00:00.000Z");
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function newTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "d2q-"));
  tmpDirs.push(d);
  return d;
}
function writeJsonl(name: string, lines: unknown[]): string {
  const p = join(newTmp(), name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}
let tsN = 0;
function ts(): string {
  return new Date(Date.UTC(2026, 5, 21, 10, tsN++ % 60, 0)).toISOString();
}
function userLine(uuid: string, content: string, extra: Record<string, unknown> = {}) {
  return { type: "user", uuid, sessionId: SX, cwd: CWD, timestamp: ts(), message: { role: "user", content }, ...extra };
}

// 检索用单 token 标记（ASCII，segmentQuery 单单元、required=1，照 R1 系测试惯例）
const MARK = "zqxwsuspectmark";
// 启发式命中形态（与 authorship 写侧兜底判据逐字对齐）：前导句 + 紧跟合成结构 / 结构化 XML 标签行首
const GENUINE_TEAMMATE = `Another Claude session sent a message:\n<teammate-message teammate_id="x" color="green">\n{"type":"idle_notification"} ${MARK}\n</teammate-message>`;
const GENUINE_SELFREVIEW = "你是 anima——这台机器上 Claude Code 的魂。现在是收工时间，请以第一人称回顾今天这个会话。\n\n<material>\n## 对话节选\n用户：随便说\n</material>";
const TASK_NOTIF = "<task-notification>\n<task-id>b6mu3hrc7</task-id>\n<status>killed</status>\n</task-notification>";

type SuspectRow = { id: number; kind: string; payload: string; dedup_key: string | null };

/** 造一座库：铁证 1 条 + 启发式命中 3 条 + 真人 2 条（含以标签开头但 promptSource=user 的真人） */
function seedDb() {
  const db = openDb(join(newTmp(), "d2q.db"));
  const transcriptPath = writeJsonl("d2q.jsonl", [
    userLine("h1", `帮我修 capture 的游标推进，真人原话独门标记 ${MARK}`), // 真人：promptSource 缺失 + 长相不命中
    userLine("h2", `${TASK_NOTIF}\n上面这通知啥意思`, { promptSource: "user" }), // 真人：元数据权威说人（长相再像也不判）
    userLine("i1", "看着像普通话但来自系统合成", { promptSource: "system" }), // 铁证合成
    userLine("s1", GENUINE_TEAMMATE), // 启发式：队友信封
    userLine("s2", GENUINE_SELFREVIEW), // 启发式：自评 prompt 回吐
    userLine("s3", TASK_NOTIF), // 启发式：结构化 XML 行首
  ]);
  captureTranscript(db, transcriptPath, { clock });
  return { db, transcriptPath };
}
function suspectRows(db: ReturnType<typeof openDb>): SuspectRow[] {
  return db
    .query("SELECT id, kind, payload, dedup_key FROM situation_log WHERE kind = 'user_message_suspect' ORDER BY id ASC")
    .all() as SuspectRow[];
}

describe("D2 写侧三分：铁证销毁 / 启发式隔离 / 真人照常", () => {
  test("铁证（promptSource=system）→ 整条不落库：无 user_message 也无 user_message_suspect", () => {
    const { db } = seedDb();
    const all = listSituations(db, { sessionId: SX });
    expect(all.some((s) => JSON.stringify(s.payload).includes("来自系统合成"))).toBe(false);
    expect((db.query("SELECT count(*) AS c FROM situation_log WHERE dedup_key = 'msg:i1'").get() as { c: number }).c).toBe(0);
  });

  test("启发式命中 → 落 kind='user_message_suspect'：正文原样全存、dedup_key=msg:<uuid>", () => {
    const { db } = seedDb();
    const rows = suspectRows(db);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.dedup_key)).toEqual(["msg:s1", "msg:s2", "msg:s3"]);
    const texts = rows.map((r) => String((JSON.parse(r.payload) as { text?: string }).text ?? ""));
    // 全文原样在库（结构一根毛都不少）——翻案时一条 UPDATE 就能原样复活
    expect(texts[0]).toContain("<teammate-message");
    expect(texts[0]).toContain(MARK);
    expect(texts[1]).toContain("<material>");
    expect(texts[2]).toContain("<task-notification>");
    // payload.uuid 与 dedup 指纹同源
    expect((JSON.parse(rows[0]!.payload) as { uuid?: string }).uuid).toBe("s1");
    // 绝不混进 user_message（按 uuid 查——h2 真人行照 R1 设计正文可以含标签，不能拿文本长相当判据）
    const umUuids = listSituations(db, { sessionId: SX })
      .filter((s) => s.kind === "user_message")
      .map((s) => String((s.payload as { uuid?: string }).uuid ?? ""));
    expect(umUuids.some((u) => ["s1", "s2", "s3"].includes(u))).toBe(false);
  });

  test("真人照常落 user_message：promptSource 缺失+长相不命中；promptSource=user 哪怕以标签开头", () => {
    const { db } = seedDb();
    const umTexts = listSituations(db, { sessionId: SX })
      .filter((s) => s.kind === "user_message")
      .map((s) => String((s.payload as { text?: string }).text ?? ""));
    expect(umTexts.some((t) => t.includes("真人原话独门标记"))).toBe(true);
    expect(umTexts.some((t) => t.includes("上面这通知啥意思"))).toBe(true); // 元数据权威=人，不进隔离区
    expect(suspectRows(db).some((r) => r.payload.includes("上面这通知啥意思"))).toBe(false);
  });
});

describe("D2 嫌疑行对全部读路/素材不可见（kind 白名单天然隔离）", () => {
  test("searchRawReceipts：嫌疑行不返回，真人行返回（同一标记只捞出真人那条）", () => {
    const { db } = seedDb();
    const rows = searchRawReceipts(db, MARK, { limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toContain("真人原话独门标记");
    expect(rows[0]!.text).not.toContain("<teammate-message");
  });

  test("listReceiptsChrono：时间窗覆盖嫌疑行，小票时间线不含它", () => {
    const { db } = seedDb();
    const joined = listReceiptsChrono(db, { sinceTs: "2026-06-21T00:00:00.000Z", untilTs: "2026-06-22T00:00:00.000Z", limit: 50 })
      .map((l) => l.line)
      .join("\n");
    expect(joined).toContain("真人原话独门标记");
    expect(joined).not.toContain("teammate-message");
    expect(joined).not.toContain("task-notification");
    expect(joined).not.toContain("user_message_suspect");
  });

  test("renderMemoryDetail：按 id 直取嫌疑行 → null（kind 白名单挡住）", () => {
    const { db } = seedDb();
    for (const r of suspectRows(db)) expect(renderMemoryDetail(db, "situation", r.id)).toBeNull();
    const real = db.query("SELECT id FROM situation_log WHERE dedup_key = 'msg:h1'").get() as { id: number };
    expect(renderMemoryDetail(db, "situation", real.id)).toContain("真人原话独门标记"); // 正对照：真人行照常可见
  });

  test("守卫：user_message_suspect 不在 CHRONO_RECEIPT_KINDS / TRANSCRIPT_ACTIVITY_KINDS（读路白名单+夜归属都不认它）", () => {
    expect(CHRONO_RECEIPT_KINDS as readonly string[]).not.toContain("user_message_suspect");
    expect(TRANSCRIPT_ACTIVITY_KINDS as readonly string[]).not.toContain("user_message_suspect");
  });

  test("自评素材：嫌疑行既不进对话节选、也不进 events、evidenceText 干净", () => {
    const { db, transcriptPath } = seedDb();
    const material = buildMaterial(db, { transcriptPath, sessionId: SX });
    const conv = material.conversation.join("\n");
    expect(conv).toContain("真人原话独门标记"); // 正对照：真人对话在
    expect(conv).not.toContain("teammate-message");
    expect(conv).not.toContain("你是 anima——这台机器上");
    expect(material.events.join("\n")).not.toContain("user_message_suspect");
    expect(material.evidenceText).not.toContain("teammate-message");
    expect(material.evidenceText).not.toContain("user_message_suspect");
  });
});

describe("D2 翻案：一条 UPDATE 原位复活", () => {
  test("UPDATE kind='user_message' → 行原位变回用户原话（payload/dedup_key 分毫未动）", () => {
    // 注：这是**数据层**复活（隔离设计的核心承诺：启发式误杀可逆）。读侧 R1 存量文本形态兜底
    // （syntheticTextExclusionSql/isReadExcludedUserText）是护存量污染的独立层，按前缀仍会挡合成长相
    // 正文——那层口径动不动是另案，本测试不碰。
    const { db } = seedDb();
    const target = suspectRows(db)[0]!;
    db.query("UPDATE situation_log SET kind='user_message' WHERE id = ?").run(target.id);
    const revived = listSituations(db, { sessionId: SX }).filter(
      (s) => s.kind === "user_message" && (s.payload as { uuid?: string }).uuid === "s1",
    );
    expect(revived.length).toBe(1);
    expect(String((revived[0]!.payload as { text?: string }).text)).toContain("<teammate-message"); // 全文原样
    const after = db.query("SELECT dedup_key FROM situation_log WHERE id = ?").get(target.id) as { dedup_key: string };
    expect(after.dedup_key).toBe("msg:s1"); // 指纹没动——重采仍被幂等弹回，不产重复行
  });
});
