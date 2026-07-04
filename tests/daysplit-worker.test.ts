// 步骤4 worker 日界化（DESIGN-DAYSPLIT §3.4 / §8 步骤4）正式测试套。
// 来历：TDD 红灯先行起底 + 独立验收考官的对抗测试超集折入（双刀 GO 后合并去冗余）；真值全部手算自
//       设计文档 §3.1/§3.2/§3.4/§3.6，含 racing-clock 确定性命中空增量两条收尾抢输路 + crosses 判据边界。
//
// 东八日界（半开，已实测确认）：东八日 D = UTC [D-1 16:00:00.000Z, D 16:00:00.000Z)。
//   ts 2026-06-10T15:59:59.999Z → 东八 06-10；ts 2026-06-10T16:00:00.000Z → 东八 06-11。
//
// 契约 A 按首条 entry 日切（非挂钟 today / 非重心夜）
// 契约 B occurred_at 落对天
// 契约 C 部分切片 requeue：不 markDone、不涨 attempts
// 契约 D 两条收尾路抢输验覆盖（含空增量 advanceWatermarkOnly 路）
// 契约 E 多午夜逐轮推进、单调收敛、有限轮 done
// 契约 F center 路零回归

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { enqueueReview, takeNextPending, markReviewDone, type WorkItem } from "../src/workQueue";
import { readWatermark, casWatermark, advanceWatermarkOnly } from "../src/watermark";
import { processReviewItem } from "../src/worker";

const tmpDirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "grader-dw-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// daysplit 开关由 env 控制——每个 block 显式设/清，互不污染。
const origEnv = process.env.ANIMA_DAYSPLIT;
function setDaysplit(on: boolean) {
  if (on) process.env.ANIMA_DAYSPLIT = "1";
  else delete process.env.ANIMA_DAYSPLIT;
}
afterEach(() => {
  if (origEnv === undefined) delete process.env.ANIMA_DAYSPLIT;
  else process.env.ANIMA_DAYSPLIT = origEnv;
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string };
function writeTranscript(dir: string, sid: string, turns: Turn[]): string {
  const lines = turns.map((t) =>
    JSON.stringify({
      uuid: t.uuid,
      parentUuid: null,
      isSidechain: false,
      sessionId: sid,
      timestamp: t.ts,
      cwd: "/proj",
      type: t.role,
      isMeta: false,
      message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
function goodLlm() {
  const calls = { n: 0 };
  const llm = async () => {
    calls.n++;
    return JSON.stringify({
      review: "增量复盘：处理了这一段。",
      feeling: "踏实",
      intensity: "中",
      keywords: ["复盘"],
      items: [],
    });
  };
  return { llm, calls };
}
function qstatus(db: Database, sid: string): string | undefined {
  return (db.query("SELECT status FROM work_queue WHERE session_id=? AND kind='self_review'").get(sid) as { status: string } | null)?.status;
}
function qattempts(db: Database, sid: string): number {
  return (db.query("SELECT attempts a FROM work_queue WHERE session_id=? AND kind='self_review'").get(sid) as { a: number } | null)?.a ?? -1;
}
function reviewRows(db: Database, sid: string): { content: string; occurred_at: string }[] {
  return db
    .query("SELECT content, occurred_at FROM experiences WHERE kind='self_review' AND source_session=? ORDER BY id ASC")
    .all(sid) as { content: string; occurred_at: string }[];
}
function reviewOccurredDays(db: Database, sid: string): string[] {
  // 东八日（与 SQL_LOCAL_OCCURRED_DATE 同口径）
  return (
    db
      .query("SELECT date(occurred_at, '+8 hours') d FROM experiences WHERE kind='self_review' AND source_session=? ORDER BY id ASC")
      .all(sid) as { d: string }[]
  ).map((r) => r.d);
}
function enqueueAndTake(db: Database, sid: string, path: string, target: string, clock = frozenClock("2026-06-10T05:00:00.000Z")): WorkItem {
  enqueueReview(db, { sessionId: sid, transcriptPath: path, targetUuid: target }, clock);
  return takeNextPending(db, clock)!;
}

// ---- 共用语料：一段跨午夜会话 ----
// day 06-10 的两条（< 06-10T16:00Z）：u1@01:00、u2@02:00
// day 06-11 的两条（>= 06-10T16:00Z 且 < 06-11T16:00Z）：u3@17:00、u4@18:00
// dayBound(06-10) = u2（最后一条 < 06-10T16:00Z）；item.target = u4（在 06-11）→ 必跨天切到 u2。
const CROSS: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "开始修权限测试。" },
  { uuid: "u2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "好，先看 mock。" },
  { uuid: "u3", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "继续，第二天接着干。" },
  { uuid: "u4", ts: "2026-06-10T18:00:00.000Z", role: "assistant", text: "收尾，跑回归。" },
];

describe("契约 A/B/C — 跨午夜按首条 entry 日切（非挂钟/非重心夜）+ occurred_at 落对天 + 部分切片 requeue", () => {
  beforeEach(() => setDaysplit(true));

  test("A+B+C: 挂钟在 06-12、重心夜偏向 06-11，但首片切到 dayBound(06-10)=u2、occurred_at 钉 06-10、余段 requeue 不 markDone 不涨 attempts", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", CROSS);
    // 挂钟故意设在 day 06-12（东八 06-12 = UTC 06-11 16:00Z 之后），证明用的是切片首条日(06-10)而非 clock.now()。
    const wallClock = frozenClock("2026-06-11T18:00:00.000Z"); // 东八 = 06-12
    // 入队 target=u4（会话末条，属 06-11）。enqueue 用普通时钟即可。
    const item = enqueueAndTake(db, "s1", path, "u4");
    const { llm, calls } = goodLlm();

    const out = await processReviewItem(db, item, { llm, clock: wallClock });

    // 真值：首条未审 entry = u1（wmOld=null → startIdx=0），其东八日 = 06-10，dayBound(06-10)=u2。
    // target u4 在 06-11（dbIdx(u2)=1 < tgtIdx(u4)=3）→ crosses → sliceTarget=u2 → 写 1 条、推水位线到 u2。
    expect(out).toBe("sliced_more");
    expect(calls.n).toBe(1);
    const rows = reviewRows(db, "s1");
    expect(rows.length).toBe(1);
    // B: occurred_at 落 06-10（首条日），不是挂钟 06-12、也不是重心夜
    expect(reviewOccurredDays(db, "s1")).toEqual(["2026-06-10"]);
    // 水位线推到 dayBound u2（不是 u4）
    expect(readWatermark(db, "s1")).toBe("u2");
    // C: 跨天余段 → 绝不 markReviewDone（队列留 pending）、绝不涨 attempts
    expect(qstatus(db, "s1")).toBe("pending");
    expect(qattempts(db, "s1")).toBe(0);
  });

  test("A: 证伪「用挂钟 today」——若实现误用 clock.now() 的东八日(06-12)算 firstSliceDay，dayBound(06-12) 会切错/不切；本测试钉死 occurred_at=06-10 与 wm=u2 即排除该误用", async () => {
    // 这是 A 的针对性反证：构造「挂钟日 != 首片日」，期望严格按首片日。已在上一条断言覆盖；此条用极端挂钟再钉一次。
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", CROSS);
    const farFuture = frozenClock("2030-01-01T00:00:00.000Z");
    const item = enqueueAndTake(db, "s1", path, "u4");
    const { llm } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: farFuture });
    expect(out).toBe("sliced_more");
    expect(reviewOccurredDays(db, "s1")).toEqual(["2026-06-10"]); // 仍是首片日，不受挂钟影响
    expect(readWatermark(db, "s1")).toBe("u2");
  });
});

describe("契约 B（续）— 第二轮处理剩余 06-11 片：occurred_at 落 06-11、收尾标 done", () => {
  beforeEach(() => setDaysplit(true));

  test("B2: 第一轮切 06-10 后，第二轮（wm=u2）首片日=06-11、dayBound(06-11)=u4=target → 不跨天 → 复盘剩余、occurred_at 06-11、done", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", CROSS);
    const wallClock = frozenClock("2026-06-11T18:00:00.000Z");

    // 第一轮
    let item = enqueueAndTake(db, "s1", path, "u4");
    const { llm } = goodLlm();
    expect(await processReviewItem(db, item, { llm, clock: wallClock })).toBe("sliced_more");
    expect(readWatermark(db, "s1")).toBe("u2");
    expect(qstatus(db, "s1")).toBe("pending");

    // 第二轮：drain 会重新 take 同一 pending（target 仍 u4）
    item = takeNextPending(db, wallClock)!;
    expect(item.targetUuid).toBe("u4");
    const out2 = await processReviewItem(db, item, { llm, clock: wallClock });
    // 真值：wmOld=u2 → startIdx=2 → 首条未审 = u3 @ 06-11 → 首片日=06-11，dayBound(06-11)=u4=target
    //   → dbIdx(u4)=3 不 < tgtIdx(u4)=3 → 不 crosses → sliceTarget=u4 → 复盘 (u2,u4]、推 wm=u4、done。
    expect(out2).toBe("reviewed");
    expect(readWatermark(db, "s1")).toBe("u4");
    expect(qstatus(db, "s1")).toBe("done");
    // 两条自评分别落 06-10 / 06-11
    expect(reviewOccurredDays(db, "s1")).toEqual(["2026-06-10", "2026-06-11"]);
  });
});

