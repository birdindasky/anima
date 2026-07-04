// F-3 增量切片原语 entriesBetween（DESIGN-WORKER-RESUME §v5.7）。
// 命门：上下界两种"找不到"语义不同——
//   下界 sinceUuid（水位线）找不到 → 保守从头（库层去重兜，安全）；
//   上界 targetUuid（入队快照）找不到 → 并发读 live transcript 时 target 还没落到 worker 文件视图，
//     绝不退化全量（会吞 target 之后内容却只推旧 target 水位线→推过头→永久漏），返回 {ok:false}。
import { describe, expect, test } from "bun:test";
import { entriesBetween, type TranscriptEntry } from "../src/transcript";

function ent(uuid: string): TranscriptEntry {
  return {
    type: "user",
    uuid,
    sessionId: "s1",
    cwd: null,
    timestamp: null,
    isMeta: false,
    isSidechain: false,
    role: "user",
    content: uuid,
  };
}
const E = ["a", "b", "c", "d", "e"].map(ent); // a b c d e

describe("entriesBetween", () => {
  test("since=null target=null → 全量，lastUuid=末条", () => {
    const r = entriesBetween(E, null, null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries.map((e) => e.uuid)).toEqual(["a", "b", "c", "d", "e"]);
      expect(r.lastUuid).toBe("e");
    }
  });

  test("since=null target=中间c → [a..c]，lastUuid=c", () => {
    const r = entriesBetween(E, null, "c");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
      expect(r.lastUuid).toBe("c");
    }
  });

  test("since=b target=e → (b..e]＝c d e，lastUuid=e", () => {
    const r = entriesBetween(E, "b", "e");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries.map((e) => e.uuid)).toEqual(["c", "d", "e"]);
      expect(r.lastUuid).toBe("e");
    }
  });

  test("since=b target=d → 中段 c d，lastUuid=d", () => {
    const r = entriesBetween(E, "b", "d");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries.map((e) => e.uuid)).toEqual(["c", "d"]);
  });

  test("🔴 上界 target 找不到（live 还没落盘）→ ok:false，绝不退化全量", () => {
    const r = entriesBetween(E, "b", "zzz-not-yet");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("target_not_visible");
  });

  test("下界 since 找不到（文件被重写/轮转）→ 保守从头到 target，不报错", () => {
    const r = entriesBetween(E, "gone-rotated", "c");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries.map((e) => e.uuid)).toEqual(["a", "b", "c"]); // 从头，靠库层去重兜
      expect(r.lastUuid).toBe("c");
    }
  });

  test("since=target=同一条 → 无新回合，空切片，lastUuid=该条", () => {
    const r = entriesBetween(E, "c", "c");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(0);
      expect(r.lastUuid).toBe("c"); // 水位线推到 c（无内容可写、但游标前进避免空转）
    }
  });

  test("target 在 since 之前（异常/水位线已超前）→ 空切片，lastUuid=target（调用方须单调不回退）", () => {
    const r = entriesBetween(E, "d", "b");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(0);
      expect(r.lastUuid).toBe("b");
    }
  });

  test("空 transcript + 有 target → target 找不到 → ok:false", () => {
    const r = entriesBetween([], "x", "y");
    expect(r.ok).toBe(false);
  });

  test("空 transcript + 无 target → 空切片 lastUuid=null", () => {
    const r = entriesBetween([], null, null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(0);
      expect(r.lastUuid).toBeNull();
    }
  });
});
