// 处境流水：纯客观记录，append-only，没有更新/删除口
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";

export interface SituationInput {
  sessionId?: string | null;
  project?: string | null;
  /** 'test_fail' | 'rework' | 'user_praise' | 'user_scold' ... 语义由捕获侧定义 */
  kind: string;
  payload?: unknown;
  occurredAt?: string;
  /**
   * 采集幂等指纹（v7，AUDIT-2026-07-01 rank1）：来自 transcript 事件的稳定标识
   * （用户消息=`msg:<uuid>` / 工具=`tool:<tool_use_id>:<kind>`）。传入则参与 `(session_id, dedup_key)`
   * 局部唯一索引 + INSERT OR IGNORE，同事件重采弹回不重复落库。非采集 caller（marker 等）不传 → NULL
   * → 不进唯一索引、行为不变。
   */
  dedupKey?: string | null;
}

export interface SituationRow {
  id: number;
  sessionId: string | null;
  project: string | null;
  kind: string;
  payload: unknown;
  occurredAt: string;
  createdAt: string;
}

interface RawRow {
  id: number;
  session_id: string | null;
  project: string | null;
  kind: string;
  payload: string | null;
  occurred_at: string;
  created_at: string;
}

function mapRow(r: RawRow): SituationRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    project: r.project,
    kind: r.kind,
    payload: r.payload === null ? null : JSON.parse(r.payload),
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
  };
}

export function appendSituation(
  db: Database,
  input: SituationInput,
  clock: Clock = systemClock,
): SituationRow {
  const now = clock.now().toISOString();
  const dedupKey = input.dedupKey ?? null;
  // 精确定向 upsert（v8）：只对 dedup_key 唯一索引的冲突 DO NOTHING（重采弹回，changes=0）。无 dedupKey 的行
  // dedup_key=NULL、不进局部索引 → 无冲突、正常插入。用 ON CONFLICT(dedup_key)（非宽 INSERT OR IGNORE）→ 别的
  // 约束违规（NOT NULL 等）照旧抛错、绝不被静默吞掉（codex Q4a）。
  const result = db
    .query(
      `INSERT INTO situation_log (session_id, project, kind, payload, occurred_at, created_at, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
    )
    .run(
      input.sessionId ?? null,
      input.project ?? null,
      input.kind,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.occurredAt ?? now,
      now,
      dedupKey,
    );
  // 被去重弹回（changes=0）：lastInsertRowid 是陈旧值，绝不能拿它当本行 id。回查同指纹已存在的那条返回，
  // 保持返回契约（SituationRow）诚实——采集侧不看返回值，但别的 caller 若拿 id 也拿到真行。dedup_key 单列全局
  // 唯一（v8），回查不需 session。
  const row = (result.changes === 0 && dedupKey !== null
    ? db.query("SELECT * FROM situation_log WHERE dedup_key = ?").get(dedupKey)
    : db.query("SELECT * FROM situation_log WHERE id = ?").get(Number(result.lastInsertRowid))) as RawRow;
  return mapRow(row);
}

export interface SituationFilter {
  sessionId?: string;
  project?: string;
  kind?: string;
  /** 只取 occurred_at **严格晚于**此刻的（排除水位线及更早）。增量自评切 situation_log 用（IMPORTANT-3）。 */
  sinceOccurredAt?: string;
  /** 只取 occurred_at **不晚于**此刻的（含 target 边界）。增量自评切 situation_log 用（IMPORTANT-3）。 */
  untilOccurredAt?: string;
  limit?: number;
}

export function listSituations(db: Database, filter: SituationFilter = {}): SituationRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.project !== undefined) {
    where.push("project = ?");
    params.push(filter.project);
  }
  if (filter.kind !== undefined) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.sinceOccurredAt !== undefined) {
    where.push("occurred_at > ?");
    params.push(filter.sinceOccurredAt);
  }
  if (filter.untilOccurredAt !== undefined) {
    where.push("occurred_at <= ?");
    params.push(filter.untilOccurredAt);
  }
  const sql = `SELECT * FROM situation_log
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id ASC
    ${filter.limit !== undefined ? "LIMIT ?" : ""}`;
  if (filter.limit !== undefined) params.push(filter.limit);
  return (db.query(sql).all(...params) as RawRow[]).map(mapRow);
}
