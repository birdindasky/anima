// work_action 下游路径（§3C 盘点表）：召回命中 ✓ / 晨间注入命中 ✓ / 日记+人格排除（F-A 致命）
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, searchExperiences } from "../src/experiences";
import { assembleMorningInjection } from "../src/inject";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const PROJECT = "/Users/tester/Projects/demo";
const tmpDirs: string[] = [];
function tmpHome(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  const home = join(dir, "anima-home");
  mkdirSync(home, { recursive: true });
  return home;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("召回：work_action 能被字面/keywords 命中（不被 RECALL_EXCLUDE 误杀）", () => {
  test("搜文件名 → 命中 work_action", () => {
    const home = tmpHome("anima-warc-");
    const db = openDb(join(home, "anima.db"));
    const clock = frozenClock("2026-06-21T10:00:00.000Z");
    insertExperience(
      db,
      {
        kind: "work_action",
        project: PROJECT,
        content: "把 config.ts 的 TOML 解析换成 YAML，修了 emoji 崩溃",
        keywords: ["config.ts", "YAML", "migration"],
        sourceSession: "s1",
      },
      clock,
    );
    const byFile = searchExperiences(db, "config.ts");
    expect(byFile.some((r) => r.kind === "work_action")).toBe(true);
    const byKw = searchExperiences(db, "migration");
    expect(byKw.some((r) => r.kind === "work_action")).toBe(true);
    const byContent = searchExperiences(db, "emoji");
    expect(byContent.some((r) => r.kind === "work_action")).toBe(true);
  });
});

describe("注入：近 7 天本项目 work_action 进晨间开场，且不挤掉持久记忆", () => {
  test("近期 work_action 注入；旧的(>7天)不注；preference 仍在", () => {
    const home = tmpHome("anima-wainj-");
    writeFileSync(join(home, "personality.md"), "# 人格卡\n\n我叫小满。\n", "utf8");
    const db = openDb(join(home, "anima.db"));
    const NOW = "2026-06-21T22:00:00.000Z";
    const clock = frozenClock(NOW);
    const daysAgo = (n: number) => {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString();
    };

    insertExperience(db, { kind: "preference", project: PROJECT, content: "用户要中文回复别堆术语", sourceSession: "sp" }, clock);
    insertExperience(db, { kind: "work_action", project: PROJECT, content: "WAFRESH 部署 v0.2 体积降四成", keywords: ["部署"], occurredAt: daysAgo(1), sourceSession: "s2" }, clock);
    insertExperience(db, { kind: "work_action", project: PROJECT, content: "WAOLD 八天前那次重构", keywords: ["重构"], occurredAt: daysAgo(8), sourceSession: "s3" }, clock);

    const out = assembleMorningInjection(db, {
      sessionId: "sess-x",
      project: PROJECT,
      personalityPath: join(home, "personality.md"),
      clock,
    });

    expect(out.text).toContain("WAFRESH"); // 近期 work_action 进注入
    expect(out.text).not.toContain("WAOLD"); // 7 天外不注
    expect(out.text).toContain("用户要中文回复"); // 持久 preference 没被挤掉
  });
});

describe("F-A 致命：work_action 绝不进半公开日记 / 不塑造人格", () => {
  const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // night = 2026-06-10
  const SEED = frozenClock("2026-06-10T10:00:00.000Z");

  function capturingLlm() {
    const prompts: Record<string, string> = {};
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes("画上句号")) return JSON.stringify({ closure: "那天的事过去了。" });
      if (prompt.includes("人格文档")) {
        prompts.personality = prompt;
        return "# 人格卡\n\n我叫小满。经过昨天，我把工作动作记忆补完了，心里更踏实、更确定方向。\n";
      }
      if (prompt.includes("写日记")) {
        prompts.diary = prompt;
        return "今天大部分时间在收尾采集层的修复，红到绿一次跑通，独立考官也签了字，挺踏实的一天，心里干净。";
      }
      return "{}";
    };
    return { llm, prompts };
  }

  test("work_action 不进日记素材、不进人格素材；真自评/决定照常进", async () => {
    const home = tmpHome("anima-wafa-");
    const config: DigestConfig = {
      personalityPath: join(home, "personality.md"),
      diaryDir: join(home, "diary"),
      badgePath: join(home, "badge.txt"),
    };
    const db = openDb(join(home, "anima.db"));
    insertExperience(db, { kind: "work_action", content: "WALEAK 跑了 curl 部署 含原始命令流水", keywords: ["部署"], sourceSession: "s-w" }, SEED);
    insertExperience(db, { kind: "self_review", content: "真实复盘内容：今天把采集层补完了。", sourceSession: "s-real" }, SEED);
    insertExperience(db, { kind: "decision", content: "决定：work_action 只走召回注入。", sourceSession: "s-real" }, SEED);

    const { llm, prompts } = capturingLlm();
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(result.stages.personality.status).toBe("done");
    expect(result.stages.diary.status).toBe("done");

    // 日记素材：含真内容，绝不含 work_action 流水（F-A）
    expect(prompts.diary).toContain("真实复盘内容");
    expect(prompts.diary).not.toContain("WALEAK");
    // 人格素材：含真自评/决定，绝不含 work_action
    expect(prompts.personality).toContain("真实复盘内容");
    expect(prompts.personality).toContain("决定：");
    expect(prompts.personality).not.toContain("WALEAK");
  });
});
