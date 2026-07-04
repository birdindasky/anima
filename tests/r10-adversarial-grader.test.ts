// 独立盲考官对抗测试 (R10)。不复用作者测试，专攻"根因是否真消除 + 假绿灯"。
// 三条命门：
//  (1) 非整数 meta.value → 绝不静默盖版本（旧 parseInt→NaN→跳过DDL却盖v8永久黑）。
//  (2) 空库/半截库 claims 版本但被损坏值挡住，不静默当有效库。
//  (3) schema-too-new 的可见信号必须在"hook 裸 catch{} 吞掉一切"之后仍然幸存（=写在 catch 之前）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, openDbReadonly, SCHEMA_VERSION, SchemaTooNewError, SchemaVersionCorruptError } from "../src/db";
import { openAnima } from "../src/index";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "r10adv-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rawVersion(p: string): string | undefined {
  const db = new Database(p, { readonly: true });
  const v = (db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)
    ?.value;
  db.close();
  return v;
}

// 独立复刻"旧行为"的判定，证明我的对抗断言在旧代码下会红：
// 旧 readSchemaVersion = parseInt(raw,10)。对损坏值它不抛、给个数（NaN 或截断整数），
// migrate 里 NaN>v / NaN===v 皆 false → 落进"要迁移"分支 → 最终 INSERT schema_version='8' COMMIT。
function oldParseIntWouldCoverVersion(raw: string): boolean {
  const found = parseInt(raw, 10); // 旧实现
  if (found > SCHEMA_VERSION) return false; // too-new 会 throw，不覆盖
  if (found === SCHEMA_VERSION) return false; // 已最新短路
  // 其余（含 NaN 与被截断的 8abc→8? 实际 parseInt('8abc')=8===v 短路；'garbage'=NaN 落这）→ 进迁移→盖版本
  return true;
}

describe("R10 命门1：损坏版本号绝不静默盖版本（对抗旧 parseInt 覆盖）", () => {
  for (const bad of ["garbage-not-a-number", "NaN", "Infinity", "8.5", "  ", "v8"]) {
    test(`损坏值 ${JSON.stringify(bad)}：新代码 loud throw 且版本原封不动`, () => {
      const p = join(freshDir(), "anima.db");
      const seed = openDb(p);
      seed.query("UPDATE meta SET value = ? WHERE key='schema_version'").run(bad);
      seed.close();

      expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
      // 命门：损坏值必须保持原样，绝不被盖成 SCHEMA_VERSION。
      expect(rawVersion(p)).toBe(bad);
    });
  }

  test("反证：这些损坏值在旧 parseInt 实现下确实会被静默盖版本（=我的断言旧行为下红）", () => {
    // 至少 'garbage-not-a-number' 这类纯非数字：旧路径 NaN→落迁移→盖 v8。
    expect(oldParseIntWouldCoverVersion("garbage-not-a-number")).toBe(true);
    expect(oldParseIntWouldCoverVersion("NaN")).toBe(true);
    expect(oldParseIntWouldCoverVersion("Infinity")).toBe(true); // parseInt('Infinity')=NaN
  });
});

describe("R10 命门2：空/半截库 claims 版本但值损坏 → 不静默当有效库", () => {
  test("裸库只有损坏的 meta、无核心表：新代码拒绝迁移不静默放行", () => {
    const p = join(freshDir(), "anima.db");
    // 手工造一个"半截/损坏"库：有 meta 表 + 损坏版本值，但没有 experiences 等核心表。
    const raw = new Database(p);
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    raw.exec("INSERT INTO meta (key,value) VALUES ('schema_version','totally-broken');");
    raw.close();

    expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
    // 没有核心表被建、也没把损坏值盖成 8：库保持"可被人工诊断"的原样。
    const chk = new Database(p, { readonly: true });
    expect(chk.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='experiences'").get()).toBeFalsy();
    expect((chk.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe(
      "totally-broken",
    );
    chk.close();
  });

  test("不误伤：合法整数（含前后空白/换行）正常放行", () => {
    const p = join(freshDir(), "anima.db");
    const seed = openDb(p);
    seed.query("UPDATE meta SET value = ? WHERE key='schema_version'").run(`\n ${SCHEMA_VERSION} \n`);
    seed.close();
    const db = openDb(p); // 不抛
    db.close();
  });
});

describe("R10 命门3：schema-too-new 的可见信号在'hook 裸 catch{} 吞一切'之后仍幸存", () => {
  test("too-new：openAnima 不抛 → degraded + 徽章'待升级' + 只读库（读活写死）", () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    const seed = openDb(dbPath);
    seed.query("UPDATE meta SET value = ? WHERE key='schema_version'").run(String(SCHEMA_VERSION + 3));
    seed.close();

    const r = openAnima({ dataDir, dbPath, badgePath });
    expect(r.degraded).toBe(true);
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");
    // 读路径活
    expect(r.db.query("SELECT value FROM meta WHERE key='schema_version'").get()).toBeTruthy();
    // 写路径响亮失败（只读）——不是零信号黑洞
    expect(() => r.db.query("INSERT INTO meta (key,value) VALUES ('x','1')").run()).toThrow();
    r.db.close();
  });

  test("命门：把 openAnima 包进和 hooks/stop.ts 一样的裸 catch{}——损坏态 rethrow 被吞，但徽章信号已落盘幸存", () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    const seed = openDb(dbPath);
    seed.query("UPDATE meta SET value = 'corrupt-xyz' WHERE key='schema_version'").run();
    seed.close();

    // 完整复刻 hooks/stop.ts:42 的 `} catch {}`：吞掉一切异常、静默退出。
    let swallowed = false;
    try {
      openAnima({ dataDir, dbPath, badgePath });
    } catch {
      swallowed = true; // 裸 catch 确实吞了 SchemaVersionCorruptError（模拟旧"全站黑"路径）
    }
    expect(swallowed).toBe(true);
    // 根因判定：即便 hook 把异常吞成静默，可见信号（徽章）也已在 throw 之前落盘 → 不再是零信号黑洞。
    expect(existsSync(badgePath)).toBe(true);
    expect(readFileSync(badgePath, "utf8")).toContain("损坏");
  });

  test("反证 too-new 旧行为会被 hook 裸 catch 吞黑：SchemaTooNewError 是 Error 子类，裸 catch 会捕获", () => {
    // 旧行为 = migrate 直接 throw SchemaTooNewError，openAnima 若不接住则冒泡到 hook 的 catch{} → 零信号。
    const e = new SchemaTooNewError(SCHEMA_VERSION + 1, SCHEMA_VERSION);
    expect(e).toBeInstanceOf(Error); // 会被 `catch {}` 吞
    // 新行为把它转成"返回值 degraded"而非异常，从根上绕开裸 catch。
  });
});
