// worker 处理单条 processReviewItem（DESIGN-WORKER-RESUME §4.3）：读水位线 → 单读+采集 → 单调守卫 →
// 增量切到 target → 生成（注入 LLM、事务外）→ 水位线 CAS 落库 → 标 done CAS / 翻 pending / 失败熔断。
// 复用 makeup 同批原语（buildIncrementalMaterial/generateSelfReview/storeSelfReviewResult/advanceWatermarkOnly）。
// 坐实：reviewed / target 不可见→requeue 无 attempt / 空增量→covered / 生成失败→熔断(不写自评·不推水位线) /
//   lostRace（makeup 抢先）→covered / target 处理期间变了→翻 pending / 水位线超前快照→requeue。

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { enqueueReview, takeNextPending, type WorkItem } from "../src/workQueue";
import { readWatermark, casWatermark } from "../src/watermark";
import { storeSelfReviewResult, type GeneratedSelfReview, type Material } from "../src/selfReview";
import { processReviewItem, drainQueue, runWorker } from "../src/worker";

const NOW = frozenClock("2026-06-10T05:00:00.000Z");

const tmpDirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "anima-wproc-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string; isMeta?: boolean };
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
      isMeta: t.isMeta ?? false,
      message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
const TURNS: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "把权限回归测试修好。" },
  { uuid: "u2", ts: "2026-06-10T01:05:00.000Z", role: "assistant", text: "好，先看鉴权 mock。" },
  { uuid: "u3", ts: "2026-06-10T01:10:00.000Z", role: "user", text: "顺手配色先别改，等我确认。" },
];
function goodLlm() {
  const calls = { n: 0 };
  const llm = async () => {
    calls.n++;
    return JSON.stringify({
      review: "增量复盘：修权限测试、配色待确认。",
      feeling: "踏实",
      intensity: "中",
      keywords: ["权限"],
      items: [],
    });
  };
  return { llm, calls };
}
function reviewCount(db: Database, sid: string): number {
  return (
    db.query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=?").get(sid) as {
      c: number;
    }
  ).c;
}
function qstatus(db: Database, sid: string): string | undefined {
  return (db.query("SELECT status FROM work_queue WHERE session_id=? AND kind='self_review'").get(sid) as { status: string } | null)?.status;
}
/** 入队 + 取活，返回 processing 的 WorkItem */
function enqueueAndTake(db: Database, sid: string, path: string, target: string): WorkItem {
  enqueueReview(db, { sessionId: sid, transcriptPath: path, targetUuid: target }, NOW);
  return takeNextPending(db, NOW)!;
}

