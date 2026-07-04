// 块① stageMakeup 改水位线判定（DESIGN-WORKER-RESUME §5）：把「有任意自评就整会话跳过」的二元判定，
// 换成「transcript 末 uuid > 已覆盖水位线就补增量」。核心治的回归：worker 给会话前半段写了自评后，
// 用户 resume 接着干一大段——老二元判定因「该会话已有自评」把整段跳过，后半段永久漏。
// 本组坐实：① resume 后半段被补（老逻辑会漏）；② 已覆盖到末尾则跳过；③ 从未复盘→全量+设水位线；
//   ④ 真空增量（对话/事件/书签全空）→ 不写自评但推水位线（防反复空转）；
//   ⑤ 去重不靠 work_queue：有新鲜在跑的队列行也照常兜底未覆盖尾巴（CAS 才是去重闸；codex S1 守卫）；
//   ⑥ 事件型尾巴（无对话但有客观事件）→ 照常复盘、不被当空增量漏掉（codex S2）；
//   ⑦ 增量失败 → 有界兜底壳 + marker + 推水位线（绝不空等、不留永久缺口；壳只统计本段，codex I1）；
//   ⑧ I3 回填守卫：有旧自评却无水位线（backfill 没跑）→ 绝不全量重刷，标失败 loud 留待回填；
//   ⑨ 单调守卫：wmOld 不在快照（并发 worker 已推过我们的快照尾巴）→ 绝不把水位线回退，标失败留待重跑（codex SEVERE）。

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { runNightlyDigestion, type DigestConfig, type StageName } from "../src/digest";

const NIGHT = "2026-06-10";
const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // 凌晨跑，消化昨天；now-1h = 2026-06-11T02:00Z

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-mkup-"));
  tmpDirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
  };
  return { dir, dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string; isMeta?: boolean };
function writeTranscript(dir: string, sessionId: string, turns: Turn[]): string {
  const lines = turns.map((t) =>
    JSON.stringify({
      uuid: t.uuid,
      parentUuid: null,
      isSidechain: false,
      sessionId,
      timestamp: t.ts,
      cwd: "/Users/tester/Projects/demo",
      type: t.role,
      isMeta: t.isMeta ?? false,
      message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function mockReviewLlm() {
  const calls: string[] = [];
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("收工时间")) {
      calls.push("review");
      return JSON.stringify({
        review: "补课增量自评：把这段没复盘的尾巴回顾了一下。",
        feeling: "踏实",
        intensity: "不大",
        keywords: ["补课", "增量"],
        items: [],
      });
    }
    calls.push("other");
    return "{}";
  };
  return { llm, calls };
}

// 只跑 makeup，其余阶段空跑（隔离 makeup，免 closure/人格/日记噪声）
const ONLY_MAKEUP: Partial<Record<StageName, () => Promise<void>>> = {
  closure: async () => {},
  decay: async () => {},
  personality: async () => {},
  diary: async () => {},
  vectorize: async () => {},
};

function setWatermark(db: Database, sid: string, lastUuid: string, at = "2026-06-10T12:00:00.000Z") {
  db.query("INSERT INTO review_watermark (session_id, last_uuid, updated_at) VALUES (?,?,?)").run(
    sid,
    lastUuid,
    at,
  );
}
function watermark(db: Database, sid: string): string | null {
  const r = db.query("SELECT last_uuid l FROM review_watermark WHERE session_id=?").get(sid) as
    | { l: string }
    | null;
  return r?.l ?? null;
}
function reviewCount(db: Database, sid: string): number {
  return (
    db
      .query(
        "SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL",
      )
      .get(sid) as { c: number }
  ).c;
}

const FIRST_HALF: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "今天先把权限回归测试修好。" },
  { uuid: "u2", ts: "2026-06-10T01:05:00.000Z", role: "assistant", text: "好，我先看鉴权模块的 mock。" },
];
const SECOND_HALF: Turn[] = [
  { uuid: "u3", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "顺手把配色也先别改，等我确认。" },
  { uuid: "u4", ts: "2026-06-10T02:05:00.000Z", role: "assistant", text: "明白，配色改动我先问你再动手。" },
];

