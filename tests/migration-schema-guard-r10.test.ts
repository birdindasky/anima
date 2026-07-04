// R10（AUDIT-2026-07-03 全项目审查）红灯先行 → 转绿。迁移引擎两处"会撒谎的整数 + 降级静默全站黑"：
//
// (a) readSchemaVersion 无整数校验：meta.value 非数字（损坏/手改/同步冲突）→ 旧 parseInt→NaN，而
//     `NaN > v`/`NaN === v` 皆 false → 跳过全部 DDL → 却照样 INSERT schema_version='8' 并 COMMIT →
//     空/半截库自称 v8 永久变黑、零报错永不重试。修：Number+Number.isInteger 硬校验，非法即 loud
//     throw SchemaVersionCorruptError，绝不静默盖版本。
//
// (b) schema-too-new（老代码开更新的库＝降级）：原来 migrate 硬 throw、被每个 hook 裸 catch{} 静默吞
//     → 全站黑零信号。修：openAnima 接住 SchemaTooNewError → 亮徽章"待升级"(可见态) + 只读开库让
//     读路径存活，而非静默 throw。
//
// (c) 结构断言（COMMIT 前）：DDL 万一没落地也当场炸掉回滚，别盖版本骗后人。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  openDb,
  openDbReadonly,
  SCHEMA_VERSION,
  SchemaTooNewError,
  SchemaVersionCorruptError,
} from "../src/db";
import { openAnima } from "../src/index";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "r10-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 建一个已迁到 v8 的库，然后把 schema_version 值改成 raw（模拟损坏/手改/未来版本）。 */
function dbWithVersionValue(raw: string): string {
  const p = join(freshDir(), "anima.db");
  const db = openDb(p);
  db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(raw);
  db.close();
  return p;
}
function readVersionRaw(p: string): string | undefined {
  const db = new Database(p, { readonly: true });
  const v = (db.query("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined)?.value;
  db.close();
  return v;
}

describe("R10 (a) schema_version 非法整数 → loud throw，绝不静默盖版本", () => {
  test("非数字值：openDb 抛 SchemaVersionCorruptError，且 meta.value 原封不动（没被盖成 8）", () => {
    const p = dbWithVersionValue("garbage-not-a-number");
    // 反证旧行为：旧 parseInt('garbage')=NaN → 跳过 DDL → 却 INSERT schema_version='8' COMMIT（实测坐实）。
    // 新行为：当场 loud throw、绝不进 runMigrationTx、值保持损坏原样（可被人工修复）。
    expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
    expect(readVersionRaw(p)).toBe("garbage-not-a-number"); // 命门：绝不静默盖版本
  });

  test("尾随字母（parseInt 会宽容读成 8，Number 严格判 NaN）：也 loud throw", () => {
    const p = dbWithVersionValue("8abc");
    expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
    expect(readVersionRaw(p)).toBe("8abc");
  });

  test("小数（非整数）：loud throw", () => {
    const p = dbWithVersionValue("8.5");
    expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
  });

  test("空串/纯空白：视为损坏 loud throw（TEXT NOT NULL 允许空串，但空版本号=损坏信号）", () => {
    const p = dbWithVersionValue("   ");
    expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
  });

  test("合法整数字符串（含前后空白）：正常放行，不误伤", () => {
    const p = dbWithVersionValue(` ${SCHEMA_VERSION} `);
    const db = openDb(p); // 不抛
    db.close();
  });
});

describe("R10 (b) schema-too-new → 具名 error + openAnima 可见降级态（非静默）", () => {
  test("库比代码新：openDb 抛具名 SchemaTooNewError（携带版本号）", () => {
    const p = dbWithVersionValue(String(SCHEMA_VERSION + 1));
    let caught: unknown;
    try {
      openDb(p);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaTooNewError);
    expect((caught as SchemaTooNewError).foundVersion).toBe(SCHEMA_VERSION + 1);
    expect((caught as SchemaTooNewError).supportedVersion).toBe(SCHEMA_VERSION);
  });

  test("openAnima 降级：不再静默 throw，而是亮徽章'待升级' + 只读开库 + degraded=true", () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    // 先把库建到 v8 再顶成 v+1（更新的库）
    const seed = openDb(dbPath);
    seed.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    seed.close();

    const r = openAnima({ dataDir, dbPath, badgePath });
    expect(r.degraded).toBe(true); // 可见降级态，而非抛异常被 hook 吞黑
    // 可见信号：徽章亮"待升级"
    const badge = readFileSync(badgePath, "utf8");
    expect(badge).toContain("待升级");
    // 只读开库：读路径存活，写路径响亮失败（不是零信号黑洞）
    expect(r.db.query("SELECT value FROM meta WHERE key='schema_version'").get()).toBeTruthy();
    expect(() =>
      r.db.query("INSERT INTO meta (key, value) VALUES ('x','1')").run(),
    ).toThrow();
    r.db.close();
  });

  test("openAnima 遇损坏版本号：先亮徽章示警，但仍 loud rethrow（fail-closed，不拿不可信库跑）", () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    const seed = openDb(dbPath);
    seed.query("UPDATE meta SET value = 'corrupt!!' WHERE key = 'schema_version'").run();
    seed.close();

    expect(() => openAnima({ dataDir, dbPath, badgePath })).toThrow(SchemaVersionCorruptError);
    expect(readFileSync(badgePath, "utf8")).toContain("损坏"); // 徽章仍亮出可见信号
  });
});

describe("R10 (c) 结构断言 + 常态回归", () => {
  test("正常全新库迁移：三张地基表都在、版本盖成 SCHEMA_VERSION（结构断言不误伤）", () => {
    const p = join(freshDir(), "anima.db");
    const db = openDb(p);
    for (const t of ["experiences", "situation_log", "meta"]) {
      expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
    }
    expect((db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe(
      String(SCHEMA_VERSION),
    );
    db.close();
  });

  test("openDbReadonly：能读已存在库、写被拒", () => {
    const p = join(freshDir(), "anima.db");
    openDb(p).close();
    const ro = openDbReadonly(p);
    expect(ro.query("SELECT value FROM meta WHERE key='schema_version'").get()).toBeTruthy();
    expect(() => ro.query("INSERT INTO meta (key,value) VALUES ('x','1')").run()).toThrow();
    ro.close();
  });
});
