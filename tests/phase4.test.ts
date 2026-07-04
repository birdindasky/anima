// Phase 4 看见（显示侧）— T4.1~T4.4（见 tests/TEST-PLAN.md）

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, getExperience } from "../src/experiences";
import { addBookmark } from "../src/bookmark";
import { appendSituation } from "../src/situation";
import { estimateMood, renderMoodPanel } from "../src/mood";
import { refreshBadge, sanitizeBadge } from "../src/badge";

const NOW = "2026-06-11T15:00:00.000Z";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-test-"));
  tmpDirs.push(dir);
  return { dbPath: join(dir, "anima.db"), badgePath: join(dir, "badge.txt") };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 今天有情绪经历 + 客观流水的常规库 */
function seedCalm(db: ReturnType<typeof openDb>, clock = frozenClock(NOW)) {
  addBookmark(db, { content: "联调一次过，挺顺", feeling: "踏实", sessionId: "s1" }, clock);
  appendSituation(db, { sessionId: "s1", kind: "test_run", payload: { command: "bun test", ok: true } }, clock);
  appendSituation(db, { sessionId: "s1", kind: "test_run", payload: { command: "bun test", ok: false } }, clock);
  appendSituation(db, { sessionId: "s1", kind: "test_run", payload: { command: "bun test", ok: true } }, clock);
}

/** 死亡螺旋流水：同文件反复改 + 测试连挂 5 次 */
function seedSpiral(db: ReturnType<typeof openDb>, clock = frozenClock(NOW)) {
  insertExperience(db, { kind: "event", content: "权限测试一直修不动", feeling: "烦，有点上头" }, clock);
  for (let i = 0; i < 5; i++) {
    appendSituation(db, { sessionId: "s2", kind: "file_edit", payload: { path: "src/auth.ts", tool: "Edit" } }, clock);
    appendSituation(db, { sessionId: "s2", kind: "test_run", payload: { command: "bun test", ok: false } }, clock);
  }
}

describe("T4.1 只读铁律", () => {
  test("源码面审计：mood 模块无任何写入口、不挂 LLM", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "mood.ts"), "utf8");
    for (const banned of [
      "INSERT", "UPDATE ", "DELETE", ".run(", "writeFileSync", "mkdirSync",
      "insertExperience", "appendSituation", "recordInjection", "recordHook",
      "writeBadge", "invalidateExperience", "claudeCli", "llm",
    ]) {
      expect(src).not.toContain(banned);
    }
  });

  test("运行时审计：估计+渲染零写入；归因事件真实在库", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedCalm(db, clock);

    const before = (db.query("SELECT total_changes() c").get() as any).c;
    const est = estimateMood(db, { clock });
    renderMoodPanel(est, { badgePath: "/tmp/badge.txt" });
    const after = (db.query("SELECT total_changes() c").get() as any).c;
    expect(after).toBe(before); // 一行都没写

    expect(est.attributions.length).toBeGreaterThan(0);
    for (const a of est.attributions) {
      expect(getExperience(db, a.id)).not.toBeNull(); // 归因不是编的
    }
  });
});

describe("T4.2 螺旋亮灯", () => {
  test("同文件反复改+测试连挂 5 次 → 亮灯+锦囊+badge 变色", () => {
    const { dbPath, badgePath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedSpiral(db, clock);

    const est = estimateMood(db, { clock });
    expect(est.spiral.active).toBe(true);
    expect(est.spiral.reason).toContain("连挂");
    expect(est.spiral.rescue.length).toBeGreaterThanOrEqual(3);
    expect(est.spiral.rescue.join("")).toContain("小任务"); // 给它一个赢

    refreshBadge(db, badgePath, clock);
    expect(readFileSync(badgePath, "utf8")).toStartWith("⚠"); // 变色

    // 面板上锦囊可见
    const panel = renderMoodPanel(est, { badgePath });
    expect(panel).toContain("救援锦囊");
  });

  test("平静流水不报警（误报检查）", () => {
    const { dbPath, badgePath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedCalm(db, clock);

    const est = estimateMood(db, { clock });
    expect(est.spiral.active).toBe(false);

    refreshBadge(db, badgePath, clock);
    expect(readFileSync(badgePath, "utf8")).not.toContain("⚠");
  });
});

describe("T4.3 badge 合规", () => {
  test("恒 ≤50 字符、无 ANSI/控制字符；感受里夹脏字符也干净", () => {
    expect(sanitizeBadge("a".repeat(200)).length).toBeLessThanOrEqual(50);
    expect(sanitizeBadge("\x1b[31m红色\x1b[0m 心情")).toBe("红色 心情");
    expect(sanitizeBadge("第一行\n第二行\t制表")).toBe("第一行 第二行 制表");

    const { dbPath, badgePath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    // 投毒：感受里夹 ANSI 和换行
    addBookmark(db, { content: "x", feeling: "\x1b[31m烦\x1b[0m\n死了".repeat(10), sessionId: "s" }, clock);
    refreshBadge(db, badgePath, clock);
    const badge = readFileSync(badgePath, "utf8");
    expect(badge.length).toBeLessThanOrEqual(50);
    expect(badge).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  test("无 claude-hud 退化：badge 是纯文件，面板照常给出路径", () => {
    const { dbPath, badgePath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedCalm(db, clock);
    refreshBadge(db, badgePath, clock);

    const panel = renderMoodPanel(estimateMood(db, { clock }), { badgePath });
    expect(panel).toContain(badgePath); // 没装 HUD 也能 cat 这个路径
    expect(readFileSync(badgePath, "utf8").length).toBeGreaterThan(0);
  });
});

describe("T4.4 估计确定性（纯函数）", () => {
  test("同一事件历史+同一表针 → 估计与面板逐字节相同", () => {
    const { dbPath, badgePath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedSpiral(db, clock);
    seedCalm(db, clock);

    const a = estimateMood(db, { clock: frozenClock(NOW) });
    const b = estimateMood(db, { clock: frozenClock(NOW) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(renderMoodPanel(a, { badgePath })).toBe(renderMoodPanel(b, { badgePath }));

    // 拨表才会变（时间是输入，不是副作用）
    const later = estimateMood(db, { clock: frozenClock("2026-06-14T15:00:00.000Z") });
    expect(JSON.stringify(later)).not.toBe(JSON.stringify(a));
  });

  test("面板输出不含心情数值（自然语言标签）", () => {
    const { dbPath, badgePath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedSpiral(db, clock);
    const panel = renderMoodPanel(estimateMood(db, { clock }), { badgePath });
    expect(panel).not.toMatch(/(心情|情绪|电荷|charge)[^\n]{0,10}\d/);
    expect(panel).not.toMatch(/\d+\s*\/\s*10|\d+(\.\d+)?%/);
  });
});
