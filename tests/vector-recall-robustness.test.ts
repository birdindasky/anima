// AUDIT-2026-07-01 向量召回健壮性：
//  rank9b cosine 维度不一致返 0（不算 NaN 漏召 / 截断假余弦）；
//  rank9a vectorSearch 按 model_ver 过滤（混版/迁移半途不拿老维·异模型向量乱算）；
//  rank8  单条坏 blob 只跳过该行，不让异常冒泡把整段语义召回永久降级纯字面。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { cosine } from "../src/embed";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { searchExperiencesHybrid, type QueryEmbedder } from "../src/hybridSearch";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-vrr-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 余弦桩（2 维）：query=[1,0]，doc→[c,√(1-c²)] → cosine=c。按 content 映射。
const COS = new Map<string, number>();
const stubDocs: EmbedFn = async (texts) => texts.map((t) => Float32Array.from([COS.get(t) ?? 0, Math.sqrt(Math.max(0, 1 - (COS.get(t) ?? 0) ** 2))]));
const stubQuery: QueryEmbedder = async () => Float32Array.from([1, 0]);
const clock = frozenClock("2026-06-18T09:00:00.000Z");
afterEach(() => COS.clear());

function seed(db: ReturnType<typeof openDb>, content: string, cos: number) {
  COS.set(content, cos);
  return insertExperience(db, { kind: "event", project: "anima", content }, clock);
}

describe("rank9b · cosine 维度闸", () => {
  test("维度不一致返 0（不 NaN、不截断假余弦）", () => {
    expect(cosine(Float32Array.from([1, 0, 0, 0]), Float32Array.from([1, 0, 0]))).toBe(0); // 短→旧码越界 NaN
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0.6, 0, 0.8, 0]))).toBe(0); // 查询维<存储→旧码截断=1.0
    // 同维仍正常
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1, 5);
  });
});

describe("rank9a · model_ver 读侧过滤", () => {
  test("老 model_ver 的向量不参与召回（即便余弦很高）", async () => {
    const db = tmpDb();
    const a = seed(db, "AAA当前模型", 0.9);
    const b = seed(db, "BBB老模型", 0.95); // 余弦更高，但会被标成老版
    await backfillVectors(db, stubDocs); // 两条都按当前 EMBED_MODEL_VER 写入
    db.query("UPDATE vec_experiences SET model_ver = 'stale-model-v0' WHERE experience_id = ?").run(b.id);

    // 查询词与两条 content 都不字面重叠 → 只能走向量路
    const res = await searchExperiencesHybrid(db, "换个说法的查询", stubQuery);
    const ids = res.map((r) => r.id);
    expect(ids).toContain(a.id); // 当前模型：召回
    expect(ids).not.toContain(b.id); // 老模型：过滤掉，绝不拿异版向量乱算
  });
});

describe("rank8 · 单条坏 blob 不拖垮整段语义召回", () => {
  test("一条坏 blob 只跳过它，好行照常语义召回（不整体降级纯字面）", async () => {
    const db = tmpDb();
    const good = seed(db, "好行宇宙飞船", 0.9);
    const bad = seed(db, "坏行光合作用", 0.9);
    await backfillVectors(db, stubDocs);
    // 把 bad 那条的 embedding 改成 3 字节（非 4 倍数）→ blobToVec 会抛 RangeError
    db.query("UPDATE vec_experiences SET embedding = ? WHERE experience_id = ?").run(new Uint8Array([1, 2, 3]), bad.id);

    // 查询词与两条都不字面重叠 → 好行只能靠向量被找回；若坏 blob 拖垮整段语义→退纯字面→好行丢
    const res = await searchExperiencesHybrid(db, "换个说法的查询", stubQuery);
    const ids = res.map((r) => r.id);
    expect(ids).toContain(good.id); // 好行照常语义召回
    // 坏行跳过：不崩、不整体降级；坏行本身可返可不返（其向量已坏），不做强断言
  });
});
