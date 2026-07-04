// R7/R8 情绪三读数修复回归（AUDIT-2026-07-03 R7/R8）
// R7：chargeLevel 会话-日归一（长会话切片不累加成"强"）+ 删篇幅当强度 + valenceOf 去重/否定/混合 + 死亡螺旋编辑腿耦合失败
// R8：/mood 面板不再空口承诺"不进人格消化"（选 (b)：让 UI 不说谎）

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { estimateMood, renderMoodPanel, valenceOf } from "../src/mood";
import { imprintStrength } from "../src/charge";

const NOW = "2026-06-11T15:00:00.000Z";
const tmpDirs: string[] = [];
function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "anima-r7-"));
  tmpDirs.push(dir);
  return openDb(join(dir, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("R7-1 imprintStrength：篇幅不再当强度代理（方向反了）", () => {
  test("同强度下，长篇不再比短篇更强；情绪自述(intensity)才是加成源", () => {
    // 一句"崩了"可以比一段无情绪流水账更烈：短+有强度 > 长+无强度
    const shortIntense = { feeling: "崩", intensity: "满格" } as any;
    const longPlain = { feeling: "今天写了很长很长的一段流水账不带情绪词".repeat(5), intensity: null } as any;
    expect(imprintStrength(shortIntense)).toBeGreaterThan(imprintStrength(longPlain));

    // 同 intensity、篇幅相差 200 倍 → 强度必须相等（篇幅零加成）
    const a = { feeling: "累", intensity: null } as any;
    const b = { feeling: "累".repeat(200), intensity: null } as any;
    expect(imprintStrength(a)).toBe(imprintStrength(b));
  });
});

describe("R7-2 chargeLevel：长会话切片归一，不再永钉'强'", () => {
  test("一个长会话切成 15 片各自带感受 → 归一后是'微'，不是'强'", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    // 同一 source_session、同一东八日：worker 切片的典型形态
    for (let i = 0; i < 15; i++) {
      insertExperience(
        db,
        { kind: "self_review", content: `第 ${i} 片复盘`, feeling: "还行", sourceSession: "long-sess" },
        clock,
      );
    }
    const est = estimateMood(db, { clock });
    // 归一取 max：15 片坍缩成 1 次充电（强度 1）→ total≈1 → 微；旧代码求和≈15 → 强
    expect(est.chargeLevel).not.toBe("强");
    expect(est.chargeLevel).toBe("微");
  });

  test("梯度还活着：多个不同会话各带感受 → 能爬到'中'/'强'", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    for (let s = 0; s < 8; s++) {
      insertExperience(
        db,
        { kind: "event", content: `会话 ${s} 的经历`, feeling: "有点烦", sourceSession: `sess-${s}` },
        clock,
      );
    }
    const est = estimateMood(db, { clock });
    // 8 个独立会话 = 8 组，各 max≈1 → total≈8 → 至少'中'（证明不是恒定塌成一个档）
    expect(["中", "强"]).toContain(est.chargeLevel);
  });
});

describe("R7-3 valenceOf：去重 / 否定 / 混合", () => {
  test("'不烦躁不沮丧、豁然开朗' 不判负", () => {
    expect(valenceOf("不烦躁不沮丧、豁然开朗")).toBeGreaterThanOrEqual(0);
  });

  test("基本否定：'不烦' / '不沮丧' 不判负；'不爽' 判负", () => {
    expect(valenceOf("不烦")).toBeGreaterThanOrEqual(0);
    expect(valenceOf("不沮丧")).toBeGreaterThanOrEqual(0);
    expect(valenceOf("不爽")).toBeLessThan(0);
  });

  test("混合'累但踏实'不粗暴抵消成 0（转折落点偏正）", () => {
    expect(valenceOf("累但踏实")).toBeGreaterThan(0);
  });

  test("'沮丧'含'丧'不双计：单负词有界，且转折里不双重扣分", () => {
    expect(valenceOf("沮丧")).toBe(-1); // 有界，不是 -2
    // '沮丧但爽'：pre 只扣一次(-1) 而非两次(-2)，转折落点为正 → 明显偏正
    expect(valenceOf("沮丧但爽")).toBeGreaterThan(0.4);
  });

  test("纯负仍判负、纯正仍判正（没修坏基本盘）", () => {
    expect(valenceOf("好丧")).toBeLessThan(0);
    expect(valenceOf("踏实")).toBeGreaterThan(0);
  });
});

describe("R7-4 死亡螺旋编辑腿：耦合失败，治告警疲劳", () => {
  test("大重构（同文件改 12 次）但零测试失败 → 不亮灯", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    for (let i = 0; i < 12; i++) {
      appendSituation(db, { sessionId: "s", kind: "file_edit", payload: { path: "src/big.ts", tool: "Edit" } }, clock);
    }
    // 有几次测试但全过（在写正经代码，不是卡住）
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { command: "bun test", ok: true } }, clock);
    const est = estimateMood(db, { clock });
    expect(est.spiral.active).toBe(false); // 旧代码 maxEdits>=8 单腿 → 会误亮
  });

  test("改同文件多次 + 测试真受挫 → 亮灯（返工-失败耦合）", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    for (let i = 0; i < 10; i++) {
      appendSituation(db, { sessionId: "s", kind: "file_edit", payload: { path: "src/big.ts", tool: "Edit" } }, clock);
    }
    // 3 次失败但不连挂到 5（隔离编辑腿：leg1 maxStreak>=5 不触发）
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: false } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: true } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: false } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: true } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: false } }, clock);
    const est = estimateMood(db, { clock });
    expect(est.spiral.active).toBe(true);
    expect(est.spiral.reason).toContain("文件");
  });
});

describe("R8 /mood 面板：不再空口承诺'不进人格消化'", () => {
  test("触发存疑（自述偏正+今日多次受挫）→ 有'存疑'提示，但不再宣称'不进人格消化'", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    // 自述偏正
    insertExperience(db, { kind: "event", content: "联调很顺", feeling: "踏实、爽", sourceSession: "s" }, clock);
    // 今日 3 次测试失败（不连挂到 5，避免螺旋喧宾夺主）
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: false } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: true } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: false } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: true } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: false } }, clock);

    const est = estimateMood(db, { clock });
    expect(est.doubts.length).toBeGreaterThan(0); // 存疑腿真的点亮
    const panel = renderMoodPanel(est, { badgePath: "/tmp/b.txt" });
    expect(panel).toContain("存疑"); // 诚实提示还在
    // 关键：不能再说"不进人格消化"——代码从不执行这件事，UI 不许撒谎
    expect(est.doubts.join("")).not.toContain("不进人格消化");
    expect(panel).not.toContain("不进人格消化");
  });
});
