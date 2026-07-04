// INDEPENDENT GRADER tests (not authored by the implementer).
// Goal: prove the F-2 split's load-bearing claims by deriving truth from behavior,
// NOT by trusting the implementer's own assertions.
//
//   ① generateSelfReview writes ZERO rows to BOTH experiences AND situation_log,
//      on the pass path AND the exhausted path AND the LLM-throws path.
//   ② storeSelfReviewResult writes everything (review + items + dedup markers / fallback).
//   ③ runSelfReview == generate + store, byte-for-byte behavior vs. pre-split:
//      pass→review+items, dedup suppression still fires, exhaust→fallback+marker,
//      occurredAt/clock threaded, attempts counting identical, return values identical.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import {
  buildMaterial,
  generateSelfReview,
  storeSelfReviewResult,
  runSelfReview,
  type Material,
  type GeneratedSelfReview,
} from "../src/selfReview";

import { materializeFixture, DEMO_PROJECT } from "./fixtures/materialize";
const FIXTURE = materializeFixture(join(import.meta.dir, "fixtures", "transcript-day.jsonl"));
const SESSION = "sess-fix-1";
const NOW = "2026-06-10T18:00:00.000Z";
const OCC = "2026-06-09T23:30:00.000Z"; // makeup-night occurredAt, distinct from clock NOW

const tmpDirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-grader-"));
  tmpDirs.push(d);
  return join(d, "anima.db");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function countExp(db: ReturnType<typeof openDb>): number {
  return (db.query("SELECT count(*) c FROM experiences").get() as { c: number }).c;
}
function countSit(db: ReturnType<typeof openDb>): number {
  return (db.query("SELECT count(*) c FROM situation_log").get() as { c: number }).c;
}
function mat(db: ReturnType<typeof openDb>): Material {
  return buildMaterial(db, { transcriptPath: FIXTURE, sessionId: SESSION });
}

