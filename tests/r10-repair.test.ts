// R10 残留缺口修复（AUDIT-2026-07-03 全项目审查 codex GO-WITH-GAPS）。红灯先行 → 转绿。
// 逐条盯 codex 逐条列出的缺口：
//   gap1（回归·最重）：degraded 态 hook 不能让心情 badge 覆盖掉"待升级"警示牌（修复自己把可见信号又抹了）。
//   gap2：NULL meta.value 必须走响亮 corrupt 路径（不是在 raw.trim() 抛裸 TypeError、漏掉损坏徽章）。
//   gap3：worker 这条常跑后门（直接 openDb、不走 openAnima）schema-too-new 时也要亮可见徽章。
//   gap5：worker 取锁后 openDb 抛异常 → 必须先放锁再退（否则锁 + 句柄泄漏）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, SCHEMA_VERSION, SchemaTooNewError, SchemaVersionCorruptError } from "../src/db";
import { runWorker } from "../src/worker";
import { acquireRunLock, releaseRunLock, taskRunPaths } from "../src/runLock";
import type { LlmClient } from "../src/llm";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "r10rep-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 建一个已迁到 v8 的库，把 schema_version 顶成 raw（模拟更新的库/损坏值）。 */
function seedVersion(dbPath: string, raw: string): void {
  const db = openDb(dbPath);
  db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(raw);
  db.close();
}

const STOP_HOOK = join(import.meta.dir, "..", "hooks", "stop.ts");
const SESSION_END_HOOK = join(import.meta.dir, "..", "hooks", "session-end.ts");

/** 真跑 hook 子进程（喂 stdin JSON + 隔离 env）。ANIMA_CONFIG_PATH 指向不存在文件 = 强制忽略用户真 config，
 *  badgePath/dbPath 全落进临时 dataDir，绝不碰真 ~/.claude/anima。 */
async function runHook(
  script: string,
  input: Record<string, unknown>,
  dataDir: string,
): Promise<number | null> {
  const proc = Bun.spawn(["bun", script], {
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      ANIMA_DATA_DIR: dataDir,
      ANIMA_CONFIG_PATH: join(dataDir, "no-such-config.json"),
      ANIMA_HEADLESS: "", // 绝不带哨兵，否则 hook 秒退什么都不测
    },
  });
  await proc.exited;
  return proc.exitCode;
}

describe("R10 gap1+gap4：degraded 态 hook 不覆盖'待升级'徽章、不静默硬写只读库", () => {
  test("Stop（无 transcript_path）：库比代码新 → 徽章保持'待升级'，绝不被心情标签盖掉", async () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    seedVersion(dbPath, String(SCHEMA_VERSION + 1));

    const code = await runHook(STOP_HOOK, {}, dataDir);
    expect(code).toBe(0); // hook 永不非 0 退出
    // 命门（回归）：openAnima 亮的"待升级"警示牌必须幸存——修复前 refreshBadge 用心情标签盖掉了它。
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");
  }, 30_000);

  test("Stop（有 transcript_path）：degraded 下依旧保持'待升级'（写路径整段跳过）", async () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    seedVersion(dbPath, String(SCHEMA_VERSION + 2));
    // 造一份真 transcript：证明即便有活可采，degraded 也跳过写、不覆盖徽章。
    const tp = join(dataDir, "s1.jsonl");
    writeFileSync(
      tp,
      JSON.stringify({
        uuid: "u1",
        parentUuid: null,
        isSidechain: false,
        sessionId: "s1",
        timestamp: "2026-07-03T01:00:00.000Z",
        cwd: "/proj",
        type: "user",
        isMeta: false,
        message: { role: "user", content: "hi" },
      }) + "\n",
    );

    const code = await runHook(STOP_HOOK, { transcript_path: tp, session_id: "s1" }, dataDir);
    expect(code).toBe(0);
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");
  }, 30_000);

  test("SessionEnd（无 transcript_path）：degraded 下同样保'待升级'", async () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    seedVersion(dbPath, String(SCHEMA_VERSION + 1));

    const code = await runHook(SESSION_END_HOOK, {}, dataDir);
    expect(code).toBe(0);
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");
  }, 30_000);

  test("不误伤常态：健康库（v8）下 Stop 照常刷心情徽章（不含'待升级'）", async () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    openDb(dbPath).close(); // 健康 v8 库

    const code = await runHook(STOP_HOOK, {}, dataDir);
    expect(code).toBe(0);
    const badge = readFileSync(badgePath, "utf8");
    expect(badge.length).toBeGreaterThan(0); // 心情标签确实写了
    expect(badge).not.toContain("待升级"); // 非降级态：绝不误报"待升级"
  }, 30_000);
});

describe("R10 gap2：NULL meta.value → 响亮 corrupt 路径（不是裸 TypeError）", () => {
  test("meta.value 为 NULL：openDb 抛 SchemaVersionCorruptError（走可见损坏路径）", () => {
    const p = join(freshDir(), "anima.db");
    // 手工造一个 value 列可空、且值为 NULL 的 meta（模拟同步冲突/手改/未来放宽约束）。
    const raw = new Database(p);
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"); // 可空
    raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', NULL);");
    raw.close();

    // 修复前：readSchemaVersion 直接 raw.trim() → 裸 TypeError（不是 SchemaVersionCorruptError）。
    // 修复后：typeof 先判 → 走 SchemaVersionCorruptError 响亮损坏路径。
    expect(() => openDb(p)).toThrow(SchemaVersionCorruptError);
  });
});

describe("R10 gap3+gap5：worker 后门 schema-too-new → 亮可见徽章 + 放锁（不泄漏）", () => {
  test("runWorker 撞更新的库：抛 SchemaTooNewError、亮'待升级'徽章、且锁已释放（可再取）", async () => {
    const dataDir = join(freshDir(), "data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "anima.db");
    const badgePath = join(dataDir, "badge.txt");
    seedVersion(dbPath, String(SCHEMA_VERSION + 1));

    const llm: LlmClient = async () => ""; // openDb 先炸，永不触达 LLM
    const fixedNow = new Date("2026-07-03T02:00:00.000Z");

    let caught: unknown;
    try {
      await runWorker({ dbPath, dataDir, badgePath, llm, now: fixedNow, pollMs: 0, idleExitMs: 0 });
    } catch (e) {
      caught = e;
    }
    // gap3：worker 后门也响亮报错（而非静默）+ 亮可见徽章。
    expect(caught).toBeInstanceOf(SchemaTooNewError);
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");

    // gap5：取锁后 openDb 抛错，锁必须已被释放——同进程再取应成功（flock 未释放则第二把会失败）。
    const paths = taskRunPaths(dataDir, "worker", fixedNow);
    const reacquire = acquireRunLock(paths, { cooldownMinutes: 0, now: fixedNow });
    expect(reacquire.ok).toBe(true);
    releaseRunLock(paths);
  }, 30_000);
});
