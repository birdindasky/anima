// 召回硬排除 self_review_fallback 兜底壳：壳是「这段没能复盘」的降级审计记录，不是记忆，
// 字面/语义两路都不得召回它（write-eval 把 live fallback 壳列为 landmine）。
// 复现 2026-06-21 盲审逮到的 bug：06-20 makeup 在薄尾巴切片上自评失败→写了条「用户消息 0 条」
// 的假空壳，而召回路未按 kind 排除 → 未来召回会把这条噪音壳捞出来误导。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, searchExperiences } from "../src/experiences";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { searchExperiencesHybrid, type QueryEmbedder } from "../src/hybridSearch";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-fbx-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = frozenClock("2026-06-21T09:00:00.000Z");
// 桩向量：壳与真记忆给同一向量，确保语义路也会把壳当候选——排除必须靠 kind 而非"碰巧不相似"。
const sameVec: EmbedFn = async (texts) => texts.map(() => new Float32Array([1, 0, 0]));
const stubQuery: QueryEmbedder = async () => new Float32Array([1, 0, 0]);

describe("召回排除 self_review_fallback", () => {
  test("字面路：壳内容命中查询也不召回，同内容真记忆照常召回", () => {
    const db = tmpDb();
    const shell = insertExperience(
      db,
      {
        kind: "self_review_fallback",
        project: "anima",
        content: "客观流水兜底摘要（自评生成失败 2 次）：；用户消息 0 条；测试跑了 0 次。",
        sourceSession: "s-fallback",
      },
      clock,
    );
    const real = insertExperience(
      db,
      { kind: "self_review", project: "anima", content: "客观流水兜底摘要 真实复盘内容 用户消息很多", sourceSession: "s-real" },
      clock,
    );

    const ids = searchExperiences(db, "客观流水兜底摘要", { project: "anima" }).map((r) => r.id);
    expect(ids).not.toContain(shell.id); // 壳被排除
    expect(ids).toContain(real.id); // 真记忆不受影响
  });

  test("字面路：includeHistory 也排除壳（壳是降级记录，不是已失效的真记忆）", () => {
    const db = tmpDb();
    const shell = insertExperience(
      db,
      { kind: "self_review_fallback", project: "anima", content: "客观流水兜底摘要 测试跑了 0 次", sourceSession: "s2" },
      clock,
    );
    const ids = searchExperiences(db, "客观流水兜底摘要", { project: "anima", includeHistory: true }).map(
      (r) => r.id,
    );
    expect(ids).not.toContain(shell.id);
  });

  test("语义路：壳与真记忆同向量，壳仍被排除、真记忆召回", async () => {
    const db = tmpDb();
    const shell = insertExperience(
      db,
      { kind: "self_review_fallback", project: "anima", content: "兜底壳 噪音", sourceSession: "s3" },
      clock,
    );
    const real = insertExperience(
      db,
      { kind: "event", project: "anima", content: "真实事件 内容", sourceSession: "s4" },
      clock,
    );
    await backfillVectors(db, sameVec);

    const ids = (await searchExperiencesHybrid(db, "随便查点啥", stubQuery, { project: "anima" })).map(
      (r) => r.id,
    );
    expect(ids).not.toContain(shell.id);
    expect(ids).toContain(real.id);
  });
});
