// worker 待办板 work_queue 的读写（DESIGN-WORKER-RESUME §4.2/§4.3 + §v5.7 S-4/I-10）。
// experiences 才是唯一真相源；work_queue 只是 worker「处理到哪了」的私有操作账（failed 行靠夜跑兜底捡回）。
// 只有单例 worker 写它（makeup 不看 work_queue，§5 去重靠水位线 CAS），故无需跨进程并发防护；
// 取活已收成单条 CAS UPDATE（U41，自带原子）；标 done+翻 pending 仍裹同步事务保原子（SEVERE-2）。
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";

const KIND = "self_review";

export interface WorkItem {
  sessionId: string;
  transcriptPath: string | null;
  /** 入队时刻的 transcript 末条快照——worker 增量切片的上界（targetUuid） */
  targetUuid: string | null;
  attempts: number;
}

/**
 * §4.2 入队（per-turn Stop / SessionEnd 都走它，幂等 upsert）：
 * - processing：保持 processing、只更 target/path（worker 收尾 CAS 会发现 target 变了自动再转），
 *   enqueued_at **不刷**（当 worker 活性代理给自清时限用）。
 * - failed：保持 failed、**不复活、不清 attempts**（S-4：防持续失败被每轮 Stop 复活→每轮烧 haiku；
 *   靠夜跑 makeup 兜底捡回）；仍更 target/path 记最新意图。
 * - 其余（pending/done/新行）：pending、attempts=0、enqueued_at=now。
 */
export function enqueueReview(
  db: Database,
  opts: { sessionId: string; transcriptPath: string | null; targetUuid: string | null },
  clock: Clock = systemClock,
): void {
  const now = clock.now().toISOString();
  db.query(
    `INSERT INTO work_queue (session_id, kind, transcript_path, status, target_uuid, attempts, enqueued_at)
     VALUES (?, ?, ?, 'pending', ?, 0, ?)
     ON CONFLICT(session_id, kind) DO UPDATE SET
       target_uuid     = excluded.target_uuid,
       transcript_path = excluded.transcript_path,
       status = CASE status WHEN 'processing' THEN 'processing'
                            WHEN 'failed'     THEN 'failed'
                            ELSE 'pending' END,
       attempts = CASE WHEN status IN ('processing', 'failed') THEN attempts ELSE 0 END,
       enqueued_at = CASE WHEN status = 'processing' THEN enqueued_at ELSE excluded.enqueued_at END`,
  ).run(opts.sessionId, KIND, opts.transcriptPath, opts.targetUuid, now);
}

/** §4.3-1 取一条 pending → 标 processing。M-12 粗 FIFO：取 enqueued_at 最早。无则 null。
 *  U41（AUDIT-2026-06-29 残余）：取活收成**单条** `UPDATE … AND status='pending' … RETURNING`——
 *  谓词进语句本身，抢不到（已被别的写者取走/状态已变）→ 0 行 → null。单 worker 下 SELECT+UPDATE
 *  裹同步事务本就安全，这刀是多 worker 化/跨进程并发前的硬前置：绝不把非 pending 行改写成 processing。 */
export function takeNextPending(db: Database, _clock: Clock = systemClock): WorkItem | null {
  const row = db
    .query(
      `UPDATE work_queue SET status = 'processing'
        WHERE kind = ?1 AND status = 'pending'
          AND session_id = (SELECT session_id FROM work_queue
                             WHERE kind = ?1 AND status = 'pending'
                             ORDER BY enqueued_at ASC, session_id ASC LIMIT 1)
        RETURNING session_id AS s, transcript_path AS p, target_uuid AS t, attempts AS a`,
    )
    .get(KIND) as { s: string; p: string | null; t: string | null; a: number } | null;
  if (!row) return null;
  return { sessionId: row.s, transcriptPath: row.p, targetUuid: row.t, attempts: row.a };
}

/**
 * §4.3-3 标 done（CAS on target_uuid）+ 翻 pending，**单事务**（SEVERE-2：两条 UPDATE 不裹一个事务，
 * SIGKILL 落中间会卡 processing 无人回收）。processedTarget = worker 实际处理到的 target（取活时的 T）。
 * - target 未变（仍 == processedTarget）→ status='done'。
 * - 期间被入队更新（resume 又来，target 变了）→ CAS 落空 → 翻回 pending、attempts 清零（新一段非重试）、当轮重取。
 */
