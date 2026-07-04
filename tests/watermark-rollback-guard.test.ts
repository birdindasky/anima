// AUDIT-2026-07-01 盘点 U28 红灯先行：水位线 CAS 原语不防回退。
// 病根：casWatermark 只做「旧值相等即换」，不校验 newUuid 在 transcript 序里不早于 oldUuid——
// 现有调用方各自写 atOrAfter 护栏所以没在烧，但新增一个漏写护栏的调用方就会把已消化段
// 重标未消化 → 重复记忆。修＝原语收一个**必传**的序见证参数（entries | null）：
//   - 传序列：old/new 都可见且 new 早于 old → 拒绝推进（false，一行不写）；
//   - 传 null：显式弃权（写者自证无 transcript 语境，可 grep 审计）；
//   - 漏传（undefined，bun 不查类型）：直接 throw——fail-loud，绝不静默跳守卫。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { casWatermark, advanceWatermarkOnly, readWatermark } from "../src/watermark";
import { frozenClock } from "../src/clock";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-wmguard-${process.pid}-${n++}.db`));
const NOW = "2026-06-10T12:00:00.000Z";
const ENTRIES = [{ uuid: "u1" }, { uuid: "u2" }, { uuid: "u3" }];

describe("U28 casWatermark 序见证防回退", () => {
  test("回退推进被拒：u3→u1（两者都在序里、new 更早）→ false 且水位线不动", () => {
    const db = freshDb();
    expect(casWatermark(db, "s1", null, "u3", NOW, null)).toBe(true);
    expect(casWatermark(db, "s1", "u3", "u1", NOW, ENTRIES)).toBe(false);
    expect(readWatermark(db, "s1")).toBe("u3");
  });

  test("正向推进照常：u1→u3 带序见证 → true", () => {
    const db = freshDb();
    expect(casWatermark(db, "s1", null, "u1", NOW, null)).toBe(true);
    expect(casWatermark(db, "s1", "u1", "u3", NOW, ENTRIES)).toBe(true);
    expect(readWatermark(db, "s1")).toBe("u3");
  });

  test("旧锚点不在序里（换 transcript 的合法 resume）→ 不拦，CAS 语义照旧", () => {
    const db = freshDb();
    expect(casWatermark(db, "s1", null, "zz", NOW, null)).toBe(true); // 旧文件推的水位线
    // 新 transcript 里没有 zz——序校验无从谈起，放行给 DB 层 CAS（WHERE last_uuid='zz' 命中即换）
    expect(casWatermark(db, "s1", "zz", "u1", NOW, ENTRIES)).toBe(true);
    expect(readWatermark(db, "s1")).toBe("u1");
  });

  test("显式 null＝弃权，行为与旧版逐字一致（含回退——弃权自负）", () => {
    const db = freshDb();
    expect(casWatermark(db, "s1", null, "u3", NOW, null)).toBe(true);
    expect(casWatermark(db, "s1", "u3", "u1", NOW, null)).toBe(true); // 弃权路不拦
    expect(readWatermark(db, "s1")).toBe("u1");
  });

  test("漏传见证（undefined）→ throw，绝不静默跳守卫", () => {
    const db = freshDb();
    // @ts-expect-error 故意漏传——bun 不做类型检查，运行时必须炸
    expect(() => casWatermark(db, "s1", null, "u1", NOW)).toThrow();
  });

  test("advanceWatermarkOnly 同守卫：回退被拒", () => {
    const db = freshDb();
    const clk = frozenClock(NOW);
    expect(advanceWatermarkOnly(db, "s1", null, "u2", null, clk)).toBe(true);
    expect(advanceWatermarkOnly(db, "s1", "u2", "u1", ENTRIES, clk)).toBe(false);
    expect(readWatermark(db, "s1")).toBe("u2");
  });
});
