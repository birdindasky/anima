// 独立盲考官 —— R10 round-2 三条需求对抗验收（不看修者自测，另起炉灶）。
//  R1: 夜跑 digest 收尾 refreshBadge 绝不用心情 badge 盖掉"待升级/损坏"警示牌（单一事实源）。
//  R2: SessionStart（正式+影子）/ stop / session-end hooks degraded-aware → 只读降级库上即 bail。
//  R3: introspect anima.schema_version 遇 NULL/非整数 → 走可见损坏路径(ok:false)，不 String(null)='null' 冒充 data。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, SchemaTooNewError, SchemaVersionCorruptError, isValidSchemaVersionRaw } from "../src/db";
import { openAnima } from "../src/index";
import { writeSchemaErrorBadge, clearSchemaErrorBadge, refreshBadge } from "../src/badge";
import { probe } from "../src/introspect";
import { buildSelfStatusBlock } from "../src/selfStatus";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "r10r2blind-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 建 nullable meta 的裸库并写入指定行（模拟磁盘损坏/手改/同步冲突绕过 NOT NULL）。 */
function rawMeta(dbPath: string, insertSql: string): Database {
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  raw.exec(insertSql);
  return raw;
}

// ────────────────────────── R1：警示牌不被心情盖 ──────────────────────────
describe("R1 心情 badge 不覆盖警示牌", () => {
  test("亮警示牌后 refreshBadge 多次调用都不覆盖（=夜跑 digest.ts:1335 那口调的同一函数）", () => {
    const dir = freshDir();
    const dbPath = join(dir, "anima.db");
    const badgePath = join(dir, "badge.txt");
    const db = openDb(dbPath); // 健康库，estimateMood 有真表可读

    // 亮"待升级"警示牌（写 badge + 立哨兵）
    const wrote = writeSchemaErrorBadge(badgePath, new SchemaTooNewError(999, 8));
    expect(wrote).toBe(true);
    const warn = readFileSync(badgePath, "utf8");
    expect(warn).toContain("待升级");

    // 夜跑收尾就是调 refreshBadge(db, badgePath, clock)。连调多次都不能把警示牌抹成心情标签。
    for (let i = 0; i < 5; i++) refreshBadge(db, badgePath);
    expect(readFileSync(badgePath, "utf8")).toBe(warn);
    db.close();
  });

  test("损坏警示牌同样不被覆盖", () => {
    const dir = freshDir();
    const badgePath = join(dir, "badge.txt");
    const db = openDb(join(dir, "anima.db"));
    writeSchemaErrorBadge(badgePath, new SchemaVersionCorruptError("<NULL>"));
    const warn = readFileSync(badgePath, "utf8");
    expect(warn).toContain("损坏");
    refreshBadge(db, badgePath);
    expect(readFileSync(badgePath, "utf8")).toBe(warn);
    db.close();
  });

  test("反向假绿灯闸：schema 恢复(clear 哨兵)后 refreshBadge 必须重新正常刷心情（防偷懒把它改成永久 no-op）", () => {
    const dir = freshDir();
    const badgePath = join(dir, "badge.txt");
    const db = openDb(join(dir, "anima.db"));
    writeSchemaErrorBadge(badgePath, new SchemaTooNewError(999, 8));
    clearSchemaErrorBadge(badgePath); // = openAnima 健康开库时那口
    expect(existsSync(`${badgePath}.schema-error`)).toBe(false);
    refreshBadge(db, badgePath);
    const after = readFileSync(badgePath, "utf8");
    expect(after).not.toContain("待升级"); // 已恢复成心情
    expect(after.length).toBeGreaterThan(0);
    db.close();
  });

  test("健康库首刷（无哨兵）refreshBadge 正常写心情，不被误当警示牌拦掉", () => {
    const dir = freshDir();
    const badgePath = join(dir, "badge.txt");
    const db = openDb(join(dir, "anima.db"));
    refreshBadge(db, badgePath);
    expect(existsSync(badgePath)).toBe(true);
    expect(readFileSync(badgePath, "utf8")).not.toContain("待升级");
    db.close();
  });
});

// ────────────────────────── R2：hooks degraded-aware ──────────────────────────
// session-start-shadow 已随 autowall 写侧埋葬（docs/TOMBSTONE-AUTOWALL.md），此处只剩三个真 hook。
const HOOKS = {
  "session-start": join(import.meta.dir, "..", "hooks", "session-start.ts"),
  stop: join(import.meta.dir, "..", "hooks", "stop.ts"),
  "session-end": join(import.meta.dir, "..", "hooks", "session-end.ts"),
};

async function runHook(script: string, input: Record<string, unknown>, dataDir: string) {
  const proc = Bun.spawn(["bun", script], {
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ANIMA_DATA_DIR: dataDir,
      ANIMA_CONFIG_PATH: join(dataDir, "no-such-config.json"),
      ANIMA_HEADLESS: "",
      ANIMA_WORKER_ENABLED: "", // 保持默认关
    },
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: proc.exitCode, stdout, stderr };
}

