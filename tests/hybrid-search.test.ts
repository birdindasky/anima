// 混合检索：语义补字面漏召、RRF 融合、逃生阀、出错兜底、项目过滤
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { searchExperiencesHybrid, type QueryEmbedder } from "../src/hybridSearch";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-hyb-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = frozenClock("2026-06-15T09:00:00.000Z");

// 桩：按"主题"（同义词组）映射到正交单位向量——精确控制"语义相近"，不碰真模型。
function topic(text: string): number {
  if (/鉴权|登录|token|验证|权限/.test(text)) return 0;
  if (/天气|下雨|晴/.test(text)) return 1;
  if (/数据库|schema|表|SQL/.test(text)) return 2;
  return -1;
}
function topicVec(text: string): Float32Array {
  const v = new Float32Array(3);
  const t = topic(text);
  if (t >= 0) v[t] = 1;
  return v;
}
const stubDocs: EmbedFn = async (texts) => texts.map(topicVec);
const stubQuery: QueryEmbedder = async (q) => topicVec(q);

function seed(db: ReturnType<typeof openDb>, content: string, project = "anima") {
  return insertExperience(db, { kind: "event", project, content }, clock);
}

describe("searchExperiencesHybrid", () => {
  test("语义补字面漏召：字面搜不到、按意思捞回来", async () => {
    const db = tmpDb();
    const d1 = seed(db, "登录 token 失效了"); // 主题=鉴权，但不含"鉴权"二字
    seed(db, "今天下雨了");
    await backfillVectors(db, stubDocs);

    // 纯字面：查"鉴权问题" → 拆成 鉴权/权问/问题，d1 一个都不含 → 漏
    const lexOnly = await searchExperiencesHybrid(db, "鉴权问题", stubQuery, { semantic: false });
    expect(lexOnly.map((r) => r.id)).not.toContain(d1.id);

    // 混合：向量按主题把 d1 捞回来
    const hybrid = await searchExperiencesHybrid(db, "鉴权问题", stubQuery);
    expect(hybrid.map((r) => r.id)).toContain(d1.id);
  });

  test("RRF：两路都命中的排在只命中一路的前面", async () => {
    const db = tmpDb();
    const both = seed(db, "鉴权问题排查"); // 字面含"鉴权问题" + 主题=鉴权 → 两路都中
    const vecOnly = seed(db, "登录 token 失效了"); // 仅向量（主题=鉴权）
    await backfillVectors(db, stubDocs);

    const hybrid = await searchExperiencesHybrid(db, "鉴权问题", stubQuery);
    const ids = hybrid.map((r) => r.id);
    expect(ids.indexOf(both.id)).toBeLessThan(ids.indexOf(vecOnly.id));
    expect(ids.indexOf(both.id)).toBe(0);
  });

  test("逃生阀 semantic=false → 等同纯字面", async () => {
    const db = tmpDb();
    const hit = seed(db, "鉴权问题排查");
    seed(db, "登录 token 失效了");
    await backfillVectors(db, stubDocs);
    const lex = await searchExperiencesHybrid(db, "鉴权问题", stubQuery, { semantic: false });
    expect(lex.map((r) => r.id)).toEqual([hit.id]); // 只有字面命中那条
  });

  test("embed 出错 → 自动兜回纯字面，不抛", async () => {
    const db = tmpDb();
    const hit = seed(db, "鉴权问题排查");
    await backfillVectors(db, stubDocs);
    const boom: QueryEmbedder = async () => {
      throw new Error("模型挂了");
    };
    const res = await searchExperiencesHybrid(db, "鉴权问题", boom);
    expect(res.map((r) => r.id)).toEqual([hit.id]);
  });

  test("项目过滤：向量路也只在指定项目内召回", async () => {
    const db = tmpDb();
    seed(db, "登录 token 失效了", "anima"); // 主题鉴权，项目 anima
    const other = seed(db, "登录验证流程", "acme-app"); // 主题鉴权，项目 acme-app
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, "鉴权问题", stubQuery, { project: "anima" });
    expect(res.map((r) => r.id)).not.toContain(other.id);
  });

  test("无向量库存（没补算）也不炸，退回字面", async () => {
    const db = tmpDb();
    const hit = seed(db, "鉴权问题排查");
    // 不调 backfillVectors → vec_experiences 空
    const res = await searchExperiencesHybrid(db, "鉴权问题", stubQuery);
    expect(res.map((r) => r.id)).toEqual([hit.id]);
  });
});
