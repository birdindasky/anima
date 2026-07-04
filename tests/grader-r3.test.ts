// 独立验收考官（R3：书签/承接致自评误杀丢记忆）。盲考——只按需求写，绝不引用实现方自测。
// 缺陷：validateSelfReview 的事实接地（findUngroundedPaths：产物提及的文件路径必须在 evidenceText 里）
// 用的 evidenceText 只拼 conversation+events，漏了 bookmarks 与 priorSliceSummary；而 buildSelfReviewPrompt
// 把书签与承接自评也喂给模型（规则 6 要求"只提素材里真实出现的文件"）→ 模型忠实引用书签里的文件 →
// 接地判失败 → 两次全败落 self_review_fallback 壳 → 整段真记忆丢，stageHeal 同口径永远愈不动。
// 修＝evidenceText 覆盖模型看得到的全部素材（补 bookmarks + priorSliceSummary），且不越界（跨会话/作废/
// 首片 不该进的绝不进），且真接地校验不被废掉。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { addBookmark } from "../src/bookmark";
import { appendSituation } from "../src/situation";
import {
  buildMaterial,
  buildIncrementalMaterial,
  runSelfReview,
  type Material,
} from "../src/selfReview";
import { validateSelfReview } from "../src/validator";
import { frozenClock } from "../src/clock";

const SX = "sess-grader-r3";
const clock = frozenClock("2026-06-11T00:00:00.000Z");
const T1 = "2026-06-10T10:00:00.000Z";
const T2 = "2026-06-10T10:01:00.000Z";
const TM = "2026-06-10T10:02:30.000Z"; // 落在 (u2,u4] 增量窗内
const T3 = "2026-06-10T10:02:00.000Z";
const T4 = "2026-06-10T10:03:00.000Z";

