// AUDIT-2026-07-03 B5：R4（closure 失败 throw-重试，不落永久壳）+ R9（非幂等阶段崩溃窗口重跑不双写）
// + R11（turn_flaws ∪ enumerate 合并去重、不重灌整日枚举噪声）。全程驱动真 runNightlyDigestion，不复制 SQL。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { findUndigestedNights, runNightlyDigestion, type DigestConfig } from "../src/digest";

const SEED_CLOCK = frozenClock("2026-06-10T10:00:00.000Z"); // 东八 18:00 → night = 2026-06-10
const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // 凌晨跑 → night = 2026-06-10
const LATER_NOW = "2026-06-12T03:00:00.000Z"; // 次夜：findUndigestedNights 的 now（cutoff 覆盖 06-10）
const NIGHT = "2026-06-10";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-b5-"));
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

// 一个「除 closure 外都能过」的 LLM 桩：closureOk 决定画句号成不成。personality/diary 输出须过长度校验
// （personality≥30、diary≥30 且无未接地路径），否则那两阶段也 failed、该夜 done<7 会一直挂欠账、干扰 R4 断言。
function llmWith(closureOk: boolean) {
  return async (prompt: string): Promise<string> => {
    if (prompt.includes("画上句号")) return closureOk ? JSON.stringify({ closure: "那摊事过去了，留下经验。" }) : "{}";
    if (prompt.includes("人格文档")) return "# 人格卡\n\n我是一个稳定、克制、爱较真的助手，性格以月为单位慢慢成形。\n";
    if (prompt.includes("穷举")) return "";
    if (prompt.includes("忠实度自检")) return JSON.stringify({ faithful: true, missing: "" });
    if (prompt.includes("写日记")) return "今天把手头一个小东西收了尾，过程很平静，没什么波澜，踏实地结束了这一天。";
    return "{}";
  };
}

const liveDigestCount = (db: ReturnType<typeof openDb>) =>
  (db.query("SELECT count(*) c FROM experiences WHERE kind = 'digest' AND invalid_at IS NULL").get() as { c: number }).c;

describe("R4：closure 失败 throw → 标 failed、下夜自动重跑恢复", () => {
  test("closure 失败夜被 findUndigestedNights 重选，重跑成功后正好一条 digest", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(
      db,
      { kind: "self_review", content: "复盘：今天把一个洞收尾了。", feeling: "踏实", sourceSession: "s1" },
      SEED_CLOCK,
    );

    // 第一夜：closure 失败 → throw → 阶段 failed、不落任何壳/digest
    const r1 = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmWith(false), config });
    expect(r1.stages.closure.status).toBe("failed");
    expect(liveDigestCount(db)).toBe(0);
    expect(
      (db.query("SELECT count(*) c FROM experiences WHERE kind = 'digest_fallback'").get() as { c: number }).c,
    ).toBe(0);

    // 该夜 done < 7（closure 没 done）→ findUndigestedNights 仍把它列为待消化 = 下夜会重跑
    expect(findUndigestedNights(db, { now: new Date(LATER_NOW) }).nights).toContain(NIGHT);

    // 第二夜：只有 closure 重跑（其余阶段已 done 被跳过），这次成功 → 正好一条 digest
    const r2 = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmWith(true), config });
    expect(r2.stages.closure.status).toBe("done");
    expect(liveDigestCount(db)).toBe(1);
    // 恢复后不再欠账
    expect(findUndigestedNights(db, { now: new Date(LATER_NOW) }).nights).not.toContain(NIGHT);
  });
});

