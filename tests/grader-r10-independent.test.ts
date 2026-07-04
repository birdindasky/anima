// 独立盲考官 R10 对抗测试（与作者自测无关，重写、专挑边角）。
// 5 项需求：
//  (1) degraded 态心情 badge 不覆盖"待升级"警示牌（回归已消）
//  (2) NULL / 非数字 meta.value 走可见损坏路径（SchemaVersionCorruptError），不是裸 TypeError
//  (3) openDb 后门（worker 徽章 / backfill 脚本 stderr）降级有可见信号
//  (4) degraded hook 不静默吞（可见信号=徽章幸存）
//  (5) worker 取锁后 openDb 抛异常也放锁
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, SCHEMA_VERSION, SchemaTooNewError, SchemaVersionCorruptError } from "../src/db";
import { runWorker } from "../src/worker";
import { acquireRunLock, releaseRunLock, isRunLockActive, taskRunPaths } from "../src/runLock";
import type { LlmClient } from "../src/llm";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gr-r10-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 建健康 v8 库，再把 schema_version 顶成 raw（模拟更新的库 / 手改损坏值）。 */
function seedVersion(dbPath: string, raw: string): void {
  const db = openDb(dbPath);
  db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(raw);
  db.close();
}

/** 直接建 meta 表并写指定值（含可空列 + NULL），绕开 openDb 的迁移。 */
function rawMeta(dbPath: string, insertSql: string): void {
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"); // 列可空
  raw.exec(insertSql);
  raw.close();
}

const STOP_HOOK = join(import.meta.dir, "..", "hooks", "stop.ts");
const SESSION_END_HOOK = join(import.meta.dir, "..", "hooks", "session-end.ts");
const HEAL_NOW = join(import.meta.dir, "..", "scripts", "heal-now.ts");

async function runHook(script: string, input: Record<string, unknown>, dataDir: string) {
  const proc = Bun.spawn(["bun", script], {
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      ANIMA_DATA_DIR: dataDir,
      ANIMA_CONFIG_PATH: join(dataDir, "no-such-config.json"),
      ANIMA_HEADLESS: "",
    },
  });
  await proc.exited;
  return proc.exitCode;
}

// ── (1)+(4) degraded hook：待升级 徽章幸存、心情标签绝不覆盖 ───────────────────
describe("R10 (1)(4) degraded hook 不覆盖警示牌 / 不静默", () => {
  for (const [name, hook] of [["Stop", STOP_HOOK], ["SessionEnd", SESSION_END_HOOK]] as const) {
    test(`${name}：库比代码新 → 徽章保持"待升级"、不含心情词`, async () => {
      const dataDir = freshDir();
      const badgePath = join(dataDir, "badge.txt");
      seedVersion(join(dataDir, "anima.db"), String(SCHEMA_VERSION + 1));

      const code = await runHook(hook, {}, dataDir);
      expect(code).toBe(0); // hook 永不非 0
      const badge = readFileSync(badgePath, "utf8");
      // 命门（gap1 回归）：openAnima 亮的"待升级"必须幸存，未被 refreshBadge 心情标签盖掉。
      expect(badge).toContain("待升级");
      // 反证：常见心情词一个都不该出现（证明确实没走 refreshBadge 写路径）。
      for (const mood of ["平静", "投入", "疲惫", "卡住", "低落", "愉快"]) {
        expect(badge).not.toContain(mood);
      }
    }, 30_000);
  }

  test("Stop 有真 transcript：有活可采也照样跳过写、不覆盖徽章", async () => {
    const dataDir = freshDir();
    const badgePath = join(dataDir, "badge.txt");
    seedVersion(join(dataDir, "anima.db"), String(SCHEMA_VERSION + 3));
    const tp = join(dataDir, "s1.jsonl");
    writeFileSync(
      tp,
      JSON.stringify({
        uuid: "u1", parentUuid: null, isSidechain: false, sessionId: "s1",
        timestamp: "2026-07-03T01:00:00.000Z", cwd: "/proj", type: "user",
        isMeta: false, message: { role: "user", content: "hi" },
      }) + "\n",
    );
    const code = await runHook(STOP_HOOK, { transcript_path: tp, session_id: "s1" }, dataDir);
    expect(code).toBe(0);
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");
  }, 30_000);

  test("不误伤常态：健康 v8 库 Stop 照刷心情、不误报待升级", async () => {
    const dataDir = freshDir();
    const badgePath = join(dataDir, "badge.txt");
    openDb(join(dataDir, "anima.db")).close();
    const code = await runHook(STOP_HOOK, {}, dataDir);
    expect(code).toBe(0);
    const badge = readFileSync(badgePath, "utf8");
    expect(badge.length).toBeGreaterThan(0);
    expect(badge).not.toContain("待升级");
  }, 30_000);
});