describe("块① makeup 水位线判定", () => {
  test("① resume 后半段被补（老二元判定会整段漏）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-resume";
    const path = writeTranscript(dir, sid, [...FIRST_HALF, ...SECOND_HALF]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    // 前半段：worker 已写过一条自评 + 水位线停在 u2（老二元判定会因此跳过整会话）
    insertExperience(
      db,
      { kind: "self_review", content: "前半段自评：修权限测试。", sourceSession: sid },
      frozenClock(`${NIGHT}T04:00:00.000Z`),
    );
    setWatermark(db, sid, "u2");

    const { llm, calls } = mockReviewLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(1); // 补了一次增量
    expect(reviewCount(db, sid)).toBe(2); // 前半段 + 补出的后半段
    expect(watermark(db, sid)).toBe("u4"); // 水位线推到末尾
  });

  test("② 已覆盖到末尾（水位线=末 uuid）→ 跳过、零 LLM", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-covered";
    const path = writeTranscript(dir, sid, [...FIRST_HALF, ...SECOND_HALF]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    insertExperience(
      db,
      { kind: "self_review", content: "全程已复盘。", sourceSession: sid },
      frozenClock(`${NIGHT}T04:00:00.000Z`),
    );
    setWatermark(db, sid, "u4"); // 已覆盖到末尾

    const { llm, calls } = mockReviewLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(0);
    expect(reviewCount(db, sid)).toBe(1); // 没多
    expect(watermark(db, sid)).toBe("u4"); // 没动
  });

  test("③ 从未复盘（无水位线）→ 全量复盘 + 设水位线到末尾", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-fresh";
    const path = writeTranscript(dir, sid, [...FIRST_HALF, ...SECOND_HALF]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });

    const { llm, calls } = mockReviewLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(1);
    expect(reviewCount(db, sid)).toBe(1);
    expect(watermark(db, sid)).toBe("u4");
  });

  test("④ 空增量（resume 但只剩 meta 条目，无实质新回合）→ 不写自评但推水位线", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-empty";
    const path = writeTranscript(dir, sid, [
      ...FIRST_HALF,
      { uuid: "u5", ts: "2026-06-10T03:00:00.000Z", role: "user", text: "（系统噪声）", isMeta: true },
    ]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:30:00.000Z") });
    insertExperience(
      db,
      { kind: "self_review", content: "前半段已复盘。", sourceSession: sid },
      frozenClock(`${NIGHT}T04:00:00.000Z`),
    );
    setWatermark(db, sid, "u2"); // 水位线在 u2，尾巴只有 meta 条目 u5

    const { llm, calls } = mockReviewLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(0); // 无实质内容、不烧 LLM
    expect(reviewCount(db, sid)).toBe(1); // 没多写自评
    expect(watermark(db, sid)).toBe("u5"); // 但水位线推过空尾巴，避免每夜重排
  });

  test("⑤ 去重不靠 work_queue：有新鲜在跑的队列行也照常兜底未覆盖尾巴（codex S1 守卫）", async () => {
    // 旧 SEVERE-1 让位逻辑会因这条新鲜行跳过、且把夜标 done → worker 若死则永久漏。
    // 新逻辑：makeup 不看 work_queue，照常兜底；与 worker 双跑由 CAS 去重。
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-queued";
    const path = writeTranscript(dir, sid, [...FIRST_HALF, ...SECOND_HALF]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    db.query(
      "INSERT INTO work_queue (session_id, kind, status, target_uuid, attempts, enqueued_at) VALUES (?,?,?,?,?,?)",
    ).run(sid, "self_review", "processing", "u4", 0, "2026-06-11T02:55:00.000Z"); // 极新鲜

    const { llm, calls } = mockReviewLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(1); // 照常兜底，不让位
    expect(reviewCount(db, sid)).toBe(1);
    expect(watermark(db, sid)).toBe("u4");
  });

  test("⑥ 事件型尾巴（无对话但有客观事件）→ 照常复盘，不被当空增量漏掉（codex S2）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-eventonly";
    // 尾巴 u3 是无文本的 assistant 回合（不产生对话节选），但窗口内有一条 file_edit 客观事件
    const path = writeTranscript(dir, sid, [
      ...FIRST_HALF,
      { uuid: "u3", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "" },
    ]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    insertExperience(
      db,
      { kind: "self_review", content: "前半段已复盘。", sourceSession: sid },
      frozenClock(`${NIGHT}T04:00:00.000Z`),
    );
    setWatermark(db, sid, "u2");
    // 水位线后的窗口里有客观事件（改了文件），无对话——老逻辑只看 conversation 会误判空、漏掉它
    appendSituation(
      db,
      { sessionId: sid, kind: "file_edit", payload: { path: "src/auth.ts" } },
      frozenClock("2026-06-10T01:30:00.000Z"),
    );

    const { llm, calls } = mockReviewLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(1); // 有事件 → 照常复盘
    expect(reviewCount(db, sid)).toBe(2);
    expect(watermark(db, sid)).toBe("u3");
  });

  test("⑦ 增量失败 → 有界兜底壳 + marker + 推水位线（绝不空等、不留缺口；codex I1）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-fail";
    const path = writeTranscript(dir, sid, [...FIRST_HALF, ...SECOND_HALF]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    insertExperience(
      db,
      { kind: "self_review", content: "前半段已复盘。", sourceSession: sid },
      frozenClock(`${NIGHT}T04:00:00.000Z`),
    );
    setWatermark(db, sid, "u2");

    const failingLlm = async () => {
      throw new Error("额度撞墙");
    };
    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm: failingLlm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    // 失败也覆盖了尾巴（有界兜底壳 + 推水位线）→ 不留永久缺口、阶段不失败
    expect(result.stages.makeup.status).toBe("done");
    expect(watermark(db, sid)).toBe("u4"); // 推到末尾
    expect(reviewCount(db, sid)).toBe(1); // self_review 没多（壳是 self_review_fallback）
    const shell = db
      .query(
        "SELECT content FROM experiences WHERE kind='self_review_fallback' AND source_session=?",
      )
      .get(sid) as { content: string } | null;
    expect(shell).not.toBeNull(); // 写了有界兜底壳，绝不空等
    // marker 供观测，归属夜 N
    const marker = db
      .query(
        "SELECT substr(datetime(occurred_at,'+8 hours'),1,10) d FROM situation_log WHERE kind='self_review_failed' AND session_id=?",
      )
      .get(sid) as { d: string } | null;
    expect(marker?.d).toBe(NIGHT);
  });

  test("⑧ I3 回填守卫：有旧自评却无水位线 → 绝不全量重刷，阶段标失败 loud（codex I3）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-unbackfilled";
    const path = writeTranscript(dir, sid, [...FIRST_HALF, ...SECOND_HALF]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    // 历史已复盘（旧二元 makeup 写过自评），但 backfill 没跑 → 无水位线行
    insertExperience(
      db,
      { kind: "self_review", content: "历史自评（旧二元 makeup 写的）。", sourceSession: sid },
      frozenClock(`${NIGHT}T04:00:00.000Z`),
    );

    const { llm, calls } = mockReviewLlm();
    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(0); // 绝不重刷
    expect(reviewCount(db, sid)).toBe(1); // 没写重复自评
    expect(watermark(db, sid)).toBeNull(); // 没乱设水位线（等 backfill 读对的末条）
    expect(result.stages.makeup.status).toBe("failed"); // loud：阶段失败、下轮重跑（跑过 backfill 才会过）
    const marker = db
      .query("SELECT 1 FROM situation_log WHERE kind='makeup_backfill_required' AND session_id=?")
      .get(sid);
    expect(marker).not.toBeNull();
  });

  test("⑨ 单调守卫：wmOld 不在快照（worker 已推过快照尾巴）→ 绝不回退水位线（codex SEVERE）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-ahead";
    const path = writeTranscript(dir, sid, [...FIRST_HALF, ...SECOND_HALF]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    // 模拟并发 worker 已把水位线推到一个不在 makeup 本快照里的、更靠后的 uuid（worker 见过更新文件）
    setWatermark(db, sid, "u-worker-ahead");

    const { llm, calls } = mockReviewLlm();
    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });

    expect(calls.filter((c) => c === "review").length).toBe(0); // 不处理
    expect(watermark(db, sid)).toBe("u-worker-ahead"); // 绝不回退到本快照尾巴 u4
    expect(reviewCount(db, sid)).toBe(0); // 不写重复自评
    expect(result.stages.makeup.status).toBe("failed"); // 留待下轮（届时读到一致视图）
    const marker = db
      .query("SELECT 1 FROM situation_log WHERE kind='makeup_watermark_ahead' AND session_id=?")
      .get(sid);
    expect(marker).not.toBeNull();
  });
});
