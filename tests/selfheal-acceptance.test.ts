// 独立验收（DESIGN-SELFHEAL §4 不变量 H1-H8 + §5 ①-⑩）。本文件由独立考官自写、自定真值——不复用
// selfHeal.ts 的任何自评，不引用 selfheal-smoke.test.ts。真值全部从源码行为推导（见每个 test 的注释）。
//
// 脚手架照搬 makeup-watermark.test.ts：造假 transcript、mock 计数 LLM、runNightlyDigestion + stageOverrides。
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { insertExperience } from "../src/experiences";
import { runNightlyDigestion, type DigestConfig, type StageName } from "../src/digest";
import { buildIncrementalMaterial } from "../src/selfReview";
import { MAX_HEAL_ATTEMPTS } from "../src/selfHeal";

// ---------------- 脚手架 ----------------
const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-heal-acc-"));
  tmpDirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = { personalityPath: join(home, "personality.md"), diaryDir: join(home, "diary") };
  return { dir, dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string; isMeta?: boolean };
function writeTranscript(dir: string, sid: string, turns: Turn[]): string {
  const lines = turns.map((t) =>
    JSON.stringify({
      uuid: t.uuid, parentUuid: null, isSidechain: false, sessionId: sid,
      timestamp: t.ts, cwd: "/Users/tester/Projects/demo", type: t.role,
      isMeta: t.isMeta ?? false, message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// 只跑 makeup + heal，其余阶段 no-op（隔离）
const MAKEUP_HEAL: Partial<Record<StageName, () => Promise<void>>> = {
  closure: async () => {}, decay: async () => {}, personality: async () => {}, diary: async () => {}, vectorize: async () => {},
};
// 只跑 heal（预置壳/账场景，不让 makeup 干扰）
const ONLY_HEAL: Partial<Record<StageName, () => Promise<void>>> = {
  makeup: async () => {}, closure: async () => {}, decay: async () => {}, personality: async () => {}, diary: async () => {}, vectorize: async () => {},
};

// 计数 LLM：区分 review 调用（含"收工时间"）与其它。可注入成功/失败。
function countingLlm(mode: "good" | "fail") {
  const calls: string[] = [];
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("收工时间")) {
      calls.push("review");
      if (mode === "fail") throw new Error("额度撞墙");
      return JSON.stringify({
        review: "愈合后的真自评：把这段失败切片补回顾了。", feeling: "踏实", intensity: "一般",
        keywords: ["愈合", "补回顾"], items: [],
      });
    }
    calls.push("other");
    return "{}";
  };
  return { llm, calls, reviewCalls: () => calls.filter((c) => c === "review").length };
}

const TURNS: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "把配置从 TOML 换成 YAML，修了 emoji 崩溃。" },
  { uuid: "u2", ts: "2026-06-10T01:05:00.000Z", role: "assistant", text: "好，我改 config loader 接 YAML 解析。" },
  { uuid: "u3", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "跑一下回归。" },
  { uuid: "u4", ts: "2026-06-10T02:05:00.000Z", role: "assistant", text: "回归全绿，emoji 那条不再崩。" },
];

const NIGHT = "2026-06-10";
const NEXT = "2026-06-11";

// ---------- 查询助手 ----------
function shell(db: Database, sid: string) {
  return db.query("SELECT id, invalid_at FROM experiences WHERE kind='self_review_fallback' AND source_session=?").get(sid) as { id: number; invalid_at: string | null } | null;
}
function watermark(db: Database, sid: string): string | null {
  const r = db.query("SELECT last_uuid l FROM review_watermark WHERE session_id=?").get(sid) as { l: string } | null;
  return r?.l ?? null;
}
function heal(db: Database, sid: string) {
  return db.query("SELECT * FROM review_heal WHERE session_id=?").get(sid) as any;
}
function markerCount(db: Database, kind: string, sid?: string): number {
  const q = sid
    ? db.query("SELECT count(*) c FROM situation_log WHERE kind=? AND session_id=?").get(kind, sid)
    : db.query("SELECT count(*) c FROM situation_log WHERE kind=?").get(kind);
  return (q as any).c;
}
function realReview(db: Database, sid: string) {
  return db.query("SELECT id, order_seq, content FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL").get(sid) as { id: number; order_seq: number | null; content: string } | null;
}

