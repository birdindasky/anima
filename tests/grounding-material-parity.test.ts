// R3（AUDIT-2026-07-02 对抗审查）红灯先行：事实接地证据文本与喂模型的素材不同口径 → 合法自评被误杀。
// buildSelfReviewPrompt 把 conversation + events + bookmarks + priorSliceSummary 全喂给模型（规则 6
// 要求"只提素材里真实出现的文件"），但 evidenceText 只拼 conversation + events——漏了 bookmarks 与
// priorSliceSummary。于是：会话书签里出现文件名（config.ts）而对话/事件流水没有 → 模型忠实引用书签里
// 的文件 → validateSelfReview 判"事实接地失败" → 两次全败 → 落 self_review_fallback 壳 → 整段真记忆丢，
// 且 stageHeal 用同口径 evidenceText 永远愈不动。
// 修＝evidenceText 覆盖模型能看到的全部素材（补 bookmarks + priorSliceSummary）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { buildMaterial, buildIncrementalMaterial } from "../src/selfReview";
import { validateSelfReview } from "../src/validator";
import { frozenClock } from "../src/clock";

const SX = "sess-ground-1";
const tmpDirs: string[] = [];
function setup() {
  const d = mkdtempSync(join(tmpdir(), "anima-ground-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  const lines = [
    { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:00:00.000Z", message: { role: "user", content: "随便聊聊今天" } },
    { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
    { type: "user", uuid: "u3", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:02:00.000Z", message: { role: "user", content: "继续" } },
    { type: "assistant", uuid: "u4", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:03:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "嗯" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { db, path };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const clock = frozenClock("2026-06-11T00:00:00.000Z");

// 模拟模型忠实引用书签里的文件名产出的自评（review 提 config.ts）
const outputMentioning = (path: string) =>
  JSON.stringify({ review: `今天在 ${path} 那处折腾了很久，最后过了。`, feeling: "", intensity: "", flaws: [], keywords: ["x"], items: [] });

describe("R3 evidenceText 覆盖书签（模型能看到 → 接地能核到）", () => {
  test("书签含文件名 config.ts，evidenceText 含它，引用它的自评接地通过", () => {
    const { db, path } = setup();
    insertExperience(db, { kind: "bookmark", content: "config.ts 那处改得真漂亮", sourceSession: SX, occurredAt: "2026-06-10T10:02:30.000Z" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    expect(m.evidenceText).toContain("config.ts");
    const v = validateSelfReview(outputMentioning("config.ts"), m.evidenceText);
    expect(v.ok).toBe(true); // 旧码：书签不在 evidenceText → 接地失败 → 误杀
  });

  test("增量素材同样覆盖书签", () => {
    const { db, path } = setup();
    insertExperience(db, { kind: "bookmark", content: "src/db.ts 的迁移拆句器有雷", sourceSession: SX, occurredAt: "2026-06-10T10:02:30.000Z" }, clock);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.material.evidenceText).toContain("src/db.ts");
      expect(validateSelfReview(outputMentioning("src/db.ts"), r.material.evidenceText).ok).toBe(true);
    }
  });
});

describe("R3 evidenceText 覆盖 priorSliceSummary（承接框喂了 → 接地能核到）", () => {
  test("上一片自评提到的文件，本片引用它接地通过", () => {
    const { db, path } = setup();
    // 上一片真自评提到 worker.ts
    insertExperience(db, { kind: "self_review", content: "上一片把 worker.ts 的水位线逻辑理顺了", sourceSession: SX, occurredAt: "2026-06-10T09:00:00.000Z" }, clock);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.material.priorSliceSummary).toContain("worker.ts");
      expect(r.material.evidenceText).toContain("worker.ts"); // 旧码：承接框喂了但 evidenceText 没有
      expect(validateSelfReview(outputMentioning("worker.ts"), r.material.evidenceText).ok).toBe(true);
    }
  });
});

describe("R3 零回归：真编造的文件仍被接地拦下", () => {
  test("素材（对话/事件/书签/承接）里都没有的文件，引用它仍判接地失败", () => {
    const { db, path } = setup();
    insertExperience(db, { kind: "bookmark", content: "普通感触没有文件名", sourceSession: SX, occurredAt: "2026-06-10T10:02:30.000Z" }, clock);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const v = validateSelfReview(outputMentioning("fabricated/ghost.ts"), m.evidenceText);
    expect(v.ok).toBe(false); // 真编造照样拦
  });
});
