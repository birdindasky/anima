// R10-display：schema_version 损坏态（NULL / 非法整数）必须在展示层**响亮可见**为「损坏」，
// 绝不被压平成 "unknown"（等同静默降级为正常态）。同时要区分「损坏」与「未知/探测失败」两种 !ok：
// 行缺失（全新库/尚无版本行）仍显示 unknown，不误报损坏。
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { buildSelfStatusBlock } from "../src/selfStatus";
import { collectSelfKnowledge, renderSelfKnowledge } from "../scripts/whoami";
import { probe } from "../src/introspect";

// 最小库：满足 selfStatus（experiences COUNT）+ whoami（vec_experiences/digest_runs/meta）两条读路径。
function mkDb(schemaValue: string | null | undefined): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE experiences(id INTEGER PRIMARY KEY, kind TEXT, content TEXT, created_at TEXT, occurred_at TEXT, expired_at TEXT, invalid_at TEXT);
    CREATE TABLE vec_experiences(experience_id INTEGER PRIMARY KEY, embedding BLOB, model_ver TEXT);
    CREATE TABLE digest_runs(night TEXT, stage TEXT, status TEXT);
  `);
  if (schemaValue === undefined) {
    // 行缺失：完全不写 schema_version（等同全新库/尚无版本行）——这是「未知」而非「损坏」。
  } else if (schemaValue === null) {
    db.query("INSERT INTO meta(key,value) VALUES('schema_version', NULL)").run();
  } else {
    db.query("INSERT INTO meta(key,value) VALUES('schema_version', ?)").run(schemaValue);
  }
  return db;
}

const noLaunchd = () => "";

// ── introspect 机制层：损坏要带 corrupt 标记，行缺失不带 ──
test("introspect：schema_version NULL → ok:false 且 corrupt", () => {
  const db = mkDb(null);
  const p = probe("anima.schema_version", db);
  expect(p.ok).toBe(false);
  expect((p as { corrupt?: boolean }).corrupt).toBe(true);
  db.close();
});

test("introspect：schema_version '8abc' 非法整数 → ok:false 且 corrupt", () => {
  const db = mkDb("8abc");
  const p = probe("anima.schema_version", db);
  expect(p.ok).toBe(false);
  expect((p as { corrupt?: boolean }).corrupt).toBe(true);
  db.close();
});

test("introspect：schema_version 行缺失 → ok:false 但非 corrupt（未知≠损坏）", () => {
  const db = mkDb(undefined);
  const p = probe("anima.schema_version", db);
  expect(p.ok).toBe(false);
  expect((p as { corrupt?: boolean }).corrupt).not.toBe(true);
  db.close();
});

// ── selfStatus 注入块：损坏响亮可见，非 unknown ──
test("selfStatus 块：schema_version NULL → 显示「损坏」而非 vunknown", () => {
  const db = mkDb(null);
  const block = buildSelfStatusBlock(db, 150);
  expect(block).toContain("损坏");
  expect(block).not.toContain("vunknown");
  db.close();
});

test("selfStatus 块：schema_version 非法整数 → 显示「损坏」", () => {
  const db = mkDb("v8-conflict");
  const block = buildSelfStatusBlock(db, 150);
  expect(block).toContain("损坏");
  expect(block).not.toContain("vunknown");
  db.close();
});

test("selfStatus 块：schema_version 行缺失 → 仍 unknown，不误报损坏", () => {
  const db = mkDb(undefined);
  const block = buildSelfStatusBlock(db, 150);
  expect(block).not.toContain("损坏");
  expect(block).toContain("unknown");
  db.close();
});

test("selfStatus 块：正常整数 schema_version → 照常显示版本号", () => {
  const db = mkDb("8");
  const block = buildSelfStatusBlock(db, 150);
  expect(block).toContain("schema v8");
  expect(block).not.toContain("损坏");
  db.close();
});

// ── whoami：损坏在报告与主字段响亮可见 ──
test("whoami：schema_version NULL → 报告含「损坏」、主字段非 unknown", () => {
  const db = mkDb(null);
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.schemaVersion).toContain("损坏");
  const report = renderSelfKnowledge(sk);
  expect(report).toContain("损坏");
  db.close();
});

test("whoami：schema_version 非法整数 → 报告含「损坏」", () => {
  const db = mkDb("8abc");
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.schemaVersion).toContain("损坏");
  expect(renderSelfKnowledge(sk)).toContain("损坏");
  db.close();
});

test("whoami：schema_version 行缺失 → 主字段 unknown，不误报损坏", () => {
  const db = mkDb(undefined);
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.schemaVersion).toBe("unknown");
  expect(renderSelfKnowledge(sk)).not.toContain("损坏");
  db.close();
});
