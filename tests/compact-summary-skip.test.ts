// R1（AUDIT-2026-07-02 对抗审查）红灯先行：compact 摘要被当"用户原话"整只吞入。
// 长会话 auto-compact 生成的 1-3 万字机器摘要行（type:"user" + isCompactSummary/isVisibleInTranscriptOnly）
// 被 readTranscriptEntries 当普通用户消息透传，三处遭殃：① capture 无长度帽写进 situation_log；
// ② assembleMaterial 全文进 material.conversation（二次复盘已复盘内容 + 挤爆素材预算）；
// ③ recall 按"用户原话"检索时那条"提到全场"的摘要霸榜。
// 修＝readTranscriptEntries 透传两标志 + capture/assembleMaterial 两消费点跳过（uuid/窗口空间不动）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { readTranscriptEntries } from "../src/transcript";
import { captureTranscript } from "../src/capture";
import { buildMaterial, buildIncrementalMaterial } from "../src/selfReview";
import { listSituations } from "../src/situation";
import { frozenClock } from "../src/clock";

const SX = "sess-compact-1";
const COMPACT_BODY =
  "This session is being continued from a previous conversation… " + "前半场已复盘的内容 vector 索引为什么慢 ".repeat(400);
const tmpDirs: string[] = [];
function setup() {
  const d = mkdtempSync(join(tmpdir(), "anima-compact-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  const lines = [
    { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:00:00.000Z", message: { role: "user", content: "真实问题A" } },
    { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "回答A" }] } },
    // compact 摘要行：字段照抄实机
    { type: "user", uuid: "c1", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:02:00.000Z", isCompactSummary: true, isVisibleInTranscriptOnly: true, isSidechain: false, message: { role: "user", content: COMPACT_BODY } },
    { type: "user", uuid: "u3", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:03:00.000Z", message: { role: "user", content: "真实问题B" } },
    { type: "assistant", uuid: "u4", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:04:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "回答B" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { db, path };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const clock = frozenClock("2026-06-11T00:00:00.000Z");

describe("R1 readTranscriptEntries 透传 compact 标志", () => {
  test("compact 行标志被解析出来（真实/普通行为 false）", () => {
    const { path } = setup();
    const es = readTranscriptEntries(path);
    const c = es.find((e) => e.uuid === "c1")!;
    expect(c.isCompactSummary).toBe(true);
    expect(c.isVisibleInTranscriptOnly).toBe(true);
    const u1 = es.find((e) => e.uuid === "u1")!;
    expect(u1.isCompactSummary).toBe(false);
    expect(u1.isVisibleInTranscriptOnly).toBe(false);
    // uuid 空间不变：compact 行仍在返回集里（不破坏窗口/水位线定位）
    expect(es.map((e) => e.uuid)).toEqual(["u1", "u2", "c1", "u3", "u4"]);
  });
});

describe("R1① compact 不进 situation_log", () => {
  test("captureTranscript 后无 compact 摘要的 user_message 行", () => {
    const { db, path } = setup();
    captureTranscript(db, path, { clock });
    const sits = listSituations(db, { sessionId: SX });
    const texts = sits.filter((s) => s.kind === "user_message").map((s) => String((s.payload as any).text));
    expect(texts).toContain("真实问题A");
    expect(texts).toContain("真实问题B");
    expect(texts.some((t) => t.includes("This session is being continued"))).toBe(false);
  });
});

describe("R1② compact 不进 material.conversation", () => {
  test("全量 buildMaterial：摘要不进对话、真实对话在", () => {
    const { db, path } = setup();
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const conv = m.conversation.join("\n");
    expect(conv).toContain("真实问题A");
    expect(conv).toContain("真实问题B");
    expect(conv).not.toContain("This session is being continued");
    expect(m.evidenceText).not.toContain("This session is being continued");
  });

  test("增量 buildIncrementalMaterial：跨 compact 的切片不吞摘要", () => {
    const { db, path } = setup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const conv = r.material.conversation.join("\n");
      expect(conv).toContain("真实问题B");
      expect(conv).not.toContain("This session is being continued");
    }
  });

  test("预算不再被摘要挤爆：真实新对话在素材里", () => {
    const { db, path } = setup();
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    // 摘要 ~13KB 若进对话会顶爆 CONVERSATION_BUDGET 挤出真实对话；跳过后两条都在
    expect(m.conversation.join("\n")).toContain("真实问题A");
    expect(m.conversation.join("\n")).toContain("真实问题B");
  });
});
