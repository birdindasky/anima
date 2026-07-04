// 独立验收考官 —— R2 修复：material.events 白名单（唯一输入=交办需求，未看开发者自测）。
//
// 需求复述：assembleMaterial 组装 material.events 曾用「反向过滤」——只排 user_message、收其余全部
// situation_log 行。管线自产的审计 marker（turn_flaws / echo_suppressed / self_review_failed / heal_* /
// makeup_* / digest_* / injection_warning / work_capture_overflow / diary_faithfulness_unresolved …）的
// occurred_at 用「归属夜合成正午锚」，跨正午切片（上午干活、下午续）会把上午的 marker 全捞进下午的
// material.events + evidenceText → 前片失误被 LLM 复述进日记（双计）、echo_suppressed 装的被抑制记忆
// 回喂破 echo 防线、纯 marker 切片被撑成非空白烧一次 LLM、self_review_failed 的 lastReason 出网。
// 声称修复：events 翻成白名单——只收真实 transcript 活动 kind（复用 TRANSCRIPT_ACTIVITY_KINDS 单一
// 事实源，减 user_message），任何管线 marker 不在白名单 → 永不进 events / evidenceText。
//
// 本考官不看 src 之外任何产物、不看开发者自测，marker 全集由我独立 grep 全部 appendSituation 落点 +
// capture.ts 的 work_capture_overflow 枚举而来。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { appendSituation, listSituations } from "../src/situation";
import { buildMaterial, buildIncrementalMaterial } from "../src/selfReview";
import { frozenClock } from "../src/clock";

const SX = "sess-r2-grader";
const clock = frozenClock("2026-07-01T00:00:00.000Z");

// 管线自产的 situation_log marker 全集（独立枚举：全部 appendSituation 落点 + capture 的
// work_capture_overflow）。这 20 种一律不得进 events / evidenceText。
const PIPELINE_MARKERS = [
  "turn_flaws",
  "echo_suppressed",
  "self_review_failed",
  "heal_success",
  "heal_exhausted",
  "heal_inert",
  "heal_since_gone",
  "heal_transcript_gone",
  "makeup_watermark_ahead",
  "makeup_transcript_missing",
  "makeup_inert_tail",
  "makeup_backfill_required",
  "makeup_late_orphan",
  "makeup_daysplit_snapshot_missing",
  "digest_fallback",
  "digest_late_reclaim",
  "digest_decay_snapshot",
  "injection_warning",
  "work_capture_overflow",
  "diary_faithfulness_unresolved",
] as const;

// 白名单 = TRANSCRIPT_ACTIVITY_KINDS 减 user_message：这 5 种真实活动必须保留进 events，不得误杀。
const ACTIVITY_KEPT = ["file_edit", "file_read", "command_run", "test_run", "tool_error"] as const;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 跨正午切片 transcript：上午 u1(10:00)→u2(11:00)，下午 u3(13:00)→u4(13:01)。
// buildIncrementalMaterial(sinceUuid=u1, targetUuid=u4) 的时间窗 = (10:00, 13:01]，
// 正午锚 12:00 的 marker 全落进窗内——正是被指控的攻击路径。
function setup() {
  const d = mkdtempSync(join(tmpdir(), "anima-r2-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  const lines = [
    { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "上午先看看昨天那个 bug" } },
    { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", timestamp: "2026-07-01T11:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "好，我读一下" }] } },
    { type: "user", uuid: "u3", sessionId: SX, cwd: "/proj", timestamp: "2026-07-01T13:00:00.000Z", message: { role: "user", content: "下午继续弄" } },
    { type: "assistant", uuid: "u4", sessionId: SX, cwd: "/proj", timestamp: "2026-07-01T13:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "行" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { db, path };
}

// 给每种 marker 塞独一无二的泄漏哨兵；断言它绝不出现在 events / evidenceText。
const markerSentinel = (k: string) => `MARKERLEAK_${k}`;
// 给每种活动塞保留哨兵；断言它必须出现在 events。
const keepSentinel = (k: string) => `ACTIVITYKEEP_${k}`;

