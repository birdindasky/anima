// AUDIT-2026-07-01 盘点 U37 红灯先行：作废/过期宿主的向量行永不清理，vec_experiences 无界增长。
// 读侧三重闸（live JOIN / model_ver / 维度）保证孤儿只是磁盘+扫表负担、不是召回污染——
// 修＝pruneOrphanVectors 夜跑顺手清（幂等、只删 dead 宿主的行；experiences 零物理删除 → 孤儿仅此一种）。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { pruneOrphanVectors } from "../src/vectorize";
import { frozenClock } from "../src/clock";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-vecprune-${process.pid}-${n++}.db`));
const clk = frozenClock("2026-06-10T12:00:00.000Z");

const vecCount = (db: ReturnType<typeof freshDb>) =>
  (db.query("SELECT count(*) c FROM vec_experiences").get() as { c: number }).c;

function seedVec(db: ReturnType<typeof freshDb>, expId: number, modelVer = "test-model-v1"): void {
  const blob = new Uint8Array(new Float32Array([0.1, 0.2, 0.3]).buffer);
  db.query("INSERT INTO vec_experiences (experience_id, embedding, model_ver) VALUES (?, ?, ?)").run(
    expId,
    blob,
    modelVer,
  );
}

describe("U37 向量孤儿清理", () => {
  test("作废宿主的向量行被清，live 宿主的原样保留", () => {
    const db = freshDb();
    const dead = insertExperience(db, { kind: "self_review", content: "已被推翻", sourceSession: "s1" }, clk);
    const live = insertExperience(db, { kind: "self_review", content: "仍然成立", sourceSession: "s1" }, clk);
    seedVec(db, dead.id);
    seedVec(db, live.id);
    invalidateExperience(db, dead.id, clk);

    expect(vecCount(db)).toBe(2);
    const pruned = pruneOrphanVectors(db);
    expect(pruned).toBe(1);
    expect(vecCount(db)).toBe(1);
    const left = db.query("SELECT experience_id FROM vec_experiences").get() as { experience_id: number };
    expect(left.experience_id).toBe(live.id);
  });

  test("幂等：二次清理 0 行，live 向量永不误删", () => {
    const db = freshDb();
    const live = insertExperience(db, { kind: "self_review", content: "活的", sourceSession: "s1" }, clk);
    seedVec(db, live.id);
    expect(pruneOrphanVectors(db)).toBe(0);
    expect(pruneOrphanVectors(db)).toBe(0);
    expect(vecCount(db)).toBe(1);
  });

  test("expired_at 单独置位（无 invalid_at）的宿主同样算孤儿", () => {
    const db = freshDb();
    const exp = insertExperience(db, { kind: "self_review", content: "过期", sourceSession: "s1" }, clk);
    seedVec(db, exp.id);
    db.query("UPDATE experiences SET expired_at = ? WHERE id = ?").run("2026-06-10T13:00:00.000Z", exp.id);
    expect(pruneOrphanVectors(db)).toBe(1);
    expect(vecCount(db)).toBe(0);
  });
});
