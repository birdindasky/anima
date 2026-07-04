// AUDIT-2026-06-29 A区#3 复现 + 修复验收：愈合非幂等 → 同段双写 live 自评。
// 旧码 completeHeal/completeHealByShell = invalidate(壳) + 无条件 writeSelfReviewBody。invalidate 对已作废
// 壳是静默 no-op，但 write 照写 → 撞同一壳（手动 heal-now 撞夜跑 / 重跑一键全愈）写出两条 order_seq 相同的
// live 自评（召回双命中/日记双计/人格双读）。修：invalidate 返回 CAS 翻转行数，抢到（返 1）才写。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { completeHeal, completeHealByShell } from "../src/selfHeal";
import type { GeneratedSelfReview, Material } from "../src/selfReview";

const NIGHT = "2026-06-10";
const clock = frozenClock("2026-06-11T04:00:00.000Z");

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-healidem-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gen(text: string): GeneratedSelfReview {
  return { ok: true, attempts: 1, value: { review: text, feeling: "踏实", intensity: "中", keywords: ["愈合"], items: [], flaws: [] } };
}
function mat(sid: string): Material {
  return { sessionId: sid, project: "anima", conversation: [], events: [], bookmarks: [], evidenceText: "" };
}
function liveReviews(db: ReturnType<typeof openDb>, sid: string) {
  return db
    .query("SELECT id, order_seq, content FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL")
    .all(sid) as { id: number; order_seq: number | null; content: string }[];
}
function seedShell(db: ReturnType<typeof openDb>, sid: string) {
  return insertExperience(
    db,
    { kind: "self_review_fallback", content: "壳", sourceSession: sid, occurredAt: `${NIGHT}T04:00:00.000Z` },
    clock,
  );
}

describe("愈合幂等（AUDIT A区#3）：撞同一壳/重跑全愈不双写 live 自评", () => {
  test("completeHealByShell 跑两次同壳 → 只写一条 live 自评（order_seq=壳id）、壳已作废", () => {
    const db = tmpDb();
    const sid = "S1";
    const sh = seedShell(db, sid);
    const rec = { sessionId: sid, shellId: sh.id, night: NIGHT, generated: gen("第一次愈合"), material: mat(sid) };

    completeHealByShell(db, rec, clock);
    completeHealByShell(db, { ...rec, generated: gen("第二次愈合·不该再写") }, clock); // 模拟重跑/撞夜跑

    const reviews = liveReviews(db, sid);
    expect(reviews.length).toBe(1); // 关键：不是 2
    expect(reviews[0]!.order_seq).toBe(sh.id);
    expect(reviews[0]!.content).toContain("第一次愈合");
    const shell = db.query("SELECT invalid_at FROM experiences WHERE id=?").get(sh.id) as { invalid_at: string | null };
    expect(shell.invalid_at).not.toBeNull();
  });

  test("completeHeal 跑两次同壳 → 只写一条 live 自评、账被删", () => {
    const db = tmpDb();
    const sid = "S2";
    const sh = seedShell(db, sid);
    db.query(
      "INSERT INTO review_heal (session_id,since_uuid,target_uuid,shell_id,night,attempts,status,next_attempt_at,created_at) VALUES (?,?,?,?,?,0,'pending',?,?)",
    ).run(sid, "u1", "u4", sh.id, NIGHT, `${NIGHT}T04:00:00.000Z`, `${NIGHT}T04:00:00.000Z`);
    const rec = { sessionId: sid, targetUuid: "u4", shellId: sh.id, night: NIGHT, generated: gen("第一次愈合"), material: mat(sid) };

    completeHeal(db, rec, clock);
    completeHeal(db, { ...rec, generated: gen("第二次愈合·不该再写") }, clock);

    expect(liveReviews(db, sid).length).toBe(1);
    expect((db.query("SELECT count(*) AS c FROM review_heal WHERE session_id=?").get(sid) as { c: number }).c).toBe(0);
  });

  test("invalidateExperience 是 CAS：首次翻转返 true、再次返 false", () => {
    const db = tmpDb();
    const r = insertExperience(db, { kind: "self_review", content: "x", sourceSession: "S3" }, clock);
    expect(invalidateExperience(db, r.id, clock)).toBe(true);
    expect(invalidateExperience(db, r.id, clock)).toBe(false);
  });

  test("正常单次愈合仍照常写真自评（防过度修复）", () => {
    const db = tmpDb();
    const sid = "S4";
    const sh = seedShell(db, sid);
    completeHealByShell(
      db,
      { sessionId: sid, shellId: sh.id, night: NIGHT, generated: gen("唯一愈合内容ABC"), material: mat(sid) },
      clock,
    );
    const reviews = liveReviews(db, sid);
    expect(reviews.length).toBe(1);
    expect(reviews[0]!.content).toContain("唯一愈合内容ABC");
    expect(reviews[0]!.order_seq).toBe(sh.id);
  });
});