export function markReviewDone(
  db: Database,
  sessionId: string,
  processedTarget: string | null,
): { requeued: boolean } {
  const tx = db.transaction(() => {
    const done = db
      .query(
        `UPDATE work_queue SET status = 'done'
          WHERE session_id = ? AND kind = ? AND status = 'processing' AND target_uuid IS ?`,
      )
      .run(sessionId, KIND, processedTarget);
    if (done.changes === 0) {
      db.query(
        `UPDATE work_queue SET status = 'pending', attempts = 0
          WHERE session_id = ? AND kind = ? AND status = 'processing'`,
      ).run(sessionId, KIND);
      return { requeued: true };
    }
    return { requeued: false };
  });
  return tx();
}

/** §4.3-4 失败：attempts++，< maxAttempts 留 pending 重试、>= 标 failed。**绝不标 done**。 */
export function recordReviewFailure(
  db: Database,
  sessionId: string,
  maxAttempts: number,
): { failed: boolean } {
  const tx = db.transaction(() => {
    const r = db
      .query(`SELECT attempts AS a FROM work_queue WHERE session_id = ? AND kind = ?`)
      .get(sessionId, KIND) as { a: number } | null;
    const attempts = (r?.a ?? 0) + 1;
    const status = attempts >= maxAttempts ? "failed" : "pending";
    db.query(
      `UPDATE work_queue SET status = ?, attempts = ? WHERE session_id = ? AND kind = ? AND status = 'processing'`,
    ).run(status, attempts, sessionId, KIND);
    return { failed: status === "failed" };
  });
  return tx();
}

/**
 * worker 启动自清（§5.6）：processing 超过 staleMs 的回退 pending（崩溃残留的卡死行）。
 * 用 enqueued_at 当 processing 起始代理（§4.2：processing 行不刷 enqueued_at，≈ 取活时刻）。
 */
export function reclaimStaleProcessing(
  db: Database,
  opts: { staleMs: number; clock?: Clock },
): number {
  const clock = opts.clock ?? systemClock;
  const cutoff = new Date(clock.now().getTime() - opts.staleMs).toISOString();
  return db
    .query(
      `UPDATE work_queue SET status = 'pending'
        WHERE kind = ? AND status = 'processing' AND enqueued_at < ?`,
    )
    .run(KIND, cutoff).changes;
}

/** 取指定会话的 pending → 标 processing。给清队按起始快照逐会话取活用（每会话本轮一次，
 *  防 requeue 的行被 FIFO 立刻重取成忙转）。该会话已非 pending（被处理/done）→ null。
 *  U41：同 takeNextPending，单条 CAS UPDATE + status 谓词，绝不改写非 pending 行。 */
export function takeSessionReview(db: Database, sessionId: string): WorkItem | null {
  const row = db
    .query(
      `UPDATE work_queue SET status = 'processing'
        WHERE session_id = ? AND kind = ? AND status = 'pending'
        RETURNING transcript_path AS p, target_uuid AS t, attempts AS a`,
    )
    .get(sessionId, KIND) as { p: string | null; t: string | null; a: number } | null;
  if (!row) return null;
  return { sessionId, transcriptPath: row.p, targetUuid: row.t, attempts: row.a };
}

/** 本轮起始的 pending 会话列表（FIFO 序）。清队按它逐个取，requeue/新入的留到下一轮。 */
export function listPendingSessions(db: Database): string[] {
  return (
    db
      .query(
        `SELECT session_id AS s FROM work_queue WHERE kind = ? AND status = 'pending'
          ORDER BY enqueued_at ASC, session_id ASC`,
      )
      .all(KIND) as { s: string }[]
  ).map((r) => r.s);
}

/**
 * 无惩罚退回 pending（processing→pending，attempts 不变）：target 尚不可见（live transcript 还没落到
 * worker 文件视图）/ 水位线超前快照等「不是失败、只是这轮做不了」的情形——留待下轮，绝不计 attempts。
 */
export function requeueReview(db: Database, sessionId: string): void {
  db.query(
    `UPDATE work_queue SET status = 'pending' WHERE session_id = ? AND kind = ? AND status = 'processing'`,
  ).run(sessionId, KIND);
}

/** 当前 pending 待办数（worker 主循环判空闲自退用）。 */
export function countPendingReviews(db: Database): number {
  return (
    db.query(`SELECT count(*) AS c FROM work_queue WHERE kind = ? AND status = 'pending'`).get(KIND) as {
      c: number;
    }
  ).c;
}
