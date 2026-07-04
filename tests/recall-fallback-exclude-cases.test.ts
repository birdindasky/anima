// INDEPENDENT GRADER TEST (not the implementer's). Verifies self_review_fallback shells are
// excluded from BOTH retrieval paths and all recall entrypoints, with no collateral damage.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import {
  insertExperience,
  invalidateExperience,
  searchExperiences,
  RECALL_EXCLUDE_KIND_SQL,
} from "../src/experiences";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { searchExperiencesHybrid, type QueryEmbedder } from "../src/hybridSearch";
import { searchMemoryIndex, searchMemoryIndexHybrid } from "../src/recall";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-grader-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = frozenClock("2026-06-15T09:00:00.000Z");

// Stub embedder: everything mentioning "权限/鉴权/token" maps to the SAME unit vector,
// so a fallback shell containing those words has cosine 1.0 with the query — it WOULD match
// the vector path if not excluded. This is the adversarial seed.
function vecFor(text: string): Float32Array {
  const v = new Float32Array(2);
  if (/权限|鉴权|token|登录|0 条|兜底|自评/.test(text)) v[0] = 1;
  else v[1] = 1;
  return v;
}
const stubDocs: EmbedFn = async (texts) => texts.map(vecFor);
const stubQuery: QueryEmbedder = async (q) => vecFor(q);

// A realistic fallback shell whose content is FULL of the query words (would match lexical too).
const SHELL =
  "客观流水兜底摘要（自评生成失败 2 次）：权限测试 鉴权 token 登录；用户消息 0 条；测试跑了 0 次。";
const QUERY = "权限 鉴权 token 登录";

