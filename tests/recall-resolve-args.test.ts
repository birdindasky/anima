// DESIGN-WORK-TIMELINE §3C：MCP recall 工具参数解析（纯函数，零 LLM）。
// since 相对词(today/yesterday/this_week/Nd)→dayWindow 展开成 chrono 时间窗；ISO 绝对值→绝对窗；
// 无 since→relevance（零回归）；解析不了→不猜、退 relevance。query 可空。
// 红灯先行：实现前 recall.ts 无 resolveRecallArgs 导出。
import { describe, expect, test } from "bun:test";
import { frozenClock } from "../src/clock";
import { resolveRecallArgs, dayWindowFor } from "../src/recall";

const clock = frozenClock("2026-06-13T03:00:00.000Z"); // 东八 06-13 11:00

describe("resolveRecallArgs（MCP 参数→召回 opts）", () => {
  test("since 相对词 today → chrono + dayWindow 窗 + query 可空", () => {
    const { query, opts } = resolveRecallArgs({ since: "today", project: "/p" }, clock);
    expect(query).toBe("");
    expect(opts.order).toBe("chrono");
    expect(opts.sinceTs).toBe("2026-06-12T16:00:00.000Z");
    expect(opts.untilTs).toBe("2026-06-13T16:00:00.000Z");
    expect(opts.project).toBe("/p");
  });

  test("since 相对词可带 query（chrono 路 query 仅作筛、不挡）", () => {
    const { query, opts } = resolveRecallArgs({ since: "7d", query: "config" }, clock);
    expect(query).toBe("config");
    expect(opts.order).toBe("chrono");
    expect(opts.sinceTs).toBe("2026-06-06T16:00:00.000Z");
  });

  test("ISO 绝对 since/until → chrono 绝对窗", () => {
    const { opts } = resolveRecallArgs(
      { since: "2026-06-13T01:00:00.000Z", until: "2026-06-13T05:00:00.000Z" },
      clock,
    );
    expect(opts.order).toBe("chrono");
    expect(opts.sinceTs).toBe("2026-06-13T01:00:00.000Z");
    expect(opts.untilTs).toBe("2026-06-13T05:00:00.000Z");
  });

  test("ISO since 无 until → until 补为当下", () => {
    const { opts } = resolveRecallArgs({ since: "2026-06-13T01:00:00.000Z" }, clock);
    expect(opts.order).toBe("chrono");
    expect(opts.untilTs).toBe("2026-06-13T03:00:00.000Z"); // clock.now
  });

  test("无 since → relevance（零回归，不带时间窗）", () => {
    const { query, opts } = resolveRecallArgs({ query: "YAML 配置", project: "/p" }, clock);
    expect(query).toBe("YAML 配置");
    expect(opts.order).toBeUndefined();
    expect(opts.sinceTs).toBeUndefined();
  });

  test("解析不了的 since → 不猜、退 relevance（无时间窗）", () => {
    const { opts } = resolveRecallArgs({ since: "上礼拜八", query: "x" }, clock);
    expect(opts.order).toBeUndefined();
    expect(opts.sinceTs).toBeUndefined();
  });

  test("order='relevance' 显式绕过 since→chrono 推断（codex m2）", () => {
    const { opts } = resolveRecallArgs({ since: "today", order: "relevance" }, clock);
    expect(opts.order).toBeUndefined();
    expect(opts.sinceTs).toBeUndefined();
  });

  test("scope='actions' 透传到 chrono opts；非 actions 不带 scope", () => {
    expect(resolveRecallArgs({ since: "today", scope: "actions" }, clock).opts.scope).toBe("actions");
    expect(resolveRecallArgs({ since: "today", scope: "memory" }, clock).opts.scope).toBeUndefined();
    expect(resolveRecallArgs({ since: "today" }, clock).opts.scope).toBeUndefined();
  });

  test("dayWindowFor 暴露给工具层做相对词解析（薄封装 tz.dayWindow）", () => {
    expect(dayWindowFor("today", clock)).toEqual({
      sinceTs: "2026-06-12T16:00:00.000Z",
      untilTs: "2026-06-13T16:00:00.000Z",
    });
    expect(dayWindowFor("瞎写", clock)).toBeNull();
  });
});
