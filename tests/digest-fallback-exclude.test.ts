// digest 的人格改写 / 日记两阶段排除 self_review_fallback 兜底壳：壳是「自评失败/0 消息」的降级
// 审计噪音，不该流进塑造 personality.md（每会话注入核心区）与日记（半公开窗台）的 LLM 素材。
// 复现 2026-06-21 盲审逮到的「洗白型」泄漏：壳不经召回，而是经 digest builder 被洗进未来会话面。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // 凌晨跑 → night = 2026-06-10
const SEED_CLOCK = frozenClock("2026-06-10T10:00:00.000Z");

const SHELL = "客观流水兜底摘要（自评生成失败 2 次）：；用户消息 0 条；测试跑了 0 次。";
const REAL_REVIEW = "真实复盘内容：今天把召回排除兜底壳的修复落地，红到绿全跑通。";
const REAL_DECISION = "决定：召回与注入层一律排除兜底壳。";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-digfbx-"));
  tmpDirs.push(dir);
  const home = join(dir, "anima-home");
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

// 抓各阶段实际收到的 prompt（含素材），用以断言壳没混进素材。
function capturingLlm() {
  const prompts: Record<string, string> = {};
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("画上句号")) return JSON.stringify({ closure: "那天的事过去了，留下经验。" });
    if (prompt.includes("人格文档")) {
      prompts.personality = prompt;
      return "# 人格卡\n\n我叫小满。经过昨天，我更确定要把降级噪音挡在记忆之外。\n";
    }
    if (prompt.includes("写日记")) {
      prompts.diary = prompt;
      return "今天大部分时间在收尾那个兜底壳的修复，红到绿一次跑通，独立考官也签了字，挺踏实的一天，心里干净。";
    }
    return "{}";
  };
  return { llm, prompts };
}

describe("digest 人格/日记素材排除 self_review_fallback", () => {
  test("壳不进人格改写素材、也不进日记素材；真内容照常进", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "self_review_fallback", content: SHELL, sourceSession: "s-shell" }, SEED_CLOCK);
    insertExperience(db, { kind: "self_review", content: REAL_REVIEW, sourceSession: "s-real" }, SEED_CLOCK);
    insertExperience(db, { kind: "decision", content: REAL_DECISION, sourceSession: "s-real" }, SEED_CLOCK);

    const { llm, prompts } = capturingLlm();
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(result.stages.personality.status).toBe("done");
    expect(result.stages.diary.status).toBe("done");

    // 人格素材：含真自评/决定，绝不含壳
    expect(prompts.personality).toContain("真实复盘内容");
    expect(prompts.personality).toContain("决定：");
    expect(prompts.personality).not.toContain("自评生成失败");
    expect(prompts.personality).not.toContain("用户消息 0 条");

    // 日记素材：含真内容，绝不含壳
    expect(prompts.diary).toContain("真实复盘内容");
    expect(prompts.diary).not.toContain("自评生成失败");
    expect(prompts.diary).not.toContain("用户消息 0 条");
  });
});