/** 把 20 种 marker（正午锚 12:00）+ 5 种活动（12:30）+ user_message（12:15）全塞进窗内。 */
function seedWindow(db: ReturnType<typeof openDb>) {
  for (const kind of PIPELINE_MARKERS) {
    appendSituation(db, { sessionId: SX, project: "/proj", kind, payload: { leak: markerSentinel(kind), lastReason: "不该出网的失败原因" }, occurredAt: "2026-07-01T12:00:00.000Z" }, clock);
  }
  for (const kind of ACTIVITY_KEPT) {
    appendSituation(db, { sessionId: SX, project: "/proj", kind, payload: { keep: keepSentinel(kind), path: `src/${kind}.ts` }, occurredAt: "2026-07-01T12:30:00.000Z" }, clock);
  }
  // situation_log 里的 user_message marker：白名单里没它（用户话已在对话节选）——不得进 events。
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "user_message", payload: { text: "UMSG_SHOULD_NOT_BE_IN_EVENTS", uuid: "x" }, occurredAt: "2026-07-01T12:15:00.000Z" }, clock);
}

describe("R2 攻击面①：跨正午窗内每一种管线 marker 都不得进 events / evidenceText（buildIncrementalMaterial 真实攻击路径）", () => {
  test("20 种 marker + user_message 全被白名单挡在 events 外；5 种活动全保留", () => {
    const { db, path } = setup();
    seedWindow(db);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u1", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const eventsText = r.material.events.join("\n");

    // 每一种 marker：哨兵 + kind 名都不得出现在 events。
    for (const k of PIPELINE_MARKERS) {
      expect(eventsText).not.toContain(markerSentinel(k));
      expect(eventsText).not.toContain(k);
    }
    // self_review_failed 的 lastReason 绝不出网。
    expect(eventsText).not.toContain("不该出网的失败原因");
    // situation_log 的 user_message marker 不进 events。
    expect(eventsText).not.toContain("UMSG_SHOULD_NOT_BE_IN_EVENTS");

    // 5 种真实活动全部保留、一个不少。
    for (const k of ACTIVITY_KEPT) {
      expect(eventsText).toContain(keepSentinel(k));
      expect(eventsText).toContain(k);
    }
    // events 行数恰等于活动数（无 marker 混入、无误杀）。
    expect(r.material.events.length).toBe(ACTIVITY_KEPT.length);
  });

  test("evidenceText（喂云端 LLM 的接地全文）不含任何 marker 正文 / lastReason", () => {
    const { db, path } = setup();
    seedWindow(db);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u1", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const k of PIPELINE_MARKERS) {
      expect(r.material.evidenceText).not.toContain(markerSentinel(k));
    }
    expect(r.material.evidenceText).not.toContain("不该出网的失败原因");
    expect(r.material.evidenceText).not.toContain("UMSG_SHOULD_NOT_BE_IN_EVENTS");
    // 活动流水仍在 evidenceText 里（接地要靠它）。
    for (const k of ACTIVITY_KEPT) expect(r.material.evidenceText).toContain(keepSentinel(k));
  });
});

describe("R2 攻击面②：buildMaterial 全量口径（无时间窗，全会话 marker 直灌）同样挡住", () => {
  // buildMaterial 把全会话 situation 一股脑传进 assembleMaterial——这是白名单最纯粹的考法：
  // 窗 / session 过滤全不参与，只剩白名单在挡。
  test("全量素材里 20 种 marker 全不进 events，5 种活动全保留", () => {
    const { db, path } = setup();
    seedWindow(db);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const eventsText = m.events.join("\n");
    for (const k of PIPELINE_MARKERS) {
      expect(eventsText).not.toContain(markerSentinel(k));
      expect(eventsText).not.toContain(k);
    }
    for (const k of ACTIVITY_KEPT) expect(eventsText).toContain(keepSentinel(k));
    expect(m.events.length).toBe(ACTIVITY_KEPT.length);
  });
});

