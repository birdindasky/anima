// worker 待办板 work_queue 的读写（DESIGN-WORKER-RESUME §4.2/§4.3 + §v5.7 S-4/I-10）。
// experiences 才是唯一真相源；work_queue 只是 worker "处理到哪了" 的私有操作账。
// 坐实：① 入队 upsert（新行/重复入队更 target/processing 不打断/failed 不复活·不清 attempts，S-4）；
//   ② 取活 FIFO + 标 processing；③ 标 done CAS（target 没变→done；processing 期间被入队更 target→翻 pending）；
//   ④ 失败 attempts++ 到顶标 failed、绝不标 done；⑤ 启动自清陈旧 processing。

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import {
  enqueueReview,
  takeNextPending,
  markReviewDone,
  recordReviewFailure,
  reclaimStaleProcessing,
  countPendingReviews,
} from "../src/workQueue";

const tmpDirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), "anima-wq-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function row(db: Database, sid: string) {
  return db
    .query("SELECT status, target_uuid, attempts, transcript_path, enqueued_at FROM work_queue WHERE session_id=? AND kind='self_review'")
    .get(sid) as
    | { status: string; target_uuid: string | null; attempts: number; transcript_path: string | null; enqueued_at: string }
    | null;
}

const C1 = frozenClock("2026-06-10T01:00:00.000Z");
const C2 = frozenClock("2026-06-10T02:00:00.000Z");

describe("work_queue 入队 upsert", () => {
  test("新会话 → pending、target/path 记下、attempts=0", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/s1.jsonl", targetUuid: "u5" }, C1);
    const r = row(db, "s1")!;
    expect(r.status).toBe("pending");
    expect(r.target_uuid).toBe("u5");
    expect(r.transcript_path).toBe("/p/s1.jsonl");
    expect(r.attempts).toBe(0);
  });

  test("重复入队（pending）→ 只更 target/path 到最新，仍 pending", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u5" }, C1);
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/b.jsonl", targetUuid: "u9" }, C2);
    const r = row(db, "s1")!;
    expect(r.status).toBe("pending");
    expect(r.target_uuid).toBe("u9"); // 更到最新
    expect(r.transcript_path).toBe("/p/b.jsonl"); // I-10：path 也刷
  });

  test("processing 行重复入队 → 保持 processing、更 target、enqueued_at 不刷（活性代理）", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u5" }, C1);
    takeNextPending(db, C1); // → processing，enqueued_at 记 C1
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u9" }, C2);
    const r = row(db, "s1")!;
    expect(r.status).toBe("processing"); // 没被打断
    expect(r.target_uuid).toBe("u9"); // target 更到最新（收尾 CAS 会发现并再转）
    expect(r.enqueued_at).toBe("2026-06-10T01:00:00.000Z"); // 不刷，仍是取活时刻
  });

  test("failed 行重复入队 → 保持 failed、不复活、不清 attempts（S-4 防每轮烧 haiku）", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u5" }, C1);
    takeNextPending(db, C1);
    recordReviewFailure(db, "s1", 1); // maxAttempts=1 → 立即 failed，attempts=1
    expect(row(db, "s1")!.status).toBe("failed");
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u9" }, C2);
    const r = row(db, "s1")!;
    expect(r.status).toBe("failed"); // 不复活成 pending
    expect(r.attempts).toBe(1); // 不清零
    expect(r.target_uuid).toBe("u9"); // 但记下最新意图（供观测/将来）
  });
});

describe("work_queue 取活 / 标 done / 失败 / 自清", () => {
  test("取活 FIFO（最早 enqueued_at 先）+ 标 processing", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "early", transcriptPath: "/p/e.jsonl", targetUuid: "u1" }, C1);
    enqueueReview(db, { sessionId: "late", transcriptPath: "/p/l.jsonl", targetUuid: "u1" }, C2);
    const item = takeNextPending(db, C2);
    expect(item?.sessionId).toBe("early"); // FIFO
    expect(row(db, "early")!.status).toBe("processing");
    expect(row(db, "late")!.status).toBe("pending");
    expect(item?.targetUuid).toBe("u1");
    expect(item?.transcriptPath).toBe("/p/e.jsonl");
  });

  test("空队列取活 → null", () => {
    expect(takeNextPending(tmpDb(), C1)).toBeNull();
  });

  test("标 done：target 没变 → done", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u5" }, C1);
    takeNextPending(db, C1);
    const r = markReviewDone(db, "s1", "u5");
    expect(r.requeued).toBe(false);
    expect(row(db, "s1")!.status).toBe("done");
  });

  test("标 done：processing 期间被入队更新 target → CAS 落空 → 翻回 pending 当轮重取", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u5" }, C1);
    takeNextPending(db, C1); // 取活，处理 u5
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u9" }, C2); // resume 又来，target→u9
    const r = markReviewDone(db, "s1", "u5"); // worker 收尾，处理的是 u5
    expect(r.requeued).toBe(true); // target 已是 u9 ≠ u5 → 翻 pending
    const after = row(db, "s1")!;
    expect(after.status).toBe("pending");
    expect(after.target_uuid).toBe("u9");
  });

  test("失败：attempts++ 未到顶 → 留 pending 重试；到顶 → failed，绝不 done", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/p/a.jsonl", targetUuid: "u5" }, C1);
    takeNextPending(db, C1);
    const r1 = recordReviewFailure(db, "s1", 2);
    expect(r1.failed).toBe(false);
    expect(row(db, "s1")!.status).toBe("pending");
    expect(row(db, "s1")!.attempts).toBe(1);
    takeNextPending(db, C1); // 重取
    const r2 = recordReviewFailure(db, "s1", 2);
    expect(r2.failed).toBe(true);
    expect(row(db, "s1")!.status).toBe("failed");
    expect(row(db, "s1")!.attempts).toBe(2);
  });

  test("启动自清：陈旧 processing（超 staleMs）→ 回 pending；新鲜的不动", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "stale", transcriptPath: "/p/s.jsonl", targetUuid: "u1" }, frozenClock("2026-06-10T00:00:00.000Z"));
    takeNextPending(db, frozenClock("2026-06-10T00:00:00.000Z")); // processing，enqueued_at=00:00
    enqueueReview(db, { sessionId: "fresh", transcriptPath: "/p/f.jsonl", targetUuid: "u1" }, frozenClock("2026-06-10T02:55:00.000Z"));
    takeNextPending(db, frozenClock("2026-06-10T02:55:00.000Z")); // processing，enqueued_at=02:55
    // now=03:00，staleMs=10min → cutoff=02:50：stale(00:00)<02:50 回收，fresh(02:55)>02:50 不动
    const n = reclaimStaleProcessing(db, { staleMs: 10 * 60_000, clock: frozenClock("2026-06-10T03:00:00.000Z") });
    expect(n).toBe(1);
    expect(row(db, "stale")!.status).toBe("pending");
    expect(row(db, "fresh")!.status).toBe("processing");
  });

  test("countPendingReviews：只数 pending", () => {
    const db = tmpDb();
    enqueueReview(db, { sessionId: "a", transcriptPath: null, targetUuid: "u1" }, C1);
    enqueueReview(db, { sessionId: "b", transcriptPath: null, targetUuid: "u1" }, C1);
    takeNextPending(db, C1); // a → processing
    expect(countPendingReviews(db)).toBe(1); // 只剩 b
  });
});