describe("R2 降级态 hooks 端到端", () => {
  test("库比代码新 → openAnima degraded=true + 亮待升级徽章（读路径活着）", () => {
    const dir = freshDir();
    const dbPath = join(dir, "anima.db");
    const db = openDb(dbPath);
    db.query("UPDATE meta SET value='999' WHERE key='schema_version'").run();
    db.close();
    const r = openAnima({ dataDir: dir, dbPath, badgePath: join(dir, "badge.txt") });
    expect(r.degraded).toBe(true);
    expect(readFileSync(join(dir, "badge.txt"), "utf8")).toContain("待升级");
    r.db.close();
  });

  for (const [name, script] of Object.entries(HOOKS)) {
    test(`${name} 在降级库上：exit 0 + 不把警示牌覆盖成心情`, async () => {
      const dir = freshDir();
      const dbPath = join(dir, "anima.db");
      const badgePath = join(dir, "badge.txt");
      const db = openDb(dbPath);
      db.query("UPDATE meta SET value='999' WHERE key='schema_version'").run();
      db.close();

      const r = await runHook(script, { session_id: "s1", cwd: dir, transcript_path: join(dir, "no.jsonl") }, dir);
      expect(r.code).toBe(0); // 绝不崩、绝不挡开工
      // openAnima 已亮警示牌；hook 不得把它盖掉
      const badge = readFileSync(badgePath, "utf8");
      expect(badge).toContain("待升级");
      // 正式 session-start 降级态绝不吐注入上下文
      if (name === "session-start") expect(r.stdout.trim()).toBe("");
    });
  }
});

// ────────────────────────── R3：introspect NULL/非整数 ──────────────────────────
describe("R3 introspect schema_version 损坏可见", () => {
  test("value=NULL → ok:false 且绝不返回 'null' 冒充 data", () => {
    const dir = freshDir();
    const dbPath = join(dir, "raw.db");
    const db = rawMeta(dbPath, "INSERT INTO meta (key,value) VALUES ('schema_version', NULL);");
    const p = probe("anima.schema_version", db);
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error("NULL 竟被当合法值");
    expect(p.error).toMatch(/损坏|NULL/);
    // 铁证：任何字段都不能出现字符串 'null' 冒充真值
    expect(JSON.stringify(p)).not.toContain('"value":"null"');
    db.close();
  });

  test("value='8abc'(非整数) → ok:false", () => {
    const dir = freshDir();
    const db = rawMeta(join(dir, "raw.db"), "INSERT INTO meta (key,value) VALUES ('schema_version', '8abc');");
    const p = probe("anima.schema_version", db);
    expect(p.ok).toBe(false);
    db.close();
  });

  test("value='8.5'(非整数) → ok:false（比 parseInt 严）", () => {
    const dir = freshDir();
    const db = rawMeta(join(dir, "raw.db"), "INSERT INTO meta (key,value) VALUES ('schema_version', '8.5');");
    expect(probe("anima.schema_version", db).ok).toBe(false);
    db.close();
  });

  test("value='8'(合法) → ok:true value='8'（防把有效值也误杀）", () => {
    const dir = freshDir();
    const db = rawMeta(join(dir, "raw.db"), "INSERT INTO meta (key,value) VALUES ('schema_version', '8');");
    const p = probe("anima.schema_version", db);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toBe("8");
    db.close();
  });

  test("buildSelfStatusBlock：NULL schema 响亮显示「损坏」，绝不静默降级/注入 'null'", () => {
    const dir = freshDir();
    const db = rawMeta(join(dir, "raw.db"), "INSERT INTO meta (key,value) VALUES ('schema_version', NULL);");
    // selfStatus 还会读 experiences COUNT，裸库没这表 → 该调用会抛；只验 probe 层已足够。
    // 为覆盖注入层，补一张空 experiences 表让 COUNT 走通。
    db.exec("CREATE TABLE experiences (id INTEGER, expired_at TEXT, invalid_at TEXT);");
    const block = buildSelfStatusBlock(db, 300);
    // R10-display 残留修复：损坏态必须响亮可见「损坏」，不再压平成 "vunknown"（静默降级=正常态）。
    expect(block).toContain("损坏");
    expect(block).not.toContain("schema vunknown");
    // 安全不变量：绝不把损坏原值（null）当有效版本注入上下文。
    expect(block).not.toContain("schema vnull");
    db.close();
  });

  test("isValidSchemaVersionRaw 单一事实源判据边界", () => {
    expect(isValidSchemaVersionRaw(null)).toBe(false);
    expect(isValidSchemaVersionRaw("")).toBe(false);
    expect(isValidSchemaVersionRaw("   ")).toBe(false);
    expect(isValidSchemaVersionRaw("8abc")).toBe(false);
    expect(isValidSchemaVersionRaw("8.5")).toBe(false);
    expect(isValidSchemaVersionRaw("Infinity")).toBe(false);
    expect(isValidSchemaVersionRaw("8")).toBe(true);
    expect(isValidSchemaVersionRaw("0")).toBe(true);
  });
});
