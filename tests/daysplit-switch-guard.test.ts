// DEV smoke（非验收）：day-split 切换前置闸 guardDaysplitSwitch（§3.6 / 修 A）自检。验收另由独立考官写。
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db";
import { guardDaysplitSwitch } from "../src/digest";

const NOW = new Date("2026-06-22T20:00:00.000Z"); // cutoff=latestCompletedNight=2026-06-22

const dirs: string[] = [];
function freshDb(): Database {
  const d = mkdtempSync(join(tmpdir(), "anima-dsguard-"));
  dirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// 造一夜的活动（让它进 findUndigestedNights 的候选），occurred_at +8h 落在 night
function activity(db: Database, night: string) {
  db.query(
    `INSERT INTO situation_log (session_id, kind, occurred_at, created_at) VALUES (?, 'user_message', ?, ?)`,
  ).run(`s-${night}`, `${night}T05:00:00.000Z`, `${night}T05:00:00.000Z`);
}
function stage(db: Database, night: string, stage: string, status: "done" | "failed") {
  db.query(
    `INSERT INTO digest_runs (night, stage, status, error, finished_at) VALUES (?, ?, ?, NULL, ?)`,
  ).run(night, stage, status, `${night}T06:00:00.000Z`);
}
function marker(db: Database) {
  return db.query("SELECT value FROM meta WHERE key='daysplit_activated'").get() as { value: string } | null;
}

describe("guardDaysplitSwitch（§3.6 修 A）", () => {
  test("Q4 脏夜：makeup 未完成但下游 done → 拒绝切换，不落标记", () => {
    const db = freshDb();
    activity(db, "2026-06-20");
    stage(db, "2026-06-20", "makeup", "failed"); // makeup 没 done
    stage(db, "2026-06-20", "closure", "done"); // 下游 done
    stage(db, "2026-06-20", "diary", "done");
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toContain("2026-06-20");
    expect(marker(db)).toBeNull(); // 拒绝时绝不落标记
  });

  test("新鲜夜（0 done）→ 干净放行 + 落 daysplit_activated 标记", () => {
    const db = freshDb();
    activity(db, "2026-06-21"); // 有活动、无任何 digest_runs
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r).toEqual({ safe: true, activated: true });
    expect(marker(db)?.value).toBe(NOW.toISOString());
  });

  test("老『全 done』夜（加 heal 前 6 阶段、缺 heal 行）不被误判半态", () => {
    const db = freshDb();
    activity(db, "2026-06-20");
    // 6 个老阶段全 done（无 heal 行）——findUndigestedNights 因 6<7 当它 eligible，但 makeup=done、安全
    for (const s of ["makeup", "closure", "decay", "personality", "diary", "vectorize"]) stage(db, "2026-06-20", s, "done");
    activity(db, "2026-06-21"); // 再加一夜全新干净夜
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r).toEqual({ safe: true, activated: true }); // 不因老夜误拒
  });

  test("已切换（marker 在）→ 即便有脏夜也放行，不锁死后续", () => {
    const db = freshDb();
    db.query("INSERT INTO meta (key,value) VALUES ('daysplit_activated', ?)").run("2026-06-19T00:00:00.000Z");
    activity(db, "2026-06-20");
    stage(db, "2026-06-20", "makeup", "failed"); // daysplit 正常运行的偶发半态
    stage(db, "2026-06-20", "closure", "done");
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r).toEqual({ safe: true, activated: false }); // 不再拦
  });

  test("makeup done、仅缺下游（如只 makeup done）→ 不算危险（下游会在 daysplit 下新跑）", () => {
    const db = freshDb();
    activity(db, "2026-06-20");
    stage(db, "2026-06-20", "makeup", "done"); // makeup 已 done，下游还没跑
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(true); // makeup done = 归属已定，安全
  });
});
