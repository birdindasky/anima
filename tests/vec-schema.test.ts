// v4 语义指纹边表 schema —— 附加迁移、向量 BLOB 往返、外键约束
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb, SCHEMA_VERSION } from "../src/db";
import { insertExperience } from "../src/experiences";
import { vecToBlob, blobToVec, EMBED_MODEL_VER } from "../src/embed";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-vec-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-06-15T09:00:00.000Z";

describe("v4 向量边表 schema", () => {
  test("库被打到当前 schema 版本（版本数字硬断言归 worker-schema.test.ts）", () => {
    const db = tmpDb();
    const row = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    // SCHEMA_VERSION 随 worker schema 升到 5；这里只断言迁移把库打到当前版本，不再硬钉具体数字
    expect(row.value).toBe(String(SCHEMA_VERSION));
  });

  test("vec_experiences 表存在且列正确", () => {
    const db = tmpDb();
    const cols = (db.query("PRAGMA table_info(vec_experiences)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.sort()).toEqual(["embedding", "experience_id", "model_ver"]);
  });

  test("存取向量 BLOB 往返保真 + model_ver", () => {
    const db = tmpDb();
    const exp = insertExperience(
      db,
      { kind: "event", project: "anima", content: "登录 token 过期" },
      frozenClock(NOW),
    );
    const vec = new Float32Array([0.1, -0.2, 0.3, 0.9, -0.5]);
    db.query("INSERT INTO vec_experiences (experience_id, embedding, model_ver) VALUES (?, ?, ?)").run(
      exp.id,
      vecToBlob(vec),
      EMBED_MODEL_VER,
    );
    const got = db
      .query("SELECT embedding, model_ver FROM vec_experiences WHERE experience_id = ?")
      .get(exp.id) as { embedding: Uint8Array; model_ver: string };
    expect([...blobToVec(got.embedding)]).toEqual([...vec]);
    expect(got.model_ver).toBe(EMBED_MODEL_VER);
  });

  test("外键挡住给不存在的经历存向量", () => {
    const db = tmpDb();
    expect(() =>
      db
        .query("INSERT INTO vec_experiences (experience_id, embedding, model_ver) VALUES (?, ?, ?)")
        .run(999999, vecToBlob(new Float32Array([1])), "x"),
    ).toThrow();
  });

  test("重复开同一库不报错、数据保留（迁移幂等）", () => {
    const d = mkdtempSync(join(tmpdir(), "anima-vec-"));
    tmpDirs.push(d);
    const path = join(d, "anima.db");
    const db1 = openDb(path);
    const exp = insertExperience(db1, { kind: "event", project: "anima", content: "x" }, frozenClock(NOW));
    db1.query("INSERT INTO vec_experiences (experience_id, embedding, model_ver) VALUES (?, ?, ?)").run(
      exp.id,
      vecToBlob(new Float32Array([1, 2, 3])),
      EMBED_MODEL_VER,
    );
    db1.close();
    const db2 = openDb(path); // 二次开库走迁移，不该报错
    const n = db2.query("SELECT count(*) c FROM vec_experiences").get() as { c: number };
    expect(n.c).toBe(1);
  });
});
