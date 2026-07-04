// 密钥脱敏第二条腿（2026-07-02 批，广度审 U30-③）红灯先行：
// capture 路的 situation payload 早走 scrubSecrets，但 selfReview 组装 Material 的**对话正文**
// （用户原话 + 助手文本）一直裸着——用户在对话里贴过的密钥会随 prompt 出网到云端 LLM、
// 还可能被自评复述进 append-only 记忆（不可逆）。修＝assembleMaterial 单一咽喉处对
// 对话文本过 scrubSecrets（与 capture 同一把刀，precision>recall 宁可误打码）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { buildMaterial, buildSelfReviewPrompt } from "../src/selfReview";

const SX = "sess-scrub-1";
const tmpDirs: string[] = [];
function setup(userText: string, assistantText: string) {
  const d = mkdtempSync(join(tmpdir(), "anima-scrub-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  const lines = [
    { type: "user", uuid: "u1", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:00:00.000Z", message: { role: "user", content: userText } },
    { type: "assistant", uuid: "u2", sessionId: SX, cwd: "/proj", timestamp: "2026-06-10T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { db, path };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("U30-③ 对话正文出网前脱敏", () => {
  test("用户原话里的前缀型 token 不进 Material/prompt", () => {
    const { db, path } = setup("这个 key 用不了：ghp_AbC123def456GHI789 帮我看看", "我看看。");
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const conv = m.conversation.join("\n");
    expect(conv).not.toContain("ghp_AbC123def456GHI789");
    expect(conv).toContain("[REDACTED]");
    expect(m.evidenceText).not.toContain("ghp_AbC123def456GHI789");
    expect(buildSelfReviewPrompt(m)).not.toContain("ghp_AbC123def456GHI789");
  });

  test("助手文本里的 Bearer/JWT 同样打码", () => {
    const { db, path } = setup(
      "帮我调这个接口",
      "用这个头：Authorization: Bearer abcDEF123456.token-value 试试；JWT 是 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
    );
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const conv = m.conversation.join("\n");
    expect(conv).not.toContain("abcDEF123456.token-value");
    expect(conv).not.toContain("dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P");
  });

  test("普通对话逐字不动（零误伤守卫）", () => {
    const { db, path } = setup("把水位线护栏补上，谢了", "补好了，考官签过字。");
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SX });
    const conv = m.conversation.join("\n");
    expect(conv).toContain("把水位线护栏补上，谢了");
    expect(conv).toContain("补好了，考官签过字。");
    expect(conv).not.toContain("[REDACTED]");
  });
});