describe("R9：非幂等阶段崩溃窗口（副作用已提交、done 未提交）重跑不双写", () => {
  test("closure：删掉 done 标记后重跑 → 旧 digest 软失效、只留一条 live（append-only 不物删）", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(
      db,
      { kind: "self_review", content: "复盘：收尾了。", feeling: "踏实", sourceSession: "s1" },
      SEED_CLOCK,
    );

    // 完整跑一遍：closure 成功、digest_runs 全 done
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmWith(true), config });
    expect(liveDigestCount(db)).toBe(1);

    // 模拟崩溃窗口：insert 已落库、但 record(closure, done) 那次 autocommit 没持久化 → 删掉该行
    db.query("DELETE FROM digest_runs WHERE night = ? AND stage = 'closure'").run(NIGHT);

    // 重跑：closure 非 done → 再跑一次 → supersedeNightDigest 先软失效旧句号、再插新的
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmWith(true), config });

    // live 只有一条（不双句号污染 inject）
    expect(liveDigestCount(db)).toBe(1);
    // 但旧行没被物删——append-only：总计两条 digest，其一带 invalid_at
    const total = (db.query("SELECT count(*) c FROM experiences WHERE kind = 'digest'").get() as { c: number }).c;
    expect(total).toBe(2);
    const invalidated = (db
      .query("SELECT count(*) c FROM experiences WHERE kind = 'digest' AND invalid_at IS NOT NULL")
      .get() as { c: number }).c;
    expect(invalidated).toBe(1);
  });

  test("decay：删掉 done 标记后重跑 → dedup_key 撞唯一索引 DO NOTHING、快照仍只一份", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(
      db,
      { kind: "self_review", content: "复盘：收尾了。", feeling: "踏实", sourceSession: "s1" },
      SEED_CLOCK,
    );

    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmWith(true), config });
    // 快照 occurred_at 是消化运行时刻（非归属夜），故按稳定 dedup_key 计数（= 同夜一份的幂等键）
    const snapCount = () =>
      (db
        .query("SELECT count(*) c FROM situation_log WHERE kind = 'digest_decay_snapshot' AND dedup_key = ?")
        .get(`digest_decay_snapshot:${NIGHT}`) as { c: number }).c;
    expect(snapCount()).toBe(1);

    // 崩溃窗口：decay 快照已 append、但 record(decay, done) 没落 → 删标记重跑
    db.query("DELETE FROM digest_runs WHERE night = ? AND stage = 'decay'").run(NIGHT);
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmWith(true), config });

    // 稳定 dedup_key → 第二次 append DO NOTHING → 仍只一份（旧 bug：两份）
    expect(snapCount()).toBe(1);
  });
});

describe("R11：turn_flaws 打底 + enumerate 补充，合并去重、不重灌噪声", () => {
  const TURN_FLAW = "把配置项名字打错导致启动失败";
  const NEW_ENUM_FLAW = "漏了给缓存加过期时间";

  function countOcc(hay: string, needle: string): number {
    let n = 0;
    let i = hay.indexOf(needle);
    while (i !== -1) {
      n++;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  }

  // enumOut 决定语义穷举返回什么；返回 diary 阶段实际收到的 prompt（含失误清单）。
  async function runAndCaptureDiary(enumOut: string): Promise<string> {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // self_review 正文刻意不含失误清单原文 → 清单只可能来自 turn_flaws/enumerate 合并路径
    insertExperience(
      db,
      { kind: "self_review", content: "复盘：今天有个地方判错了，返工了一下。", feeling: "踏实", sourceSession: "s1" },
      SEED_CLOCK,
    );
    // 采集时打标的当夜切片失误（turn_flaws）
    appendSituation(db, { kind: "turn_flaws", payload: { flaws: [TURN_FLAW] } }, SEED_CLOCK);

    let diaryPrompt = "";
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes("画上句号")) return JSON.stringify({ closure: "过去了。" });
      if (prompt.includes("人格文档")) return "# 人格卡\n\n我。\n";
      if (prompt.includes("穷举")) return enumOut;
      if (prompt.includes("忠实度自检")) return JSON.stringify({ faithful: true, missing: "" });
      if (prompt.includes("写日记")) {
        diaryPrompt = prompt;
        return "今天返工了一次，也收了尾。";
      }
      return "{}";
    };
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });
    return diaryPrompt;
  }

  test("有 turn_flaws 时 enumerate 仍跑：新枚举失误被补进日记失误清单（旧实现会永久漏掉）", async () => {
    const prompt = await runAndCaptureDiary(`- ${TURN_FLAW}\n- ${NEW_ENUM_FLAW}`);
    expect(prompt).toContain(TURN_FLAW); // turn_flaws 主体在
    expect(prompt).toContain(NEW_ENUM_FLAW); // enumerate 补充信号在（旧：turnFlaws 非空即短路，这条永远进不来）
    // 去重：turn_flaws 与 enumerate 都含 TURN_FLAW，合并后清单里只出现一次（不重灌整日枚举噪声）
    expect(countOcc(prompt, TURN_FLAW)).toBe(1);
  });

  test("enumerate 抽风返空/无补充 → 只剩 turn_flaws 主体，稳健不受影响", async () => {
    const prompt = await runAndCaptureDiary(""); // 语义枚举返空（当天确无额外失误 / 抽风）
    expect(prompt).toContain(TURN_FLAW);
    expect(prompt).not.toContain(NEW_ENUM_FLAW);
    expect(countOcc(prompt, TURN_FLAW)).toBe(1);
  });
});