describe("R2 攻击面③：纯 marker 切片 → material.events.length === 0（worker/digest 的空增量闸真能触发）", () => {
  // 真实消费者（worker.ts:188 / digest.ts:392,592,1090）判空全靠 `inc.material.events.length === 0`。
  // 旧反向过滤下纯 marker 切片会被撑成非空 → 白烧一次 LLM；修复后必须归零。
  test("窗内只有 marker、无任何活动 → events 为空、但 sliceEntryCount>0（对应 makeup_inert_tail 空转不烧 LLM）", () => {
    const { db, path } = setup();
    for (const kind of PIPELINE_MARKERS) {
      appendSituation(db, { sessionId: SX, project: "/proj", kind, payload: { leak: markerSentinel(kind) }, occurredAt: "2026-07-01T12:00:00.000Z" }, clock);
    }
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u1", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.material.events.length).toBe(0); // 空增量闸成立
    expect(r.sliceEntryCount).toBeGreaterThan(0); // 有 transcript 条目 → 落 makeup_inert_tail 而非真空
  });
});

describe("R2 零回归①：fallbackSituations（inc.situations 原始未过滤）没被顺手过滤掉", () => {
  // storeSelfReviewResult 的兜底壳靠 inc.situations 统计（user_message 数 / test_run 成败 / file_edit 路径）。
  // 白名单只作用于 events 投影，绝不能连累这份原始流水——否则兜底壳统计失真。
  test("inc.situations 含全部 26 行（20 marker + 5 活动 + 1 user_message），一行不少", () => {
    const { db, path } = setup();
    seedWindow(db);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u1", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kinds = r.situations.map((s) => s.kind);
    expect(r.situations.length).toBe(PIPELINE_MARKERS.length + ACTIVITY_KEPT.length + 1);
    for (const k of PIPELINE_MARKERS) expect(kinds).toContain(k);
    for (const k of ACTIVITY_KEPT) expect(kinds).toContain(k);
    expect(kinds).toContain("user_message"); // 兜底壳要数它
  });
});

describe("R2 零回归②：collectTurnFlaws 的数据源（situation_log 的 turn_flaws 行）毫发无损", () => {
  // collectTurnFlaws（digest.ts）直接查 situation_log WHERE kind='turn_flaws'，与 events 投影零关联。
  // 白名单只过滤 events 数组、绝不动表——证明：turn_flaws 行仍在库、payload.flaws 完好、且照样查得到。
  test("turn_flaws 被挡出 events，但原行 + payload.flaws 在 situation_log 里完好可查", () => {
    const { db, path } = setup();
    const flawList = ["上午那版方向带偏、整段返工", "把 config.ts 改错了被用户纠正"];
    appendSituation(db, { sessionId: SX, project: "/proj", kind: "turn_flaws", payload: { flaws: flawList }, occurredAt: "2026-07-01T12:00:00.000Z" }, clock);
    // 白名单把它挡出 events
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.events.join("\n")).not.toContain("方向带偏");
    // 但 collectTurnFlaws 的数据源完好：直查 situation_log 仍拿得到 flaws 原文
    const rows = listSituations(db, { sessionId: SX, kind: "turn_flaws" });
    expect(rows.length).toBe(1);
    expect((rows[0]!.payload as { flaws: string[] }).flaws).toEqual(flawList);
    // 复刻 collectTurnFlaws 的取数路径，坐实它仍能汇总
    const raw = db.query("SELECT payload FROM situation_log WHERE kind = 'turn_flaws'").all() as { payload: string }[];
    const gathered = raw.flatMap((r) => (JSON.parse(r.payload) as { flaws: string[] }).flaws);
    expect(gathered).toEqual(flawList);
  });
});
