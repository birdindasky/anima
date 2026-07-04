// 时区基建：localDate / localDayIndex 在 UTC↔东八区边界的行为
// 边界点：东八区午夜 = 前一日 UTC 16:00（00:00 +08:00 = 16:00Z）
import { describe, expect, test } from "bun:test";
import { localDate, localDayIndex } from "../src/tz";

describe("tz（东八区换算）", () => {
  test("localDate：跨东八区午夜边界（16:00Z）翻日", () => {
    expect(localDate("2026-06-12T15:59:59.000Z")).toBe("2026-06-12"); // 东八区 06-12 23:59
    expect(localDate("2026-06-12T16:00:00.000Z")).toBe("2026-06-13"); // 东八区 06-13 00:00
    expect(localDate("2026-06-12T18:00:00.000Z")).toBe("2026-06-13"); // 东八区 06-13 02:00
  });

  test("localDate：接受 Date 入参", () => {
    expect(localDate(new Date("2026-06-12T16:00:00.000Z"))).toBe("2026-06-13");
  });

  test("localDayIndex：跨边界差 1，边界内差 0", () => {
    const before = localDayIndex("2026-06-12T15:59:59.000Z"); // 东八区 06-12
    const after = localDayIndex("2026-06-12T16:00:00.000Z"); // 东八区 06-13
    expect(after - before).toBe(1);

    const sameDayEarly = localDayIndex("2026-06-12T16:00:00.000Z"); // 东八区 06-13 00:00
    const sameDayLate = localDayIndex("2026-06-13T15:00:00.000Z"); // 东八区 06-13 23:00
    expect(sameDayLate - sameDayEarly).toBe(0);
  });
});
