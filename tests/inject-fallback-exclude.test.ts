// 晨间注入排除 self_review_fallback 兜底壳：壳是「这段没能复盘」的降级审计记录，不是记忆，
// 注进新会话开场只会把「用户消息 0 条」这类噪音当记忆喂给未来会话。
// 与召回排除同口径（2026-06-21 盲审逮到的第二条读侧暴露面）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { assembleMorningInjection } from "../src/inject";

const NOW = "2026-06-21T22:00:00.000Z";
const PROJECT = "/Users/tester/Projects/demo";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-injfbx-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "anima-home"), { recursive: true });
  const personalityPath = join(dir, "anima-home", "personality.md");
  writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");
  return { dbPath: join(dir, "anima-home", "anima.db"), personalityPath };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function recentIso(daysAgo: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

describe("晨间注入排除 self_review_fallback", () => {
  test("兜底壳不进晨间开场，真自评照常注入", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);

    insertExperience(
      db,
      {
        kind: "self_review_fallback",
        project: PROJECT,
        content: "客观流水兜底摘要（自评生成失败 2 次）：；用户消息 0 条；测试跑了 0 次。",
        sourceSession: "s-shell",
        occurredAt: recentIso(1),
      },
      clock,
    );
    insertExperience(
      db,
      {
        kind: "self_review",
        project: PROJECT,
        content: "真实复盘：今天把召回排除兜底壳的修复落地，红到绿全跑通了。",
        sourceSession: "s-real",
        occurredAt: recentIso(1),
      },
      clock,
    );

    const out = assembleMorningInjection(db, { sessionId: "sess-x", project: PROJECT, personalityPath, clock });

    expect(out.text).not.toContain("自评生成失败"); // 壳的招牌词
    expect(out.text).not.toContain("用户消息 0 条");
    expect(out.text).toContain("真实复盘"); // 真自评不受影响
  });
});
