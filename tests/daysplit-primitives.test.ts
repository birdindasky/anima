// day-split 基础原语：dayBoundUuid（东八日界，半开）+ atOrAfter（快照顺序判定，unsafe 语义）
// 红灯先行：DESIGN-DAYSPLIT §3.1/§3.2 + codex v3-GO（F1/F4）。
import { test, expect, describe } from "bun:test";
import { dayBoundUuid, atOrAfter, type TranscriptEntry } from "../src/transcript";

// 最小 entry 构造：只关心 uuid + timestamp
function e(uuid: string, timestamp: string | null): TranscriptEntry {
  return {
    type: "user",
    uuid,
    sessionId: null,
    cwd: null,
    timestamp,
    isMeta: false,
    isSidechain: false,
    role: "user",
    content: "",
  };
}

describe("dayBoundUuid（东八日界 半开 < dayT16:00:00.000Z）", () => {
  test("返回最后一条严格早于本日 16:00Z 的 uuid", () => {
    const entries = [
      e("a", "2026-06-17T07:00:00.000Z"), // 东八 15:00 当天
      e("b", "2026-06-17T15:59:59.999Z"), // 东八 23:59:59 当天 = 日界内最后一条
      e("c", "2026-06-17T16:00:00.000Z"), // 东八 次日 00:00 → 不属本日
      e("d", "2026-06-18T03:00:00.000Z"),
    ];
    expect(dayBoundUuid(entries, "2026-06-17")).toBe("b");
  });

  test("恰好 16:00:00.000Z 归下一天，不含入本日（F4 半开）", () => {
    const entries = [e("a", "2026-06-17T09:00:00.000Z"), e("x", "2026-06-17T16:00:00.000Z")];
    expect(dayBoundUuid(entries, "2026-06-17")).toBe("a"); // x 不算本日
  });

  test("全部活动都在本日界之后 → null（本会话本夜无可消化内容）", () => {
    const entries = [e("a", "2026-06-18T01:00:00.000Z"), e("b", "2026-06-18T05:00:00.000Z")];
    expect(dayBoundUuid(entries, "2026-06-17")).toBeNull();
  });

  test("null timestamp 条目跳过、不参与日界", () => {
    const entries = [e("a", "2026-06-17T09:00:00.000Z"), e("noTs", null), e("c", "2026-06-17T16:30:00.000Z")];
    expect(dayBoundUuid(entries, "2026-06-17")).toBe("a");
  });

  test("空 entries → null", () => {
    expect(dayBoundUuid([], "2026-06-17")).toBeNull();
  });
});

describe("atOrAfter（快照下标顺序；不在快照=unsafe）", () => {
  const entries = [e("w0", "t"), e("w1", "t"), e("w2", "t"), e("w3", "t")];

  test("a 在 b 之后 → true", () => {
    expect(atOrAfter(entries, "w3", "w1")).toBe(true);
  });
  test("a 在 b 之前 → false", () => {
    expect(atOrAfter(entries, "w1", "w3")).toBe(false);
  });
  test("a===b（到了）→ true", () => {
    expect(atOrAfter(entries, "w2", "w2")).toBe(true);
  });
  test("a 不在快照 → unsafe", () => {
    expect(atOrAfter(entries, "ghost", "w1")).toBe("unsafe");
  });
  test("b 不在快照 → unsafe", () => {
    expect(atOrAfter(entries, "w1", "ghost")).toBe("unsafe");
  });
  test("b 为 null（覆盖'无'）→ true（vacuous）", () => {
    expect(atOrAfter(entries, "w1", null)).toBe(true);
  });
  test("a 为 null（水位线为空，在一切之前）、b 非空 → false", () => {
    expect(atOrAfter(entries, null, "w1")).toBe(false);
  });
  test("a、b 都 null → true（覆盖'无'恒真）", () => {
    expect(atOrAfter(entries, null, null)).toBe(true);
  });
});