describe("契约 D — 两条收尾路抢输验覆盖（lostRace 但未覆盖 target → 不丢段、不提前 done、不回退水位线）", () => {
  beforeEach(() => setDaysplit(true));

  // D1：storeSelfReviewResult 路 lostRace。让别的写者只把水位线推到 dayBound(u2)（未覆盖 target u4）。
  // worker 处理首片(null,u2]，CAS oldUuid=null 会落空（别人已 INSERT 行）→ finalizeRaceLost：
  //   wmNow=u2，atOrAfter(entries,u2,u4)=false（idx2 < idx3）→ 不 done → requeue → sliced_more。
  test("D1 (storeSelfReviewResult 路): lostRace 且赢家只推到 dayBound(u2) 未覆盖 target u4 → requeue 余段、不 markDone、水位线保持 u2 不回退", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", CROSS);
    const clock = frozenClock("2026-06-11T18:00:00.000Z");
    const item = enqueueAndTake(db, "s1", path, "u4");

    // 模拟别的写者（makeup/另一 worker）抢先把水位线从 null → u2（只覆盖到 06-10 日界，未到 target u4）。
    // 但**不**预设到使 worker 在 atOrAfter(wmOld,target) 早退——我们要 worker 走到 storeSelfReviewResult 才发现 CAS 落空。
    // 关键：worker 读 wmOld 必须在抢先之前。这里 processReviewItem 内部先 readWatermark(wmOld)。
    // 为让 wmOld=null 进入切片、却在落库 CAS 时落空，需要在 worker 读 wmOld 之后、CAS 之前推 u2。
    // 用注入 llm 的副作用做"读后写"：llm 调用发生在 readWatermark 之后、storeSelfReviewResult 之前。
    let raced = false;
    const llm = async () => {
      if (!raced) {
        raced = true;
        casWatermark(db, "s1", null, "u2", "2026-06-10T03:00:00.000Z", null); // 赢家推到 u2（dayBound），未到 u4
      }
      return JSON.stringify({ review: "复盘 06-10 片", feeling: "", intensity: "", keywords: ["x"], items: [] });
    };

    const out = await processReviewItem(db, item, { llm, clock });
    // worker 的本片 sliceTarget=u2，CAS oldUuid=null→u2 落空（赢家已占 u2）→ finalizeRaceLost。
    // wmNow=u2，atOrAfter(u2,u4)=false → requeue 余段、sliced_more。
    expect(out).toBe("sliced_more");
    expect(readWatermark(db, "s1")).toBe("u2"); // 不回退（仍 u2，赢家的值）
    expect(qstatus(db, "s1")).toBe("pending"); // 未 markDone，余段等下轮
    expect(qattempts(db, "s1")).toBe(0); // 不计 attempt（成功推进≠失败）
    // worker 自己这段没写入（CAS 落空整体回滚）
    expect(reviewRows(db, "s1").length).toBe(0);
  });

  // 空跨天片（无抢先）基线：三路素材全空 → 走 advanceWatermarkOnly；跨天 → 推进日界 e2、余段 requeue（不 markDone）。
  test("D-base (空增量跨天路): 空片推进到 dayBound(e2)、余段 requeue、不 markDone、不写自评、不烧 LLM", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    // 纯空白文本回合 → 对话/事件/书签三路皆空 → 走空增量 advanceWatermarkOnly。
    const EMPTY_CROSS: Turn[] = [
      { uuid: "e1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "   " },
      { uuid: "e2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "   " },
      { uuid: "e3", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "   " },
      { uuid: "e4", ts: "2026-06-10T18:00:00.000Z", role: "assistant", text: "   " },
    ];
    const path = writeTranscript(dir, "s1", EMPTY_CROSS);
    const clock = frozenClock("2026-06-11T18:00:00.000Z");
    const item = enqueueAndTake(db, "s1", path, "e4");
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock });
    expect(out).toBe("sliced_more");
    expect(calls.n).toBe(0); // 空增量不烧 LLM
    expect(readWatermark(db, "s1")).toBe("e2");
    expect(qstatus(db, "s1")).toBe("pending");
    expect(reviewRows(db, "s1").length).toBe(0);
  });

  // D2（确定性命中空增量 advanceWatermarkOnly 的 lostRace —— 设计点名 v2 漏的那条，worker.ts:187）。
  // 注入点：advanceWatermarkOnly 在 CAS 那一刻调 clock.now()。本片 now() 调用序为 [capture..., CAS]，
  //   实测 processReviewItem 内空跨天路恰 2 次（#1 capture、#2 CAS）、第 2 次正是 advanceWatermarkOnly 的 CAS 前。用 racing clock 在第 2 次 now() 把水位线抢先 INSERT 到 e2，
  //   worker 自己的 advanceWatermarkOnly(null→e2) 撞 ON CONFLICT DO NOTHING → changes=0 → advanced=false →
  //   命中 `if (daysplit && !advanced) finalizeRaceLost()`。赢家 e2 未覆盖 target e4 → 应 requeue 余段、不 markDone、不回退。
  test("D2 (advanceWatermarkOnly 空增量路 lostRace): CAS 落空且赢家只到 dayBound(e2) 未覆盖 e4 → finalizeRaceLost → requeue、不 markDone、wm 不回退、不写自评", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const EMPTY_CROSS: Turn[] = [
      { uuid: "e1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "   " },
      { uuid: "e2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "   " },
      { uuid: "e3", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "   " },
      { uuid: "e4", ts: "2026-06-10T18:00:00.000Z", role: "assistant", text: "   " },
    ];
    const path = writeTranscript(dir, "s1", EMPTY_CROSS);
    // racing clock：第 3 次 now()（= advanceWatermarkOnly 的 CAS 时刻）之前，由"另一写者"先把 wm INSERT 到 e2。
    let nowCalls = 0;
    let raced = false;
    const FIXED = "2026-06-11T18:00:00.000Z"; // 挂钟东八 06-12
    const racingClock = {
      now: () => {
        nowCalls++;
        if (nowCalls === 2 && !raced) {
          raced = true;
          // 赢家：从 null INSERT 到 e2（dayBound(06-10)），未覆盖 target e4。先于 worker 自己的 CAS 落库。
          casWatermark(db, "s1", null, "e2", "2026-06-10T03:00:00.000Z", null);
        }
        return new Date(FIXED);
      },
    };
    const item = enqueueAndTake(db, "s1", path, "e4");
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: racingClock });
    expect(raced).toBe(true); // 确认抢先确实在 CAS 前发生（注入点命中）
    expect(out).toBe("sliced_more"); // finalizeRaceLost：wmNow=e2，atOrAfter(e2,e4)=false → requeue 余段
    expect(calls.n).toBe(0); // 空增量路不烧 LLM
    expect(readWatermark(db, "s1")).toBe("e2"); // 赢家值，绝不回退
    expect(qstatus(db, "s1")).toBe("pending"); // 未 markDone，余段下轮
    expect(qattempts(db, "s1")).toBe(0); // 不计 attempt
    expect(reviewRows(db, "s1").length).toBe(0);
  });

  // D2-covered（空增量 advanceWatermarkOnly lostRace 的另一半）：赢家恰覆盖到 target → finalizeRaceLost 判覆盖 → markDone covered。
  test("D2-covered (advanceWatermarkOnly 路 lostRace 覆盖到 target): 赢家已推到 target e3 → finalizeRaceLost 判覆盖 → markDone covered、不回退", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    // 单日空语料（不跨天），target=e3。racing clock 在 CAS 前由赢家直接推到 e3（=target）。
    const SINGLE_EMPTY: Turn[] = [
      { uuid: "e1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "   " },
      { uuid: "e2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "   " },
      { uuid: "e3", ts: "2026-06-10T03:00:00.000Z", role: "user", text: "   " },
    ];
    const path = writeTranscript(dir, "s1", SINGLE_EMPTY);
    let nowCalls = 0;
    let raced = false;
    const racingClock = {
      now: () => {
        nowCalls++;
        if (nowCalls === 2 && !raced) {
          raced = true;
          casWatermark(db, "s1", null, "e3", "2026-06-10T03:30:00.000Z", null); // 赢家推到 target e3
        }
        return new Date("2026-06-10T05:00:00.000Z");
      },
    };
    const item = enqueueAndTake(db, "s1", path, "e3", frozenClock("2026-06-10T05:00:00.000Z"));
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: racingClock });
    expect(raced).toBe(true);
    expect(out).toBe("covered"); // wmNow=e3=target → atOrAfter true → markDone covered
    expect(calls.n).toBe(0);
    expect(readWatermark(db, "s1")).toBe("e3");
    expect(qstatus(db, "s1")).toBe("done");
  });

  // D2-mutkill（决定性突变杀手）：空增量、**不跨天**（crossedDay=false）、CAS 落空、赢家只推到**中间** e2（未覆盖 target e3）。
  //   ——这是唯一能把「空增量抢输验覆盖」(worker.ts:187) 与「跨天 requeue 兜底」分开的场景：
  //   · 正确实现：finalizeRaceLost 重读 wm=e2，atOrAfter(e2,e3)=false → requeue → sliced_more（不丢段、不 markDone）。
  //   · 若删掉 :187 那条 check：因 crossedDay=false 不会落到跨天 requeue → 直接 markReviewDone(item.target=e3) → covered（错误地标完成、丢了 (e2,e3] 段）。
  //   全 06-10 单日，全 < 06-10T16Z，故首片日=06-10、dayBound(06-10)=e3=target → 不跨天。
  test("D2-mutkill (空增量·不跨天·CAS落空·赢家只到中间e2未覆盖target e3): 必须 finalizeRaceLost→requeue sliced_more（删 :187 check 则错成 covered）", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const SINGLE_EMPTY: Turn[] = [
      { uuid: "e1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "   " },
      { uuid: "e2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "   " },
      { uuid: "e3", ts: "2026-06-10T03:00:00.000Z", role: "user", text: "   " },
    ];
    const path = writeTranscript(dir, "s1", SINGLE_EMPTY);
    let nowCalls = 0;
    let raced = false;
    const racingClock = {
      now: () => {
        nowCalls++;
        if (nowCalls === 2 && !raced) {
          raced = true;
          // 赢家只推到中间 e2（未覆盖 target e3）。worker 自己的 advanceWatermarkOnly(null→e3) 撞 ON CONFLICT → advanced=false。
          casWatermark(db, "s1", null, "e2", "2026-06-10T02:30:00.000Z", null);
        }
        return new Date("2026-06-10T05:00:00.000Z");
      },
    };
    const item = enqueueAndTake(db, "s1", path, "e3", frozenClock("2026-06-10T05:00:00.000Z"));
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: racingClock });
    expect(raced).toBe(true);
    expect(out).toBe("sliced_more"); // 决定性：不跨天的空增量 lostRace 也必须验覆盖、requeue 余段
    expect(calls.n).toBe(0);
    expect(readWatermark(db, "s1")).toBe("e2"); // 赢家值，绝不回退、绝不推到 e3
    expect(qstatus(db, "s1")).toBe("pending"); // 绝不提前 markDone
    expect(qattempts(db, "s1")).toBe(0);
    expect(reviewRows(db, "s1").length).toBe(0);
  });
});

