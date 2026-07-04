// AUDIT-2026-07-03 R2 复现 + 修复验收：晨间注入把「过去一周消化记忆 digest」整批挤掉。
// 根因：pastRows 按 emotionalCharge 降序排，而 digest 写入时 feeling/intensity 恒 NULL → charge 恒 0，
//   永远沉到带情绪的原始自评之后；且 digest 无专属配额，高产日（几十条当天自评）轻松填满 1300 token
//   经历区，把过去 7 天的 digest 全数挤出注入（实测窗内 6 条 digest 注入 0 条）。
// 修法（照搬书签 rank6a 招）：给 digest 一个有保底的专属子配额 DIGEST_INJECT_QUOTA，按 recency 排、
//   在自评之前先占那份额度（自评吃不到），用不满的余量再让给自评区。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { assembleMorningInjection, DIGEST_INJECT_QUOTA, REGION_QUOTAS } from "../src/inject";
import { estimateTokens } from "../src/tokens";

// 东八区 07-03 10:00——保证 daysAgoIso 落在整齐的过去日子里
const NOW = "2026-07-03T02:00:00.000Z";
const PROJECT = "/Users/tester/Projects/demo";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-injdq-"));
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

// 过去 5 天（2..6 天前，全在 7 天窗内、各自独立的东八日、都不是今天）各一条 digest。
const DIGEST_DAYS = [2, 3, 4, 5, 6];
const digestMarker = (d: number) => `DIGEST_DAY_${d}`;

function seedHighProductionDay(db: ReturnType<typeof openDb>, clock: ReturnType<typeof frozenClock>) {
  // 今天（未消化日）几十条带情绪的原始自评——charge 高、篇幅够长，足以填满整个经历区。
  for (let i = 0; i < 40; i++) {
    insertExperience(
      db,
      {
        kind: "self_review",
        project: PROJECT,
        content: `今日第${i}条自评：${"当天工作的流水细节描述比较长。".repeat(3)}`,
        feeling: "踏实又有点累",
        intensity: "较强",
        occurredAt: daysAgoIso(0),
      },
      clock,
    );
  }
  // 过去 5 天各一条 digest：feeling/intensity 恒 NULL（与生产写入口径一致）→ charge 恒 0。
  for (const d of DIGEST_DAYS) {
    insertExperience(
      db,
      {
        kind: "digest",
        project: PROJECT,
        content: `${digestMarker(d)} 这天把一件事收了尾，留下了经验。`,
        occurredAt: daysAgoIso(d),
      },
      clock,
    );
  }
}

describe("R2 晨间注入 digest 保底子配额（AUDIT-2026-07-03）", () => {
  test("常量健全：DIGEST_INJECT_QUOTA 为正、且不超过经历区总配额", () => {
    expect(DIGEST_INJECT_QUOTA).toBeGreaterThan(0);
    expect(DIGEST_INJECT_QUOTA).toBeLessThanOrEqual(REGION_QUOTAS.experiences);
  });

  test("高产日：过去 7 天每天的 digest 全数稳定进注入，不被当天自评挤空", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedHighProductionDay(db, clock);

    const out = assembleMorningInjection(db, { sessionId: "sess-r2", project: PROJECT, personalityPath, clock });
    const exp = out.regions.find((r) => r.name === "experiences")!.content;

    // 修复前：digest（charge=0）全排在 40 条带情绪自评之后 + 无保底配额 → 一条都进不来。
    // 修复后：每天的 digest 都在场。
    for (const d of DIGEST_DAYS) {
      expect(exp).toContain(digestMarker(d));
    }
    // 注入台账里能数到 5 条 digest（内容里没有 charge/数值泄漏这条由其它测试守，这里只验存在）。
    const injectedDigests = DIGEST_DAYS.filter((d) => exp.includes(digestMarker(d)));
    expect(injectedDigests.length).toBe(DIGEST_DAYS.length);
  });

  test("digest 先占保底额度，但没用满的余量让给自评（自评仍在场）", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    seedHighProductionDay(db, clock);

    const out = assembleMorningInjection(db, { sessionId: "sess-r2b", project: PROJECT, personalityPath, clock });
    const exp = out.regions.find((r) => r.name === "experiences")!.content;

    // digest 只占小份（5 条短 digest 远不到 DIGEST_INJECT_QUOTA），余量让给自评 → 今日自评仍有若干在场。
    expect(exp).toContain("今日第");
    // 经历区仍在总配额内（子配额没把区撑爆）。
    const expRegion = out.regions.find((r) => r.name === "experiences")!;
    expect(expRegion.tokens).toBeLessThanOrEqual(REGION_QUOTAS.experiences);
  });

  test("digest 挤不爆经历区：灌满 30 条长 digest 时，digest 用量不超过其保底子配额", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    // 30 条长 digest（renderItem 截到 160 token/条），确认子配额起了「上限」作用、没吞掉整个经历区。
    for (let i = 0; i < 30; i++) {
      insertExperience(
        db,
        {
          kind: "digest",
          project: PROJECT,
          content: `LONGDIGEST_${i} ${"这天的复盘内容写得很长很长很长。".repeat(20)}`,
          occurredAt: daysAgoIso((i % 5) + 2),
        },
        clock,
      );
    }
    // 同时给点自评，验证它们仍能拿到 digest 用剩的余量。
    for (let i = 0; i < 10; i++) {
      insertExperience(
        db,
        { kind: "self_review", project: PROJECT, content: `REVIEW_${i} 例行自评。`, feeling: "平静", occurredAt: daysAgoIso(0) },
        clock,
      );
    }

    const out = assembleMorningInjection(db, { sessionId: "sess-r2c", project: PROJECT, personalityPath, clock });
    const exp = out.regions.find((r) => r.name === "experiences")!.content;

    // 只统计 digest 行（含 LONGDIGEST_ 标记）的 token 用量，不得超过保底子配额。
    const digestLines = exp.split("\n").filter((l) => l.includes("LONGDIGEST_"));
    const digestTok = digestLines.reduce((s, l) => s + estimateTokens(l) + 1, 0);
    expect(digestTok).toBeLessThanOrEqual(DIGEST_INJECT_QUOTA);
    // 自评仍能进（余量没被 digest 全吃光）。
    expect(exp).toContain("REVIEW_");
  });
});
