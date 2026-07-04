// worker resume 迁移冷启动回填（DESIGN-WORKER-RESUME §9）——
// 给库里所有「已自评」会话回填复盘水位线，否则 worker 上线首夜会把全部历史会话
// 当成「水位线空＝从未复盘」整段重刷一遍（O(全库)烧 haiku + 错乱夜归属）。
// 回填值 = transcript 真末条 uuid；文件缺 → 退采集游标 → 退末条 user_message uuid → 跳过+告警。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { backfillReviewWatermark } from "../src/watermarkBackfill";

const NOW = "2026-06-17T16:00:00.000Z";
const clock = frozenClock(NOW);

const tmpDirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-wm-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 写一个 transcript 文件，文件名 = <sessionId>.jsonl（贴合 Claude Code 命名约定），首条 sessionId=会话 */
function writeTranscript(dir: string, sessionId: string, uuids: string[]): string {
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = uuids.map((u, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      uuid: u,
      sessionId,
      timestamp: "2026-06-10T10:00:00.000Z",
      message: { role: i % 2 === 0 ? "user" : "assistant", content: "x" },
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** 登记 capture_cursors（defaultFindTranscripts 与 basename 兜底都从这里读） */
function registerCursor(db: ReturnType<typeof openDb>, path: string, lastUuid: string): void {
  db.query(
    "INSERT INTO capture_cursors (transcript_path, last_uuid, updated_at) VALUES (?, ?, ?)",
  ).run(path, lastUuid, "2026-06-10T10:00:00.000Z");
}

/** 加一条自评经历（可选作废） */
function addReview(
  db: ReturnType<typeof openDb>,
  sessionId: string,
  kind: "self_review" | "self_review_fallback" = "self_review",
  invalid = false,
): void {
  const row = insertExperience(
    db,
    { kind, content: "回顾", sourceSession: sessionId, occurredAt: "2026-06-10T12:00:00.000Z" },
    clock,
  );
  if (invalid) {
    db.query("UPDATE experiences SET invalid_at = ? WHERE id = ?").run(NOW, row.id);
  }
}

function watermark(db: ReturnType<typeof openDb>, sessionId: string): string | null {
  const r = db
    .query("SELECT last_uuid FROM review_watermark WHERE session_id = ?")
    .get(sessionId) as { last_uuid: string } | null;
  return r?.last_uuid ?? null;
}

describe("§9 水位线迁移回填", () => {
  test("回填对象筛选：仅有未作废 self_review/fallback 的会话才回填", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));

    const pRev = writeTranscript(dir, "rev", ["a1", "a2"]);
    registerCursor(db, pRev, "a2");
    addReview(db, "rev"); // self_review → 回填

    const pFb = writeTranscript(dir, "fb", ["b1"]);
    registerCursor(db, pFb, "b1");
    addReview(db, "fb", "self_review_fallback"); // fallback 也算已复盘 → 回填

    const pInv = writeTranscript(dir, "inv", ["c1"]);
    registerCursor(db, pInv, "c1");
    addReview(db, "inv", "self_review", true); // 已作废 → 不回填

    const pNone = writeTranscript(dir, "none", ["d1"]);
    registerCursor(db, pNone, "d1");
    insertExperience(db, { kind: "event", content: "普通事件", sourceSession: "none" }, clock); // 非自评 → 不回填

    const r = backfillReviewWatermark(db, { clock });

    expect(r.total).toBe(2); // 只有 rev / fb
    expect(watermark(db, "rev")).toBe("a2");
    expect(watermark(db, "fb")).toBe("b1");
    expect(watermark(db, "inv")).toBeNull();
    expect(watermark(db, "none")).toBeNull();
    db.close();
  });

  test("回填值 = transcript 真末条 uuid（不是采集游标）", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    const p = writeTranscript(dir, "s1", ["u1", "u2", "u3"]);
    registerCursor(db, p, "u2"); // 采集游标停在 u2（比真末条 u3 浅）
    addReview(db, "s1");

    const r = backfillReviewWatermark(db, { clock });
    expect(watermark(db, "s1")).toBe("u3"); // 取真末条 u3，不是游标 u2
    expect(r.filledFromTranscript).toBe(1);
    db.close();
  });

  test("文件已删 → 退回 capture_cursors.last_uuid", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    // 登记游标指向一个不存在的文件（basename=会话名），不写文件
    registerCursor(db, join(dir, "gone.jsonl"), "curZ");
    addReview(db, "gone");

    const r = backfillReviewWatermark(db, { clock });
    expect(watermark(db, "gone")).toBe("curZ");
    expect(r.filledFromCursor).toBe(1);
    expect(r.filledFromTranscript).toBe(0);
    db.close();
  });

  test("文件与游标皆无 → 退回末条 user_message 的 payload.uuid", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    addReview(db, "sit"); // 无 transcript、无 capture_cursors
    appendSituation(db, { sessionId: "sit", kind: "user_message", payload: { text: "早", uuid: "sitU1" } }, clock);
    appendSituation(db, { sessionId: "sit", kind: "user_message", payload: { text: "晚", uuid: "sitU2" } }, clock);
    appendSituation(db, { sessionId: "sit", kind: "file_edit", payload: { path: "x.ts" } }, clock); // 无 uuid，最新

    const r = backfillReviewWatermark(db, { clock });
    expect(watermark(db, "sit")).toBe("sitU2"); // 末条带 uuid 的 user_message
    expect(r.filledFromSituation).toBe(1);
    db.close();
  });

  test("三路皆空 → 跳过不回填 + 计入 warnedSessions（不写 situation marker）", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    addReview(db, "blank"); // 无 transcript / 游标 / 带 uuid 的流水
    appendSituation(db, { sessionId: "blank", kind: "file_edit", payload: { path: "x.ts" } }, clock);

    const before = (db.query("SELECT count(*) c FROM situation_log").get() as { c: number }).c;
    const r = backfillReviewWatermark(db, { clock });

    expect(watermark(db, "blank")).toBeNull();
    expect(r.warnedSessions).toContain("blank");
    // 不往 situation_log 写带 session_id 的 marker（守 错盖夜 教训）
    const after = (db.query("SELECT count(*) c FROM situation_log").get() as { c: number }).c;
    expect(after).toBe(before);
    db.close();
  });

  test("幂等：已有水位线不覆盖", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    const p = writeTranscript(dir, "s1", ["u1", "u2"]);
    registerCursor(db, p, "u2");
    addReview(db, "s1");
    db.query("INSERT INTO review_watermark (session_id, last_uuid, updated_at) VALUES ('s1','preset','t0')").run();

    const r = backfillReviewWatermark(db, { clock });
    expect(watermark(db, "s1")).toBe("preset"); // 不被覆盖
    expect(r.skipped).toBe(1);
    expect(r.filledFromTranscript).toBe(0);
    db.close();
  });

  test("可断点续跑：二次运行全跳过、无重复行", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    const pa = writeTranscript(dir, "a", ["a1", "a2"]);
    registerCursor(db, pa, "a2");
    addReview(db, "a");
    const pb = writeTranscript(dir, "b", ["b1"]);
    registerCursor(db, pb, "b1");
    addReview(db, "b");

    const r1 = backfillReviewWatermark(db, { clock });
    expect(r1.filledFromTranscript).toBe(2);

    const r2 = backfillReviewWatermark(db, { clock }); // 再跑
    expect(r2.skipped).toBe(2);
    expect(r2.filledFromTranscript).toBe(0);

    const rows = (db.query("SELECT count(*) c FROM review_watermark").get() as { c: number }).c;
    expect(rows).toBe(2); // 无重复
    db.close();
  });

  // rank3（AUDIT-2026-07-01）：回填绝不把水位线钉到文件末条——「末次复盘后、回填前新增的轮次」会被
  // digest wmOld===tailUuid 永久跳过、静默丢。取最近自评所属夜的日界作保守水位线。
  test("rank3：复盘 day1 后 day2 又加了轮次、无水位线 → 回填设 day1 日界，不吞 day2 新轮次", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    // multi 会话：u1/u2 属东八 6-10（10:00Z<16:00Z 日界内），u3/u4 属东八 6-11（复盘后新增）
    const path = join(dir, "multi.jsonl");
    const mk = (u: string, ts: string, i: number) =>
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        uuid: u,
        sessionId: "multi",
        timestamp: ts,
        message: { role: i % 2 === 0 ? "user" : "assistant", content: "x" },
      });
    writeFileSync(
      path,
      [
        mk("u1", "2026-06-10T10:00:00.000Z", 0),
        mk("u2", "2026-06-10T11:00:00.000Z", 1),
        mk("u3", "2026-06-11T10:00:00.000Z", 2), // 复盘后新增（东八 6-11）
        mk("u4", "2026-06-11T11:00:00.000Z", 3),
      ].join("\n") + "\n",
    );
    registerCursor(db, path, "u4");
    // 只复盘了 6-10 夜（occurred_at 前 10 位=夜日期）
    insertExperience(
      db,
      { kind: "self_review", content: "回顾 6-10", sourceSession: "multi", occurredAt: "2026-06-10T12:00:00.000Z" },
      clock,
    );

    const r = backfillReviewWatermark(db, { clock });
    expect(r.filledFromTranscript).toBe(1);
    // 关键：水位线 = day1 日界 u2（不是文件末条 u4）——否则 u3/u4 会被永久当已复盘跳过、静默丢
    expect(watermark(db, "multi")).toBe("u2");
    db.close();
  });

  test("rank3 对照：会话复盘后无新活动（全在复盘夜内）→ 日界==文件末条，行为与旧一致、不丢", () => {
    const dir = newDir();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "inactive", ["v1", "v2", "v3"]); // 全 6-10T10:00Z
    registerCursor(db, path, "v3");
    insertExperience(
      db,
      { kind: "self_review", content: "回顾", sourceSession: "inactive", occurredAt: "2026-06-10T12:00:00.000Z" },
      clock,
    );
    backfillReviewWatermark(db, { clock });
    expect(watermark(db, "inactive")).toBe("v3"); // 日界==末条
    db.close();
  });
});
