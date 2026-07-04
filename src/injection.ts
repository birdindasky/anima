// 已注入记忆台账：Phase 2 晨间注入时记录，供衍生回显抑制与审计交叉验证
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";

export function recordInjection(
  db: Database,
  sessionId: string,
  experienceIds: number[],
  clock: Clock = systemClock,
): void {
  const now = clock.now().toISOString();
  const stmt = db.query(
    "INSERT INTO injection_log (session_id, experience_id, injected_at) VALUES (?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const id of experienceIds) stmt.run(sessionId, id, now);
  });
  tx();
}

export function listInjectedExperienceIds(db: Database, sessionId: string): number[] {
  const rows = db
    .query("SELECT experience_id FROM injection_log WHERE session_id = ?")
    .all(sessionId) as { experience_id: number }[];
  return rows.map((r) => r.experience_id);
}
