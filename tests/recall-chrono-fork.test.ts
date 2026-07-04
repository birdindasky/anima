// DESIGN-WORK-TIMELINE §3A：召回入口分叉。order='chrono' + 有时间窗 → 走 listReceiptsChrono（time-only，query 可空）；
// 否则 relevance 路逐字不变（零回归 F-NEW-1：空 query 维持短路返空，sinceTs 不绕过短路）。
// 红灯先行：实现前 RecallOptions 无 order/sinceTs/untilTs，入口不分叉。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { insertExperience } from "../src/experiences";
import { frozenClock } from "../src/clock";
import { searchMemoryIndex, searchMemoryIndexHybrid } from "../src/recall";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-fork-${process.pid}-${n++}.db`));
const SINCE = "2026-06-12T16:00:00.000Z";
const UNTIL = "2026-06-13T16:00:00.000Z";
const clock = frozenClock("2026-06-13T03:00:00.000Z");
const noEmbed = async () => null;

describe("召回入口 chrono 分叉 + 零回归", () => {
  test("chrono + 时间窗 + 空 query → 走 listReceiptsChrono（time-only 能返当日小票）", () => {
    const db = freshDb();
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git push" }, occurredAt: "2026-06-13T03:00:00.000Z" });
    const out = searchMemoryIndex(db, "", { order: "chrono", sinceTs: SINCE, untilTs: UNTIL, project: "/p", clock });
    expect(out.length).toBe(1);
    expect(out[0]!.source).toBe("situation");
    expect(out[0]!.line).toContain("git push");
  });

  test("零回归：默认 relevance + 空 query → 维持短路返空（即便给了 sinceTs 也不绕过）", () => {
    const db = freshDb();
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git push" }, occurredAt: "2026-06-13T03:00:00.000Z" });
    expect(searchMemoryIndex(db, "", { project: "/p", clock }).length).toBe(0);
    // 给了时间窗但 order 仍是默认 relevance → 不走 chrono、维持空 query 短路
    expect(searchMemoryIndex(db, "", { sinceTs: SINCE, untilTs: UNTIL, project: "/p", clock }).length).toBe(0);
  });

  test("零回归：默认 relevance + 有 query → 照旧命中经历（行为不变）", () => {
    const db = freshDb();
    insertExperience(db, {
      sessionId: "s1", project: "/p", kind: "decision", content: "决定改用 YAML 配置",
      feeling: null, keywords: ["YAML", "配置"], occurredAt: "2026-06-13T03:00:00.000Z",
    });
    const out = searchMemoryIndex(db, "YAML 配置", { project: "/p", clock });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.source).toBe("experience");
  });

  test("hybrid 入口同样分叉：chrono + 时间窗 + 空 query → 小票时间线", async () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_edit", project: "/p", payload: { path: "/p/config.ts", change: "yaml" }, occurredAt: "2026-06-13T03:00:00.000Z" });
    const out = await searchMemoryIndexHybrid(db, "", noEmbed, { order: "chrono", sinceTs: SINCE, untilTs: UNTIL, project: "/p", clock });
    expect(out.length).toBe(1);
    expect(out[0]!.line).toContain("/p/config.ts");
  });
});