const tmpDirs: string[] = [];
function setup(): { db: ReturnType<typeof openDb>; path: string } {
  const d = mkdtempSync(join(tmpdir(), "anima-grader-r3-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  // 关键：对话/工具流水里**不出现任何文件路径**——这样接地能否通过完全取决于书签/承接是否进了 evidenceText。
  const lines = [
    { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: T1, message: { role: "user", content: "随便聊聊今天，没提任何文件" } },
    { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", timestamp: T2, message: { role: "assistant", content: [{ type: "text", text: "好的，聊。" }] } },
    { type: "user", uuid: "u3", sessionId: SX, cwd: "/proj", timestamp: T3, message: { role: "user", content: "继续闲扯" } },
    { type: "assistant", uuid: "u4", sessionId: SX, cwd: "/proj", timestamp: T4, message: { role: "assistant", content: [{ type: "text", text: "嗯，继续。" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { db, path };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 一份合法自评（只有 review 引用给定路径；其余字段全合规，故唯一能触发的失败点就是"接地"）。
const outputMentioning = (path: string): string =>
  JSON.stringify({
    review: `今天主要在 ${path} 那处折腾了很久，来回改了几版，最后总算过了，心里踏实。`,
    feeling: "",
    intensity: "",
    flaws: [],
    keywords: ["复盘"],
    items: [],
  });

// ───────────────────────── 1. 书签接地：full + incremental 两路 ─────────────────────────
describe("R3-1 书签里的文件名 → 引用它的自评接地通过", () => {
  test("full 路（buildMaterial）", () => {
    const { db, path } = setup();
    addBookmark(db, { sessionId: SX, content: "config.ts 那处改得真顺" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.evidenceText).toContain("config.ts");
    expect(validateSelfReview(outputMentioning("config.ts"), m.evidenceText).ok).toBe(true);
  });

  test("incremental 路（buildIncrementalMaterial）", () => {
    const { db, path } = setup();
    addBookmark(db, { sessionId: SX, content: "src/db.ts 的迁移拆句器有雷" }, clock);
    // 书签落在增量窗 (u2,u4] 内（addBookmark 用 systemClock 落 occurred_at≈now，故直接改 occurred_at 到窗内）
    db.run("UPDATE experiences SET occurred_at = ? WHERE kind='bookmark' AND source_session=?", [TM, SX]);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.material.evidenceText).toContain("src/db.ts");
    expect(validateSelfReview(outputMentioning("src/db.ts"), r.material.evidenceText).ok).toBe(true);
  });

  test("PATH_RE 各形态在书签里都接地（config.ts / src/x.ts / a/b/c.md / deep/nested/f.json）", () => {
    const { db, path } = setup();
    for (const f of ["config.ts", "src/x.ts", "a/b/c.md", "deep/nested/f.json"]) {
      addBookmark(db, { sessionId: SX, content: `书签提到了 ${f} 这个文件` }, clock);
    }
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    for (const f of ["config.ts", "src/x.ts", "a/b/c.md", "deep/nested/f.json"]) {
      expect(m.evidenceText).toContain(f);
      expect(validateSelfReview(outputMentioning(f), m.evidenceText).ok).toBe(true);
    }
  });
});

// ───────────────────────── 2. 承接（priorSliceSummary）接地 ─────────────────────────
describe("R3-2 上一片自评提到的文件 → 本片引用它接地通过", () => {
  test("incremental 有前片（sinceUuid!=null）：prior.content 进 evidenceText", () => {
    const { db, path } = setup();
    insertExperience(db, { kind: "self_review", content: "上一片把 worker.ts 的水位线逻辑理顺了", sourceSession: SX, occurredAt: "2026-06-10T09:00:00.000Z" }, clock);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.material.priorSliceSummary).toContain("worker.ts");
    expect(r.material.evidenceText).toContain("worker.ts");
    expect(validateSelfReview(outputMentioning("worker.ts"), r.material.evidenceText).ok).toBe(true);
  });

  test("愈合路 slicePos 上界：取壳原位之前那片当 prior，仍进 evidenceText", () => {
    const { db, path } = setup();
    // 早片（id 小）提 alpha.ts；晚片（id 大，模拟"未来已在库的 review"）提 beta.ts。
    const early = insertExperience(db, { kind: "self_review", content: "早片处理了 alpha.ts", sourceSession: SX, occurredAt: "2026-06-10T08:00:00.000Z" }, clock);
    const shell = insertExperience(db, { kind: "self_review_fallback", content: "壳", sourceSession: SX, occurredAt: "2026-06-10T09:00:00.000Z" }, clock);
    insertExperience(db, { kind: "self_review", content: "晚片处理了 beta.ts", sourceSession: SX, occurredAt: "2026-06-10T11:00:00.000Z" }, clock);
    // slicePos=壳id → 只取 COALESCE(order_seq,id) < 壳id 的最近真自评（=early），不误取晚片
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4", slicePos: shell.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.material.priorSliceSummary).toContain("alpha.ts");
    expect(r.material.priorSliceSummary).not.toContain("beta.ts");
    expect(r.material.evidenceText).toContain("alpha.ts");
    expect(validateSelfReview(outputMentioning("alpha.ts"), r.material.evidenceText).ok).toBe(true);
    expect(early.id).toBeLessThan(shell.id);
  });
});

// ───────────────────────── 3. 零回归：真接地校验没被废掉 ─────────────────────────
describe("R3-3 零回归——真编造/越界的文件仍被接地拦下", () => {
  test("素材里都没有的文件（full）仍判接地失败", () => {
    const { db, path } = setup();
    addBookmark(db, { sessionId: SX, content: "普通感触，没有文件名" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(validateSelfReview(outputMentioning("fabricated/ghost.ts"), m.evidenceText).ok).toBe(false);
  });

  test("素材里都没有的文件（incremental）仍判接地失败", () => {
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateSelfReview(outputMentioning("fabricated/ghost.ts"), r.material.evidenceText).ok).toBe(false);
  });

  test("conversation 里的文件仍接地（旧行为保留，没因改动丢掉对话腿）", () => {
    const { db } = setup();
    const d = mkdtempSync(join(tmpdir(), "anima-grader-r3c-"));
    tmpDirs.push(d);
    const p2 = join(d, "t.jsonl");
    writeFileSync(p2, JSON.stringify({ type: "user", uuid: "c1", sessionId: SX, cwd: "/proj", timestamp: T1, message: { role: "user", content: "帮我看下 handler.ts 的报错" } }) + "\n");
    const m = buildMaterial(db, { transcriptPath: p2, sessionId: SX });
    expect(m.evidenceText).toContain("handler.ts");
    expect(validateSelfReview(outputMentioning("handler.ts"), m.evidenceText).ok).toBe(true);
  });

  test("events（客观流水）里的文件仍接地（旧行为保留，没丢事件腿）", () => {
    const { db, path } = setup();
    appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { path: "src/router.ts" }, occurredAt: TM }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.evidenceText).toContain("src/router.ts");
    expect(validateSelfReview(outputMentioning("src/router.ts"), m.evidenceText).ok).toBe(true);
  });

  test("作废/过期的书签不进 evidenceText → 引用它仍判接地失败（补书签没顺带放行失效书签）", () => {
    const { db, path } = setup();
    const bm = addBookmark(db, { sessionId: SX, content: "invalidated.ts 这条书签待会作废掉" }, clock);
    db.run("UPDATE experiences SET invalid_at = ? WHERE id = ?", ["2026-06-10T12:00:00.000Z", bm.id]);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.evidenceText).not.toContain("invalidated.ts");
    expect(validateSelfReview(outputMentioning("invalidated.ts"), m.evidenceText).ok).toBe(false);
  });

  test("别的会话的书签不进本会话 evidenceText → 引用它仍判接地失败（补书签没跨会话放宽）", () => {
    const { db, path } = setup();
    addBookmark(db, { sessionId: "OTHER-SESSION", content: "leak.ts 属于另一个会话" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.evidenceText).not.toContain("leak.ts");
    expect(validateSelfReview(outputMentioning("leak.ts"), m.evidenceText).ok).toBe(false);
  });

  test("首片（sinceUuid=null）不注承接 → 前片提过的文件不接地", () => {
    const { db, path } = setup();
    insertExperience(db, { kind: "self_review", content: "更早的片提过 firstslice.ts", sourceSession: SX, occurredAt: "2026-06-10T09:00:00.000Z" }, clock);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: null, targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.material.priorSliceSummary).toBeUndefined();
    expect(r.material.evidenceText).not.toContain("firstslice.ts");
    expect(validateSelfReview(outputMentioning("firstslice.ts"), r.material.evidenceText).ok).toBe(false);
  });
});

// ───────────────────────── 4. 补书签没漏进别的素材腿（不该串味） ─────────────────────────
describe("R3-4 书签只进 bookmarks/evidenceText，不漏进 conversation/events", () => {
  test("material.conversation 与 material.events 不含书签内容", () => {
    const { db, path } = setup();
    addBookmark(db, { sessionId: SX, content: "BOOKMARKONLYTOKEN 独有标记" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.bookmarks.join("\n")).toContain("BOOKMARKONLYTOKEN");
    expect(m.conversation.join("\n")).not.toContain("BOOKMARKONLYTOKEN");
    expect(m.events.join("\n")).not.toContain("BOOKMARKONLYTOKEN");
    expect(m.evidenceText).toContain("BOOKMARKONLYTOKEN");
  });

  test("空书签+无承接：接地行为与旧口径（仅 conv+events）一致", () => {
    const { db } = setup();
    const d = mkdtempSync(join(tmpdir(), "anima-grader-r3e-"));
    tmpDirs.push(d);
    const p2 = join(d, "t.jsonl");
    writeFileSync(p2, JSON.stringify({ type: "user", uuid: "e1", sessionId: SX, cwd: "/proj", timestamp: T1, message: { role: "user", content: "只提 solo.ts 一个文件" } }) + "\n");
    const m = buildMaterial(db, { transcriptPath: p2, sessionId: SX });
    expect(m.bookmarks.length).toBe(0);
    // 旧口径也会含 solo.ts（在 conversation 腿）；新口径接地结论必须一致
    expect(validateSelfReview(outputMentioning("solo.ts"), m.evidenceText).ok).toBe(true);
    expect(validateSelfReview(outputMentioning("nothere.ts"), m.evidenceText).ok).toBe(false);
  });
});

// ───────────────────────── 5. 端到端：书签提文件、对话没提 → 不再落兜底壳 ─────────────────────────
describe("R3-5 端到端 runSelfReview——书签独有文件被忠实引用，不再误杀成兜底壳", () => {
  test("正例：mock LLM 引用书签里的 config.ts → 落真 self_review、无 fallback、无 self_review_failed", async () => {
    const { db, path } = setup();
    addBookmark(db, { sessionId: SX, content: "config.ts 那处的 TOML 换 YAML，修了 emoji 崩溃" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const llm = async () => outputMentioning("config.ts");
    const res = await runSelfReview(db, { material: m, llm, clock });
    expect(res.fallback).toBe(false); // 命门：真记忆没被误杀成壳
    expect(res.attempts).toBe(1); // 首试即过（接地不再拦）
    const real = db.query("SELECT content FROM experiences WHERE kind='self_review' AND source_session=?").get(SX) as { content: string } | null;
    expect(real?.content).toContain("config.ts");
    const shell = db.query("SELECT COUNT(*) c FROM experiences WHERE kind='self_review_fallback' AND source_session=?").get(SX) as { c: number };
    expect(shell.c).toBe(0);
    const failed = db.query("SELECT COUNT(*) c FROM situation_log WHERE kind='self_review_failed' AND session_id=?").get(SX) as { c: number };
    expect(failed.c).toBe(0);
  });

  test("负例（证接地闸没被废）：mock LLM 引用真编造文件 → 两次全败 → 落 self_review_fallback 壳 + self_review_failed marker", async () => {
    const { db, path } = setup();
    addBookmark(db, { sessionId: SX, content: "普通感触，没文件名" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const llm = async () => outputMentioning("totally/made-up.ts");
    const res = await runSelfReview(db, { material: m, llm, clock });
    expect(res.fallback).toBe(true); // 编造照样被拦到兜底
    expect(res.attempts).toBe(2); // 有界重试耗尽
    const shell = db.query("SELECT COUNT(*) c FROM experiences WHERE kind='self_review_fallback' AND source_session=?").get(SX) as { c: number };
    expect(shell.c).toBe(1);
    const real = db.query("SELECT COUNT(*) c FROM experiences WHERE kind='self_review' AND source_session=?").get(SX) as { c: number };
    expect(real.c).toBe(0);
    const failed = db.query("SELECT COUNT(*) c FROM situation_log WHERE kind='self_review_failed' AND session_id=?").get(SX) as { c: number };
    expect(failed.c).toBe(1);
  });
});
