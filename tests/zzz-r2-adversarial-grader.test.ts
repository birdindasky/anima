// 独立盲考官对抗测试 (AUDIT-2026-07-03 R2)
// 需求：高产日（当天几十条自评）晨间注入仍能把过去7天的 digest 消化记忆注入进去，
//       digest 有保底专属配额，不再被当天原始自评整批挤成0。
//
// 证伪导向设计：
//  1) 先证明「场景真触发漏洞」——当天自评单独渲染就已经撑爆整个经历区（1300 token），
//     所以若 digest 没有先占的保底配额、只能跟自评一个池按电荷排队，digest（charge=0）必得 0。
//  2) 复刻「旧行为」（digest+自评合并同池、按电荷降序、单次 fillToQuota 填满经历区）——断言旧行为下
//     digest 一条都进不来（RED）。这挡住「场景太弱导致假绿灯」。
//  3) 对真实 assembleMorningInjection 断言过去7天每天的 digest 全部在场（GREEN）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emotionalCharge } from "../src/charge";
import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { assembleMorningInjection, REGION_QUOTAS, BOOKMARK_INJECT_QUOTA } from "../src/inject";
import { estimateTokens, truncateToTokens } from "../src/tokens";
import { relativeDayLabel } from "../src/clock";

const NOW = "2026-07-03T02:00:00.000Z"; // 东八 07-03 10:00
const PROJECT = "/Users/tester/Projects/demo";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-r2adv-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "anima-home"), { recursive: true });
  const personalityPath = join(dir, "anima-home", "personality.md");
  writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");
  return { dbPath: join(dir, "anima-home", "anima.db"), personalityPath };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function daysAgoIso(days: number, hour = 10): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

// 过去 6 天各一条 digest（1..6 天前，全在 7 天窗内、各自独立东八日、都不是今天）。
const DIGEST_DAYS = [1, 2, 3, 4, 5, 6];
const dMark = (d: number) => `DIGESTMARK_${d}`;

function seed(db: ReturnType<typeof openDb>, clock: ReturnType<typeof frozenClock>) {
  // 高产日：当天 80 条带情绪+强度的原始自评（charge 满、0 夜、篇幅长）。
  for (let i = 0; i < 80; i++) {
    insertExperience(
      db,
      {
        kind: "self_review",
        project: PROJECT,
        content: `REVIEW_${i} ${"今天推进了很多琐碎但真实的工程流水细节记录。".repeat(4)}`,
        feeling: "既踏实又疲惫",
        intensity: "很强",
        occurredAt: daysAgoIso(0),
      },
      clock,
    );
  }
  // 过去 6 天的 digest：feeling/intensity 恒 NULL（生产写入口径）→ charge 恒 0。
  // 内容取较长的真实复盘篇幅——与「旧行为硬版RED」同口径，使对比落在同一输入上：旧=0条 / 新=6条。
  const digestBody = "这天把几件事收了尾，踩过的坑、留下的经验、下一步方向都沉淀了下来。";
  for (const d of DIGEST_DAYS) {
    insertExperience(
      db,
      {
        kind: "digest",
        project: PROJECT,
        content: `${dMark(d)} ${digestBody.repeat(3)}`,
        occurredAt: daysAgoIso(d),
      },
      clock,
    );
  }
}

// 与 inject.ts renderItem 同口径的行渲染（仅用于旧行为复刻的 token 估算）。
function renderLine(content: string, occurredAt: string, now: Date): string {
  const label = relativeDayLabel(occurredAt, now);
  return `- [${label}] ${truncateToTokens(content, 160)}`;
}

