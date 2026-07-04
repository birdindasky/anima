// 独立盲考官对抗测试（R10-display）：schema_version 损坏（NULL/非法整数）时，
// selfStatus 注入块 与 whoami 报告都必须**显式显示「损坏」**，绝不压平成 "unknown"/"vunknown" 静默降级。
//
// 红/绿设计：
//  - 若某展示层把 corrupt 当成 unknown（回归） → 断言 contains("损坏") 会红。
//  - 反向哨兵：合法值时绝不喊「损坏」；纯缺失（meta 无行）走 unknown 而非误报「损坏」。
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { buildSelfStatusBlock } from "../src/selfStatus";
import { probe } from "../src/introspect";
import { collectSelfKnowledge, renderSelfKnowledge } from "../scripts/whoami";
import { REGION_QUOTAS } from "../src/inject";

// 造一个「schema_version 值可控」的最小库，含 selfStatus/whoami 两条路径要用到的全部表。
function buildDb(schemaValue: string | null | undefined): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE experiences (
      id INTEGER PRIMARY KEY, kind TEXT, content TEXT,
      created_at TEXT, occurred_at TEXT, expired_at TEXT, invalid_at TEXT
    );
    CREATE TABLE vec_experiences (
      experience_id INTEGER PRIMARY KEY REFERENCES experiences(id),
      embedding BLOB, model_ver TEXT
    );
    CREATE TABLE digest_runs (night TEXT, stage TEXT, status TEXT);
  `);
  const now = "2020-01-01T00:00:00Z";
  db.exec(`INSERT INTO experiences(id,kind,content,created_at,occurred_at) VALUES
    (1,'alpha','a','${now}','${now}'),(2,'beta','b','${now}','${now}')`);
  if (schemaValue === undefined) {
    // 不插版本行 = meta 里根本没有 schema_version（纯缺失，非损坏）
  } else if (schemaValue === null) {
    db.query("INSERT INTO meta(key,value) VALUES('schema_version', NULL)").run();
  } else {
    db.query("INSERT INTO meta(key,value) VALUES('schema_version', ?)").run(schemaValue);
  }
  return db;
}

const noLaunchd = () => "";

// 逐个损坏样本：NULL / 非整数 / 空串 / 纯空白 / 浮点
const CORRUPT_SAMPLES: (string | null)[] = [null, "abc", "8abc", "", "   ", "8.5", "v8"];

for (const sample of CORRUPT_SAMPLES) {
  const label = sample === null ? "<NULL>" : JSON.stringify(sample);

  test(`probe: 损坏样本 ${label} → ok:false + corrupt:true`, () => {
    const db = buildDb(sample);
    const p = probe("anima.schema_version", db);
    db.close();
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.corrupt).toBe(true);
  });

  test(`selfStatus: 损坏样本 ${label} → 块里显式「损坏」，不含 vunknown/v损坏`, () => {
    const db = buildDb(sample);
    // 用生产真实配额，确认损坏文案不被截断吞掉
    const block = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
    db.close();
    expect(block).toContain("损坏");
    // 绝不静默降级成 unknown 冒充正常态
    expect(block).not.toContain("schema vunknown");
    expect(block).not.toContain("schema v损坏");
    // schema 那一行不能只写个正常的 "schema vN"
    expect(/schema v\d/.test(block)).toBe(false);
  });

  test(`whoami: 损坏样本 ${label} → 报告显式「损坏」，schema 字段非 unknown 冒充`, () => {
    const db = buildDb(sample);
    const sk = collectSelfKnowledge({ db, dbPath: "/x/anima.db", launchctlList: noLaunchd });
    const report = renderSelfKnowledge(sk);
    db.close();
    // schema 段响亮损坏
    expect(report).toContain("损坏");
    // 采集出的 schemaVersion 字段不得压平成 "unknown"（那是纯缺失/探测失败的语义）
    expect(sk.schemaVersion).not.toBe("unknown");
    // 且不得误当成「版本漂移」正常路径（正常路径会打印 "代码 SCHEMA_VERSION" 对比且不含损坏字样）
    expect(report).toMatch(/损坏/);
  });
}

// ── 反向哨兵：合法值绝不喊损坏；纯缺失走 unknown 而非误报损坏 ──
test("合法值 '8' → 正常 schema v8，绝不喊损坏", () => {
  const db = buildDb("8");
  const block = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
  const p = probe("anima.schema_version", db);
  db.close();
  expect(p.ok).toBe(true);
  expect(p.ok && p.value).toBe("8");
  expect(block).toContain("schema v8");
  expect(block).not.toContain("损坏");
});

test("meta 无 schema_version 行（纯缺失）→ unknown，不是损坏", () => {
  const db = buildDb(undefined);
  const p = probe("anima.schema_version", db);
  const block = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
  db.close();
  expect(p.ok).toBe(false);
  expect(p.ok === false && !!p.corrupt).toBe(false); // 缺失 ≠ 损坏
  // 缺失是 unknown 语义，不该冒充「损坏」
  expect(block).not.toContain("损坏");
});