describe("worker processReviewItem", () => {
  test("正常：增量复盘 → 写自评 + 推水位线 + 队列 done", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS);
    const item = enqueueAndTake(db, "s1", path, "u3");
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: NOW });
    expect(out).toBe("reviewed");
    expect(calls.n).toBe(1);
    expect(reviewCount(db, "s1")).toBe(1);
    expect(readWatermark(db, "s1")).toBe("u3");
    expect(qstatus(db, "s1")).toBe("done");
  });

  test("stale item（target 早于当前水位线）→ covered，绝不回退水位线（codex ④：makeup/reclaim 推 wm 后处理旧 item）", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS); // u1,u2,u3
    // 入队一条 stale item，target=u2（会话 Stop@u2 时入队）
    const item = enqueueAndTake(db, "s1", path, "u2");
    // 之后 makeup（daysplit 走 dayBound 水位线）/ reclaim 重跑 / 别的 worker 把水位线推到了 u3（> u2）
    casWatermark(db, "s1", null, "u3", "2026-06-10T04:00:00.000Z", null);

    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: NOW });
    // 水位线已越过 target → 视同已覆盖，直接收尾；绝不因空切片 advanceWatermarkOnly(u3→u2) 把水位线拉回
    expect(out).toBe("covered");
    expect(calls.n).toBe(0); // 不烧 LLM
    expect(readWatermark(db, "s1")).toBe("u3"); // 绝不回退到 u2
    expect(reviewCount(db, "s1")).toBe(0); // 不产生重复自评
    expect(qstatus(db, "s1")).toBe("done");
  });

  test("target 不可见（不在本进程文件视图）→ requeue pending、不烧 LLM、不推水位线、不计 attempt", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS);
    // 入队 target=u9（transcript 里没有 u9，模拟 target 还没落到 worker 文件视图）
    const item = enqueueAndTake(db, "s1", path, "u9");
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: NOW });
    expect(out).toBe("target_not_visible");
    expect(calls.n).toBe(0); // 绝不烧 LLM
    expect(reviewCount(db, "s1")).toBe(0);
    expect(readWatermark(db, "s1")).toBeNull(); // 不推水位线
    expect(qstatus(db, "s1")).toBe("pending"); // 退回 pending 等下轮
    expect((db.query("SELECT attempts a FROM work_queue WHERE session_id='s1'").get() as { a: number }).a).toBe(0);
  });

  test("空增量（target==水位线，无新内容）→ 不烧 LLM、队列 done（covered）", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS);
    // 先把水位线设到 u3（已覆盖到末尾）
    db.query("INSERT INTO review_watermark(session_id,last_uuid,updated_at) VALUES('s1','u3','2026-06-10T02:00:00Z')").run();
    const item = enqueueAndTake(db, "s1", path, "u3");
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: NOW });
    expect(out).toBe("covered");
    expect(calls.n).toBe(0);
    expect(reviewCount(db, "s1")).toBe(0);
    expect(qstatus(db, "s1")).toBe("done");
  });

  test("生成失败 → 熔断计 attempt（不写自评、不推水位线、不标 done）", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS);
    const item = enqueueAndTake(db, "s1", path, "u3");
    const failingLlm = async () => {
      throw new Error("额度撞墙");
    };
    const out = await processReviewItem(db, item, { llm: failingLlm, clock: NOW, maxAttempts: 2 });
    expect(out).toBe("failed");
    expect(reviewCount(db, "s1")).toBe(0); // 不写自评
    expect(
      (db.query("SELECT count(*) c FROM experiences WHERE kind='self_review_fallback' AND source_session='s1'").get() as { c: number }).c,
    ).toBe(0); // 也不写兜底壳（worker 留待重试，壳是 makeup 的活）
    expect(readWatermark(db, "s1")).toBeNull(); // 不推水位线
    expect(qstatus(db, "s1")).toBe("pending"); // attempts=1 < 2 → 留 pending 重试
  });

  test("lostRace（makeup 抢先覆盖同段）→ covered，队列 done，不重复写", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS);
    const item = enqueueAndTake(db, "s1", path, "u3");
    // 模拟 makeup 抢先：从无水位线 → 写了一条自评并把水位线推到 u3
    storeSelfReviewResult(
      db,
      { ok: true, attempts: 1, value: { review: "makeup 抢先写的复盘", feeling: "", intensity: "", keywords: ["x"], items: [] } } as GeneratedSelfReview,
      {
        material: { sessionId: "s1", project: "p", conversation: ["用户：x"], events: [], bookmarks: [], evidenceText: "x" } as Material,
        clock: NOW,
        advanceWatermark: { oldUuid: null, newUuid: "u3", entries: null },
      },
    );
    expect(reviewCount(db, "s1")).toBe(1);
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: NOW });
    expect(out).toBe("covered"); // worker 发现水位线已到 u3，无活
    expect(calls.n).toBe(0);
    expect(reviewCount(db, "s1")).toBe(1); // 没重复写
    expect(qstatus(db, "s1")).toBe("done");
  });

  test("处理期间 target 被入队更新（resume 又来）→ 标 done CAS 落空 → 翻回 pending", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS);
    const item = enqueueAndTake(db, "s1", path, "u3"); // worker 处理 u3
    // 处理中又入队（resume），target→u3b（用一个 transcript 里没有的更新 target 即可触发 CAS 落空）
    enqueueReview(db, { sessionId: "s1", transcriptPath: path, targetUuid: "u3b" }, frozenClock("2026-06-10T05:30:00.000Z"));
    const { llm } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: NOW });
    expect(out).toBe("requeued_target"); // 处理的是 u3，但 target 已是 u3b
    expect(qstatus(db, "s1")).toBe("pending"); // 翻回 pending 等下轮处理 u3b
  });
});

