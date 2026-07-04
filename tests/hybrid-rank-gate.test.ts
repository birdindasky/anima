// 钉2（排序钝）+ 钉3（陷阱无空返回闸）：
// - 钉2：RRF 融合后同分按「情绪烙印→近因→id」打破，相关性仍是主轴不被越过。
// - 钉3：向量路 cosine>0 的地板对 bge 形同虚设（基线相似度本来就高），陷阱题靠语义沾边
//        漏一片平庸噪音。改为经实测标定的余弦地板，字面+向量都空时诚实空返回。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock, type Clock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { searchExperiencesHybrid, VECTOR_MIN_COSINE, type QueryEmbedder } from "../src/hybridSearch";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-hrg-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 余弦桩：query=[1,0]，doc 映射到指定余弦 c → 单位向量 [c, √(1-c²)]，cosine(query,doc)=c。
const COS = new Map<string, number>();
function vecAt(c: number): Float32Array {
  return Float32Array.from([c, Math.sqrt(Math.max(0, 1 - c * c))]);
}
const stubDocs: EmbedFn = async (texts) => texts.map((t) => vecAt(COS.get(t) ?? 0));
const stubQuery: QueryEmbedder = async () => Float32Array.from([1, 0]);

function seed(
  db: ReturnType<typeof openDb>,
  content: string,
  cos: number,
  opts: { feeling?: string | null; clock?: Clock } = {},
) {
  COS.set(content, cos);
  return insertExperience(
    db,
    { kind: "event", project: "anima", content, feeling: opts.feeling ?? null },
    opts.clock ?? frozenClock("2026-06-18T09:00:00.000Z"),
  );
}

const oldClock = frozenClock("2026-06-10T09:00:00.000Z");
const newClock = frozenClock("2026-06-18T09:00:00.000Z");

afterEach(() => COS.clear());

describe("钉3 · 向量地板（保守剪垃圾，非陷阱解）", () => {
  // 注意：独立考官真模型证伪了"高地板堵陷阱"——bge 真实余弦下陷阱噪音(≈0.51)与真命中
  // (C5≈0.42 / C10≈0.53 / 跨语言≈0.45)区间重叠，无单一标量能分开。故地板取保守 0.30，
  // 只剪明显正交项、对真召回零代价；干净"陷阱空返回"留作检索栈升级（见 hybridSearch.ts 注释）。
  test("地板保守、远低于真命中底（≈0.42）：不为堵陷阱赌一个误杀真召回的高地板", () => {
    expect(VECTOR_MIN_COSINE).toBeGreaterThan(0); // 比原 cosine>0 严，挡正交垃圾
    expect(VECTOR_MIN_COSINE).toBeLessThan(0.4); // 远低于实测真命中底，零召回代价
  });

  test("明显正交项（向量 0.20，地板下）被剪：字面也无命中 → 空返回", async () => {
    const db = tmpDb();
    seed(db, "部署上线流程", 0.2); // 正交无关，低于地板
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, "鉴权登录令牌", stubQuery);
    expect(res.length).toBe(0);
  });

  test("换说法救场：字面无命中但向量过地板（0.45，含低余弦真命中）→ 召回（不误杀）", async () => {
    const db = tmpDb();
    const d = seed(db, "部署上线流程", 0.45); // 低余弦真命中，仍在地板上
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, "鉴权登录令牌", stubQuery);
    expect(res.map((r) => r.id)).toContain(d.id);
  });

  test("正交一热桩（cosine 1/0）行为不变：同主题召回、异主题不召回", async () => {
    const db = tmpDb();
    const hit = seed(db, "鉴权登录令牌排查", 1.0);
    const miss = seed(db, "完全无关的天气", 0.0);
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, "鉴权登录令牌", stubQuery);
    expect(res.map((r) => r.id)).toContain(hit.id);
    expect(res.map((r) => r.id)).not.toContain(miss.id);
  });
});

describe("钉2 · 同分按情绪/近因打破", () => {
  test("RRF 同分：带情绪烙印的排在无情绪的前面", async () => {
    const db = tmpDb();
    // A：仅字面命中（向量 0 被地板挡）、无情绪
    const a = seed(db, "鉴权登录令牌甲", 0.0, { feeling: null });
    // B：仅向量命中（无字面交集）、带情绪 → 与 A 同分（各自 rank0）
    const b = seed(db, "部署上线流程乙", 0.9, { feeling: "松了口气" });
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, "鉴权登录令牌", stubQuery);
    const ids = res.map((r) => r.id);
    expect(ids).toEqual([b.id, a.id]); // 同分，带情绪的 B 在前
  });

  test("RRF 同分且情绪相同：近因（occurred_at 晚）的排在前", async () => {
    const db = tmpDb();
    // 两条都无情绪、各自 rank0 同分；A 更新、B 更旧 → A 应在前（证近因驱动，非 id 顺序）
    const a = seed(db, "鉴权登录令牌甲", 0.0, { feeling: null, clock: newClock });
    const b = seed(db, "部署上线流程乙", 0.9, { feeling: null, clock: oldClock });
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, "鉴权登录令牌", stubQuery);
    // A(id 小但更新) 在 B(id 大但更旧) 前 → 近因压过 id 末位序
    expect(res.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  test("相关性不被越过：明显更相关者（两路都中、融合分更高）压过更新/带情绪者", async () => {
    const db = tmpDb();
    // high：字面+向量都 rank0 → 融合分 2/61，无情绪、更旧
    const high = seed(db, "鉴权登录令牌中枢", 0.9, { feeling: null, clock: oldClock });
    // low：仅向量 rank1（0.7<0.9）→ 融合分 1/62，带情绪、更新
    const low = seed(db, "部署上线流程边缘", 0.7, { feeling: "爽", clock: newClock });
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, "鉴权登录令牌", stubQuery);
    expect(res[0].id).toBe(high.id); // 相关性主轴：high 必在前，不被情绪/近因翻盘
  });
});