describe("GRADER: self_review_fallback excluded from recall", () => {
  test("predicate const is exported and references e.kind", () => {
    expect(RECALL_EXCLUDE_KIND_SQL).toContain("self_review_fallback");
    expect(RECALL_EXCLUDE_KIND_SQL).toContain("digest_fallback"); // 两类兜底壳同口径排除（AUDIT A区#1 连带）
    expect(RECALL_EXCLUDE_KIND_SQL).toContain("e.kind");
  });

  test("(a) lexical searchExperiences excludes the shell, keeps a real memory", () => {
    const db = tmpDb();
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const real = insertExperience(db, { kind: "self_review", project: "anima", content: "权限 鉴权 token 登录 都修好了" }, clock);
    const res = searchExperiences(db, QUERY);
    const ids = res.map((r) => r.id);
    expect(ids).not.toContain(shell.id);
    expect(ids).toContain(real.id);
  });

  test("(b) hybrid (semantic on): shell absent even though its VECTOR matches perfectly", async () => {
    const db = tmpDb();
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const real = insertExperience(db, { kind: "event", project: "anima", content: "鉴权 token 登录 排查" }, clock);
    await backfillVectors(db, stubDocs);
    // sanity: the shell DID get a live vector (proves backfill does not pre-filter it)
    const vecCount = db.query("SELECT count(*) c FROM vec_experiences WHERE experience_id = ?").get(shell.id) as { c: number };
    expect(vecCount.c).toBe(1);

    const res = await searchExperiencesHybrid(db, QUERY, stubQuery);
    const ids = res.map((r) => r.id);
    expect(ids).not.toContain(shell.id);
    expect(ids).toContain(real.id);
  });

  test("(c) hybrid semantic:false (escape hatch) still excludes the shell", async () => {
    const db = tmpDb();
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const real = insertExperience(db, { kind: "decision", project: "anima", content: "权限 鉴权 token 登录 决定" }, clock);
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, QUERY, stubQuery, { semantic: false });
    const ids = res.map((r) => r.id);
    expect(ids).not.toContain(shell.id);
    expect(ids).toContain(real.id);
  });

  test("includeHistory:true STILL excludes the shell, but returns expired REAL memory", () => {
    const db = tmpDb();
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const expiredReal = insertExperience(db, { kind: "self_review", project: "anima", content: "权限 鉴权 token 登录 旧记忆" }, clock);
    invalidateExperience(db, expiredReal.id, clock); // make it expired/invalid
    // default recall: expired real is filtered out
    expect(searchExperiences(db, QUERY).map((r) => r.id)).not.toContain(expiredReal.id);
    // includeHistory: expired real comes back, shell stays gone
    const hist = searchExperiences(db, QUERY, { includeHistory: true }).map((r) => r.id);
    expect(hist).toContain(expiredReal.id);
    expect(hist).not.toContain(shell.id);
  });

  test("includeHistory:true on hybrid path also excludes shell, returns expired real", async () => {
    const db = tmpDb();
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const expiredReal = insertExperience(db, { kind: "self_review", project: "anima", content: "鉴权 token 登录 旧" }, clock);
    await backfillVectors(db, stubDocs);
    invalidateExperience(db, expiredReal.id, clock);
    const hist = (await searchExperiencesHybrid(db, QUERY, stubQuery, { includeHistory: true })).map((r) => r.id);
    expect(hist).not.toContain(shell.id);
    expect(hist).toContain(expiredReal.id);
  });

  test("project + includeGlobal filtering still works alongside the exclusion", () => {
    const db = tmpDb();
    insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const inProj = insertExperience(db, { kind: "event", project: "anima", content: "权限 鉴权 token 登录 本项目" }, clock);
    const global = insertExperience(db, { kind: "event", project: null, content: "权限 鉴权 token 登录 全局" }, clock);
    const other = insertExperience(db, { kind: "event", project: "other", content: "权限 鉴权 token 登录 别项目" }, clock);

    const scoped = searchExperiences(db, QUERY, { project: "anima", includeGlobal: false }).map((r) => r.id);
    expect(scoped).toContain(inProj.id);
    expect(scoped).not.toContain(global.id);
    expect(scoped).not.toContain(other.id);

    const withGlobal = searchExperiences(db, QUERY, { project: "anima", includeGlobal: true }).map((r) => r.id);
    expect(withGlobal).toContain(inProj.id);
    expect(withGlobal).toContain(global.id);
    expect(withGlobal).not.toContain(other.id);
  });

  test("all real kinds survive recall (event/decision/preference/correction/digest/self_review)", () => {
    const db = tmpDb();
    const kinds = ["event", "decision", "preference", "correction", "digest", "self_review"];
    const ids = kinds.map((k) =>
      insertExperience(db, { kind: k, project: "anima", content: `权限 鉴权 token 登录 ${k}` }, clock).id,
    );
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const got = searchExperiences(db, QUERY, { limit: 50 }).map((r) => r.id);
    for (const id of ids) expect(got).toContain(id);
    expect(got).not.toContain(shell.id);
  });

  test("FTS narrowing path (long english unit) still excludes the shell", () => {
    const db = tmpDb();
    // a long (>=3 char) unit forces the FTS narrowing branch
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: "fallbackshell token0001 自评失败" }, clock);
    const real = insertExperience(db, { kind: "event", project: "anima", content: "token0001 真实记忆" }, clock);
    const res = searchExperiences(db, "token0001").map((r) => r.id);
    expect(res).toContain(real.id);
    expect(res).not.toContain(shell.id);
  });

  test("top-level entrypoint searchMemoryIndex (sync) excludes shell", () => {
    const db = tmpDb();
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const real = insertExperience(db, { kind: "event", project: "anima", content: "权限 鉴权 token 登录 真" }, clock);
    const lines = searchMemoryIndex(db, QUERY, { clock });
    const ids = lines.map((l) => l.id);
    expect(ids).toContain(real.id);
    expect(ids).not.toContain(shell.id);
    // also: no rendered line should mention the fallback shell content
    expect(lines.some((l) => l.line.includes("兜底摘要"))).toBe(false);
  });

  test("top-level entrypoint searchMemoryIndexHybrid (async) excludes shell", async () => {
    const db = tmpDb();
    const shell = insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    const real = insertExperience(db, { kind: "event", project: "anima", content: "鉴权 token 登录 真" }, clock);
    await backfillVectors(db, stubDocs);
    const lines = await searchMemoryIndexHybrid(db, QUERY, stubQuery, { clock });
    const ids = lines.map((l) => l.id);
    expect(ids).toContain(real.id);
    expect(ids).not.toContain(shell.id);
    expect(lines.some((l) => l.line.includes("兜底摘要"))).toBe(false);
  });

  test("ADVERSARIAL: shell is the ONLY thing matching → recall returns empty (no shell leak)", async () => {
    const db = tmpDb();
    // only a shell matches; nothing real. Must NOT fall through to surfacing the shell.
    insertExperience(db, { kind: "self_review_fallback", project: "anima", content: SHELL }, clock);
    insertExperience(db, { kind: "event", project: "anima", content: "完全无关的内容 天气真好" }, clock);
    await backfillVectors(db, stubDocs);
    const res = await searchExperiencesHybrid(db, QUERY, stubQuery);
    expect(res.map((r) => r.id)).toHaveLength(0);
  });
});