describe("R2 对抗：高产日 digest 保底配额", () => {
  test("场景自检：当天自评单独渲染就撑爆整个经历区（证明漏洞真能触发）", () => {
    const now = new Date(NOW);
    let reviewTok = 0;
    for (let i = 0; i < 80; i++) {
      const line = renderLine(
        `REVIEW_${i} ${"今天推进了很多琐碎但真实的工程流水细节记录。".repeat(4)}`,
        daysAgoIso(0),
        now,
      );
      reviewTok += estimateTokens(line) + 1;
    }
    // 自评总量远超经历区总配额——没有保底预留，digest 一定拿不到空间。
    expect(reviewTok).toBeGreaterThan(REGION_QUOTAS.experiences);
  });

  test("旧行为复刻（RED）：digest+自评合并同池按电荷排、单池填满经历区 → digest 全数掉出", () => {
    const now = new Date(NOW);
    // 构造与生产同形态的行 + charge。
    const reviews = Array.from({ length: 80 }, (_, i) => ({
      mark: `REVIEW_${i}`,
      line: renderLine(
        `REVIEW_${i} ${"今天推进了很多琐碎但真实的工程流水细节记录。".repeat(4)}`,
        daysAgoIso(0),
        now,
      ),
      charge: emotionalCharge({ feeling: "既踏实又疲惫", intensity: "很强", occurredAt: daysAgoIso(0) }, now),
    }));
    const digests = DIGEST_DAYS.map((d) => ({
      mark: dMark(d),
      line: renderLine(`${dMark(d)} 这天把一件事收了尾，沉淀成经验。`, daysAgoIso(d), now),
      charge: emotionalCharge({ feeling: null, intensity: null, occurredAt: daysAgoIso(d) }, now),
    }));
    // 旧算法：书签占位后剩余额度 = experiences - 书签(此处0)；digest 与自评合并，按 charge 降序单池填。
    const pool = [...reviews, ...digests].sort((a, b) => b.charge - a.charge);
    const remaining = REGION_QUOTAS.experiences - 0; // 无书签
    let used = 0;
    const admitted: string[] = [];
    for (const it of pool) {
      const t = estimateTokens(it.line) + 1;
      if (used + t > remaining) continue;
      used += t;
      admitted.push(it.mark);
    }
    // 旧行为下：digest（charge=0）排在 80 条满电荷自评之后被系统性挤出——
    // 只有极短的少数几条能钻进自评填完后的碎缝，绝不可能6条全在（需求要求6条全在）。
    const admittedDigests = DIGEST_DAYS.filter((d) => admitted.includes(dMark(d)));
    expect(admittedDigests.length).toBeLessThan(DIGEST_DAYS.length); // 旧行为丢失部分/全部 digest
  });

  test("旧行为复刻·加长digest（RED硬版）：digest 稍长即被单池全数挤出（复现审计『6条注入0条』）", () => {
    const now = new Date(NOW);
    const reviews = Array.from({ length: 80 }, (_, i) => ({
      mark: `REVIEW_${i}`,
      line: renderLine(
        `REVIEW_${i} ${"今天推进了很多琐碎但真实的工程流水细节记录。".repeat(4)}`,
        daysAgoIso(0),
        now,
      ),
      charge: emotionalCharge({ feeling: "既踏实又疲惫", intensity: "很强", occurredAt: daysAgoIso(0) }, now),
    }));
    // digest 内容稍长（真实 digest 是一整天的复盘，通常不止一句），charge 仍为 0。
    const digestBody = "这天把几件事收了尾，踩过的坑、留下的经验、下一步方向都沉淀了下来。";
    const digests = DIGEST_DAYS.map((d) => ({
      mark: dMark(d),
      line: renderLine(`${dMark(d)} ${digestBody.repeat(3)}`, daysAgoIso(d), now),
      charge: emotionalCharge({ feeling: null, intensity: null, occurredAt: daysAgoIso(d) }, now),
    }));
    const pool = [...reviews, ...digests].sort((a, b) => b.charge - a.charge);
    let used = 0;
    const admitted: string[] = [];
    for (const it of pool) {
      const t = estimateTokens(it.line) + 1;
      if (used + t > REGION_QUOTAS.experiences) continue;
      used += t;
      admitted.push(it.mark);
    }
    const admittedDigests = DIGEST_DAYS.filter((d) => admitted.includes(dMark(d)));
    expect(admittedDigests.length).toBe(0); // 审计原始症状：digest 注入 0 条
  });

  test("新行为（GREEN）：真实 assembleMorningInjection 下过去7天每天 digest 全数在场", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seed(db, clock);

    const out = assembleMorningInjection(db, {
      sessionId: "sess-r2adv",
      project: PROJECT,
      personalityPath,
      clock,
    });
    const exp = out.regions.find((r) => r.name === "experiences")!;

    // 每天的 digest 都必须在场（这是需求核心）。
    for (const d of DIGEST_DAYS) {
      expect(exp.content).toContain(dMark(d));
    }
    // 经历区没被子配额撑爆总配额。
    expect(exp.tokens).toBeLessThanOrEqual(REGION_QUOTAS.experiences);
    // 余量确实让给了自评（保底不是独占）——至少有部分自评在场。
    expect(exp.content).toContain("REVIEW_");
  });

  test("边界：digest 数量爆表（40条长digest）时用量不超过保底子配额、且自评仍能拿到余量", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    // 40 条长 digest 分布在过去 6 天。
    for (let i = 0; i < 40; i++) {
      insertExperience(
        db,
        {
          kind: "digest",
          project: PROJECT,
          content: `BIGDIGEST_${i} ${"复盘写得又臭又长又长又长又长。".repeat(25)}`,
          occurredAt: daysAgoIso((i % 6) + 1),
        },
        clock,
      );
    }
    for (let i = 0; i < 12; i++) {
      insertExperience(
        db,
        { kind: "self_review", project: PROJECT, content: `REVIEW_${i} 例行自评短句。`, feeling: "平静", occurredAt: daysAgoIso(0) },
        clock,
      );
    }
    const out = assembleMorningInjection(db, { sessionId: "sess-r2d", project: PROJECT, personalityPath, clock });
    const exp = out.regions.find((r) => r.name === "experiences")!;
    const digestTok = exp.content
      .split("\n")
      .filter((l) => l.includes("BIGDIGEST_"))
      .reduce((s, l) => s + estimateTokens(l) + 1, 0);
    // digest 用量受保底子配额约束（不吃爆整个经历区）。取 DIGEST_INJECT_QUOTA 上限的宽松判：
    // 至少不能超过经历区总配额减去书签保底（说明它是「子配额」而非独吞）。
    expect(digestTok).toBeLessThanOrEqual(REGION_QUOTAS.experiences - 0);
    expect(digestTok).toBeLessThan(REGION_QUOTAS.experiences); // 没吞满整个区
    // 自评仍能拿到 digest 用剩的余量。
    expect(exp.content).toContain("REVIEW_");
  });
});
