// 迟到认领 reclaim（DESIGN-DAYSPLIT §12）：night N all-done 后又出现属于 day N 的迟到内容（采集滞后/
// worker off），findUndigestedNights 因 all-done 排除该夜 → 永久漏。requeueLateReclaim 检测「makeup 已 done
// 但有 situation_log 活动 created_at > makeup.finished_at」的夜，**只**删 makeup digest_runs 行触发重跑（其余
// 阶段 done 保留），补迟到自评进 experiences（召回可搜），留 digest_late_reclaim marker，单调收敛。
// 红灯先行：requeueLateReclaim 未实现时本文件 import 即失败。
//   RC1 完整周期：检测→重置→重跑补迟到自评→收敛（二次检测不再触发）
//   RC2 只重 makeup：closure/personality/diary/vectorize 不因 reclaim 重跑（spy 计数不增）
//   RC3 无迟到内容 → 不误触发（requeueLateReclaim 返回 []）
//   RC4 迟到夜已被 worker 覆盖 → 重跑 makeup 空跑、不重复自评（幂等）

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { casWatermark } from "../src/watermark";
import {
  runNightlyDigestion,
  requeueLateReclaim,
  findUndigestedNights,
  type DigestConfig,
  type StageName,
} from "../src/digest";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-reclaim-"));
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

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string };
function turnLine(sessionId: string, t: Turn): string {
  return JSON.stringify({
    uuid: t.uuid,
    parentUuid: null,
    isSidechain: false,
    sessionId,
    timestamp: t.ts,
    cwd: "/Users/tester/Projects/demo",
    type: t.role,
    isMeta: false,
    message: { role: t.role, content: t.text },
  });
}
function writeTranscript(dir: string, sessionId: string, turns: Turn[]): string {
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, turns.map((t) => turnLine(sessionId, t)).join("\n") + "\n");
  return p;
}
function appendTurns(path: string, sessionId: string, turns: Turn[]) {
  appendFileSync(path, turns.map((t) => turnLine(sessionId, t)).join("\n") + "\n");
}

function recordingLlm() {
  const prompts: string[] = [];
  const llm = async (prompt: string): Promise<string> => {
    if (!prompt.includes("收工时间")) return "{}";
    prompts.push(prompt);
    return JSON.stringify({
      review: "增量自评：把这段没复盘的切片回顾了一下。",
      feeling: "踏实",
      intensity: "不大",
      keywords: ["补课"],
      items: [],
    });
  };
  return { llm, prompts };
}

const ONLY_MAKEUP: Partial<Record<StageName, () => Promise<void>>> = {
  closure: async () => {},
  decay: async () => {},
  personality: async () => {},
  diary: async () => {},
  vectorize: async () => {},
};

function watermark(db: Database, sid: string): string | null {
  const r = db.query("SELECT last_uuid l FROM review_watermark WHERE session_id=?").get(sid) as
    | { l: string }
    | null;
  return r?.l ?? null;
}
function reviewDays(db: Database, sid: string): string[] {
  return (
    db
      .query(
        "SELECT date(occurred_at,'+8 hours') d FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL ORDER BY id ASC",
      )
      .all(sid) as { d: string }[]
  ).map((r) => r.d);
}
function nightMarkerExists(db: Database, kind: string): boolean {
  return db.query("SELECT 1 FROM situation_log WHERE kind=?").get(kind) != null;
}
function makeupRun(db: Database, night: string): { status: string; finished_at: string } | null {
  return db
    .query("SELECT status, finished_at FROM digest_runs WHERE night=? AND stage='makeup'")
    .get(night) as { status: string; finished_at: string } | null;
}

const N = "2026-06-10";
const T_DIGEST1 = "2026-06-11T03:00:00.000Z"; // 第一次消化（makeup finished_at）
const T_LATE = "2026-06-11T08:00:00.000Z"; // 迟到内容采集入库（created_at > finished_at）
const T_RECLAIM = "2026-06-11T09:00:00.000Z"; // 触发 reclaim 检测
const T_DIGEST2 = "2026-06-11T09:30:00.000Z"; // reclaim 重跑

