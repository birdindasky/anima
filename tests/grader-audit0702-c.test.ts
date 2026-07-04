// 独立验收考官（刀C / AUDIT-2026-07-01）——U28 水位线防回退守卫 + U41 workQueue 取活 status 谓词。
// 本文件由考官独立设计，绝不复用被验代码自带的测试。真临时库（openDb 全量 schema），绝不碰生产库。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { advanceWatermarkOnly, casWatermark, readWatermark, type WatermarkOrder } from "../src/watermark";
import {
  countPendingReviews,
  enqueueReview,
  listPendingSessions,
  markReviewDone,
  recordReviewFailure,
  requeueReview,
  takeNextPending,
  takeSessionReview,
} from "../src/workQueue";
import { frozenClock } from "../src/clock";

let dir: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-grader-c-"));
  db = openDb(join(dir, "anima.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 真 transcript 条目形状（uuid 之外还带 type/timestamp）——确认 findIndex(e=>e.uuid) 对真结构可用。
function ord(...uuids: string[]): WatermarkOrder {
  return uuids.map((u, i) => ({ uuid: u, type: "user", timestamp: `2026-07-02T00:0${i}:00.000Z` }));
}
const ORDER = ord("e0", "e1", "e2", "e3"); // 单调序：e0<e1<e2<e3
function wmRow(sid: string) {
  return db.query("SELECT last_uuid AS u, updated_at AS at FROM review_watermark WHERE session_id=?").get(sid) as
    | { u: string; at: string }
    | null;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("U28 水位线 CAS 防回退守卫", () => {
  test("核心：old/new 都可见且 new 严格早于 old → 拒绝且一行不写", () => {
    expect(casWatermark(db, "s", null, "e2", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true); // 播到 e2
    const before = wmRow("s");
    // 回退推进 e2→e1（e1 早于 e2）：必须拒绝
    expect(casWatermark(db, "s", "e2", "e1", "2026-07-02T11:00:00.000Z", ORDER)).toBe(false);
    // 一行不写：last_uuid 与 updated_at 全不变（连 no-op 写都没有）
    expect(wmRow("s")).toEqual(before);
    expect(before?.u).toBe("e2");
  });

  test("advanceWatermarkOnly 同样受守卫（worker/digest 真调的就是它）", () => {
    expect(casWatermark(db, "ao", null, "e2", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    const before = wmRow("ao");
    const clock = frozenClock("2026-07-02T11:00:00.000Z");
    expect(advanceWatermarkOnly(db, "ao", "e2", "e1", ORDER, clock)).toBe(false);
    expect(wmRow("ao")).toEqual(before); // 回退被挡、时间戳不动
  });

  test("漏传 order（undefined）必 throw——增量路 + 首评路都炸，绝不静默跳守卫", () => {
    const casLoose = casWatermark as unknown as (...a: unknown[]) => boolean;
    const advLoose = advanceWatermarkOnly as unknown as (...a: unknown[]) => boolean;
    // 增量路（old 非 null）
    expect(() => casLoose(db, "u", "e2", "e1", "2026-07-02T10:00:00.000Z")).toThrow(/序见证/);
    expect(() => casLoose(db, "u", "e2", "e1", "2026-07-02T10:00:00.000Z", undefined)).toThrow(/序见证/);
    // 首评路（old===null）也必炸：undefined 检查在 oldUuid===null 短路之前
    expect(() => casLoose(db, "u", null, "e0", "2026-07-02T10:00:00.000Z")).toThrow(/序见证/);
    // advanceWatermarkOnly 省略 order（第 5 位）→ undefined → 炸
    expect(() => advLoose(db, "u", "e2", "e1")).toThrow(/序见证/);
    // 炸完一行未写
    expect(wmRow("u")).toBeNull();
  });

  test("见证 = null → 显式弃权（旧宽松行为）：回退照写", () => {
    expect(casWatermark(db, "w", null, "e2", "2026-07-02T10:00:00.000Z", null)).toBe(true);
    // null 弃权下回退 e2→e1 不被挡（守卫 opt-in，命门在见证质量）
    expect(casWatermark(db, "w", "e2", "e1", "2026-07-02T11:00:00.000Z", null)).toBe(true);
    expect(readWatermark(db, "w")).toBe("e1");
  });

  test("合法 resume：old 不在见证序里 → 不误杀（换 transcript 场景）", () => {
    expect(casWatermark(db, "r", null, "e2", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    // 换了一份 transcript，见证是 [x0,x1]，old=e2 不在里面 → 放行，推到 x1
    const other = ord("x0", "x1");
    expect(casWatermark(db, "r", "e2", "x1", "2026-07-02T11:00:00.000Z", other)).toBe(true);
    expect(readWatermark(db, "r")).toBe("x1");
  });

  test("old==new 不是回退（new 非严格早于 old）→ 放行", () => {
    expect(casWatermark(db, "eq", null, "e2", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    expect(casWatermark(db, "eq", "e2", "e2", "2026-07-02T11:00:00.000Z", ORDER)).toBe(true);
    expect(readWatermark(db, "eq")).toBe("e2");
  });

  test("正常前进（new 晚于 old）→ 放行，happy path 零回归", () => {
    expect(casWatermark(db, "fw", null, "e1", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    expect(casWatermark(db, "fw", "e1", "e3", "2026-07-02T11:00:00.000Z", ORDER)).toBe(true);
    expect(readWatermark(db, "fw")).toBe("e3");
  });

  test("部分/空见证 → 无从证明序 → 放行（spec: 任一不可见即弃权，靠调用方 atOrAfter 兜）", () => {
    // 空见证：old/new 都不可见 → 放行（会真回退，暴露"守卫只是 provable-rollback 的兜底"）
    expect(casWatermark(db, "a", null, "e2", "2026-07-02T10:00:00.000Z", ord())).toBe(true);
    expect(casWatermark(db, "a", "e2", "e1", "2026-07-02T11:00:00.000Z", ord())).toBe(true);
    expect(readWatermark(db, "a")).toBe("e1"); // 空见证不设防（符合 spec）

    // 只含 new：old 不可见 → 放行
    expect(casWatermark(db, "b", null, "e2", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    expect(casWatermark(db, "b", "e2", "e1", "2026-07-02T11:00:00.000Z", ord("e1"))).toBe(true);
    expect(readWatermark(db, "b")).toBe("e1");

    // 只含 old：new 不可见 → 放行（无从证明 new 更早）
    expect(casWatermark(db, "c", null, "e2", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    expect(casWatermark(db, "c", "e2", "e1", "2026-07-02T11:00:00.000Z", ord("e2"))).toBe(true);
    expect(readWatermark(db, "c")).toBe("e1");
  });

  test("首评 CAS 去重（并发首评第二个抢不到）——防回退不干扰既有 dedup", () => {
    expect(casWatermark(db, "cc", null, "e0", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    // 第二个首评：INSERT ON CONFLICT DO NOTHING → 抢不到
    expect(casWatermark(db, "cc", null, "e1", "2026-07-02T10:00:01.000Z", ORDER)).toBe(false);
    expect(readWatermark(db, "cc")).toBe("e0");
  });

  test("增量 CAS 去重（别人已推过 old→别处，我的 old 不再匹配）→ 抢不到", () => {
    expect(casWatermark(db, "d", null, "e0", "2026-07-02T10:00:00.000Z", ORDER)).toBe(true);
    expect(casWatermark(db, "d", "e0", "e1", "2026-07-02T10:00:01.000Z", ORDER)).toBe(true); // 别人推到 e1
    // 我拿着旧 old=e0 想推到 e2：WHERE last_uuid=e0 不匹配（现为 e1）→ 抢不到，且非回退（e2>e0）
    expect(casWatermark(db, "d", "e0", "e2", "2026-07-02T10:00:02.000Z", ORDER)).toBe(false);
    expect(readWatermark(db, "d")).toBe("e1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const KIND_SNAPSHOT = "SELECT session_id AS s, status, attempts AS a, target_uuid AS t, enqueued_at AS e FROM work_queue ORDER BY session_id";
function enq(sid: string, target: string | null, iso: string) {
  enqueueReview(db, { sessionId: sid, transcriptPath: `/t/${sid}.jsonl`, targetUuid: target }, frozenClock(iso));
}
function rowOf(sid: string) {
  return db
    .query("SELECT status, attempts AS a, target_uuid AS t FROM work_queue WHERE session_id=? AND kind='self_review'")
    .get(sid) as { status: string; a: number; t: string | null } | null;
}

describe("U41 workQueue 取活 status 谓词（跨进程并发硬前置）", () => {
  test("takeSessionReview：对 processing 行返回 null 且一字不改", () => {
    enq("s1", "T", "2026-07-02T00:00:00.000Z");
    const first = takeSessionReview(db, "s1");
    expect(first).toEqual({ sessionId: "s1", transcriptPath: "/t/s1.jsonl", targetUuid: "T", attempts: 0 });
    const snap = rowOf("s1");
    expect(snap?.status).toBe("processing");
    // 二次取活：已 processing → null，且行快照完全不变
    expect(takeSessionReview(db, "s1")).toBeNull();
    expect(rowOf("s1")).toEqual(snap);
  });

  test("takeSessionReview / takeNextPending：对 failed 行绝不取活", () => {
    enq("s2", "T", "2026-07-02T00:00:00.000Z");
    takeSessionReview(db, "s2"); // → processing
    const r = recordReviewFailure(db, "s2", 1); // attempts 1>=1 → failed
    expect(r.failed).toBe(true);
    expect(rowOf("s2")?.status).toBe("failed");
    const snap = rowOf("s2");
    expect(takeSessionReview(db, "s2")).toBeNull();
    expect(takeNextPending(db)).toBeNull(); // 唯一会话是 failed → 取不到
    expect(rowOf("s2")).toEqual(snap); // 状态 + attempts 全不变（S-4 不复活）
  });

  test("takeSessionReview / takeNextPending：对 done 行绝不取活", () => {
    enq("s3", "T", "2026-07-02T00:00:00.000Z");
    takeSessionReview(db, "s3");
    expect(markReviewDone(db, "s3", "T")).toEqual({ requeued: false });
    expect(rowOf("s3")?.status).toBe("done");
    const snap = rowOf("s3");
    expect(takeSessionReview(db, "s3")).toBeNull();
    expect(takeNextPending(db)).toBeNull();
    expect(rowOf("s3")).toEqual(snap);
  });

  test("原子性：谓词在 UPDATE 语句内——行被带外抢走（→processing）后取活立即 null（无 SELECT 陈旧窗口）", () => {
    enq("s4", "T", "2026-07-02T00:00:00.000Z");
    // 模拟"另一 worker 在我 SELECT 与 UPDATE 之间把它抢成 processing"：直接带外改状态
    db.query("UPDATE work_queue SET status='processing' WHERE session_id='s4' AND kind='self_review'").run();
    // 若取活靠外层事务缝 SELECT+UPDATE，陈旧读会误改；单条谓词 UPDATE 则当场判死 → null
    expect(takeSessionReview(db, "s4")).toBeNull();
    // takeNextPending 同理：带外先占，谓词挡下
    enq("s5", "T", "2026-07-02T00:00:01.000Z");
    db.query("UPDATE work_queue SET status='processing' WHERE session_id='s5' AND kind='self_review'").run();
    expect(takeNextPending(db)).toBeNull();
  });

  test("takeNextPending：FIFO 取最早 pending、跳过 processing、绝不双取", () => {
    enq("A", "Ta", "2026-07-02T00:00:00.000Z");
    enq("B", "Tb", "2026-07-02T00:00:01.000Z");
    enq("C", "Tc", "2026-07-02T00:00:02.000Z");
    const seen = [takeNextPending(db)?.sessionId, takeNextPending(db)?.sessionId, takeNextPending(db)?.sessionId];
    expect(seen).toEqual(["A", "B", "C"]); // 严格 FIFO
    expect(new Set(seen).size).toBe(3); // 无重复取
    expect(takeNextPending(db)).toBeNull(); // 全 processing → 无可取
  });

  test("takeNextPending：同 enqueued_at 用 session_id ASC 破平", () => {
    enq("sB", "Tb", "2026-07-02T00:00:00.000Z");
    enq("sA", "Ta", "2026-07-02T00:00:00.000Z"); // 同刻
    expect(takeNextPending(db)?.sessionId).toBe("sA"); // session_id 升序破平
    expect(takeNextPending(db)?.sessionId).toBe("sB");
  });

  test("takeNextPending：队列无 pending 时 null 且一字不改（0 行）", () => {
    enq("A", "Ta", "2026-07-02T00:00:00.000Z");
    takeNextPending(db); // A → processing
    const before = db.query(KIND_SNAPSHOT).all();
    expect(takeNextPending(db)).toBeNull();
    expect(db.query(KIND_SNAPSHOT).all()).toEqual(before); // 整表快照不变
  });

  test("requeue → 再取循环：无回归", () => {
    enq("A", "Ta", "2026-07-02T00:00:00.000Z");
    expect(takeNextPending(db)?.sessionId).toBe("A"); // processing
    requeueReview(db, "A"); // → pending，enqueued_at 不变
    expect(rowOf("A")?.status).toBe("pending");
    expect(takeNextPending(db)?.sessionId).toBe("A"); // 可被重取
    expect(rowOf("A")?.status).toBe("processing");
  });

  test("markReviewDone CAS 翻 pending 语义零回归：target 匹配→done / 变了→requeue 重取", () => {
    // (a) target 匹配 → done
    enq("X", "T1", "2026-07-02T00:00:00.000Z");
    takeSessionReview(db, "X"); // processing, T=T1
    expect(markReviewDone(db, "X", "T1")).toEqual({ requeued: false });
    expect(rowOf("X")?.status).toBe("done");

    // (b) 期间被 resume 改了 target → CAS 落空 → 翻 pending + attempts 清零 + 可重取
    enq("Y", "T1", "2026-07-02T00:00:01.000Z");
    const item = takeSessionReview(db, "Y"); // processing, 取活时 T=T1
    expect(item?.targetUuid).toBe("T1");
    enq("Y", "T2", "2026-07-02T00:00:02.000Z"); // resume：processing 保持、target→T2
    expect(rowOf("Y")).toEqual({ status: "processing", a: 0, t: "T2" });
    expect(markReviewDone(db, "Y", "T1")).toEqual({ requeued: true }); // 处理到的 T1 ≠ 现 T2
    expect(rowOf("Y")).toEqual({ status: "pending", a: 0, t: "T2" });
    expect(takeSessionReview(db, "Y")?.targetUuid).toBe("T2"); // 翻 pending 后可重取新 target
  });

  test("enqueue 幂等 × 取活：pending 重入不产生第二行、不双取；processing/failed 重入不复活", () => {
    // pending 重入：刷新 enqueued_at/target，仍单行
    enq("Z", "T1", "2026-07-02T00:00:00.000Z");
    enq("Z", "T2", "2026-07-02T00:00:05.000Z");
    expect(countPendingReviews(db)).toBe(1);
    expect(rowOf("Z")).toEqual({ status: "pending", a: 0, t: "T2" });

    // processing 重入（resume）：状态保持 processing、不回 pending → 不会被再取
    takeSessionReview(db, "Z"); // → processing
    enq("Z", "T3", "2026-07-02T00:00:06.000Z");
    expect(rowOf("Z")?.status).toBe("processing");
    expect(takeSessionReview(db, "Z")).toBeNull(); // processing 不重取
    expect(takeNextPending(db)).toBeNull();

    // failed 重入：不复活、不清 attempts（S-4）
    enq("W", "T", "2026-07-02T00:00:00.000Z");
    takeSessionReview(db, "W");
    recordReviewFailure(db, "W", 1); // → failed, attempts=1
    enq("W", "T9", "2026-07-02T00:00:09.000Z"); // resume 不复活
    expect(rowOf("W")).toEqual({ status: "failed", a: 1, t: "T9" }); // 仍 failed、attempts 不清
    expect(countPendingReviews(db)).toBe(0);
  });

  test("listPendingSessions 只列 pending、FIFO 序（取活/done 后不再出现）", () => {
    enq("A", "Ta", "2026-07-02T00:00:00.000Z");
    enq("B", "Tb", "2026-07-02T00:00:01.000Z");
    enq("C", "Tc", "2026-07-02T00:00:02.000Z");
    expect(listPendingSessions(db)).toEqual(["A", "B", "C"]);
    takeSessionReview(db, "B"); // B → processing
    expect(listPendingSessions(db)).toEqual(["A", "C"]); // B 退出列表
  });
});
