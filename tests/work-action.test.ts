// work_action 蒸馏（§3B）：校验放行 + content<200 + 事实接地防编造 + 落库 feeling 恒 NULL
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { storeSelfReviewResult, type GeneratedSelfReview } from "../src/selfReview";
import { validateSelfReview } from "../src/validator";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-wa-${Date.now()}-${n++}.db`));
// deno-lint-ignore no-explicit-any
const mkRaw = (items: any[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ review: "今天干了点活", feeling: "", intensity: "", keywords: ["x"], items, ...extra });

describe("validator 放行 work_action", () => {
  test("合法 work_action（content<200、文件接地）→ 收", () => {
    const r = validateSelfReview(
      mkRaw([{ type: "work_action", content: "把 config.ts 的 TOML 换成 YAML", keywords: ["config.ts", "YAML"] }]),
      "改了 config.ts 的解析",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items.length).toBe(1);
      expect(r.value.items[0].type).toBe("work_action");
    }
  });

  test("work_action content ≥200 字 → 丢这一条、不毁整份自评（M-2）", () => {
    const long = "改" + "x".repeat(250);
    const r = validateSelfReview(
      mkRaw([
        { type: "work_action", content: long, keywords: [] },
        { type: "work_action", content: "git commit 修 bug", keywords: ["git"] },
      ]),
      "git",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items.length).toBe(1); // 超长那条被丢
      expect(r.value.items[0].content).toContain("git commit");
    }
  });

  test("work_action 提及素材里没有的文件 → 事实接地拦下（防编造，M-2）", () => {
    const r = validateSelfReview(
      mkRaw([{ type: "work_action", content: "重写了 ghost.ts 的核心逻辑", keywords: [] }]),
      "今天只碰了 real.ts", // ghost.ts 不在素材
    );
    expect(r.ok).toBe(false);
  });

  test("四类老 item 不受影响（零回归）", () => {
    const r = validateSelfReview(
      mkRaw([{ type: "preference", content: "用户要中文回复", keywords: [] }]),
      "",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.items[0].type).toBe("preference");
  });
});

describe("validator 解析 flaws（option 2 结构化失误字段，2026-06-26）", () => {
  test("flaws 是字符串数组 → 原样进 value.flaws", () => {
    const r = validateSelfReview(mkRaw([], { flaws: ["方向带偏、整段返工", "误判了用户意图"] }), "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flaws).toEqual(["方向带偏、整段返工", "误判了用户意图"]);
  });

  test("flaws 缺省 → []（向后兼容：旧自评不带此字段也放行）", () => {
    const r = validateSelfReview(mkRaw([]), "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flaws).toEqual([]);
  });

  test("flaws 非数组 / 含非字符串 / 空串 → 宽容强制（[] 或过滤），绝不毁整份自评", () => {
    const r1 = validateSelfReview(mkRaw([], { flaws: "不是数组" }), "");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.flaws).toEqual([]);
    const r2 = validateSelfReview(mkRaw([], { flaws: ["真失误", "", 123, "   "] }), "");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.flaws).toEqual(["真失误"]);
  });

  test("flaws 超 20 条 → 截 20；单条超 300 字 → 截断", () => {
    const many = Array.from({ length: 25 }, (_, i) => `失误${i}`);
    const r = validateSelfReview(mkRaw([], { flaws: ["x".repeat(400), ...many] }), "");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.flaws.length).toBe(20);
      expect(r.value.flaws[0].length).toBe(300); // 超长条截 300
    }
  });
});

describe("落库 work_action：kind 正确、feeling 恒 NULL、绑 session", () => {
  test("work_action → experiences kind='work_action'、feeling IS NULL、source_session 对", () => {
    const db = freshDb();
    const generated: GeneratedSelfReview = {
      ok: true,
      attempts: 1,
      value: {
        review: "今天把解析换了",
        feeling: "松了口气", // 日级 feeling 有；work_action item 不该带
        intensity: "",
        keywords: ["config.ts"],
        items: [{ type: "work_action", content: "config.ts 换 YAML 修 emoji", keywords: ["config.ts"] }],
      },
    };
    const material = {
      sessionId: "sess-1",
      project: "/proj",
      conversation: [],
      events: ["x command_run {}"],
      bookmarks: [],
      evidenceText: "config.ts emoji",
    };
    // deno-lint-ignore no-explicit-any
    storeSelfReviewResult(db, generated, { material: material as any });

    // deno-lint-ignore no-explicit-any
    const wa = db
      .query("SELECT content, feeling, source_session FROM experiences WHERE kind='work_action'")
      .all() as any[];
    expect(wa.length).toBe(1);
    expect(wa[0].feeling).toBeNull(); // 恒 NULL → 守心情主权 + 不进 mood 聚合
    expect(wa[0].source_session).toBe("sess-1");
    expect(wa[0].content).toContain("config.ts");

    // 对照：self_review 本身 feeling 可以有（日级情绪不受影响）
    // deno-lint-ignore no-explicit-any
    const sr = db.query("SELECT feeling FROM experiences WHERE kind='self_review'").get() as any;
    expect(sr.feeling).toBe("松了口气");
  });
});
