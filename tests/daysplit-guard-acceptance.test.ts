// 独立验收测试：guardDaysplitSwitch（day-split 切换前置闸，DESIGN-DAYSPLIT §3.6 / 修 A）
// 真值独立从 src/digest.ts + 设计文档推导，不引用任何现成 guardDaysplitSwitch 测试。
// 关键事实（自行验证）：
//   - STAGES = [makeup, heal, closure, decay, personality, diary, vectorize] = 7 个
//   - findUndigestedNights eligible 判据：done 阶段数 < 7，且 night <= latestCompletedNight(now)
//   - latestCompletedNight(now=2026-06-22T18Z) = "2026-06-22"
//   - 活动 occurred_at +8h 落在 night；占 2026-06-21 夜 → occurred_at 2026-06-20T20:00:00Z
//   - 危险态契约：makeup 未 done 且有其他阶段 done → 拒绝；幂等：marker 存在则放行
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { guardDaysplitSwitch } from "../src/digest";

const NOW = new Date("2026-06-22T18:00:00.000Z");
const ALL_STAGES = ["makeup", "heal", "closure", "decay", "personality", "diary", "vectorize"];
const PRE_HEAL_STAGES = ["makeup", "closure", "decay", "personality", "diary", "vectorize"]; // 加 heal 前的老 6 阶段

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-dsacc-"));
  db = openDb(join(dir, "anima.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 造一夜真实活动 → 进 findUndigestedNights 候选。occurred_at +8h 落在 night。
function activity(night: string): void {
  // night "2026-06-21" 对应 occurred_at 2026-06-20T20:00:00Z（+8h = 2026-06-21）
  const occ = new Date(`${night}T00:00:00.000Z`);
  occ.setUTCHours(occ.getUTCHours() - 4); // 前一日 20:00Z，确保 +8h 仍在本 night
  db.query(
    `INSERT INTO situation_log (session_id, kind, occurred_at, created_at) VALUES ('s1','user_message', ?, ?)`,
  ).run(occ.toISOString(), occ.toISOString());
}

// 给某夜写若干 done 阶段
function done(night: string, stages: string[]): void {
  for (const st of stages) {
    db.query(
      `INSERT INTO digest_runs (night, stage, status, finished_at) VALUES (?, ?, 'done', ?)`,
    ).run(night, st, NOW.toISOString());
  }
}
function stage(night: string, st: string, status: string): void {
  db.query(
    `INSERT INTO digest_runs (night, stage, status, finished_at) VALUES (?, ?, ?, ?)`,
  ).run(night, st, status, NOW.toISOString());
}

function markerExists(): boolean {
  const m = db.query("SELECT value FROM meta WHERE key='daysplit_activated'").get();
  return m != null;
}

describe("guardDaysplitSwitch 独立验收", () => {
  // 验收点 1（核心危险态）：makeup failed/缺 + 下游 done → 拒绝、不落标记
  test("[1a] makeup 缺行（没跑）+ 下游 done → safe:false + 不落标记 + reason 含夜", () => {
    activity("2026-06-21");
    done("2026-06-21", ["closure", "personality", "diary"]); // makeup 完全没行
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(false);
    if (r.safe === false) expect(r.reason).toContain("2026-06-21");
    expect(markerExists()).toBe(false);
  });

  test("[1b] makeup failed（有行非 done）+ 下游 done → safe:false + 不落标记", () => {
    activity("2026-06-21");
    stage("2026-06-21", "makeup", "failed");
    done("2026-06-21", ["closure", "personality"]);
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(false);
    expect(markerExists()).toBe(false);
  });

  // 验收点 2（首次干净切换）：0 done → safe:true, activated:true + 落标记
  test("[2] eligible 夜 0 done → safe:true, activated:true + 落 daysplit_activated 标记", () => {
    activity("2026-06-21");
    // 完全无 digest_runs
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(true);
    if (r.safe === true) expect(r.activated).toBe(true);
    expect(markerExists()).toBe(true);
  });

  // 验收点 3（重点·易漏）：加 heal 前的老「全 done」夜只有 6 done（无 heal 行）
  // → findUndigestedNights 当它 eligible（6<7），但 makeup=done，安全，绝不能误拒。
  test("[3] 老全done夜（6 阶段无 heal、makeup=done）→ safe:true activated:true（不误拒）", () => {
    activity("2026-06-21");
    done("2026-06-21", PRE_HEAL_STAGES); // 6 个，含 makeup done，缺 heal
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(true);
    if (r.safe === true) expect(r.activated).toBe(true);
    expect(markerExists()).toBe(true);
  });

  // 验收点 4（重点·幂等不锁死）：marker 已存在 + 库里有脏半态夜 → safe:true activated:false 放行
  test("[4] marker 已存在 + 脏半态夜 → safe:true activated:false（不锁死）", () => {
    db.query("INSERT INTO meta (key,value) VALUES ('daysplit_activated', ?)").run(
      "2026-06-19T00:00:00.000Z",
    );
    activity("2026-06-21");
    stage("2026-06-21", "makeup", "failed");
    done("2026-06-21", ["closure", "personality", "diary"]); // 明确的脏半态
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(true);
    if (r.safe === true) expect(r.activated).toBe(false);
  });

  // 验收点 5：makeup 已 done、下游没跑（部分 done 但 makeup 在内）→ 安全切换
  test("[5] makeup done、下游未跑 → safe:true activated:true（不算危险）", () => {
    activity("2026-06-21");
    done("2026-06-21", ["makeup"]); // 只 makeup done，下游全没跑
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(true);
    if (r.safe === true) expect(r.activated).toBe(true);
    expect(markerExists()).toBe(true);
  });

  // 验收点 6：拒绝后能重试（拒绝不落标记 → 修好后再调可放行）
  test("[6] 拒绝后修复 makeup done → 再调放行（拒绝确实没落标记）", () => {
    activity("2026-06-21");
    done("2026-06-21", ["closure", "diary"]); // makeup 缺 → 危险
    const r1 = guardDaysplitSwitch(db, { now: NOW });
    expect(r1.safe).toBe(false);
    expect(markerExists()).toBe(false);
    // 修复：补 makeup done
    done("2026-06-21", ["makeup"]);
    const r2 = guardDaysplitSwitch(db, { now: NOW });
    expect(r2.safe).toBe(true);
    if (r2.safe === true) expect(r2.activated).toBe(true);
    expect(markerExists()).toBe(true);
  });

  // 验收点 7（多夜混合）：一干净一危险 → 整体拒绝、reason 含危险夜、不落标记
  test("[7] 多夜：一夜干净一夜危险 → 拒绝、reason 含危险夜、不落标记", () => {
    activity("2026-06-20");
    done("2026-06-20", ["makeup"]); // 干净（makeup done）
    activity("2026-06-21");
    done("2026-06-21", ["personality"]); // 危险（makeup 缺、下游 done）
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(false);
    if (r.safe === false) {
      expect(r.reason).toContain("2026-06-21");
      expect(r.reason).not.toContain("2026-06-20(");
    }
    expect(markerExists()).toBe(false);
  });

  // 验收点 8（隔离性）：危险半态夜但不 eligible（未来夜，> cutoff）→ 不被本闸看到 → 放行
  test("[8] 危险半态夜在 cutoff 之后（非 eligible）→ 不误拦", () => {
    // night 2026-06-23 > cutoff 2026-06-22 → findUndigestedNights 不返回
    activity("2026-06-23");
    done("2026-06-23", ["closure", "diary"]); // makeup 缺，但非 eligible
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(true);
    if (r.safe === true) expect(r.activated).toBe(true);
  });

  // 验收点 9（无活动空库）：没有任何 eligible 夜 → 干净放行 + 落标记
  test("[9] 空库无活动 → safe:true activated:true", () => {
    const r = guardDaysplitSwitch(db, { now: NOW });
    expect(r.safe).toBe(true);
    if (r.safe === true) expect(r.activated).toBe(true);
    expect(markerExists()).toBe(true);
  });
});
