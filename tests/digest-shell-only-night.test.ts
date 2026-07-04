// INDEPENDENT GRADER TEST: a night whose ONLY experience is a fallback shell.
// After the fix, personality + diary must produce NOTHING that night (dayRows empty → early return),
// not mutate from a "0 messages" shell. Also asserts personality.md is left untouched and no diary file.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // night = 2026-06-10
const SEED_CLOCK = frozenClock("2026-06-10T10:00:00.000Z");
const SHELL = "客观流水兜底摘要（自评生成失败 2 次）：；用户消息 0 条；测试跑了 0 次。";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-shellonly-"));
  tmpDirs.push(dir);
  const home = join(dir, "anima-home");
  mkdirSync(home, { recursive: true });
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
    badgePath: join(home, "badge.txt"),
  };
  return { dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("GRADER: shell-only night produces no personality/diary mutation", () => {
  test("only a fallback shell that night → personality untouched, no diary, prompts never built", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const ORIGINAL_PERSONALITY = "# 人格卡\n\n我叫小满。原封不动。\n";
    writeFileSync(config.personalityPath, ORIGINAL_PERSONALITY, "utf8");

    insertExperience(db, { kind: "self_review_fallback", content: SHELL, sourceSession: "s-shell" }, SEED_CLOCK);

    // Capturing LLM: if a personality/diary prompt is EVER built, it would contain the shell text.
    const seen: string[] = [];
    const llm = async (prompt: string): Promise<string> => {
      seen.push(prompt);
      if (prompt.includes("画上句号")) return JSON.stringify({ closure: "x" });
      if (prompt.includes("人格文档")) return "# 人格卡\n\nMUTATED\n";
      if (prompt.includes("写日记")) return "MUTATED DIARY ENTRY 一二三四五六七八九十";
      return "{}";
    };

    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    // personality + diary stages run but early-return (no rows) → status done, no work
    expect(result.stages.personality.status).toBe("done");
    expect(result.stages.diary.status).toBe("done");

    // personality.md must be byte-for-byte the original (no rewrite from a shell)
    expect(readFileSync(config.personalityPath, "utf8")).toBe(ORIGINAL_PERSONALITY);

    // no diary file written for that night
    const diaryFiles = existsSync(config.diaryDir) ? readdirSync(config.diaryDir) : [];
    expect(diaryFiles).toHaveLength(0);

    // and the shell text never appeared in ANY prompt handed to the LLM
    expect(seen.some((p) => p.includes("自评生成失败"))).toBe(false);
    expect(seen.some((p) => p.includes("用户消息 0 条"))).toBe(false);
  });
});
