// R2（AUDIT-2026-07-02 对抗审查）红灯先行：管线自产 marker 回灌进后续切片素材。
// assembleMaterial 的 events 是**反向过滤**（只排 user_message），于是所有管线自产 marker
// （turn_flaws / echo_suppressed / self_review_failed / heal_* / makeup_* / digest_* / injection_warning …）
// 都被当"客观事件流水"捞进 material.events + evidenceText：前片失误被 LLM 当本片事件复述（日记双计）、
// echo_suppressed 装着被抑制记忆回喂 prompt（复读回路自破）、纯噪声切片被撑成非空白烧 LLM、
// self_review_failed 的 lastReason 出网。
// 修＝events 翻成白名单，只收真实 transcript 活动（TRANSCRIPT_ACTIVITY_KINDS 减 user_message）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { buildMaterial, buildIncrementalMaterial } from "../src/selfReview";
import { frozenClock } from "../src/clock";

const SX = "sess-marker-1";
const tmpDirs: string[] = [];
function setup() {
  const d = mkdtempSync(join(tmpdir(), "anima-marker-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  const lines = [
    { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T02:00:00.000Z", message: { role: "user", content: "上午的问题" } },
    { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T02:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "回答" }] } },
    { type: "user", uuid: "u3", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T06:00:00.000Z", message: { role: "user", content: "下午的问题" } },
    { type: "assistant", uuid: "u4", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T06:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "回答2" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { db, path };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const clock = frozenClock("2026-06-11T00:00:00.000Z");

// 归属夜合成正午锚（storeSelfReviewResult 就是这么写 marker 的），落在 u2(02:01Z)~u3(06:00Z) 之间
const NOON = "2026-06-10T04:00:00.000Z";

function seedMarkers(db: ReturnType<typeof setup>["db"]) {
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "turn_flaws", payload: { flaws: ["config.ts 方向带偏了整段返工"] }, occurredAt: NOON }, clock);
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "echo_suppressed", payload: { content: "被抑制的记忆原文片段 secret-memory" }, occurredAt: NOON }, clock);
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "self_review_failed", payload: { lastReason: "接地失败 host=secret-host-0421" }, occurredAt: NOON }, clock);
  // 真实活动（应保留）
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { path: "src/real.ts", tool: "Edit", change: "真实改动" }, occurredAt: "2026-06-10T05:00:00.000Z" }, clock);
}

describe("R2 events 只收真实活动，管线 marker 不回灌", () => {
  test("全量素材：三类管线 marker 全不进 events/evidenceText，真实活动在", () => {
    const { db, path } = setup();
    seedMarkers(db);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const ev = m.events.join("\n");
    expect(ev).not.toContain("turn_flaws");
    expect(ev).not.toContain("echo_suppressed");
    expect(ev).not.toContain("self_review_failed");
    expect(ev).not.toContain("secret-host-0421");
    expect(ev).not.toContain("被抑制的记忆");
    expect(ev).toContain("src/real.ts"); // 真实活动保留
    expect(m.evidenceText).not.toContain("secret-host-0421");
    expect(m.evidenceText).not.toContain("config.ts 方向带偏");
  });

  test("跨正午增量切片：前片 marker 不被捞进本片 events", () => {
    const { db, path } = setup();
    seedMarkers(db);
    // 切片窗 u2~u4：occurred_at 窗 (02:01Z, 06:01Z] 覆盖正午锚 04:00Z
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ev = r.material.events.join("\n");
      expect(ev).not.toContain("turn_flaws");
      expect(ev).not.toContain("echo_suppressed");
      expect(ev).not.toContain("self_review_failed");
      expect(ev).toContain("src/real.ts");
    }
  });

  test("纯 marker 切片不再被撑成非空 events（防白烧 LLM）", () => {
    const { db, path } = setup();
    // 只有管线 marker、无真实活动
    appendSituation(db, { sessionId: SX, project: "/proj", kind: "turn_flaws", payload: { flaws: ["x"] }, occurredAt: NOON }, clock);
    appendSituation(db, { sessionId: SX, project: "/proj", kind: "makeup_inert_tail", payload: { entries: 1 }, occurredAt: NOON }, clock);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u3" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.material.events.length).toBe(0);
  });

  test("全部六类真实活动 kind 都算 events（白名单不误杀）", () => {
    const { db, path } = setup();
    const kinds = ["file_edit", "file_read", "command_run", "test_run", "tool_error"];
    kinds.forEach((k, i) =>
      appendSituation(db, { sessionId: SX, project: "/proj", kind: k, payload: { path: `f${i}` }, occurredAt: `2026-06-10T05:0${i}:00.000Z` }, clock),
    );
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.events.length).toBe(5); // 五类活动全在（user_message 走对话不算 events）
  });
});
