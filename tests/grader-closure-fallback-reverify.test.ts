// INDEPENDENT GRADER RE-VERIFY (AUDIT-2026-06-29 A区#1, round 2). Written from scratch by the
// acceptance examiner. Drives the REAL functions only (no hardcoded SQL copies), so it stays valid
// against future query edits. Verifies the two residuals reported last round are actually closed:
//   (1) diary read-path no longer ingests the digest_fallback shell (end-to-end real diary prompt);
//   (2) literal + semantic + chrono recall all exclude a REAL digest_fallback row, while a REAL
//       kind='digest' memory is STILL recalled (no over-exclusion from the != -> NOT IN change).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, searchExperiences, searchExperiencesChrono } from "../src/experiences";
import { searchExperiencesHybrid, type QueryEmbedder } from "../src/hybridSearch";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";
import { assembleMorningInjection } from "../src/inject";

const SEED_AT = "2026-06-15T09:00:00.000Z"; // +8h=17:00 -> 2026-06-15
const DIGEST_AT = "2026-06-16T03:00:00.000Z"; // night = 2026-06-15
const INJECT_AT = "2026-06-16T06:00:00.000Z";

// 兜底壳模板独有的中文尾巴（注意模板用中文逗号 '，'）。出现在壳里、不出现在其它素材。
const SHELL_TAIL = "回头可以翻";

const dirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-reverify-"));
  dirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
    badgePath: join(home, "badge.txt"),
  };
  return { dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Adversarial stub embedder: a digest_fallback shell stuffed with the query words gets cosine 1.0
// with the query — it WOULD surface on the vector path unless the kind exclusion bites first.
function vecFor(text: string): Float32Array {
  const v = new Float32Array(2);
  if (/权限|鉴权|token|登录|句号|兜底|带情绪/.test(text)) v[0] = 1;
  else v[1] = 1;
  return v;
}
const stubDocs: EmbedFn = async (texts) => texts.map(vecFor);
const stubQuery: QueryEmbedder = async (q) => vecFor(q);

describe("RE-VERIFY A区#1 残留闭合", () => {
  test("(1) 【R4】closure 失败夜 throw 标 failed、不落壳，真 diary 照跑不含壳", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 带情绪的 event 当料：closure 有素材可画句号、diary 有内容；避开 self_review 忠实度链路噪声。
    insertExperience(
      db,
      { kind: "event", content: "今天调了点东西，没什么大波澜。", feeling: "平静", sourceSession: "s-evt" },
      frozenClock(SEED_AT),
    );

    const diaryPrompts: string[] = [];
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes("画上句号")) return "{}"; // closure 恒失败 -> throw 标 failed（R4，不再落壳）
      if (prompt.includes("人格文档")) return "# 人格卡\n\n稳定的我。\n";
      if (prompt.includes("穷举")) return "";
      if (prompt.includes("忠实度自检")) return JSON.stringify({ faithful: true, missing: "" });
      if (prompt.includes("写日记")) {
        diaryPrompts.push(prompt);
        return "今天把一个小东西收尾了，平静。";
      }
      return "{}";
    };
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_AT), llm, config });

    // 【R4】closure 失败 → throw → 该阶段标 failed（下夜 findUndigestedNights 自动重选重跑恢复），
    // 不再落任何永久兜底壳（旧实现落 kind='digest_fallback' 壳 → 七阶段全 done → 该夜永不重跑）。
    expect(result.stages.closure.status).toBe("failed");
    const shellCount = db
      .query("SELECT count(*) c FROM experiences WHERE content LIKE '这一天有%条带情绪的记录%'")
      .get() as { c: number };
    expect(shellCount.c).toBe(0);
    const digestish = db
      .query("SELECT count(*) c FROM experiences WHERE kind IN ('digest', 'digest_fallback')")
      .get() as { c: number };
    expect(digestish.c).toBe(0); // closure 没成功 → 既无 digest 也无壳

    // diary 阶段仍独立跑（closure throw 不阻塞其余阶段），真料在、壳不在
    expect(diaryPrompts.length).toBeGreaterThan(0);
    const diaryPrompt = diaryPrompts.join("\n");
    expect(diaryPrompt).toContain("没什么大波澜"); // 真 event 在素材里
    expect(diaryPrompt).not.toContain(SHELL_TAIL); // 无壳可漏
  });

  test("(2a) 字面召回：digest_fallback 壳被排除，真 digest 仍召回", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "anima-rv-")), "a.db"));
    const shell = insertExperience(
      db,
      { kind: "digest_fallback", project: "anima", content: "这一天有 3 条带情绪的记录，原文都在库里，回头可以翻。权限 鉴权 token 登录" },
      frozenClock(SEED_AT),
    );
    const realDigest = insertExperience(
      db,
      { kind: "digest", project: "anima", content: "权限 鉴权 token 登录 那摊事折腾完了，留下经验。" },
      frozenClock(SEED_AT),
    );
    const ids = searchExperiences(db, "权限 鉴权 token 登录", { limit: 50 }).map((r) => r.id);
    expect(ids).not.toContain(shell.id); // 壳被排除
    expect(ids).toContain(realDigest.id); // 真消化记忆仍可召回（没被 NOT IN 误排）
  });

  test("(2b) 语义召回：digest_fallback 壳被排除（即便向量完美匹配），真 digest 仍召回", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "anima-rv-")), "b.db"));
    const shell = insertExperience(
      db,
      { kind: "digest_fallback", project: "anima", content: "这一天有 2 条带情绪的记录，原文都在库里，回头可以翻。鉴权 token" },
      frozenClock(SEED_AT),
    );
    const realDigest = insertExperience(
      db,
      { kind: "digest", project: "anima", content: "鉴权 token 那段排查清楚了，句号。" },
      frozenClock(SEED_AT),
    );
    await backfillVectors(db, stubDocs);
    // sanity：壳确实拿到了 live 向量（证明 backfill 不预过滤，排除必须发生在召回侧）
    const vc = db.query("SELECT count(*) c FROM vec_experiences WHERE experience_id = ?").get(shell.id) as { c: number };
    expect(vc.c).toBe(1);

    const ids = (await searchExperiencesHybrid(db, "权限 鉴权 token 登录", stubQuery, { limit: 50 })).map((r) => r.id);
    expect(ids).not.toContain(shell.id);
    expect(ids).toContain(realDigest.id);
  });

  test("(2c) 时序召回 chrono：digest_fallback 壳被排除，真 digest 仍召回", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "anima-rv-")), "c.db"));
    const shell = insertExperience(
      db,
      { kind: "digest_fallback", project: "anima", content: "这一天有 4 条带情绪的记录，原文都在库里，回头可以翻。" },
      frozenClock(SEED_AT),
    );
    const realDigest = insertExperience(
      db,
      { kind: "digest", project: "anima", content: "那天的事消化完了，留下经验。" },
      frozenClock(SEED_AT),
    );
    const ids = searchExperiencesChrono(db, "", {
      sinceTs: "2026-06-01T00:00:00.000Z",
      untilTs: "2026-07-01T00:00:00.000Z",
    }).map((r) => r.id);
    expect(ids).not.toContain(shell.id);
    expect(ids).toContain(realDigest.id);
  });

  test("(3) inject 仍正确：closure 失败夜真自评进注入、壳不进；成功夜压自评", async () => {
    // 失败夜
    {
      const { dbPath, config } = tmpHome();
      const db = openDb(dbPath);
      insertExperience(
        db,
        { kind: "self_review", content: "真实复盘：注入兜底壳的洞修好了。", feeling: "踏实", sourceSession: "s1" },
        frozenClock(SEED_AT),
      );
      const llm = async (p: string): Promise<string> => {
        if (p.includes("画上句号")) return "{}";
        if (p.includes("人格文档")) return "# 人格卡\n\n我。\n";
        if (p.includes("穷举")) return "";
        if (p.includes("忠实度自检")) return JSON.stringify({ faithful: true, missing: "" });
        if (p.includes("写日记")) return "今天收尾了一个洞，踏实。";
        return "{}";
      };
      await runNightlyDigestion(db, { clock: frozenClock(DIGEST_AT), llm, config });
      const text = assembleMorningInjection(db, {
        sessionId: "s-new",
        project: null,
        personalityPath: config.personalityPath,
        clock: frozenClock(INJECT_AT),
      }).text;
      expect(text).toContain("真实复盘");
      expect(text).not.toContain(SHELL_TAIL);
    }
    // 成功夜（防过度修复）
    {
      const { dbPath, config } = tmpHome();
      const db = openDb(dbPath);
      insertExperience(
        db,
        { kind: "self_review", content: "真实复盘：注入兜底壳的洞修好了。", feeling: "踏实", sourceSession: "s1" },
        frozenClock(SEED_AT),
      );
      const llm = async (p: string): Promise<string> => {
        if (p.includes("画上句号")) return JSON.stringify({ closure: "那摊事过去了，留下经验。" });
        if (p.includes("人格文档")) return "# 人格卡\n\n我。\n";
        if (p.includes("穷举")) return "";
        if (p.includes("忠实度自检")) return JSON.stringify({ faithful: true, missing: "" });
        if (p.includes("写日记")) return "今天收尾，踏实。";
        return "{}";
      };
      await runNightlyDigestion(db, { clock: frozenClock(DIGEST_AT), llm, config });
      const text = assembleMorningInjection(db, {
        sessionId: "s-new",
        project: null,
        personalityPath: config.personalityPath,
        clock: frozenClock(INJECT_AT),
      }).text;
      expect(text).toContain("那摊事过去了"); // 消化形态在
      expect(text).not.toContain("真实复盘"); // 原始自评被压
    }
  });
});
