// 向量补算：覆盖全算、幂等续跑、失效过滤、换模型重算
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { backfillVectors, type EmbedFn } from "../src/vectorize";
import { blobToVec } from "../src/embed";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-vz-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-06-15T09:00:00.000Z";
const clock = frozenClock(NOW);

// 桩 embedder：确定性向量（长度、首字码点），不碰真模型
const stub: EmbedFn = async (texts) =>
  texts.map((t) => new Float32Array([t.length, t.charCodeAt(0) || 0, 1]));

function seed(db: ReturnType<typeof openDb>, content: string) {
  return insertExperience(db, { kind: "event", project: "anima", content }, clock);
}

function vecCount(db: ReturnType<typeof openDb>) {
  return (db.query("SELECT count(*) c FROM vec_experiences").get() as { c: number }).c;
}

describe("backfillVectors", () => {
  test("给所有 live 经历补算，返回条数", async () => {
    const db = tmpDb();
    seed(db, "登录 token 过期");
    seed(db, "重构鉴权模块");
    seed(db, "今天天气不错");
    const n = await backfillVectors(db, stub, { batchSize: 2 });
    expect(n).toBe(3);
    expect(vecCount(db)).toBe(3);
  });

  test("续跑幂等：再跑一次新算 0、无重复", async () => {
    const db = tmpDb();
    seed(db, "a");
    seed(db, "b");
    await backfillVectors(db, stub);
    const n2 = await backfillVectors(db, stub);
    expect(n2).toBe(0);
    expect(vecCount(db)).toBe(2);
  });

  test("失效/过期经历不算向量", async () => {
    const db = tmpDb();
    const live = seed(db, "live one");
    const dead = seed(db, "invalid one");
    invalidateExperience(db, dead.id, clock);
    const n = await backfillVectors(db, stub);
    expect(n).toBe(1);
    const rows = db.query("SELECT experience_id FROM vec_experiences").all() as { experience_id: number }[];
    expect(rows.map((r) => r.experience_id)).toEqual([live.id]);
  });

  test("存的向量 = 桩算出来的", async () => {
    const db = tmpDb();
    const e = seed(db, "abc");
    await backfillVectors(db, stub);
    const got = db.query("SELECT embedding FROM vec_experiences WHERE experience_id = ?").get(e.id) as {
      embedding: Uint8Array;
    };
    expect([...blobToVec(got.embedding)]).toEqual([3, "a".charCodeAt(0), 1]);
  });

  test("换模型版本 → 旧向量重算", async () => {
    const db = tmpDb();
    seed(db, "x");
    await backfillVectors(db, stub, { modelVer: "old-model" });
    expect(vecCount(db)).toBe(1);
    // 新模型版本：同一条重算（覆盖，不新增行）
    const n = await backfillVectors(db, stub, { modelVer: "new-model" });
    expect(n).toBe(1);
    expect(vecCount(db)).toBe(1);
    const got = db.query("SELECT model_ver FROM vec_experiences").get() as { model_ver: string };
    expect(got.model_ver).toBe("new-model");
  });

  test("空库不报错、返回 0", async () => {
    const db = tmpDb();
    expect(await backfillVectors(db, stub)).toBe(0);
  });
});
