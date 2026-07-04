// AUDIT-2026-06-29 A区#1 复现 + 修复验收：closure 失败的兜底壳不该当 digest 压掉当天真自评。
// 旧 bug：兜底壳落 kind='digest' → inject 按 kind='digest' 认「该天已消化」→
//   ① 噪音壳（"这一天有 N 条带情绪的记录…"）被当记忆注入晨间开场；
//   ② 该天真 self_review 被 digestedDays 静默压掉（inject digest 查询无 project 过滤 → 还会跨夜/跨项目）。
// 修复：closure 失败落 kind='digest_fallback'（与 self_review_fallback 同口径），自然落选 inject 的 digest 查询。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, searchExperiences } from "../src/experiences";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";
import { assembleMorningInjection } from "../src/inject";

const SEED_CLOCK = frozenClock("2026-06-10T10:00:00.000Z"); // 东八 18:00 → night = 2026-06-10
const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // 凌晨跑 → night = 2026-06-10
const INJECT_NOW = "2026-06-11T05:00:00.000Z"; // 当天稍晚开新会话

const REAL_REVIEW = "真实复盘：今天把注入层兜底壳压真自评的洞修了，红到绿全跑通。";
const SHELL_FRAGMENT = "原文都在库里，回头可以翻"; // 兜底壳模板特征串

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-injfbx-"));
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

function seedReview(dbPath: string) {
  const db = openDb(dbPath);
  // 当天一条带情绪的真自评：feeling 让 stageClosure 选它当画句号的素材。
  insertExperience(
    db,
    { kind: "self_review", content: REAL_REVIEW, feeling: "踏实", sourceSession: "s-real" },
    SEED_CLOCK,
  );
  return db;
}

function inject(db: ReturnType<typeof openDb>, config: DigestConfig) {
  return assembleMorningInjection(db, {
    sessionId: "s-new",
    project: null,
    personalityPath: config.personalityPath,
    clock: frozenClock(INJECT_NOW),
  });
}

describe("inject：closure 兜底壳不压当天真自评（AUDIT A区#1）", () => {
  test("【R4】closure 失败 → throw 标 failed、不落壳；真自评照常注入、下夜可重跑", async () => {
    const { dbPath, config } = tmpHome();
    const db = seedReview(dbPath);

    // closure 恒返 {}（无 closure 字段）→ tryLlm 两次都 null → throw 标 failed（R4，不再落壳）；其余阶段给可用输出。
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes("画上句号")) return "{}";
      if (prompt.includes("人格文档")) return "# 人格卡\n\n我是小满。\n";
      if (prompt.includes("写日记")) return "今天把一个注入层的洞修好了，踏实。";
      return "{}";
    };
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    // 【R4】closure 失败 → throw → 该阶段标 failed（可见、下夜自动重跑恢复），不再落任何永久壳
    expect(result.stages.closure.status).toBe("failed");
    // situation_log 不再有 digest_fallback marker（旧实现落壳 marker）
    const marker = db
      .query("SELECT count(*) AS c FROM situation_log WHERE kind = 'digest_fallback'")
      .get() as { c: number };
    expect(marker.c).toBe(0);
    // experiences 里既无兜底壳、也无 digest（closure 没成功）
    const shells = db
      .query("SELECT count(*) AS c FROM experiences WHERE content LIKE '这一天有%条带情绪的记录%'")
      .get() as { c: number };
    expect(shells.c).toBe(0);
    expect(
      (db.query("SELECT count(*) AS c FROM experiences WHERE kind IN ('digest', 'digest_fallback')").get() as { c: number }).c,
    ).toBe(0);

    // 注入：无 digest → 该天真自评照常注入（inject 软兜底），无壳片段可漏
    const text = inject(db, config).text;
    expect(text).toContain("真实复盘");
    expect(text).not.toContain(SHELL_FRAGMENT);
  });

  test("对照：closure 成功 → 落 digest、按设计压掉当天原始自评（防过度修复回归）", async () => {
    const { dbPath, config } = tmpHome();
    const db = seedReview(dbPath);

    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes("画上句号")) return JSON.stringify({ closure: "那天的事过去了，留下经验。" });
      if (prompt.includes("人格文档")) return "# 人格卡\n\n我是小满。\n";
      if (prompt.includes("写日记")) return "今天收尾，踏实。";
      return "{}";
    };
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect((db.query("SELECT count(*) AS c FROM experiences WHERE kind = 'digest'").get() as { c: number }).c).toBe(1);

    // 有真 digest：注入消化形态、压掉同天原始自评（DESIGN §6，行为不变）
    const text = inject(db, config).text;
    expect(text).toContain("那天的事过去了");
    expect(text).not.toContain("真实复盘");
  });

  // 【R4】closure 失败 throw 后压根不落壳——所以「壳不漏进日记素材/召回」的更强保证是：库里根本没这条壳。
  // 读侧对 kind='digest_fallback' 的排除仍在（防历史遗留壳被捞），本用例固化「新路径零壳产出」这条永久门。
  test("【R4】closure 失败夜零壳产出：日记素材/字面召回都没有壳可漏", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 用带情绪的 event 当料：closure 有素材可画句号、diary 也有内容，但避开 self_review 的忠实度链路。
    insertExperience(
      db,
      { kind: "event", content: "今天干了点活，谈不上惊心动魄。", feeling: "平静", sourceSession: "s-evt" },
      SEED_CLOCK,
    );

    const diaryPrompts: string[] = [];
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes("画上句号")) return "{}"; // 强制 closure 失败 → throw 标 failed（R4，不再落壳）
      if (prompt.includes("人格文档")) return "# 人格卡\n\n我是小满。\n";
      if (prompt.includes("穷举")) return ""; // 当天无失误
      if (prompt.includes("忠实度自检")) return JSON.stringify({ faithful: true, missing: "" });
      if (prompt.includes("写日记")) {
        diaryPrompts.push(prompt);
        return "今天把一个注入层的小洞收尾了，踏实。";
      }
      return "{}";
    };
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(result.stages.closure.status).toBe("failed");
    // 库里根本没壳（旧实现落 kind='digest_fallback' 壳，这里断言零产出）
    const shellCount = db
      .query("SELECT count(*) c FROM experiences WHERE content LIKE '这一天有%条带情绪的记录%'")
      .get() as { c: number };
    expect(shellCount.c).toBe(0);

    // 日记素材：真 event 在、无壳片段
    const diaryPrompt = diaryPrompts.join("\n");
    expect(diaryPrompt).toContain("谈不上惊心动魄");
    expect(diaryPrompt).not.toContain(SHELL_FRAGMENT);

    // 字面召回：壳内容根本不存在，检索自然捞不到
    const hits = searchExperiences(db, "原文 库里 回头可以翻");
    expect(hits.some((r) => r.content.includes(SHELL_FRAGMENT))).toBe(false);
  });
});