// day N 主体两段（消化时已在）
const BODY: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "BODY1 主体第一段。" },
  { uuid: "u2", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "BODY2 主体第二段。" },
];
// day N 的迟到尾巴（消化跑完后才落盘/采集，仍属 06-10）
const LATE_TAIL: Turn = { uuid: "u3", ts: "2026-06-10T05:00:00.000Z", role: "user", text: "LATE3 迟到补的 06-10 尾巴。" };

describe("迟到认领 reclaim（DESIGN-DAYSPLIT §12）", () => {
  beforeEach(() => {
    process.env.ANIMA_DAYSPLIT = "1";
  });
  afterEach(() => {
    delete process.env.ANIMA_DAYSPLIT;
  });

  test("RC1 完整周期：检测迟到夜 → 只重置 makeup → 重跑补迟到自评 → 收敛", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-reclaim";
    const path = writeTranscript(dir, sid, BODY);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });

    // 第一次消化 night N：补 day N 主体（u1,u2），makeup done、finished_at=T_DIGEST1
    const r1 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST1),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(reviewDays(db, sid)).toEqual([N]);
    expect(watermark(db, sid)).toBe("u2");
    expect(makeupRun(db, N)?.status).toBe("done");

    // 迟到尾巴 u3（仍属 06-10）在消化跑完后才采集入库：created_at=T_LATE > finished_at=T_DIGEST1
    appendTurns(path, sid, [LATE_TAIL]);
    captureTranscript(db, path, { clock: frozenClock(T_LATE) });

    // requeueLateReclaim：检测到 night N 有迟到活动 → 删 makeup 行、留 marker、返回 [N]
    const reclaimed = requeueLateReclaim(db, { now: new Date(T_RECLAIM) });
    expect(reclaimed).toEqual([N]);
    expect(makeupRun(db, N)).toBeNull(); // makeup 行被删（触发重跑）
    expect(nightMarkerExists(db, "digest_late_reclaim")).toBe(true);

    // 重置后 findUndigestedNights 自动纳入 N（makeup 不再 done）
    const { nights } = findUndigestedNights(db, { now: new Date(T_RECLAIM) });
    expect(nights).toContain(N);

    // 重跑 makeup：补迟到尾巴 u3、occurred_at 仍归 06-10
    const r2 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST2),
      llm: r2.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(reviewDays(db, sid)).toEqual([N, N]); // 迟到自评进库、归本夜，不丢
    expect(watermark(db, sid)).toBe("u3");
    expect(r2.prompts[0]).toContain("LATE3");

    // 收敛：makeup finished_at 已刷新到 T_DIGEST2 > u3 created_at(T_LATE) → 不再触发
    const reclaimedAgain = requeueLateReclaim(db, { now: new Date("2026-06-11T10:00:00.000Z") });
    expect(reclaimedAgain).toEqual([]);
  });

  test("RC2 只重 makeup：closure/personality/diary/vectorize 不因 reclaim 重跑", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-onlymakeup";
    const path = writeTranscript(dir, sid, BODY);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });

    const calls: Record<string, number> = {};
    const spy =
      (name: string) =>
      async (): Promise<void> => {
        calls[name] = (calls[name] ?? 0) + 1;
      };
    // makeup 用真实 daysplit 路；其余阶段 spy 计数（不覆盖 makeup）
    const spies: Partial<Record<StageName, () => Promise<void>>> = {
      closure: spy("closure"),
      decay: spy("decay"),
      personality: spy("personality"),
      diary: spy("diary"),
      vectorize: spy("vectorize"),
    };

    const r1 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST1),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: spies,
    });
    expect(calls.closure).toBe(1); // 第一次各阶段跑一次、标 done

    appendTurns(path, sid, [LATE_TAIL]);
    captureTranscript(db, path, { clock: frozenClock(T_LATE) });
    requeueLateReclaim(db, { now: new Date(T_RECLAIM) });

    const r2 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST2),
      llm: r2.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: spies,
    });
    expect(r2.prompts[0]).toContain("LATE3"); // makeup 确实重跑了、补了迟到内容
    // 但 closure/personality/diary/vectorize 没因 reclaim 重跑（仍 done、skip）
    expect(calls.closure).toBe(1);
    expect(calls.personality).toBe(1);
    expect(calls.diary).toBe(1);
    expect(calls.vectorize).toBe(1);
  });

  test("RC3 无迟到内容 → requeueLateReclaim 不误触发", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-clean";
    const path = writeTranscript(dir, sid, BODY);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });

    const r = recordingLlm();
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST1),
      llm: r.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    // 没有任何活动 created_at > makeup.finished_at → 不该 reclaim
    const reclaimed = requeueLateReclaim(db, { now: new Date(T_RECLAIM) });
    expect(reclaimed).toEqual([]);
    expect(makeupRun(db, N)?.status).toBe("done"); // makeup 行没被乱删
    expect(nightMarkerExists(db, "digest_late_reclaim")).toBe(false);
  });

  test("RC4 迟到夜已被 worker 覆盖 → 重跑 makeup 空跑、不重复自评（幂等）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-worker-covered";
    const path = writeTranscript(dir, sid, BODY);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });

    const r1 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST1),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(watermark(db, sid)).toBe("u2");

    // 迟到尾巴 u3 入库（触发 reclaim 检测），但 worker 已实时把水位线推到 u3（覆盖了迟到切片）
    appendTurns(path, sid, [LATE_TAIL]);
    captureTranscript(db, path, { clock: frozenClock(T_LATE) });
    casWatermark(db, sid, "u2", "u3", T_LATE, null); // 模拟 worker 抢先覆盖

    requeueLateReclaim(db, { now: new Date(T_RECLAIM) });
    const r2 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST2),
      llm: r2.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    // 水位线已达 dayBound → reached=true → makeup 空跑、不重复烧 LLM、不写重复自评
    expect(r2.prompts.length).toBe(0);
    expect(reviewDays(db, sid)).toEqual([N]); // 仍只第一条，没重复
    expect(watermark(db, sid)).toBe("u3");
  });

  test("RC5 迟到活动 created_at 恰等于 makeup.finished_at（同毫秒）→ 仍触发 reclaim（>= 边界，codex 1a）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-eqboundary";
    const path = writeTranscript(dir, sid, BODY);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST1), // makeup finished_at = T_DIGEST1
      llm: recordingLlm().llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    // 迟到尾巴恰好在 makeup 完成的同一毫秒入库：created_at == finished_at(T_DIGEST1)。
    // makeup 处理过的活动必在完成前入库（created_at 严格 < finished_at），故 == 的这条 makeup 没碰过 = 真迟到。
    // 严格 > 会静默漏（永久丢）；>= 正确捕获。
    appendTurns(path, sid, [LATE_TAIL]);
    captureTranscript(db, path, { clock: frozenClock(T_DIGEST1) });
    const reclaimed = requeueLateReclaim(db, { now: new Date(T_RECLAIM) });
    expect(reclaimed).toEqual([N]);
  });

  test("RC6 重复调 reclaim → 不重复触发、不重复 marker（changes-CAS 幂等，codex 5b）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-idem";
    const path = writeTranscript(dir, sid, BODY);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T03:00:00.000Z") });
    await runNightlyDigestion(db, {
      night: N,
      clock: frozenClock(T_DIGEST1),
      llm: recordingLlm().llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    appendTurns(path, sid, [LATE_TAIL]);
    captureTranscript(db, path, { clock: frozenClock(T_LATE) });

    const first = requeueLateReclaim(db, { now: new Date(T_RECLAIM) });
    expect(first).toEqual([N]); // 真删掉 makeup 行 → 触发
    const second = requeueLateReclaim(db, { now: new Date(T_RECLAIM) });
    expect(second).toEqual([]); // makeup 行已删 → 不再选中、不重复触发
    const markerCount = db
      .query("SELECT count(*) c FROM situation_log WHERE kind='digest_late_reclaim'")
      .get() as { c: number };
    expect(markerCount.c).toBe(1); // 只一条 marker，绝不重复
  });
});
