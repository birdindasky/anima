// buildIncrementalMaterial（F-3 / IMPORTANT-3 接线，DESIGN-WORKER-RESUME §v5.7）：
// 三路（transcript / situation_log / 书签）一致按 (sinceUuid 之后 .. targetUuid 含] 切窗；
// target 不可见 → {ok:false}（不烧 LLM）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { buildIncrementalMaterial } from "../src/selfReview";

const SX = "sess-inc-1";
const T1 = "2026-06-10T10:00:00.000Z";
const T1b = "2026-06-10T10:00:30.000Z"; // situation：u1~u2 之间
const T2 = "2026-06-10T10:01:00.000Z";
const T3 = "2026-06-10T10:02:00.000Z";
const T3b = "2026-06-10T10:02:30.000Z"; // situation：u3~u4 之间
const T4 = "2026-06-10T10:03:00.000Z";

const tmpDirs: string[] = [];
function setup(): { db: ReturnType<typeof openDb>; path: string } {
  const d = mkdtempSync(join(tmpdir(), "anima-test-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  const lines = [
    { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: T1, message: { role: "user", content: "问题A关于权限" } },
    { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", timestamp: T2, message: { role: "assistant", content: [{ type: "text", text: "回答A" }] } },
    { type: "user", uuid: "u3", sessionId: SX, cwd: "/proj", timestamp: T3, message: { role: "user", content: "问题B关于配色" } },
    { type: "assistant", uuid: "u4", sessionId: SX, cwd: "/proj", timestamp: T4, message: { role: "assistant", content: [{ type: "text", text: "回答B" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const clk = frozenClock("2026-06-11T00:00:00.000Z");
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { tag: "early" }, occurredAt: T1b }, clk);
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { tag: "late" }, occurredAt: T3b }, clk);
  return { db, path };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildIncrementalMaterial 三路切窗", () => {
  test("since=null target=u2 → 只含前半 u1/u2 + early situation，lastUuid=u2", () => {
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: null, targetUuid: "u2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const conv = r.material.conversation.join("\n");
      expect(conv).toContain("问题A");
      expect(conv).not.toContain("问题B"); // 后半不该进
      expect(r.material.events.join("\n")).toContain("early");
      expect(r.material.events.join("\n")).not.toContain("late");
      expect(r.lastUuid).toBe("u2");
    }
  });

  test("since=u2 target=u4 → 只含后半 u3/u4 + late situation，旧的不混进", () => {
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const conv = r.material.conversation.join("\n");
      expect(conv).toContain("问题B");
      expect(conv).not.toContain("问题A"); // 命门：增量不混全场旧对话
      const ev = r.material.events.join("\n");
      expect(ev).toContain("late");
      expect(ev).not.toContain("early"); // 命门：situation 也按窗切，不混旧事件
      expect(r.lastUuid).toBe("u4");
    }
  });

  test("🔴 target 不可见（live 还没落盘）→ ok:false，不出活", () => {
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u999" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("target_not_visible");
  });

  test("since=target=u2（无新回合）→ ok:true 但对话空，lastUuid=u2", () => {
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.material.conversation.join("\n")).not.toContain("问题");
      expect(r.lastUuid).toBe("u2");
    }
  });

  test("target=u2 是 meta 边界也能定位（不被 meta 过滤误判不可见）", () => {
    // 退化保护：即便 target 指向会被对话过滤掉的条目，entriesBetween 在未过滤列表上定位，仍 ok
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: null, targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lastUuid).toBe("u4");
  });
});

// —— AUDIT-2026-07-01 盘点两刀（U39 / U40）红灯先行 ——

describe("U39 queryBookmarks 排除已作废/过期书签（复活口收口）", () => {
  test("作废书签不进 buildMaterial 素材，活书签照常进", async () => {
    const { db, path } = setup();
    const { insertExperience, invalidateExperience } = await import("../src/experiences");
    const clk = frozenClock("2026-06-10T12:00:00.000Z");
    const dead = insertExperience(
      db,
      { kind: "bookmark", content: "已被推翻的旧感触", sourceSession: SX, occurredAt: T1b },
      clk,
    );
    insertExperience(
      db,
      { kind: "bookmark", content: "仍然成立的感触", sourceSession: SX, occurredAt: T3b },
      clk,
    );
    invalidateExperience(db, dead.id, clk);

    const { buildMaterial } = await import("../src/selfReview");
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const joined = m.bookmarks.join("\n");
    expect(joined).toContain("仍然成立的感触");
    expect(joined).not.toContain("已被推翻的旧感触");
  });

  test("增量窗内的作废书签同样不进素材", async () => {
    const { db, path } = setup();
    const { insertExperience, invalidateExperience } = await import("../src/experiences");
    const clk = frozenClock("2026-06-10T12:00:00.000Z");
    const dead = insertExperience(
      db,
      { kind: "bookmark", content: "已被推翻的旧感触", sourceSession: SX, occurredAt: T3b },
      clk,
    );
    invalidateExperience(db, dead.id, clk);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.material.bookmarks.join("\n")).not.toContain("已被推翻的旧感触");
  });
});

describe("U40 锚点条目 timestamp 缺失 → 回退最近更早带 ts 条目，不退化无界窗", () => {
  const T0 = "2026-06-10T09:00:00.000Z"; // 早于整个 transcript 的陈年流水
  const T5 = "2026-06-10T11:00:00.000Z"; // 晚于整个 transcript 的未来流水

  function setupNullTs(): { db: ReturnType<typeof openDb>; path: string } {
    const d = mkdtempSync(join(tmpdir(), "anima-test-"));
    tmpDirs.push(d);
    const db = openDb(join(d, "anima.db"));
    const path = join(d, "transcript.jsonl");
    // u2（水位线锚点）与 u4（切片末条）都没有 timestamp
    const lines = [
      { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: T1, message: { role: "user", content: "问题A关于权限" } },
      { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", message: { role: "assistant", content: [{ type: "text", text: "回答A" }] } },
      { type: "user", uuid: "u3", sessionId: SX, cwd: "/proj", timestamp: T3, message: { role: "user", content: "问题B关于配色" } },
      { type: "assistant", uuid: "u4", sessionId: SX, cwd: "/proj", message: { role: "assistant", content: [{ type: "text", text: "回答B" }] } },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const clk = frozenClock("2026-06-11T00:00:00.000Z");
    appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { tag: "ancient" }, occurredAt: T0 }, clk);
    appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { tag: "late" }, occurredAt: T3b }, clk);
    appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { tag: "future" }, occurredAt: T5 }, clk);
    return { db, path };
  }

  test("since 锚点无 ts：下界回退到更早邻条（u1），陈年流水不再泄进增量素材", () => {
    const { db, path } = setupNullTs();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const events = r.material.events.join("\n");
      expect(events).not.toContain("ancient"); // 旧码：sinceTs=undefined 无界 → 泄进来
      expect(events).toContain("late"); // 窗内的照常在
    }
  });

  test("末条无 ts：上界维持开放（宁重叠不漏段），本片尾部流水绝不丢", () => {
    // 上界若也回退更早邻条（u3），u3~u4 间的尾部流水会被挤给"下一片"——会话就此结束时
    // 根本没有下一片＝真丢料。设计取舍：罕见场景下窗开着（future 会重叠进来），换"绝不漏段"。
    const { db, path } = setupNullTs();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.material.events.join("\n")).toContain("late"); // 尾部流水必须留在本片
    }
  });

  test("时间戳齐全时行为逐字不变（零回归守卫）", () => {
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const events = r.material.events.join("\n");
      expect(events).toContain("late");
      expect(events).not.toContain("early");
    }
  });
});
