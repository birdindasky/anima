// R8 独立盲考官对抗测试：/mood 面板不许对"存疑→不进人格消化"撒谎
// 证伪导向：旧行为（doubt 文案含"不进人格消化"）红；新行为（删假承诺，只留诚实存疑）绿。
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { estimateMood, renderMoodPanel } from "../src/mood";

const NOW = "2026-06-11T15:00:00.000Z";
const dirs: string[] = [];
function db() {
  const d = mkdtempSync(join(tmpdir(), "r8-blind-"));
  dirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 构造"自述偏正 + 今日多次受挫"→ 存疑腿必然点亮的典型触发前提
function doubtScenario() {
  const d = db();
  const clock = frozenClock(NOW);
  insertExperience(d, { kind: "event", content: "联调打通", feeling: "爽、踏实", sourceSession: "s" }, clock);
  // 3 次失败但不连挂到 5（避免螺旋喧宾夺主，孤立存疑腿）
  for (const ok of [false, true, false, true, false]) {
    appendSituation(d, { sessionId: "s", kind: "test_run", payload: { ok } }, clock);
  }
  return { est: estimateMood(d, { clock }) };
}

describe("R8 · 存疑腿必须真点亮（不许靠'干脆不报存疑'蒙混）", () => {
  test("典型触发前提下 doubts 非空且面板出现'存疑'", () => {
    const { est } = doubtScenario();
    expect(est.doubts.length).toBeGreaterThan(0);
    const panel = renderMoodPanel(est, { badgePath: "/tmp/b.txt" });
    expect(panel).toContain("存疑");
  });
});

describe("R8 · 假承诺'不进人格消化'必须全灭（旧行为红/新行为绿）", () => {
  test("doubts 文案不含'不进人格消化'", () => {
    const { est } = doubtScenario();
    // 旧代码 push 的是「…存疑，不进人格消化」——这一整句就是谎。
    for (const d of est.doubts) expect(d).not.toContain("不进人格消化");
    // 更狠一点：连"人格消化""不进消化"这类残留半句都不许留在存疑文案里
    for (const d of est.doubts) {
      expect(d.includes("不进人格") || d.includes("不进消化")).toBe(false);
    }
  });

  test("整块渲染面板不含'不进人格消化'", () => {
    const { est } = doubtScenario();
    const panel = renderMoodPanel(est, { badgePath: "/tmp/b.txt" });
    expect(panel).not.toContain("不进人格消化");
  });

  test("显式重放旧文案：确认这正是被删掉的谎（红/绿分界锚点）", () => {
    // 旧 doubt 串（git 8c61faf）: "自述偏正面，但今日测试多次受挫——存疑，不进人格消化"
    const oldLie = "自述偏正面，但今日测试多次受挫——存疑，不进人格消化";
    const { est } = doubtScenario();
    // 新串保留诚实前半、砍掉假承诺后半
    expect(est.doubts.some((d) => d === oldLie)).toBe(false);
    expect(est.doubts.some((d) => d.startsWith("自述偏正面，但今日测试多次受挫——存疑"))).toBe(true);
  });
});