// 跑一夜失败 makeup（造出壳 + pending 账），返回 shellId / wm。
async function seedFailedShell(dir: string, dbPath: string, config: DigestConfig, sid: string, turns = TURNS) {
  const db = openDb(dbPath);
  const path = writeTranscript(dir, sid, turns);
  captureTranscript(db, path, { clock: frozenClock(`${NIGHT}T03:00:00.000Z`) });
  await runNightlyDigestion(db, {
    clock: frozenClock(`${NIGHT}T20:00:00.000Z`), night: NIGHT, llm: countingLlm("fail").llm, config,
    findTranscripts: () => [{ sessionId: sid, path }],
    stageOverrides: { closure: async () => {}, decay: async () => {}, personality: async () => {}, diary: async () => {}, vectorize: async () => {} },
  });
  return { db, path };
}

describe("self-heal 验收 §5 / §4", () => {

  // ① 失败写壳必同时建账（仅 makeup 路）
  test("① 失败写壳必同时建 pending 账（since/target/shell/night/cooldown 都对）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "S1";
    const { db } = await seedFailedShell(dir, dbPath, config, sid);

    const sh = shell(db, sid);
    expect(sh).not.toBeNull(); // 壳存在
    const acc = heal(db, sid);
    expect(acc).not.toBeNull(); // 账存在
    expect(acc.status).toBe("pending");
    expect(acc.shell_id).toBe(sh!.id); // 账指向壳
    expect(acc.target_uuid).toBe("u4"); // 覆盖到末尾
    expect(acc.since_uuid).toBeNull(); // 首评失败 since=null
    expect(acc.night).toBe(NIGHT); // 归属夜=失败夜
    expect(acc.next_attempt_at).toBe(NEXT); // 冷却到 night+1（防同夜双烧）
    expect(acc.attempts).toBe(0);
  });

  // ② 自愈成功 = 壳作废 + 真自评在 + 账删 + 水位线未变（H1）
  test("② 愈合成功：壳作废 + 真自评在 + 账删 + 水位线两次相等（H1）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "S2";
    const { db, path } = await seedFailedShell(dir, dbPath, config, sid);
    const shellId = shell(db, sid)!.id;
    const wmBefore = watermark(db, sid); // H1：愈合前

    const good = countingLlm("good");
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: good.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: MAKEUP_HEAL,
    });

    expect(shell(db, sid)!.invalid_at).not.toBeNull(); // 壳作废、不删原文
    const real = realReview(db, sid);
    expect(real).not.toBeNull(); // 真自评写入
    expect(real!.order_seq).toBe(shellId); // 继承壳原位 order_seq
    expect(heal(db, sid)).toBeNull(); // 账已删（不会二次愈合）
    expect(watermark(db, sid)).toBe(wmBefore); // H1：水位线一步不动（两次相等）
    expect(markerCount(db, "heal_success", sid)).toBe(1);
  });

  // ③ 空增量壳 → 作废不重烧（heal_inert，零 LLM）
  test("③ 空增量（薄尾，无对话/事件/书签）→ 作废壳 + dead + 不烧 LLM", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "S3";
    const db = openDb(dbPath);
    // 造一段薄尾：u1 有内容（被前评覆盖），尾巴 u2 是 meta 噪声（不产对话）。先让前评失败造壳。
    const turns: Turn[] = [
      { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "真实内容一段。" },
      { uuid: "u2", ts: "2026-06-10T01:05:00.000Z", role: "user", text: "（系统噪声）", isMeta: true },
    ];
    const path = writeTranscript(dir, sid, turns);
    captureTranscript(db, path, { clock: frozenClock(`${NIGHT}T03:00:00.000Z`) });
    // 预置：前评已覆盖 u1（水位线 u1），尾巴只剩 meta u2。直接手工塞壳 + pending 账（since=u1,target=u2），
    // 模拟一条"切片只剩 meta、空增量"的待愈账（真值：stageHeal 应作废壳 + dead + 不烧 LLM）。
    const shellRow = insertExperience(db, { kind: "self_review_fallback", content: "壳", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    db.query("INSERT INTO review_watermark (session_id,last_uuid,updated_at) VALUES (?,?,?)").run(sid, "u1", `${NIGHT}T04:00:00.000Z`);
    db.query("INSERT INTO review_heal (session_id,since_uuid,target_uuid,shell_id,night,attempts,status,next_attempt_at,created_at) VALUES (?,?,?,?,?,0,'pending',?,?)")
      .run(sid, "u1", "u2", shellRow.id, NIGHT, NIGHT, `${NIGHT}T04:00:00.000Z`);

    const c = countingLlm("good");
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: c.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_HEAL,
    });

    expect(c.reviewCalls()).toBe(0); // 不烧 LLM
    expect(shell(db, sid)!.invalid_at).not.toBeNull(); // 壳作废
    expect(heal(db, sid).status).toBe("dead"); // dead
    expect(markerCount(db, "heal_inert", sid)).toBe(1);
  });

  // ④ transcript 没了 → dead 不崩，不烧 LLM
  test("④ transcript 没了（找不到 ref）→ dead + heal_transcript_gone + 零 LLM、不崩", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "S4";
    const { db } = await seedFailedShell(dir, dbPath, config, sid);
    expect(heal(db, sid).status).toBe("pending");

    const c = countingLlm("good");
    // 次夜：findTranscripts 返回空 = transcript 没了
    const result = await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: c.llm, config,
      findTranscripts: () => [],
      stageOverrides: ONLY_HEAL,
    });

    expect(result.stages.heal.status).toBe("done"); // 不崩、阶段完成
    expect(c.reviewCalls()).toBe(0); // 零 LLM
    expect(heal(db, sid).status).toBe("dead");
    expect(markerCount(db, "heal_transcript_gone", sid)).toBe(1);
    expect(shell(db, sid)!.invalid_at).toBeNull(); // 壳留作客观记录（不作废）
  });

  // ⑤ H3 防风暴：连失败到 MAX 后 dead，LLM 调用封顶（不每夜重烧）
  test("⑤ H3：连失败 → MAX_HEAL_ATTEMPTS=3 后 dead，LLM 调用次数封顶=3", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "S5";
    const { db, path } = await seedFailedShell(dir, dbPath, config, sid);
    const fail = countingLlm("fail");

    // 模拟连续多夜（≥5 夜）都喂失败 LLM。每夜冷却推到下夜，attempts++；到 3 即 dead，此后不再烧。
    let night = NEXT;
    let callsAtDead = -1;
    for (let i = 0; i < 6; i++) {
      await runNightlyDigestion(db, {
        clock: frozenClock(`${night}T20:00:00.000Z`), night, llm: fail.llm, config,
        findTranscripts: () => [{ sessionId: sid, path }],
        stageOverrides: ONLY_HEAL,
      });
      // 一进 dead 就记下当时的 LLM 调用累计——之后多跑几夜该数字必须不再增长（防风暴核心）。
      if (callsAtDead < 0 && heal(db, sid).status === "dead") callsAtDead = fail.reviewCalls();
      // 下一夜 = night+1（让冷却过期）
      const d = new Date(`${night}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
      night = d.toISOString().slice(0, 10);
    }

    expect(heal(db, sid).status).toBe("dead"); // 到顶 dead
    expect(heal(db, sid).attempts).toBe(MAX_HEAL_ATTEMPTS); // 正好 MAX 轮
    // 真值（源码推导）：每轮 generateSelfReview 默认 maxAttempts=2 → 每轮最多烧 2 次 LLM；MAX=3 轮 → 封顶 6 次。
    // 关键防风暴铁证：到 dead 时累计 ≤ MAX×2，且 dead 之后再跑 3 夜，调用数**一次不增**。
    expect(callsAtDead).toBeGreaterThan(0);
    expect(callsAtDead).toBeLessThanOrEqual(MAX_HEAL_ATTEMPTS * 2); // 有界
    expect(fail.reviewCalls()).toBe(callsAtDead); // dead 后绝不每夜重烧（最终累计==入 dead 时累计）
    expect(markerCount(db, "heal_exhausted", sid)).toBe(1);
    expect(shell(db, sid)!.invalid_at).toBeNull(); // 壳留作最终客观记录
  });

  // ⑥ 并发：worker 推新段 + 自愈升旧壳 同库不互毁（水位线归 worker、壳切片归 heal）
  test("⑥ 并发不互毁：heal 升级旧壳期间，worker 已推到的水位线保持不变、新段自评不被动", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "S6";
    const { db, path } = await seedFailedShell(dir, dbPath, config, sid); // 壳覆盖到 u4，wm=u4
    const shellId = shell(db, sid)!.id;
    // 模拟 worker 之后写了一段"更新的自评"并把水位线推过 u4（用合成 uuid 表示 worker 见过更晚文件）。
    db.query("UPDATE review_watermark SET last_uuid=? WHERE session_id=?").run("u-worker-ahead", sid);
    const newer = insertExperience(db, { kind: "self_review", content: "worker 写的更新段自评。", sourceSession: sid, occurredAt: `${NEXT}T04:00:00.000Z` }, frozenClock(`${NEXT}T04:00:00.000Z`));
    const wmBefore = watermark(db, sid);

    const good = countingLlm("good");
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: good.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_HEAL,
    });

    // heal 升级了壳（壳作废、写出愈合片 order_seq=shellId），但 worker 的水位线与新段自评毫发无损。
    expect(shell(db, sid)!.invalid_at).not.toBeNull(); // 壳被升级
    expect(watermark(db, sid)).toBe(wmBefore); // H1/H4：水位线（worker 推到的）一步不动
    const newerStill = db.query("SELECT invalid_at FROM experiences WHERE id=?").get(newer.id) as { invalid_at: string | null };
    expect(newerStill.invalid_at).toBeNull(); // worker 的新段自评没被 heal 碰
    // 愈合片继承壳原位（order_seq=shellId，旧、小）→ 不会冒充 worker 新段的最新 prior
    const healed = db.query("SELECT order_seq FROM experiences WHERE kind='self_review' AND source_session=? AND order_seq IS NOT NULL").get(sid) as { order_seq: number };
    expect(healed.order_seq).toBe(shellId);
  });

  // ⑦ 归属夜正确（H5）：愈合自评 occurred_at = 账.night，不盖成消化时刻
  test("⑦ H5：愈合自评 occurred_at 归属夜 NIGHT，非消化夜 NEXT", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "S7";
    const { db, path } = await seedFailedShell(dir, dbPath, config, sid); // night=NIGHT
    const good = countingLlm("good");
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: good.llm, config, // 消化夜=NEXT
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: MAKEUP_HEAL,
    });
    const occ = db.query("SELECT occurred_at FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL").get(sid) as { occurred_at: string };
    expect(occ.occurred_at).toBe(`${NIGHT}T04:00:00.000Z`); // 归属失败夜，非消化夜
    // marker 也归属夜
    const succ = db.query("SELECT occurred_at FROM situation_log WHERE kind='heal_success' AND session_id=?").get(sid) as { occurred_at: string };
    expect(succ.occurred_at).toBe(`${NIGHT}T04:00:00.000Z`);
  });

  // ⑧ H8①纯老库零回归：order_seq 全 NULL 时缝合结果 == 改前 ORDER BY id DESC 逐字相同
  test("⑧-H8① 纯老库零回归：order_seq 全 NULL → priorSliceSummary 与 ORDER BY id DESC 字节等价", () => {
    const { dir, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S8a";
    // 造同会话多条真叙事自评（order_seq 全 NULL），id 递增。改前逻辑取 id 最大那条当 prior。
    insertExperience(db, { kind: "self_review", content: "第一片自评", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    insertExperience(db, { kind: "self_review", content: "第二片自评", sourceSession: sid, occurredAt: `${NIGHT}T05:00:00.000Z` }, frozenClock(`${NIGHT}T05:00:00.000Z`));
    const last = insertExperience(db, { kind: "self_review", content: "第三片自评（id 最大）", sourceSession: sid, occurredAt: `${NIGHT}T06:00:00.000Z` }, frozenClock(`${NIGHT}T06:00:00.000Z`));
    // 改前真值：ORDER BY id DESC LIMIT 1
    const oldStyle = db.query("SELECT content FROM experiences WHERE source_session=? AND kind='self_review' AND invalid_at IS NULL AND content IS NOT NULL AND content!='' ORDER BY id DESC LIMIT 1").get(sid) as { content: string };
    expect(oldStyle.content).toBe(last.content); // sanity

    // 造一份 transcript 让 buildIncrementalMaterial 跑（sinceUuid!=null 触发缝合）。前向写不传 slicePos。
    const path = writeTranscript(dir, sid, TURNS);
    const { readTranscriptEntries } = require("../src/transcript");
    const entries = readTranscriptEntries(path);
    const inc = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: sid, sinceUuid: "u2", targetUuid: "u4", entries });
    expect(inc.ok).toBe(true);
    // 新缝合 COALESCE(order_seq,id) DESC（order_seq 全 NULL）必与 ORDER BY id DESC 取到同一条
    expect((inc as any).material.priorSliceSummary).toBe(oldStyle.content);
  });

  // ⑧ H8④ 愈合自身承接上界：slicePos=壳id → prior 取"壳原位之前"那片，而非未来片
  test("⑧-H8④ 愈合自身承接：slicePos=壳id 上界生效，prior=壳原位之前片，非更晚的未来片", () => {
    const { dir, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S8d";
    // before：壳原位之前的一条真自评；shell：壳；future：壳之后才写的更晚真自评（id 比壳大）。
    const before = insertExperience(db, { kind: "self_review", content: "壳之前的上一片", sourceSession: sid, occurredAt: `${NIGHT}T03:00:00.000Z` }, frozenClock(`${NIGHT}T03:00:00.000Z`));
    const shellRow = insertExperience(db, { kind: "self_review_fallback", content: "壳", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    insertExperience(db, { kind: "self_review", content: "壳之后的未来片（id 更大）", sourceSession: sid, occurredAt: `${NIGHT}T05:00:00.000Z` }, frozenClock(`${NIGHT}T05:00:00.000Z`));

    const path = writeTranscript(dir, sid, TURNS);
    const { readTranscriptEntries } = require("../src/transcript");
    const entries = readTranscriptEntries(path);
    // 无上界（前向写）会误取"未来片"；传 slicePos=壳id 必取"壳之前的上一片"。
    const noBound = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: sid, sinceUuid: "u2", targetUuid: "u4", entries });
    expect((noBound as any).material.priorSliceSummary).toBe("壳之后的未来片（id 更大）"); // 证无上界会冒充
    const withBound = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: sid, sinceUuid: "u2", targetUuid: "u4", entries, slicePos: shellRow.id });
    expect((withBound as any).material.priorSliceSummary).toBe(before.content); // 上界生效：取壳原位之前那片
  });

  // ⑧ H8② 跨夜：愈合旧夜片后，对更晚夜缝合 → prior 选相邻（更晚的真叙事），不被旧愈合片带偏
  test("⑧-H8② 跨夜：愈合旧片(order_seq=小)后，更晚夜前向缝合仍取最新片当 prior", () => {
    const { dir, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S8b";
    // 真实跨夜场景：day N 出过一个壳（id 小），后来被愈合 → 愈合片 order_seq=壳id（小）。再之后 day N+1
    // 又前向写了一条真自评（order_seq=NULL，id 比壳大）。day N+2 前向缝合（无 slicePos）应取 day N+1 那条
    // （COALESCE=自身 id 最大），而非被 order_seq=小 的旧愈合片误选。用真实 id 构造（壳 id < later id）。
    const oldShell = insertExperience(db, { kind: "self_review_fallback", content: "day N 壳（被愈合的原位）", sourceSession: sid, occurredAt: `2026-06-08T04:00:00.000Z` }, frozenClock(`2026-06-08T04:00:00.000Z`));
    const healed = insertExperience(db, { kind: "self_review", content: "day N 的愈合旧片", sourceSession: sid, occurredAt: `2026-06-08T04:00:00.000Z`, orderSeq: oldShell.id }, frozenClock(`2026-06-09T04:00:00.000Z`));
    const later = insertExperience(db, { kind: "self_review", content: "day N+1 的前向最新片", sourceSession: sid, occurredAt: `2026-06-09T04:00:00.000Z` }, frozenClock(`2026-06-09T05:00:00.000Z`));
    const healedSeq = (db.query("SELECT order_seq FROM experiences WHERE id=?").get(healed.id) as any).order_seq;
    expect(healedSeq).toBe(oldShell.id); // 愈合片继承壳原位（小）
    expect(later.id).toBeGreaterThan(oldShell.id); // 后写的前向片 id 大于壳 id

    const path = writeTranscript(dir, sid, TURNS);
    const { readTranscriptEntries } = require("../src/transcript");
    const entries = readTranscriptEntries(path);
    const inc = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: sid, sinceUuid: "u2", targetUuid: "u4", entries });
    // COALESCE(order_seq,id) DESC：later 的 id(大) > 愈合片 order_seq(=壳id,小) → 取 later，不被旧愈合片带偏。
    expect((inc as any).material.priorSliceSummary).toBe(later.content);
  });

  // ⑧ H8③ 同夜多片：壳 id 夹在兄弟间，愈合后排回原位、不被后插 id 带偏
  test("⑧-H8③ 同夜多片：愈合片 order_seq=壳id（夹在兄弟间）→ 排回原位、不被后插带偏", () => {
    const { dir, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S8c";
    // 同夜三兄弟：A(早)、壳B(中)、C(晚)。occurred_at 全 T04:00。愈合 B → order_seq=壳id（夹 A、C 之间）。
    const A = insertExperience(db, { kind: "self_review", content: "兄弟A 早片", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    const shellB = insertExperience(db, { kind: "self_review_fallback", content: "壳B 中", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    const C = insertExperience(db, { kind: "self_review", content: "兄弟C 晚片", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    expect(A.id).toBeLessThan(shellB.id);
    expect(shellB.id).toBeLessThan(C.id);

    // 愈合 B 后写出的真自评 order_seq=壳B.id。它的承接(slicePos=壳B.id)应取 A（壳原位之前），不取 C。
    const path = writeTranscript(dir, sid, TURNS);
    const { readTranscriptEntries } = require("../src/transcript");
    const entries = readTranscriptEntries(path);
    const inc = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: sid, sinceUuid: "u2", targetUuid: "u4", entries, slicePos: shellB.id });
    expect((inc as any).material.priorSliceSummary).toBe(A.content); // 排回壳原位、取 A 当上一片，不被后插 C 带偏
  });

  // ⑨ 存量 live 壳一次性标 unhealable、不建可重试账、不跑 LLM
  test("⑨ 存量壳（无 heal 账）→ 标 unhealable、不 pending、零 LLM、不被愈合", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S9";
    const path = writeTranscript(dir, sid, TURNS);
    captureTranscript(db, path, { clock: frozenClock(`${NIGHT}T03:00:00.000Z`) });
    // 预置一条 live 壳，但**没有** heal 账（模拟历史存量壳）。
    const sh = insertExperience(db, { kind: "self_review_fallback", content: "存量壳", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    expect(heal(db, sid)).toBeNull(); // 确认无账

    const c = countingLlm("good");
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: c.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_HEAL,
    });

    const acc = heal(db, sid);
    expect(acc).not.toBeNull();
    expect(acc.status).toBe("unhealable"); // 一次性标 unhealable，不是 pending
    expect(c.reviewCalls()).toBe(0); // 不跑 LLM
    expect(shell(db, sid)!.invalid_at).toBeNull(); // 不被愈合（壳还在、未作废）
    expect(realReview(db, sid)).toBeNull(); // 没写真自评
  });

  // ⑩ since 守卫：since_uuid 非 null 但快照里没了（截断）→ dead、不跑 LLM、不从头猜
  test("⑩ since 守卫：since 非 null 却被截断不在快照 → dead + heal_since_gone + 零 LLM、不从头猜", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S10";
    // transcript 头部被截断：只剩 u3、u4（u1、u2 滚没）。账 since=u1（已不在快照）、target=u4（在）。
    const truncated: Turn[] = [
      { uuid: "u3", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "跑一下回归。" },
      { uuid: "u4", ts: "2026-06-10T02:05:00.000Z", role: "assistant", text: "回归全绿。" },
    ];
    const path = writeTranscript(dir, sid, truncated);
    captureTranscript(db, path, { clock: frozenClock(`${NIGHT}T03:00:00.000Z`) });
    const sh = insertExperience(db, { kind: "self_review_fallback", content: "壳", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` }, frozenClock(`${NIGHT}T04:00:00.000Z`));
    db.query("INSERT INTO review_heal (session_id,since_uuid,target_uuid,shell_id,night,attempts,status,next_attempt_at,created_at) VALUES (?,?,?,?,?,0,'pending',?,?)")
      .run(sid, "u1", "u4", sh.id, NIGHT, NIGHT, `${NIGHT}T04:00:00.000Z`); // since=u1 已滚没

    const c = countingLlm("good");
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: c.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_HEAL,
    });

    expect(c.reviewCalls()).toBe(0); // 绝不跑 LLM（不从头猜一个错下界）
    expect(heal(db, sid).status).toBe("dead"); // dead
    expect(markerCount(db, "heal_since_gone", sid)).toBe(1);
    expect(shell(db, sid)!.invalid_at).toBeNull(); // 不愈合
    expect(realReview(db, sid)).toBeNull();
  });

  // H2 原子幂等：成功删账后再跑一夜，绝不二次愈合（无第二条真自评、壳不被二次处理）
  test("H2 幂等：愈合成功删账后再跑 → 不二次愈合（真自评仍一条、无 heal_success 再触发）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const sid = "H2";
    const { db, path } = await seedFailedShell(dir, dbPath, config, sid);
    const good = countingLlm("good");
    // 第一次愈合
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: good.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }], stageOverrides: ONLY_HEAL,
    });
    expect(realReview(db, sid)).not.toBeNull();
    expect(heal(db, sid)).toBeNull(); // 账删
    const reviewsAfter1 = (db.query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL").get(sid) as any).c;

    // 第三夜再跑：无 pending 账 → 不该再愈合。注意 stageHeal 会对 live 壳... 但壳已作废，markExistingShellsUnhealable 只扫 live。
    const good2 = countingLlm("good");
    await runNightlyDigestion(db, {
      clock: frozenClock(`2026-06-12T20:00:00.000Z`), night: "2026-06-12", llm: good2.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }], stageOverrides: ONLY_HEAL,
    });
    expect(good2.reviewCalls()).toBe(0); // 不二次烧
    const reviewsAfter2 = (db.query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL").get(sid) as any).c;
    expect(reviewsAfter2).toBe(reviewsAfter1); // 真自评数没变
  });

  // H3 子项：冷却闸——同夜不重烧（registerHeal 当夜壳冷却到 night+1，本夜 stageHeal 选不到）
  test("H3 冷却闸：失败当夜 makeup+heal 同跑 → heal 选不到本夜新壳（next_attempt_at=night+1）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "H3c";
    const path = writeTranscript(dir, sid, TURNS);
    captureTranscript(db, path, { clock: frozenClock(`${NIGHT}T03:00:00.000Z`) });
    const c = countingLlm("fail"); // makeup 失败造壳；同夜 heal 不应再烧它
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NIGHT}T20:00:00.000Z`), night: NIGHT, llm: c.llm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: { closure: async () => {}, decay: async () => {}, personality: async () => {}, diary: async () => {}, vectorize: async () => {} },
    });
    // makeup 烧了（失败），但 heal 不该对当夜新壳再烧：账冷却到 NEXT、本夜 selectHealable 选不到。
    expect(heal(db, sid).status).toBe("pending");
    expect(heal(db, sid).attempts).toBe(0); // heal 没碰它（没 attempts++）
    expect(heal(db, sid).next_attempt_at).toBe(NEXT);
  });
});