// ── (2) NULL / 非数字 meta.value → SchemaVersionCorruptError（非裸 TypeError）────
describe("R10 (2) 损坏 schema_version 走可见损坏路径", () => {
  test("value 为 NULL → SchemaVersionCorruptError（不是 TypeError）", () => {
    const p = join(freshDir(), "anima.db");
    rawMeta(p, "INSERT INTO meta (key, value) VALUES ('schema_version', NULL);");
    let err: unknown;
    try { openDb(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SchemaVersionCorruptError);
    // 铁证：绝不是裸 TypeError（那会漏掉损坏徽章分支）。
    expect(err).not.toBeInstanceOf(TypeError);
  });

  for (const bad of ["", "   ", "8abc", "v8", "8.5", "NaN"]) {
    test(`value=${JSON.stringify(bad)} → SchemaVersionCorruptError`, () => {
      const p = join(freshDir(), "anima.db");
      rawMeta(p, `INSERT INTO meta (key, value) VALUES ('schema_version', '${bad}');`);
      expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
    });
  }

  test("合法整数 '9'（更新的库）→ 是 TooNew 不是 Corrupt（别把降级误判成损坏）", () => {
    const p = join(freshDir(), "anima.db");
    seedVersion(p, "9");
    let err: unknown;
    try { openDb(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SchemaTooNewError);
    expect(err).not.toBeInstanceOf(SchemaVersionCorruptError);
  });

  test("健康 '8' → 正常开库不抛", () => {
    const p = join(freshDir(), "anima.db");
    const db = openDb(p);
    expect(db).toBeDefined();
    db.close();
  });
});

// ── (3)+(5) worker 后门徽章 + 放锁 ───────────────────────────────────────────
describe("R10 (3)(5) worker 后门可见信号 + 放锁", () => {
  const llm: LlmClient = async () => "";
  const now = new Date("2026-07-03T02:00:00.000Z");

  test("too-new 库：抛 SchemaTooNewError + 徽章'待升级' + 锁已放（isRunLockActive=false 且可再取）", async () => {
    const dataDir = join(freshDir(), "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    seedVersion(dbPath, String(SCHEMA_VERSION + 1));

    let err: unknown;
    try {
      await runWorker({ dbPath, dataDir, badgePath, llm, now, pollMs: 0, idleExitMs: 0 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SchemaTooNewError);
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");

    const paths = taskRunPaths(dataDir, "worker", now);
    // 内核视角：锁真放了。
    expect(isRunLockActive(paths)).toBe(false);
    // 再取应成功（flock 若没放，同进程另一 fd 也会被挡）。
    const re = acquireRunLock(paths, { cooldownMinutes: 0, now });
    expect(re.ok).toBe(true);
    releaseRunLock(paths);
  }, 30_000);

  test("corrupt 库（非 too-new 分支）：抛 SchemaVersionCorruptError + 徽章'损坏' + 锁仍放（任意异常都放锁）", async () => {
    const dataDir = join(freshDir(), "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    rawMeta(dbPath, "INSERT INTO meta (key, value) VALUES ('schema_version', 'garbage');");

    let err: unknown;
    try {
      await runWorker({ dbPath, dataDir, badgePath, llm, now, pollMs: 0, idleExitMs: 0 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SchemaVersionCorruptError);
    expect(readFileSync(badgePath, "utf8")).toContain("损坏");

    const paths = taskRunPaths(dataDir, "worker", now);
    expect(isRunLockActive(paths)).toBe(false);
  }, 30_000);
});

// ── (3) backfill 脚本后门：降级不静默吞（stderr 可见 + 非 0 退出）───────────────
describe("R10 (3) backfill 脚本降级有可见信号（非静默）", () => {
  test("heal-now 撞更新的库：非 0 退出 + stderr 含升级提示（不静默吞）", async () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    seedVersion(dbPath, String(SCHEMA_VERSION + 1));

    const proc = Bun.spawn(["bun", HEAL_NOW, dbPath], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ANIMA_HEADLESS: "" },
    });
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    // 可见信号：脚本没把 schema 降级静默吞成"跑成功"，而是响亮报错。
    expect(proc.exitCode).not.toBe(0);
    expect(stderr).toMatch(/请升级|schema v|SchemaTooNew/);
  }, 30_000);
});
