// R10 round-2 残留（codex NO-GO 三条）独立 TDD 验收。红先行：每条命门在旧代码下必红。
//  (1) 夜跑 digest 收尾 refreshBadge 在 schema 警示牌待处理时绝不覆盖它（单一事实源哨兵，覆盖所有调用方）。
//  (2) SessionStart 正式版/影子版 degraded → 即 bail，不拿只读降级库走写路径/注入可能错的降级上下文。
//  (3) introspect schema_version：NULL / 非整数 meta.value → 走可见损坏路径（ok:false），不 String(null)='null' 冒充普通 data。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, SCHEMA_VERSION, SchemaTooNewError } from "../src/db";
import { openAnima } from "../src/index";
import { writeSchemaErrorBadge, refreshBadge } from "../src/badge";
import { runNightlyDigestion } from "../src/digest";
import { probe } from "../src/introspect";
import { ANIMA_CONTEXT_OPEN } from "../src/echo";
import type { LlmClient } from "../src/llm";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "r10r2-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 建健康 v8 库，再把 schema_version 顶成更新的版本（模拟"库比代码新"降级态）。 */
function seedVersion(dbPath: string, raw: string): void {
  const db = openDb(dbPath);
  db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(raw);
  db.close();
}

/** 直接建可空 meta 表并写指定值（含 NULL），绕开 openDb 的迁移/校验。 */
function rawMetaNullable(dbPath: string, insertSql: string): void {
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"); // value 列可空
  raw.exec(insertSql);
  raw.close();
}

const SESSION_START_HOOK = join(import.meta.dir, "..", "hooks", "session-start.ts");

async function runHookCapture(script: string, input: Record<string, unknown>, dataDir: string) {
  const proc = Bun.spawn(["bun", script], {
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ANIMA_DATA_DIR: dataDir,
      ANIMA_CONFIG_PATH: join(dataDir, "no-such-config.json"),
      ANIMA_HEADLESS: "",
    },
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { code: proc.exitCode, stdout };
}

// ── (1) 夜跑 refreshBadge 不覆盖 schema 警示牌（单一事实源哨兵）─────────────────
describe("R10-round2 (1) 夜跑 degraded 收尾徽章不覆盖警示牌", () => {
  test("哨兵在 → refreshBadge 跳过；健康 openAnima 清哨兵后恢复刷心情", () => {
    const dir = freshDir();
    const dbPath = join(dir, "anima.db");
    const badgePath = join(dir, "badge.txt");
    const db = openDb(dbPath); // 健康 v8：refreshBadge 要能算心情

    // 模拟真实降级：openAnima 撞 too-new 时写"待升级"徽章 + 立哨兵。
    writeSchemaErrorBadge(badgePath, new SchemaTooNewError(SCHEMA_VERSION + 1, SCHEMA_VERSION));
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");

    // 命门（gap1 单一事实源）：哨兵待处理时，refreshBadge 绝不拿心情标签盖掉警示牌。
    refreshBadge(db, badgePath);
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");

    // 恢复路径：健康开库清哨兵 → 之后 refreshBadge 正常刷心情（升级后徽章不永久卡"待升级"）。
    const opened = openAnima({ dataDir: dir, dbPath, badgePath });
    refreshBadge(opened.db, badgePath);
    const after = readFileSync(badgePath, "utf8");
    expect(after).not.toContain("待升级");
    expect(after.length).toBeGreaterThan(0);
    opened.db.close();
    db.close();
  });

  test("runNightlyDigestion 收尾（digest.ts:1335）哨兵在则不覆盖警示牌", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "anima.db");
    const badgePath = join(dir, "badge.txt");
    const db = openDb(dbPath);
    writeSchemaErrorBadge(badgePath, new SchemaTooNewError(SCHEMA_VERSION + 1, SCHEMA_VERSION));

    const noop = async () => {};
    await runNightlyDigestion(db, {
      night: "2026-07-03",
      llm: (async () => "") as LlmClient,
      config: { personalityPath: join(dir, "p.md"), diaryDir: join(dir, "diary"), badgePath },
      // 全阶段 no-op：不写不败，确保一定触达收尾 refreshBadge（隔离测的就是那一句）。
      stageOverrides: {
        makeup: noop, heal: noop, closure: noop, decay: noop, personality: noop, diary: noop, vectorize: noop,
      },
    });
    expect(readFileSync(badgePath, "utf8")).toContain("待升级");
    db.close();
  });
});

// ── (2) SessionStart degraded 即 bail ────────────────────────────────────────
describe("R10-round2 (2) SessionStart degraded → bail", () => {
  test("正式版：degraded → 不吐注入、exit 0（不拿只读降级库组装/注入）", async () => {
    const dataDir = freshDir();
    seedVersion(join(dataDir, "anima.db"), String(SCHEMA_VERSION + 1));
    const { code, stdout } = await runHookCapture(SESSION_START_HOOK, { session_id: "s1", cwd: "/proj" }, dataDir);
    expect(code).toBe(0);
    // 命门：degraded 时绝不组装/吐 <anima-context> 注入（旧码会照吐 + 写路径被裸 catch 吞成静默）。
    expect(stdout).not.toContain(ANIMA_CONTEXT_OPEN);
  }, 30_000);

  // （原「影子版 degraded → exit 0」测试随 session-start-shadow hook 埋葬，见 docs/TOMBSTONE-AUTOWALL.md）
});

// ── (3) introspect schema_version 损坏可见（ok:false，不冒充 data）─────────────
describe("R10-round2 (3) introspect schema_version 损坏走可见路径", () => {
  test("meta.value = NULL → ok:false（不是 String(null)='null' 冒充普通 data）", () => {
    const p = join(freshDir(), "anima.db");
    rawMetaNullable(p, "INSERT INTO meta (key, value) VALUES ('schema_version', NULL)");
    const db = new Database(p, { readonly: true });
    const r = probe("anima.schema_version", db);
    expect(r.ok).toBe(false);
    db.close();
  });

  for (const bad of ["garbage", "", "   ", "v8", "8.5", "NaN"]) {
    test(`meta.value=${JSON.stringify(bad)} → ok:false（非法整数=损坏可见）`, () => {
      const p = join(freshDir(), "anima.db");
      rawMetaNullable(p, `INSERT INTO meta (key, value) VALUES ('schema_version', '${bad}')`);
      const db = new Database(p, { readonly: true });
      const r = probe("anima.schema_version", db);
      expect(r.ok).toBe(false);
      db.close();
    });
  }

  test("不误伤：合法整数 → ok:true 且值同步 SCHEMA_VERSION", () => {
    const db = openDb(join(freshDir(), "anima.db"));
    const r = probe("anima.schema_version", db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });
});
