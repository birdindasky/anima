// 独立盲考官对抗测试：whoami 每字段必须从真实源头现读，非硬编码。
// 手法：造一个「值故意反常」的合成库/env，若某字段被写死成真机值，就会与合成源不符 → 红。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { collectSelfKnowledge, parseLaunchd } from "../scripts/whoami";
import { getDigestStages, getWiredStages } from "../src/digest";
import { EMBED_MODEL, EMBED_MODEL_VER, EMBED_DIM } from "../src/embed";
import { SCHEMA_VERSION } from "../src/db";

// 造一个最小但字段值故意反常的库。schema_version=99（绝非代码常量），塞几个 kind。
function buildSyntheticDb(): Database {
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
    CREATE TABLE zzz_marker_table (x INTEGER);
  `);
  db.exec("INSERT INTO meta(key,value) VALUES('schema_version','99')");
  // 3 条 live 不同 kind + 1 条 expired + 1 条 invalid（后两条不该被计入）
  const now = "2020-01-01T00:00:00Z";
  db.exec(`INSERT INTO experiences(id,kind,content,created_at,occurred_at) VALUES
    (1,'alpha','a','${now}','${now}'),
    (2,'alpha','b','${now}','${now}'),
    (3,'beta','c','${now}','${now}')`);
  db.exec(`INSERT INTO experiences(id,kind,content,created_at,occurred_at,expired_at) VALUES
    (4,'gamma','d','${now}','${now}','${now}')`);
  db.exec(`INSERT INTO experiences(id,kind,content,created_at,occurred_at,invalid_at) VALUES
    (5,'gamma','e','${now}','${now}','${now}')`);
  // 向量：id1 当前模型版本(命中覆盖)，id2 旧模型(stale)，id3 无向量
  db.exec(`INSERT INTO vec_experiences(experience_id,embedding,model_ver) VALUES
    (1, x'00', '${EMBED_MODEL_VER}'),
    (2, x'00', 'ANCIENT-MODEL-v0')`);
  db.exec(`INSERT INTO digest_runs(night,stage,status) VALUES
    ('2099-12-31','makeup','done'),
    ('2099-12-31','heal','failed')`);
  return db;
}

let savedDaysplit: string | undefined;
let savedPromote: string | undefined;
beforeEach(() => {
  savedDaysplit = process.env.ANIMA_DAYSPLIT;
  savedPromote = process.env.ANIMA_PROMOTE;
});
afterEach(() => {
  if (savedDaysplit === undefined) delete process.env.ANIMA_DAYSPLIT;
  else process.env.ANIMA_DAYSPLIT = savedDaysplit;
  if (savedPromote === undefined) delete process.env.ANIMA_PROMOTE;
  else process.env.ANIMA_PROMOTE = savedPromote;
});

const noLaunchd = () => "";

test("schema_version 现读 DB meta（合成库=99，非代码常量8）", () => {
  const db = buildSyntheticDb();
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.schemaVersion).toBe("99");
  expect(sk.codeSchemaVersion).toBe(SCHEMA_VERSION); // 代码常量单独一路
  expect(sk.schemaVersion).not.toBe(String(SCHEMA_VERSION)); // 证明不是拿代码常量冒充
  db.close();
});

test("改一处真值（schema_version）whoami 跟着变", () => {
  const db = buildSyntheticDb();
  const before = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).schemaVersion;
  db.exec("UPDATE meta SET value='123' WHERE key='schema_version'");
  const after = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).schemaVersion;
  expect(before).toBe("99");
  expect(after).toBe("123");
  db.close();
});

test("tables 现读 sqlite_master（合成库含独有标记表）", () => {
  const db = buildSyntheticDb();
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.tables).toContain("zzz_marker_table");
  expect(sk.tables).toContain("meta");
  // 不该出现真机快照才有的表（证明没读错库/没硬编码真机表清单）
  expect(sk.tables).not.toContain("work_queue");
  db.close();
});

test("kindCounts 现读 DB 且滤掉 expired/invalid", () => {
  const db = buildSyntheticDb();
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  const m = new Map(sk.kindCounts.map((k) => [k.kind, k.count]));
  expect(m.get("alpha")).toBe(2);
  expect(m.get("beta")).toBe(1);
  expect(m.has("gamma")).toBe(false); // 两条 gamma 都被 expire/invalid，不计
  db.close();
});

test("插一条经历 → 计数跟着变（非缓存）", () => {
  const db = buildSyntheticDb();
  const c1 = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).kindCounts
    .find((k) => k.kind === "beta")!.count;
  db.exec("INSERT INTO experiences(id,kind,content,created_at,occurred_at) VALUES(9,'beta','x','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')");
  const c2 = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).kindCounts
    .find((k) => k.kind === "beta")!.count;
  expect(c1).toBe(1);
  expect(c2).toBe(2);
  db.close();
});

test("embedder 模型/维度现读 embed.ts；覆盖率现算 DB", () => {
  const db = buildSyntheticDb();
  const e = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).embedder;
  expect(e.model).toBe(EMBED_MODEL);
  expect(e.modelVer).toBe(EMBED_MODEL_VER);
  expect(e.dim).toBe(EMBED_DIM);
  expect(e.liveExperiences).toBe(3); // id1,2,3
  expect(e.vectorized).toBe(1); // 仅 id1 命中当前模型版本
  expect(e.staleVectors).toBe(1); // id2 旧模型
  expect(e.coveragePct).toBe(Math.round((1 / 3) * 1000) / 10); // 33.3
  db.close();
});

test("加一条当前模型向量 → 覆盖率跟着涨", () => {
  const db = buildSyntheticDb();
  const before = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).embedder.vectorized;
  db.exec(`INSERT INTO vec_experiences(experience_id,embedding,model_ver) VALUES(3,x'00','${EMBED_MODEL_VER}')`);
  const after = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).embedder;
  expect(before).toBe(1);
  expect(after.vectorized).toBe(2);
  expect(after.coveragePct).toBe(Math.round((2 / 3) * 1000) / 10); // 66.7
  db.close();
});

test("stages 现读运行时 STAGE_FNS（顺序=getDigestStages，wired=getWiredStages）", () => {
  const db = buildSyntheticDb();
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.stages.map((s) => s.name)).toEqual(getDigestStages()); // 非硬编码清单
  const wired = new Set(getWiredStages());
  for (const s of sk.stages) expect(s.wired).toBe(wired.has(s.name));
  db.close();
});

test("selfheal.wired 反映 'heal' 是否在阶段表（当前应在线）", () => {
  const db = buildSyntheticDb();
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.selfheal.wired).toBe(getDigestStages().includes("heal"));
  expect(sk.selfheal.wired).toBe(true);
  db.close();
});

test("flags 现读 env：翻 ANIMA_DAYSPLIT 输出跟着变；ANIMA_PROMOTE 显示位已随 autowall 埋葬", () => {
  const db = buildSyntheticDb();
  process.env.ANIMA_DAYSPLIT = "1";
  process.env.ANIMA_PROMOTE = "on"; // 死旋钮：翻了也不该出现（docs/TOMBSTONE-AUTOWALL.md）
  const on = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).flags;
  expect(on.find((f) => f.name === "ANIMA_DAYSPLIT")!.value).toContain("on");
  expect(on.find((f) => f.name === "ANIMA_PROMOTE")).toBeUndefined();

  process.env.ANIMA_DAYSPLIT = "0";
  delete process.env.ANIMA_PROMOTE;
  const off = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).flags;
  expect(off.find((f) => f.name === "ANIMA_DAYSPLIT")!.value).toContain("off");
  expect(off.filter((f) => f.name.startsWith("gate:"))).toEqual([]);
  db.close();
});

test("daysplit_activated flag 现读 DB meta", () => {
  const db = buildSyntheticDb();
  const before = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).flags
    .find((f) => f.name === "daysplit_activated")!.value;
  expect(before).toBe("not-activated"); // 合成库无此 meta
  db.exec("INSERT INTO meta(key,value) VALUES('daysplit_activated','2099-01-01T00:00:00Z')");
  const after = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd }).flags
    .find((f) => f.name === "daysplit_activated")!.value;
  expect(after).toContain("2099-01-01");
  db.close();
});

test("recentDigestRuns 现读 DB", () => {
  const db = buildSyntheticDb();
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: noLaunchd });
  expect(sk.recentDigestRuns.length).toBe(2);
  expect(sk.recentDigestRuns.some((r) => r.stage === "heal" && r.status === "failed")).toBe(true);
  db.close();
});

test("launchd 现读注入的 launchctl 输出（可解析真值）", () => {
  const db = buildSyntheticDb();
  const fake = "PID\tStatus\tLabel\n4242\t0\tcom.anima.digest\n999\t1\tcom.other.thing\n-\t0\tcom.anima.worker\n";
  const sk = collectSelfKnowledge({ db, dbPath: "syn", launchctlList: () => fake });
  const labels = sk.launchd.map((j) => j.label);
  expect(labels).toContain("com.anima.digest");
  expect(labels).toContain("com.anima.worker");
  expect(labels).not.toContain("com.other.thing"); // 非 anima job 滤掉
  const dig = sk.launchd.find((j) => j.label === "com.anima.digest")!;
  expect(dig.pid).toBe("4242");
  db.close();
});

test("parseLaunchd 表头行不当成 job", () => {
  const jobs = parseLaunchd("PID\tStatus\tLabel\n123\t0\tcom.anima.x\n");
  expect(jobs.length).toBe(1);
  expect(jobs[0].label).toBe("com.anima.x");
});

test("coverage 边界：0 live 经历 → 100%（不除零）", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta(key TEXT,value TEXT);
    CREATE TABLE experiences(id INTEGER PRIMARY KEY,kind TEXT,content TEXT,created_at TEXT,occurred_at TEXT,expired_at TEXT,invalid_at TEXT);
    CREATE TABLE vec_experiences(experience_id INTEGER PRIMARY KEY,embedding BLOB,model_ver TEXT);
    CREATE TABLE digest_runs(night TEXT,stage TEXT,status TEXT);
    INSERT INTO meta VALUES('schema_version','5');
  `);
  const e = collectSelfKnowledge({ db, dbPath: "empty", launchctlList: noLaunchd }).embedder;
  expect(e.liveExperiences).toBe(0);
  expect(e.coveragePct).toBe(100);
  db.close();
});