describe("worker drainQueue（清一轮）", () => {
  test("多会话各处理一次；target 不可见的 requeue 不在本轮忙转重取", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const p1 = writeTranscript(dir, "s1", TURNS);
    const p2 = writeTranscript(dir, "s2", TURNS);
    const p3 = writeTranscript(dir, "s3", TURNS);
    enqueueReview(db, { sessionId: "s1", transcriptPath: p1, targetUuid: "u3" }, NOW);
    enqueueReview(db, { sessionId: "s2", transcriptPath: p2, targetUuid: "u9" }, NOW); // u9 不可见 → requeue
    enqueueReview(db, { sessionId: "s3", transcriptPath: p3, targetUuid: "u3" }, NOW);

    const { llm, calls } = goodLlm();
    const r = await drainQueue(db, { llm, clock: NOW });

    expect(r.processed).toBe(3); // 三会话各处理一次（s2 也"处理"了，只是判定 target 不可见）
    expect(r.advanced).toBe(2); // 只 s1 s3 实质前进（净缩队列）；s2 requeue 不算前进（codex F4 主循环据此退避不空转）
    expect(r.outcomes.reviewed).toBe(2); // s1 s3
    expect(r.outcomes.target_not_visible).toBe(1); // s2
    expect(calls.n).toBe(2); // 只 s1 s3 烧了 LLM；s2 没烧、也没被本轮重取忙转
    expect(qstatus(db, "s1")).toBe("done");
    expect(qstatus(db, "s3")).toBe("done");
    expect(qstatus(db, "s2")).toBe("pending"); // requeue 留到下次唤醒
    expect(readWatermark(db, "s1")).toBe("u3");
    expect(readWatermark(db, "s3")).toBe("u3");
  });

  test("空队列 → processed 0", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const { llm } = goodLlm();
    const r = await drainQueue(db, { llm, clock: NOW });
    expect(r.processed).toBe(0);
  });

  // codex F4：卡住的 requeue 行（target 永不可见）+ idle=0 绝不能 tight-loop。若有 bug 本测试会超时失败。
  test("F4: 卡住的 requeue + idle=0 → 不 tight-loop、正常自退、不烧 LLM、行留 pending", async () => {
    const dir = tmp();
    const dbPath = join(dir, "anima.db");
    const db = openDb(dbPath);
    const path = writeTranscript(dir, "s1", TURNS);
    enqueueReview(db, { sessionId: "s1", transcriptPath: path, targetUuid: "u-never-visible" }, NOW);
    db.close();
    const { llm, calls } = goodLlm();
    const r = await runWorker({ dbPath, dataDir: dir, llm, clock: NOW, now: new Date("2026-06-10T05:00:00.000Z"), idleExitMs: 0, pollMs: 0 });
    expect(r.reason).toBe("idle_exit"); // 正常自退（没 tight-loop / 没卡死）
    expect(r.processed).toBe(1); // drain 确实跑过一次（取活 s1 → 判 target 不可见 → requeue），非空退
    expect(calls.n).toBe(0); // target 不可见 → 不烧 LLM
    const db2 = openDb(dbPath);
    expect((db2.query("SELECT status s FROM work_queue WHERE session_id='s1'").get() as { s: string }).s).toBe("pending"); // 留 pending，夜跑兜底
    db2.close();
  }, 10_000);

  // F4/F5 救援分支：idle 退出窗口里 pending **涨了**（真新会话入队）→ 收回退出、续清。用 onBeforeIdleCheck 注入点
  // 在"最后 pending 检查"前真入队，确定性命中救援分支（codex 测试缺口2：预载不算命中该分支）。
  test("F4/F5: idle 窗口里冒出真新会话（pending 涨）→ 收回退出、续清（命中救援分支）", async () => {
    const dir = tmp();
    const dbPath = join(dir, "anima.db");
    const path = writeTranscript(dir, "s-new", TURNS);
    const injector = openDb(dbPath); // 独立连接，模拟"另一轮 Stop 在 idle 窗口入队"
    let injected = false;
    const { llm, calls } = goodLlm();
    const r = await runWorker({
      dbPath,
      dataDir: dir,
      llm,
      clock: NOW,
      now: new Date("2026-06-10T05:00:00.000Z"),
      idleExitMs: 0,
      pollMs: 0,
      onBeforeIdleCheck: () => {
        if (injected) return; // 一次性：只在首个 idle 检查前注入
        injected = true;
        enqueueReview(injector, { sessionId: "s-new", transcriptPath: path, targetUuid: "u3" }, NOW);
      },
    });
    injector.close();
    expect(r.reason).toBe("idle_exit");
    expect(calls.n).toBe(1); // 救援后那一轮把新会话复盘了
    const db2 = openDb(dbPath);
    expect((db2.query("SELECT status s FROM work_queue WHERE session_id='s-new'").get() as { s: string }).s).toBe("done");
    expect((db2.query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session='s-new'").get() as { c: number }).c).toBe(1);
    db2.close();
  }, 10_000);

  test("shouldAbort（worker 停止中）→ 不再 spawn LLM、requeue 不计 attempt（codex F6）", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", TURNS);
    const item = enqueueAndTake(db, "s1", path, "u3");
    const { llm, calls } = goodLlm();
    const out = await processReviewItem(db, item, { llm, clock: NOW, shouldAbort: () => true });
    expect(out).toBe("aborted");
    expect(calls.n).toBe(0); // 停止中绝不再起 claude
    expect(reviewCount(db, "s1")).toBe(0);
    expect(qstatus(db, "s1")).toBe("pending"); // 原样留 pending 交下个 worker
    expect((db.query("SELECT attempts a FROM work_queue WHERE session_id='s1'").get() as { a: number }).a).toBe(0); // 不计 attempt
  });
});
