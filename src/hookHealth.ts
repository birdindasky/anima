// hook 失败连败计数器：失败可见化（claude-mem "failure is invisible" 教训）
// 连挂 N 次（默认 3）报警；一次成功即归零
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";

export interface HookHealthRow {
  hookName: string;
  failures: number;
  alerted: boolean;
  lastError: string | null;
  lastFailureAt: string | null;
}

interface RawRow {
  hook_name: string;
  consecutive_failures: number;
  alerted: number;
  last_error: string | null;
  last_failure_at: string | null;
}

function mapRow(r: RawRow): HookHealthRow {
  return {
    hookName: r.hook_name,
    failures: r.consecutive_failures,
    alerted: r.alerted === 1,
    lastError: r.last_error,
    lastFailureAt: r.last_failure_at,
  };
}

export function recordHookFailure(
  db: Database,
  hookName: string,
  opts: { error?: string; clock?: Clock; threshold?: number } = {},
): { failures: number; alerted: boolean } {
  const clock = opts.clock ?? systemClock;
  const threshold = opts.threshold ?? 3;
  const now = clock.now().toISOString();
  db.query(
    `INSERT INTO hook_health (hook_name, consecutive_failures, alerted, last_error, last_failure_at, updated_at)
     VALUES (?, 1, CASE WHEN 1 >= ?2 THEN 1 ELSE 0 END, ?3, ?4, ?4)
     ON CONFLICT (hook_name) DO UPDATE SET
       consecutive_failures = consecutive_failures + 1,
       alerted = CASE WHEN consecutive_failures + 1 >= ?2 THEN 1 ELSE 0 END,
       last_error = ?3,
       last_failure_at = ?4,
       updated_at = ?4`,
  ).run(hookName, threshold, opts.error ?? null, now);
  const row = db
    .query("SELECT * FROM hook_health WHERE hook_name = ?")
    .get(hookName) as RawRow;
  return { failures: row.consecutive_failures, alerted: row.alerted === 1 };
}

export function recordHookSuccess(db: Database, hookName: string): void {
  db.query(
    `INSERT INTO hook_health (hook_name, consecutive_failures, alerted)
     VALUES (?, 0, 0)
     ON CONFLICT (hook_name) DO UPDATE SET
       consecutive_failures = 0,
       alerted = 0`,
  ).run(hookName);
}

export function getHookHealth(db: Database, hookName: string): HookHealthRow | null {
  const row = db
    .query("SELECT * FROM hook_health WHERE hook_name = ?")
    .get(hookName) as RawRow | null;
  return row ? mapRow(row) : null;
}

export function getHookAlerts(db: Database): HookHealthRow[] {
  const rows = db
    .query("SELECT * FROM hook_health WHERE alerted = 1 ORDER BY hook_name")
    .all() as RawRow[];
  return rows.map(mapRow);
}