describe("契约 E — 多午夜逐轮推进、单调收敛、有限轮 done、不死循环", () => {
  beforeEach(() => setDaysplit(true));

  test("E: 跨三天会话，逐轮 drain 应在 3 轮内严格逐天推进、产 3 条各钉其日、最终 done，且不再 requeue", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    // 三天各两条：
    // 06-10: t1@01:00, t2@02:00  (dayBound06-10 = t2)
    // 06-11: t3@17:00, t4@18:00  (>=06-10T16Z, <06-11T16Z)  (dayBound06-11 = t4)
    // 06-12: t5@2026-06-11T17:00, t6@18:00 (>=06-11T16Z)
    const THREE: Turn[] = [
      { uuid: "t1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "第一天开工。" },
      { uuid: "t2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "第一天收尾。" },
      { uuid: "t3", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "第二天继续。" },
      { uuid: "t4", ts: "2026-06-10T18:00:00.000Z", role: "assistant", text: "第二天收尾。" },
      { uuid: "t5", ts: "2026-06-11T17:00:00.000Z", role: "user", text: "第三天继续。" },
      { uuid: "t6", ts: "2026-06-11T18:00:00.000Z", role: "assistant", text: "第三天收尾。" },
    ];
    const path = writeTranscript(dir, "s1", THREE);
    const clock = frozenClock("2026-06-12T18:00:00.000Z"); // 挂钟更靠后，证明逐天按首片日
    const { llm } = goodLlm();

    // 入队 target=t6（末条，属 06-12）
    enqueueReview(db, { sessionId: "s1", transcriptPath: path, targetUuid: "t6" }, clock);

    const outcomes: string[] = [];
    const wms: (string | null)[] = [];
    let rounds = 0;
    // 模拟主循环逐轮 drain（每轮 take 同一 pending + process 一次），直到 done 或安全上限。
    while (rounds < 10) {
      const item = takeNextPending(db, clock);
      if (!item) break; // 队列已无 pending（done/无）
      const out = await processReviewItem(db, item, { llm, clock });
      outcomes.push(out);
      wms.push(readWatermark(db, "s1"));
      rounds++;
      if (out === "reviewed" || out === "covered") break; // 收尾
      // sliced_more 会留 pending，下一轮继续；任何卡死 outcome 也会被上限兜住。
    }

    // 真值：轮1 切到 t2（06-10）sliced_more；轮2 wm=t2 → 首片 t3@06-11 → dayBound06-11=t4 → 切到 t4 sliced_more；
    //       轮3 wm=t4 → 首片 t5@06-12 → dayBound06-12=t6=target → 不跨天 → reviewed。
    expect(outcomes).toEqual(["sliced_more", "sliced_more", "reviewed"]);
    expect(wms).toEqual(["t2", "t4", "t6"]); // 严格单调逐天推进
    expect(reviewOccurredDays(db, "s1")).toEqual(["2026-06-10", "2026-06-11", "2026-06-12"]);
    expect(qstatus(db, "s1")).toBe("done");
    // 再 drain 一轮：无 pending（不再 requeue、不死循环）
    expect(takeNextPending(db, clock)).toBeNull();
  });
});

describe("契约 F — center 路零回归（ANIMA_DAYSPLIT 未设）", () => {
  beforeEach(() => setDaysplit(false));

  test("F: 跨午夜会话一次整段复盘到 item.target、不切、单条自评、occurred_at 取重心夜（非首片日）", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    // 重心夜＝活动最多那天。让 06-11 有 3 条、06-10 有 1 条 → 重心夜 06-11。
    const CENTER: Turn[] = [
      { uuid: "c1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "06-10 只有一条。" },
      { uuid: "c2", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "06-11 第一条。" },
      { uuid: "c3", ts: "2026-06-10T18:00:00.000Z", role: "assistant", text: "06-11 第二条。" },
      { uuid: "c4", ts: "2026-06-10T19:00:00.000Z", role: "user", text: "06-11 第三条。" },
    ];
    const path = writeTranscript(dir, "s1", CENTER);
    const clock = frozenClock("2026-06-12T05:00:00.000Z");
    const item = enqueueAndTake(db, "s1", path, "c4", clock);
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock });

    // center 路：sliceTarget=c4，crossedDay=false，整段一次复盘 → reviewed、wm=c4、单条。
    expect(out).toBe("reviewed");
    expect(calls.n).toBe(1);
    expect(reviewRows(db, "s1").length).toBe(1);
    expect(readWatermark(db, "s1")).toBe("c4");
    expect(qstatus(db, "s1")).toBe("done");
    // occurred_at 取重心夜（06-11，活动最多），不是首片日 06-10。
    // 注：captureTranscript 会把这些回合写进 situation_log（kind=user_message/assistant?），
    //    sessionCenterNight 据 situation_log 算。06-11 有 c2/c3/c4（3 条）> 06-10 的 c1（1 条）→ 重心夜 06-11。
    expect(reviewOccurredDays(db, "s1")).toEqual(["2026-06-11"]);
  });

  test("F2: center 路 lostRace 直接 covered（不走 finalizeRaceLost 的逐日核覆盖）— 旧行为逐字不变", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", CROSS);
    const clock = frozenClock("2026-06-12T05:00:00.000Z");
    const item = enqueueAndTake(db, "s1", path, "u4", clock);
    // 赢家在 worker readWatermark 之后、storeSelfReviewResult 之前只推到 u2（未覆盖 target u4）。
    let raced = false;
    const llm = async () => {
      if (!raced) {
        raced = true;
        casWatermark(db, "s1", null, "u2", "2026-06-10T03:00:00.000Z", null);
      }
      return JSON.stringify({ review: "x", feeling: "", intensity: "", keywords: ["x"], items: [] });
    };
    const out = await processReviewItem(db, item, { llm, clock });
    // center 路：storeSelfReviewResult lostRace → 直接 markReviewDone → covered（即便赢家没覆盖到 target u4，
    //   也按旧行为收尾——这是 §3.4 明文「center 路不走抢输验覆盖」的零回归点）。
    expect(out).toBe("covered");
    expect(qstatus(db, "s1")).toBe("done");
  });
});

