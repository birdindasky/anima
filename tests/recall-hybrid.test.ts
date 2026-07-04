// 混合召回（searchMemoryIndexHybrid）：语义命中→经历索引行、全空→流水兜底、逃生阀退字面
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { searchMemoryIndexHybrid } from "../src/recall";
import { type QueryEmbedder } from "../src/hybridSearch";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-rh-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = frozenClock("2026-06-16T09:00:00.000Z");

function topicVec(text: string): Float32Array {
  const v = new Float32Array(3);
  if (/鉴权|登录|token|验证/.test(text)) v[0] = 1;
  else if (/部署|上线|生产/.test(text)) v[1] = 1;
  return v;
}
const stubDocs: EmbedFn = async (texts) => texts.map(topicVec);
const stubQuery: QueryEmbedder = async (q) => topicVec(q);

describe("searchMemoryIndexHybrid", () => {
  test("语义命中 → 产出经历索引行（字面搜不到也召回）", async () => {
    const db = tmpDb();
    insertExperience(db, { kind: "event", project: "anima", content: "登录 token 失效了" }, clock);
    await backfillVectors(db, stubDocs);
    const lines = await searchMemoryIndexHybrid(db, "鉴权问题", stubQuery, { clock });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].source).toBe("experience");
    expect(lines[0].line).toContain("登录 token 失效了");
  });

  test("经历全空 → 翻原始流水兜底", async () => {
    const db = tmpDb();
    appendSituation(
      db,
      { sessionId: "s1", project: "anima", kind: "user_message", payload: { text: "我要部署到生产环境" } },
      clock,
    );
    const lines = await searchMemoryIndexHybrid(db, "部署", stubQuery, { clock });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].source).toBe("situation");
  });

  test("逃生阀 semantic=false → 纯字面", async () => {
    const db = tmpDb();
    insertExperience(db, { kind: "event", project: "anima", content: "鉴权问题排查" }, clock);
    insertExperience(db, { kind: "event", project: "anima", content: "登录 token 失效了" }, clock);
    await backfillVectors(db, stubDocs);
    const lines = await searchMemoryIndexHybrid(db, "鉴权问题", stubQuery, { clock, semantic: false });
    // 纯字面只命中含"鉴权问题"那条，不会把语义近的"登录token"拉进来
    expect(lines.map((l) => l.line).join("\n")).toContain("鉴权问题排查");
    expect(lines.map((l) => l.line).join("\n")).not.toContain("登录 token 失效了");
  });
});