// A valid review. NB: the fixture's evidenceText contains NO file paths (build only
// captures user/assistant text + situation rows, and a fresh db has no captured events),
// so the validator's grounding check rejects any path-like token. Keep review path-free.
function goodReview(items: unknown[] = []): string {
  return JSON.stringify({
    review: "今天修了鉴权模块的 mock 没复位的 bug，复跑全过。",
    feeling: "踏实",
    intensity: "中等",
    keywords: ["auth", "权限"],
    items,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ① generateSelfReview — ZERO DB writes on every path (the 命门)
// ─────────────────────────────────────────────────────────────────────────
describe("GRADER ① generateSelfReview 零写库（两表都查）", () => {
  test("过验路径：experiences 与 situation_log 行数都不变", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    // seed a row so that an item would be a near-duplicate IF generate ever called findNearDuplicate+append
    insertExperience(db, { kind: "decision", project: m.project, content: "以后破坏性操作先加护栏再跑" });
    const eBefore = countExp(db);
    const sBefore = countSit(db);

    const g = await generateSelfReview({
      material: m,
      llm: async () =>
        goodReview([
          { type: "decision", content: "以后破坏性操作先加护栏再跑", keywords: ["护栏"] }, // dup of seed
          { type: "preference", content: "改配色以后先问用户", keywords: ["配色"] },
        ]),
    });

    expect(g.ok).toBe(true);
    if (g.ok) expect(g.value.items).toHaveLength(2);
    // 命门：generate 既没写 experiences（没落 self_review/items），也没写 situation_log（没落 echo_suppressed）
    expect(countExp(db)).toBe(eBefore);
    expect(countSit(db)).toBe(sBefore);
  });

  test("连续失败路径：两表都不变（绝不偷写 fallback / marker）", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    const eBefore = countExp(db);
    const sBefore = countSit(db);

    const g = await generateSelfReview({
      material: m,
      llm: async () => "not json at all",
      maxAttempts: 3,
    });

    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.attempts).toBe(3);
      expect(g.lastReason.length).toBeGreaterThan(0);
    }
    expect(countExp(db)).toBe(eBefore);
    expect(countSit(db)).toBe(sBefore);
  });

  test("LLM 抛异常路径：捕获不冒泡，两表都不变", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    const eBefore = countExp(db);
    const sBefore = countSit(db);

    const g = await generateSelfReview({
      material: m,
      llm: async () => {
        throw new Error("claude -p 失败（exit 1）");
      },
      maxAttempts: 2,
    });

    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.attempts).toBe(2);
      expect(g.lastReason).toContain("LLM 调用失败");
    }
    expect(countExp(db)).toBe(eBefore);
    expect(countSit(db)).toBe(sBefore);
  });

  test("retry-then-pass：第一次坏第二次好 → attempts=2、仍零写库", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    const eBefore = countExp(db);
    const sBefore = countSit(db);
    let n = 0;
    const g = await generateSelfReview({
      material: m,
      llm: async () => (++n === 1 ? "garbage" : goodReview()),
      maxAttempts: 2,
    });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.attempts).toBe(2);
    expect(countExp(db)).toBe(eBefore);
    expect(countSit(db)).toBe(sBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② storeSelfReviewResult — writes the full set, sync, threads occurredAt/clock
// ─────────────────────────────────────────────────────────────────────────
describe("GRADER ② storeSelfReviewResult 写库完整 + 透传", () => {
  test("ok:true 落 self_review + 每条 item，occurred_at=occurredAt（非 clock）", () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    const generated: GeneratedSelfReview = {
      ok: true,
      attempts: 1,
      value: {
        review: "改了 src/auth.ts。",
        feeling: "踏实",
        intensity: "中等",
        keywords: ["auth"],
        items: [
          { type: "decision", content: "架构定 worker 走方案 C", keywords: ["worker"] },
          { type: "preference", content: "回复用中文", keywords: ["中文"] },
        ],
      },
    };
    const r = storeSelfReviewResult(db, generated, { material: m, clock: frozenClock(NOW), occurredAt: OCC });
    expect(r.fallback).toBe(false);
    expect(r.suppressed).toBe(0);
    expect(r.storedIds).toHaveLength(3); // review + 2 items
    expect(r.attempts).toBe(1);

    const rows = db
      .query("SELECT kind, occurred_at, created_at FROM experiences ORDER BY id")
      .all() as { kind: string; occurred_at: string; created_at: string }[];
    expect(rows.map((x) => x.kind)).toEqual(["self_review", "decision", "preference"]);
    // occurredAt 透传：occurred_at=OCC，created_at=clock NOW
    for (const row of rows) {
      expect(row.occurred_at).toBe(OCC);
      expect(row.created_at).toBe(NOW);
    }
  });

  test("ok:false 落 fallback 空壳 + self_review_failed marker；payload=attempts+lastReason(≤200)", () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    const longReason = "X".repeat(500);
    const r = storeSelfReviewResult(
      db,
      { ok: false, attempts: 2, lastReason: longReason },
      { material: m, clock: frozenClock(NOW), occurredAt: OCC },
    );
    expect(r.fallback).toBe(true);
    expect(r.suppressed).toBe(0);
    expect(r.storedIds).toHaveLength(1);

    const fb = db
      .query("SELECT occurred_at, content FROM experiences WHERE kind='self_review_fallback'")
      .get() as { occurred_at: string; content: string };
    expect(fb.occurred_at).toBe(OCC);
    expect(fb.content).toContain("自评生成失败 2 次");

    const marker = db
      .query("SELECT payload, occurred_at FROM situation_log WHERE kind='self_review_failed'")
      .get() as { payload: string; occurred_at: string };
    const payload = JSON.parse(marker.payload);
    expect(payload.attempts).toBe(2);
    expect(payload.lastReason).toHaveLength(200); // truncated
    expect(payload.lastReason).toBe("X".repeat(200));
    expect(marker.occurred_at).toBe(OCC); // marker 归属所属夜
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ runSelfReview — zero regression vs. pre-split monolith
// ─────────────────────────────────────────────────────────────────────────
describe("GRADER ③ runSelfReview 零回归", () => {
  test("过验 → self_review + items 落库，返回值齐全", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    const r = await runSelfReview(db, {
      material: m,
      llm: async () => goodReview([{ type: "event", content: "修好了 auth mock 未复位的根因", keywords: ["auth"] }]),
      clock: frozenClock(NOW),
    });
    expect(r.fallback).toBe(false);
    expect(r.attempts).toBe(1);
    expect(r.suppressed).toBe(0);
    expect(r.storedIds).toHaveLength(2);
    expect((db.query("SELECT count(*) c FROM experiences WHERE kind='self_review'").get() as { c: number }).c).toBe(1);
    expect((db.query("SELECT count(*) c FROM experiences WHERE kind='event'").get() as { c: number }).c).toBe(1);
  });

  test("条目去重抑制仍生效：撞库的 item 被压，落 echo_suppressed，不入 experiences", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    // seed an existing memory the item will duplicate
    insertExperience(db, { kind: "preference", project: m.project, content: "改配色以后先问用户，别自作主张" });
    const r = await runSelfReview(db, {
      material: m,
      llm: async () =>
        goodReview([
          { type: "preference", content: "改配色以后先问用户，别自作主张", keywords: ["配色"] }, // dup → suppressed
          { type: "event", content: "auth mock 未复位是这次回归挂的根因", keywords: ["auth"] }, // novel → stored
        ]),
      clock: frozenClock(NOW),
    });
    expect(r.fallback).toBe(false);
    expect(r.suppressed).toBe(1);
    // stored = review + the 1 novel event (dup not stored)
    expect(r.storedIds).toHaveLength(2);
    // the duplicate preference must NOT have produced a second preference row (only the seed)
    expect((db.query("SELECT count(*) c FROM experiences WHERE kind='preference'").get() as { c: number }).c).toBe(1);
    // echo_suppressed marker landed in situation_log
    const sup = db.query("SELECT payload FROM situation_log WHERE kind='echo_suppressed'").get() as {
      payload: string;
    } | null;
    expect(sup).not.toBeNull();
    expect(JSON.parse(sup!.payload).content).toContain("改配色");
  });

  test("失败 → fallback + marker；attempts 计数透传（连坏 maxAttempts 次）", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    let n = 0;
    const r = await runSelfReview(db, {
      material: m,
      llm: async () => {
        n++;
        return "broken";
      },
      maxAttempts: 3,
      clock: frozenClock(NOW),
    });
    expect(n).toBe(3); // LLM hit exactly maxAttempts times
    expect(r.fallback).toBe(true);
    expect(r.attempts).toBe(3);
    expect(r.storedIds).toHaveLength(1);
    const marker = db.query("SELECT payload FROM situation_log WHERE kind='self_review_failed'").get() as {
      payload: string;
    };
    expect(JSON.parse(marker.payload).attempts).toBe(3);
  });

  test("occurredAt 透传到所有落库行（含 review/items/marker）", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    await runSelfReview(db, {
      material: m,
      llm: async () => goodReview([{ type: "event", content: "auth mock 根因已定位", keywords: ["auth"] }]),
      clock: frozenClock(NOW),
      occurredAt: OCC,
    });
    const occs = (db.query("SELECT DISTINCT occurred_at o FROM experiences").all() as { o: string }[]).map((x) => x.o);
    expect(occs).toEqual([OCC]); // every experience row carries the makeup-night occurredAt
  });

  test("runSelfReview 默认 occurredAt 缺省 → occurred_at 回落到 clock.now()（实时收工语义不变）", async () => {
    const db = openDb(tmpDb());
    const m = mat(db);
    await runSelfReview(db, {
      material: m,
      llm: async () => goodReview(),
      clock: frozenClock(NOW),
    });
    const row = db.query("SELECT occurred_at FROM experiences WHERE kind='self_review'").get() as {
      occurred_at: string;
    };
    expect(row.occurred_at).toBe(NOW);
  });

  test("等价性：runSelfReview 的产物 == 手动 generate+store（同输入同输出）", async () => {
    // run path
    const dbA = openDb(tmpDb());
    const mA = mat(dbA);
    const llm = async () => goodReview([{ type: "event", content: "auth 根因记一笔", keywords: ["auth"] }]);
    const rRun = await runSelfReview(dbA, { material: mA, llm, clock: frozenClock(NOW), occurredAt: OCC });

    // manual two-step path on a fresh identical db
    const dbB = openDb(tmpDb());
    const mB = mat(dbB);
    const g = await generateSelfReview({ material: mB, llm });
    const rManual = storeSelfReviewResult(dbB, g, { material: mB, clock: frozenClock(NOW), occurredAt: OCC });

    expect(rRun.fallback).toBe(rManual.fallback);
    expect(rRun.attempts).toBe(rManual.attempts);
    expect(rRun.suppressed).toBe(rManual.suppressed);
    expect(rRun.storedIds.length).toBe(rManual.storedIds.length);

    const dumpA = dbA.query("SELECT kind, content, occurred_at FROM experiences ORDER BY id").all();
    const dumpB = dbB.query("SELECT kind, content, occurred_at FROM experiences ORDER BY id").all();
    expect(dumpA).toEqual(dumpB);
  });
});
