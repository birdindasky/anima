// AUDIT-2026-07-01 盘点 U33 红灯先行：HEAL_BUDGET_PER_NIGHT 的 `Number(env) || 50` 静默吃负数
// （Number("-5")||50 = -5 truthy），而 SQLite `LIMIT -5` ＝**不限量**——H3 防风暴预算被一个坏 env
// 直接架空。修＝env 解析走 envInt（min:1，坏值退默认，单一事实源 src/env.ts）+ selectHealable 入参
// 双保险 clamp（非法预算退硬默认 50，绝不透传成无界 LIMIT）。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { registerHeal, selectHealable } from "../src/selfHeal";
import { frozenClock } from "../src/clock";
import { envInt } from "../src/env";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-healbudget-${process.pid}-${n++}.db`));
const clk = frozenClock("2026-06-10T12:00:00.000Z");

function seedAccounts(db: ReturnType<typeof freshDb>, count: number): void {
  for (let i = 0; i < count; i++) {
    registerHeal(
      db,
      { sessionId: `s${i}`, sinceUuid: null, targetUuid: `t${i}`, shellId: i + 1, night: "2026-06-09" },
      clk,
    );
  }
}

describe("U33 自愈预算护栏", () => {
  test("负预算不再变成无界 LIMIT：60 条账，budget=-1 → 最多取默认 50 条", () => {
    const db = freshDb();
    seedAccounts(db, 60);
    const rows = selectHealable(db, "2026-06-10", -1);
    expect(rows.length).toBeLessThanOrEqual(50); // 旧码：LIMIT -1 ＝全取 60
    expect(rows.length).toBeGreaterThan(0); // 也不能矫枉过正取 0——预算兜回默认，账照愈
  });

  test("预算 0 / NaN 同样兜回默认，不透传", () => {
    const db = freshDb();
    seedAccounts(db, 3);
    expect(selectHealable(db, "2026-06-10", 0).length).toBe(3); // 兜回 50 > 3
    expect(selectHealable(db, "2026-06-10", Number.NaN).length).toBe(3);
  });

  test("合法预算照常生效", () => {
    const db = freshDb();
    seedAccounts(db, 5);
    expect(selectHealable(db, "2026-06-10", 2).length).toBe(2);
  });

  test("envInt 单一事实源：坏 env 退默认（负数/零/非数/越下界）", () => {
    process.env.ANIMA_TEST_ENVINT = "-5";
    expect(envInt("ANIMA_TEST_ENVINT", 50, { min: 1 })).toBe(50);
    process.env.ANIMA_TEST_ENVINT = "0";
    expect(envInt("ANIMA_TEST_ENVINT", 50, { min: 1 })).toBe(50);
    process.env.ANIMA_TEST_ENVINT = "abc";
    expect(envInt("ANIMA_TEST_ENVINT", 50, { min: 1 })).toBe(50);
    process.env.ANIMA_TEST_ENVINT = "12";
    expect(envInt("ANIMA_TEST_ENVINT", 50, { min: 1 })).toBe(12);
    delete process.env.ANIMA_TEST_ENVINT;
    expect(envInt("ANIMA_TEST_ENVINT", 50, { min: 1 })).toBe(50);
  });
});
