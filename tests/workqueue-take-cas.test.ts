// AUDIT-2026-07-01 盘点 U41：取活 UPDATE 缺 AND status='pending'。
// 单 worker 下 SELECT+UPDATE 裹同步事务、竞态窗口在进程内不可达（红灯构造不出来）——
// 本文件钉的是**新契约**：取活收成单条 `UPDATE … WHERE … AND status='pending' RETURNING`，
// 谓词进语句本身，多 worker 化/跨进程并发时也原子；对非 pending 行取活必须 null 且一字不改。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import {
  enqueueReview,
  takeNextPending,
  takeSessionReview,
  markReviewDone,
  requeueReview,
} from "../src/workQueue";
import { frozenClock } from "../src/clock";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-wq-${process.pid}-${n++}.db`));
const clk = frozenClock("2026-06-10T12:00:00.000Z");

const statusOf = (db: ReturnType<typeof freshDb>, sid: string) =>
  (db.query("SELECT status FROM work_queue WHERE session_id = ? AND kind = 'self_review'").get(sid) as { status: string } | null)
    ?.status;

describe("U41 取活单语句 CAS（status 谓词进 UPDATE）", () => {
  test("pending 行：取活成功 → processing，二次取活 → null", () => {
    const db = freshDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/t.jsonl", targetUuid: "u9" }, clk);
    const item = takeSessionReview(db, "s1");
    expect(item?.sessionId).toBe("s1");
    expect(item?.targetUuid).toBe("u9");
    expect(statusOf(db, "s1")).toBe("processing");
    expect(takeSessionReview(db, "s1")).toBeNull();
  });

  test("processing 行：takeSessionReview → null 且状态一字不改", () => {
    const db = freshDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/t.jsonl", targetUuid: "u9" }, clk);
    takeSessionReview(db, "s1");
    expect(takeSessionReview(db, "s1")).toBeNull();
    expect(statusOf(db, "s1")).toBe("processing");
  });

  test("done 行：两个取活口都 null，done 不被改写", () => {
    const db = freshDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: "/t.jsonl", targetUuid: "u9" }, clk);
    takeSessionReview(db, "s1");
    markReviewDone(db, "s1", "u9");
    expect(statusOf(db, "s1")).toBe("done");
    expect(takeSessionReview(db, "s1")).toBeNull();
    expect(takeNextPending(db)).toBeNull();
    expect(statusOf(db, "s1")).toBe("done");
  });

  test("takeNextPending：FIFO 取最早 pending，跳过 processing", () => {
    const db = freshDb();
    enqueueReview(db, { sessionId: "sA", transcriptPath: null, targetUuid: "a1" }, frozenClock("2026-06-10T10:00:00.000Z"));
    enqueueReview(db, { sessionId: "sB", transcriptPath: null, targetUuid: "b1" }, frozenClock("2026-06-10T11:00:00.000Z"));
    expect(takeNextPending(db)?.sessionId).toBe("sA"); // 最早
    expect(takeNextPending(db)?.sessionId).toBe("sB"); // sA 已 processing，取下一个
    expect(takeNextPending(db)).toBeNull();
  });

  test("requeue → 可再取（processing→pending→取活循环不破）", () => {
    const db = freshDb();
    enqueueReview(db, { sessionId: "s1", transcriptPath: null, targetUuid: "u9" }, clk);
    takeSessionReview(db, "s1");
    requeueReview(db, "s1");
    expect(statusOf(db, "s1")).toBe("pending");
    expect(takeSessionReview(db, "s1")?.sessionId).toBe("s1");
  });
});
