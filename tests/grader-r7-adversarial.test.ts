// 独立盲考官对抗测试 R7 —— 证伪导向：旧行为红、新行为绿
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { estimateMood, valenceOf } from "../src/mood";
import { imprintStrength } from "../src/charge";

const NOW = "2026-06-28T15:00:00.000Z"; // 东八区 06-28 深夜；对齐快照真实高危窗
const dirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "grader-r7-"));
  dirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("R7-1 根因：单个长会话切片不再累加成'强'（复刻快照 06-28 的 12 片）", () => {
  test("同一 session 同一日 12 片、每片都带强度自述 → 归一后远不到'强'", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    // 最恶劣：每片都有 intensity（strength=1.5），旧代码求和=12*1.5=18 稳钉'强'
    for (let i = 0; i < 12; i++) {
      insertExperience(
        db,
        { kind: "self_review", content: `复盘片 ${i}`, feeling: "有点崩", intensity: "很强", sourceSession: "sess-A" },
        clock,
      );
    }
    const est = estimateMood(db, { clock });
    // 一次情绪不该被切片放大成"强"
    expect(est.chargeLevel).not.toBe("强");
  });

  test("旧阈值+旧求和会误判：显式重算旧公式确认这是真红点（防假绿）", () => {
    // 旧: strength=1.5, halfLife=4, nights=0 → charge=1.5; total=12*1.5=18
    // 旧阈值 total<0.2无/<0.8微/<2中/else强 → 18≥2 → '强'
    const oldTotal = 12 * 1.5;
    const oldLevel = oldTotal < 0.2 ? "无" : oldTotal < 0.8 ? "微" : oldTotal < 2 ? "中" : "强";
    expect(oldLevel).toBe("强"); // 坐实旧行为会误钉强，新行为下面已证 != 强
  });
});

describe("R7-1 反向：梯度没被修死（多真实会话仍能爬到'强'）", () => {
  test("10 个不同 session 各带强度自述 → 能到'强'，证明不是一刀切压低", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    for (let s = 0; s < 10; s++) {
      insertExperience(
        db,
        { kind: "event", content: `会话${s}`, feeling: "崩溃", intensity: "满格", sourceSession: `s-${s}` },
        clock,
      );
    }
    const est = estimateMood(db, { clock });
    expect(est.chargeLevel).toBe("强"); // 10 组 * 1.5 = 15 ≥ 9
  });
});

describe("R7-2 imprintStrength：篇幅零加成，强度自述才是加成源", () => {
  test("篇幅相差 300 倍但同 intensity → 强度必须字节相等", () => {
    const short = { feeling: "崩", intensity: null };
    const long = { feeling: "流水账没有情绪词".repeat(40), intensity: null };
    expect(imprintStrength(short)).toBe(imprintStrength(long));
    // 旧公式 long 会因 lengthBonus 更高：短 1.0 vs 长 1.5 —— 这里必须相等才算修好
    expect(imprintStrength(long)).toBe(1);
  });
  test("短句带强度 > 长句无强度（方向摆正）", () => {
    expect(imprintStrength({ feeling: "崩", intensity: "满" }))
      .toBeGreaterThan(imprintStrength({ feeling: "很长很长的流水账".repeat(20), intensity: null }));
  });
});

describe("R7-3 valenceOf：否定/去重/混合", () => {
  test("需求原句 '不烦躁不沮丧、豁然开朗' 不判负", () => {
    expect(valenceOf("不烦躁不沮丧、豁然开朗")).toBeGreaterThan(0); // 旧: -3(含丧双计)→ 偏负
  });
  test("'豁然开朗' 被识别为正", () => {
    expect(valenceOf("豁然开朗")).toBeGreaterThan(0); // 旧 POS 无'开朗' → 0/中性
  });
  test("'沮丧' 不双计：'沮丧但爽' 明显偏正（旧代码丧+沮丧双扣→仍负）", () => {
    expect(valenceOf("沮丧但爽")).toBeGreaterThan(0);
  });
  test("基本盘没修坏：纯负仍负、纯正仍正、'不爽'判负", () => {
    expect(valenceOf("好丧")).toBeLessThan(0);
    expect(valenceOf("踏实")).toBeGreaterThan(0);
    expect(valenceOf("不爽")).toBeLessThan(0);
  });
});

describe("R7-4 死亡螺旋编辑腿：返工必须耦合真实测试受挫", () => {
  test("大重构：同文件改 15 次但测试全过 → 不亮灯（旧单腿会误亮）", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    for (let i = 0; i < 15; i++)
      appendSituation(db, { sessionId: "s", kind: "file_edit", payload: { path: "src/big.ts" } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: true } }, clock);
    appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok: true } }, clock);
    const est = estimateMood(db, { clock });
    expect(est.spiral.active).toBe(false);
  });
  test("同文件改 15 次但完全没跑测试（failsToday=0）→ 不亮灯", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    for (let i = 0; i < 15; i++)
      appendSituation(db, { sessionId: "s", kind: "file_edit", payload: { path: "src/big.ts" } }, clock);
    const est = estimateMood(db, { clock });
    expect(est.spiral.active).toBe(false); // 旧代码 maxEdits>=8 单腿必亮
  });
  test("返工 + 真受挫(3失败不连挂5) → 亮灯", () => {
    const db = tmpDb();
    const clock = frozenClock(NOW);
    for (let i = 0; i < 10; i++)
      appendSituation(db, { sessionId: "s", kind: "file_edit", payload: { path: "src/big.ts" } }, clock);
    for (const ok of [false, true, false, true, false])
      appendSituation(db, { sessionId: "s", kind: "test_run", payload: { ok } }, clock);
    const est = estimateMood(db, { clock });
    expect(est.spiral.active).toBe(true);
  });
});