describe("逻辑漏洞探测 — crosses 判据边界 + unsafe 路径", () => {
  beforeEach(() => setDaysplit(true));

  // 边界1：目标恰等于日界（target == dayBound(首片日)）→ 不应跨天（dbIdx == tgtIdx，dbIdx<tgtIdx 为 false）。
  test("边界: target 恰等于 dayBound(首片日) → 不跨天、一次复盘到 target、occurred_at=该日", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    // 全在 06-10：a1@01,a2@02,a3@03（都 <06-10T16Z）。dayBound(06-10)=a3=末条。target=a3。
    const SAME: Turn[] = [
      { uuid: "a1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "全在一天。" },
      { uuid: "a2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "继续。" },
      { uuid: "a3", ts: "2026-06-10T03:00:00.000Z", role: "user", text: "收尾。" },
    ];
    const path = writeTranscript(dir, "s1", SAME);
    const clock = frozenClock("2026-06-10T05:00:00.000Z");
    const item = enqueueAndTake(db, "s1", path, "a3", clock);
    const { llm } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock });
    expect(out).toBe("reviewed"); // dbIdx(a3)=2 不 < tgtIdx(a3)=2 → 不跨天
    expect(readWatermark(db, "s1")).toBe("a3");
    expect(reviewOccurredDays(db, "s1")).toEqual(["2026-06-10"]);
  });

  // 边界2：target 不可见 + 当天已收口（dayBound 不在快照末条）→ 应安全切日界、余段下轮（不把未收口当天截半）。
  // 构造：快照有 06-10 两条 + 06-11 一条；target=未来不可见 uX；首片日 06-10，dayBound06-10 不是末条 → crosses（保守路成立）。
  test("边界: target 不可见但当天已收口（dayBound 后快照仍有内容）→ 安全切日界 sliced_more、不截半当天", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", CROSS); // u1,u2(06-10) + u3,u4(06-11)
    const clock = frozenClock("2026-06-11T18:00:00.000Z");
    // target=uX 不在快照（live 还没落地），但快照里 06-10 已收口（dayBound u2 后还有 u3/u4）。
    const item = enqueueAndTake(db, "s1", path, "uX", clock);
    const { llm } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock });
    // tgtIdx<0 → crosses = dbIdx>=0 && dbIdx < len-1。dbIdx(u2)=1 < 3 → true → 切到 u2、sliced_more。
    expect(out).toBe("sliced_more");
    expect(readWatermark(db, "s1")).toBe("u2");
    expect(reviewOccurredDays(db, "s1")).toEqual(["2026-06-10"]);
    expect(qstatus(db, "s1")).toBe("pending");
  });

  // 边界3：target 不可见且当天**未收口**（首片日就是快照最后一天、dayBound=末条）→ 保守不切，
  //   走 buildIncrementalMaterial 的 target_not_visible（绝不把未收口当天截半、绝不烧 LLM）。
  test("边界: target 不可见且当天未收口（dayBound=快照末条）→ 保守 target_not_visible、不切、不烧 LLM", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    // 全在 06-11（都 >=06-10T16Z、<06-11T16Z）：b1@17,b2@18,b3@19。dayBound(06-11)=b3=末条。
    const TODAY_OPEN: Turn[] = [
      { uuid: "b1", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "今天还在进行。" },
      { uuid: "b2", ts: "2026-06-10T18:00:00.000Z", role: "assistant", text: "继续。" },
      { uuid: "b3", ts: "2026-06-10T19:00:00.000Z", role: "user", text: "还没收工。" },
    ];
    const path = writeTranscript(dir, "s1", TODAY_OPEN);
    const clock = frozenClock("2026-06-11T05:00:00.000Z");
    const item = enqueueAndTake(db, "s1", path, "bX", clock); // bX 不可见
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock });
    // 首片日 06-11，dayBound(06-11)=b3=末条(len-1)。tgtIdx<0 → crosses = dbIdx>=0 && dbIdx<len-1 = (2<2)=false
    //   → 不切（保守）→ sliceTarget=item.target=bX → buildIncrementalMaterial target 不可见 → target_not_visible。
    expect(out).toBe("target_not_visible");
    expect(calls.n).toBe(0); // 绝不烧 LLM
    expect(readWatermark(db, "s1")).toBeNull(); // 不推水位线
    expect(qstatus(db, "s1")).toBe("pending");
    expect(qattempts(db, "s1")).toBe(0);
    expect(reviewRows(db, "s1").length).toBe(0);
  });
});
