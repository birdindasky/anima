// DESIGN-WORK-TIMELINE §3B：相对词 → 东八区自然日窗口（左闭右开 [since, until)）。
// 铁律：走注入 Clock（禁裸 Date.now）；输出 UTC ISO 串（与库 occurred_at 同格式可字符串比较）。
// 边界：东八区午夜 = 前一日 UTC 16:00（00:00 +08:00 = 16:00Z）。
// 红灯先行：实现前 tz.ts 无 dayWindow 导出。
//   今天/昨天精确落东八日界；Nd 滚动窗（含今天）；this_week=滚动7天；未知词返 null（不猜）；
//   左闭右开（since 含、until 不含）；禁 Date.now（只吃 clock）。
import { describe, expect, test } from "bun:test";
import { frozenClock } from "../src/clock";
import { dayWindow } from "../src/tz";

// 钟拨到东八区 06-13 10:00（= UTC 02:00），方便核日界
const clk = () => frozenClock("2026-06-13T02:00:00.000Z");

describe("dayWindow（相对词→东八区自然日窗口）", () => {
  test("today：[东八06-13 00:00, 东八06-14 00:00) = [06-12T16:00Z, 06-13T16:00Z)", () => {
    const w = dayWindow("today", clk());
    expect(w).toEqual({
      sinceTs: "2026-06-12T16:00:00.000Z",
      untilTs: "2026-06-13T16:00:00.000Z",
    });
  });

  test("yesterday：[东八06-12 00:00, 东八06-13 00:00)", () => {
    const w = dayWindow("yesterday", clk());
    expect(w).toEqual({
      sinceTs: "2026-06-11T16:00:00.000Z",
      untilTs: "2026-06-12T16:00:00.000Z",
    });
  });

  test("7d：滚动 7 天含今天 [东八06-07 00:00, 东八06-14 00:00)", () => {
    const w = dayWindow("7d", clk());
    expect(w).toEqual({
      sinceTs: "2026-06-06T16:00:00.000Z",
      untilTs: "2026-06-13T16:00:00.000Z",
    });
  });

  test("1d：等价 today", () => {
    expect(dayWindow("1d", clk())).toEqual(dayWindow("today", clk()));
  });

  test("3d：含今天的近 3 天 [东八06-11 00:00, 东八06-14 00:00)", () => {
    const w = dayWindow("3d", clk());
    expect(w).toEqual({
      sinceTs: "2026-06-10T16:00:00.000Z",
      untilTs: "2026-06-13T16:00:00.000Z",
    });
  });

  test("this_week：= 滚动 7 天（7d 别名）", () => {
    expect(dayWindow("this_week", clk())).toEqual(dayWindow("7d", clk()));
  });

  test("左闭右开：until 不含、since 含（窗口长度恰好整日数 × 86400000ms）", () => {
    const w = dayWindow("today", clk())!;
    const span = new Date(w.untilTs).getTime() - new Date(w.sinceTs).getTime();
    expect(span).toBe(86_400_000); // 整一天
  });

  test("未知相对词返 null（不猜，调用方退相关性召回）", () => {
    expect(dayWindow("blah", clk())).toBeNull();
    expect(dayWindow("", clk())).toBeNull();
    expect(dayWindow("0d", clk())).toBeNull(); // N 必须 ≥1
    expect(dayWindow("-3d", clk())).toBeNull();
  });

  test("只吃 clock：换钟到次日，窗口随之平移一天", () => {
    const w1 = dayWindow("today", frozenClock("2026-06-13T02:00:00.000Z"))!;
    const w2 = dayWindow("today", frozenClock("2026-06-14T02:00:00.000Z"))!;
    expect(new Date(w2.sinceTs).getTime() - new Date(w1.sinceTs).getTime()).toBe(86_400_000);
  });
});
