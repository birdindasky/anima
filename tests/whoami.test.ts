// TDD — anima whoami 真相源命令（SELFKNOW-SPEC #1）。
// 核心验收：每个字段都从**真实源头现读**，改一处真值 whoami 跟着变（治「凭印象说错自己实现状态」的乌龙）。
// 手法：给 collectSelfKnowledge 喂一个受控临时库 + 注入的 launchctl / env，逐字段对真实源头核对。
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, SCHEMA_VERSION } from "../src/db";
import { getDigestStages, getWiredStages } from "../src/digest";
import { EMBED_MODEL, EMBED_MODEL_VER, EMBED_DIM } from "../src/embed";
import { MAX_HEAL_ATTEMPTS, HEAL_BUDGET_PER_NIGHT } from "../src/selfHeal";
import { collectSelfKnowledge, parseLaunchd, renderSelfKnowledge } from "../scripts/whoami";

const tmpDirs: string[] = [];
function freshDb(): { db: Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "anima-whoami-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "anima.db");
  return { db: openDb(dbPath), dbPath };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 直接落一条 live 经历（避开 insertExperience 的默认，保持测试对列的完全掌控）
let seq = 0;
function insertExp(db: Database, kind: string, opts: { invalid?: boolean } = {}): number {
  seq++;
  const now = "2026-07-01T00:00:00.000Z";
  db.query(
    `INSERT INTO experiences (uuid, kind, content, occurred_at, created_at, invalid_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`u-${seq}`, kind, `content ${seq}`, now, now, opts.invalid ? now : null);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}
function addVec(db: Database, expId: number, modelVer: string): void {
  const blob = new Uint8Array([1, 2, 3, 4]);
  db.query(
    "INSERT INTO vec_experiences (experience_id, embedding, model_ver) VALUES (?, ?, ?)",
  ).run(expId, blob, modelVer);
}

const NO_LAUNCHD = () => "";

describe("whoami — schema_version 现读 DB meta，非代码常量", () => {
  test("默认 = 代码版本；改 DB meta → whoami 跟着变（不跟代码常量）", () => {
    const { db, dbPath } = freshDb();
    const sk1 = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk1.schemaVersion).toBe(String(SCHEMA_VERSION));
    expect(sk1.codeSchemaVersion).toBe(SCHEMA_VERSION);

    // 篡改库里的真值：只动 DB meta，不动代码常量
    db.query("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    const sk2 = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk2.schemaVersion).toBe("99"); // 跟 DB 走
    expect(sk2.codeSchemaVersion).toBe(SCHEMA_VERSION); // 代码常量不受影响
  });

  test("tables 现读 sqlite_master（含核心表）", () => {
    const { db, dbPath } = freshDb();
    const sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    for (const t of ["experiences", "situation_log", "meta", "vec_experiences", "digest_runs"]) {
      expect(sk.tables).toContain(t);
    }
  });
});

describe("whoami — 夜跑阶段 + wired 现读 digest.ts", () => {
  test("阶段清单 === getDigestStages()，wired 集 === getWiredStages()", () => {
    const { db, dbPath } = freshDb();
    const sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.stages.map((s) => s.name)).toEqual(getDigestStages());
    const wiredNames = sk.stages.filter((s) => s.wired).map((s) => s.name);
    expect(wiredNames).toEqual(getWiredStages());
    // heal 必须在线（治「自愈没实装」乌龙的核心事实）
    expect(sk.stages.find((s) => s.name === "heal")?.wired).toBe(true);
  });
});

describe("whoami — 自愈开关 + 预算现读 selfHeal.ts", () => {
  test("wired / HEAL_BUDGET / MAX_ATTEMPTS 全对齐真实源头常量", () => {
    const { db, dbPath } = freshDb();
    const sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.selfheal.wired).toBe(getDigestStages().includes("heal"));
    expect(sk.selfheal.budgetPerNight).toBe(String(HEAL_BUDGET_PER_NIGHT));
    expect(sk.selfheal.maxAttempts).toBe(String(MAX_HEAL_ATTEMPTS));
  });
});

describe("whoami — embedder 模型/维度/覆盖率现读", () => {
  test("模型与维度 === embed.ts 常量", () => {
    const { db, dbPath } = freshDb();
    const sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.embedder.model).toBe(EMBED_MODEL);
    expect(sk.embedder.modelVer).toBe(EMBED_MODEL_VER);
    expect(sk.embedder.dim).toBe(EMBED_DIM);
  });

  test("向量覆盖率 = 当前模型向量 vs live 经历，插一条向量就跟着涨", () => {
    const { db, dbPath } = freshDb();
    const a = insertExp(db, "event");
    const b = insertExp(db, "event");
    // 覆盖率起点 0/2
    let sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.embedder.liveExperiences).toBe(2);
    expect(sk.embedder.vectorized).toBe(0);
    expect(sk.embedder.coveragePct).toBe(0);

    addVec(db, a, EMBED_MODEL_VER); // 1/2 = 50%
    sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.embedder.vectorized).toBe(1);
    expect(sk.embedder.coveragePct).toBe(50);

    addVec(db, b, EMBED_MODEL_VER); // 2/2 = 100%
    sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.embedder.vectorized).toBe(2);
    expect(sk.embedder.coveragePct).toBe(100);
  });

  test("旧模型版本向量算 stale、不进覆盖率；作废经历退出 live", () => {
    const { db, dbPath } = freshDb();
    const a = insertExp(db, "event");
    const c = insertExp(db, "event");
    addVec(db, a, EMBED_MODEL_VER);
    addVec(db, c, "OLD-MODEL-v0"); // 旧版本 → stale
    let sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.embedder.liveExperiences).toBe(2);
    expect(sk.embedder.vectorized).toBe(1); // 只数当前模型
    expect(sk.embedder.staleVectors).toBe(1);

    // 作废 a → live 掉到 1，覆盖率随之变（读的是真 DB 状态）
    db.query("UPDATE experiences SET invalid_at = '2026-07-02T00:00:00.000Z' WHERE id = ?").run(a);
    sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.embedder.liveExperiences).toBe(1);
    expect(sk.embedder.vectorized).toBe(0);
  });
});

describe("whoami — feature flags / gates 现读 env + 代码常量", () => {
  test("ANIMA_DAYSPLIT 跟 env 走", () => {
    const { db, dbPath } = freshDb();
    const savedD = process.env.ANIMA_DAYSPLIT;
    try {
      process.env.ANIMA_DAYSPLIT = "1";
      let sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
      expect(sk.flags.find((f) => f.name === "ANIMA_DAYSPLIT")?.value).toContain("on");

      delete process.env.ANIMA_DAYSPLIT;
      sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
      expect(sk.flags.find((f) => f.name === "ANIMA_DAYSPLIT")?.value).toContain("off");
    } finally {
      if (savedD === undefined) delete process.env.ANIMA_DAYSPLIT;
      else process.env.ANIMA_DAYSPLIT = savedD;
    }
  });

  test("autowall 已埋葬：flags 里不再有 ANIMA_PROMOTE / gate:* 显示位（TOMBSTONE-AUTOWALL）", () => {
    const { db, dbPath } = freshDb();
    const sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.flags.find((f) => f.name === "ANIMA_PROMOTE")).toBeUndefined();
    expect(sk.flags.filter((f) => f.name.startsWith("gate:"))).toEqual([]);
  });

  test("daysplit_activated 现读 DB meta 标记", () => {
    const { db, dbPath } = freshDb();
    let sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.flags.find((f) => f.name === "daysplit_activated")?.value).toBe("not-activated");
    db.query("INSERT INTO meta (key, value) VALUES ('daysplit_activated', '2026-06-22')").run();
    sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.flags.find((f) => f.name === "daysplit_activated")?.value).toContain("activated");
  });
});

describe("whoami — 记忆计数按 kind、只数 live", () => {
  test("插入/作废经历 → 计数跟着变", () => {
    const { db, dbPath } = freshDb();
    insertExp(db, "event");
    insertExp(db, "event");
    const dec = insertExp(db, "decision");
    let sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.kindCounts.find((k) => k.kind === "event")?.count).toBe(2);
    expect(sk.kindCounts.find((k) => k.kind === "decision")?.count).toBe(1);

    db.query("UPDATE experiences SET invalid_at = '2026-07-02T00:00:00.000Z' WHERE id = ?").run(dec);
    sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    expect(sk.kindCounts.find((k) => k.kind === "decision")).toBeUndefined(); // 作废后不再计
    expect(sk.kindCounts.find((k) => k.kind === "event")?.count).toBe(2);
  });
});

describe("whoami — 最近 digest_runs 现读", () => {
  test("写入 digest_runs → 出现在 recentDigestRuns", () => {
    const { db, dbPath } = freshDb();
    for (const stage of ["makeup", "heal"]) {
      db.query(
        "INSERT INTO digest_runs (night, stage, status, finished_at) VALUES (?, ?, ?, ?)",
      ).run("2026-07-02", stage, "done", "2026-07-02T08:00:00.000Z");
    }
    db.query(
      "INSERT INTO digest_runs (night, stage, status, finished_at) VALUES (?, ?, ?, ?)",
    ).run("2026-07-02", "closure", "failed", "2026-07-02T08:00:00.000Z");
    const sk = collectSelfKnowledge({ db, dbPath, launchctlList: NO_LAUNCHD });
    const runs = sk.recentDigestRuns.filter((r) => r.night === "2026-07-02");
    expect(runs.length).toBe(3);
    expect(runs.find((r) => r.stage === "closure")?.status).toBe("failed");
  });
});

describe("whoami — launchctl 解析只留 com.anima*", () => {
  test("parseLaunchd 过滤表头与非 anima job", () => {
    const raw = ["PID\tStatus\tLabel", "-\t0\tcom.anima.digest", "123\t0\tcom.apple.other", "-\t0\tcom.anima.diary-daysplit-check"].join("\n");
    const jobs = parseLaunchd(raw);
    expect(jobs.map((j) => j.label)).toEqual(["com.anima.digest", "com.anima.diary-daysplit-check"]);
    expect(jobs[0]).toEqual({ pid: "-", status: "0", label: "com.anima.digest" });
  });

  test("空输出 → 空数组（读不到，绝不编造）", () => {
    expect(parseLaunchd("")).toEqual([]);
  });

  test("collect 用注入的 launchctl 值", () => {
    const { db, dbPath } = freshDb();
    const sk = collectSelfKnowledge({
      db,
      dbPath,
      launchctlList: () => "-\t0\tcom.anima.digest\n",
    });
    expect(sk.launchd).toEqual([{ pid: "-", status: "0", label: "com.anima.digest" }]);
  });
});

describe("whoami — render 冒烟", () => {
  test("渲染含各区标题、不抛", () => {
    const { db, dbPath } = freshDb();
    insertExp(db, "event");
    const out = renderSelfKnowledge(
      collectSelfKnowledge({ db, dbPath, launchctlList: () => "-\t0\tcom.anima.digest\n" }),
    );
    expect(out).toContain("schema");
    expect(out).toContain("夜跑阶段");
    expect(out).toContain("embedder");
    expect(out).toContain("digest_runs");
  });
});
