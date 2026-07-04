// 独立盲考官测试（selfstatus-inject）——不看实现者自带测试，按需求自写对抗用例。
// 需求：开会话自动注入 <150 token「anima 机器真值·当前」块；现算不缓存（改 DB→下次注入跟着变）；
//       不碰向量模型；单独小配额、不挤真记忆；走主权清洗。
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db";
import { assembleMorningInjection, REGION_QUOTAS } from "../src/inject";
import { buildSelfStatusBlock } from "../src/selfStatus";
import { estimateTokens } from "../src/tokens";
import { scrubMoodViolations } from "../src/sovereignty";

const tmpDirs: string[] = [];
function freshDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grader-selfstatus-"));
  tmpDirs.push(dir);
  return { db: openDb(join(dir, "anima.db")), dir };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ANIMA_DAYSPLIT;
  delete process.env.ANIMA_PROMOTE;
});

let seq = 0;
function insertReview(db: Database, when: string, feeling: string | null = null): void {
  seq++;
  db.query(
    `INSERT INTO experiences (uuid, kind, content, feeling, occurred_at, created_at)
     VALUES (?, 'self_review', ?, ?, ?, ?)`,
  ).run(`u-${seq}`, `真自评正文 ${seq}，做了一些工程改动 commit ${seq}`, feeling, when, when);
}

function assemble(db: Database, dir: string, project: string | null = "proj") {
  const pPath = join(dir, "personality.md");
  writeFileSync(pPath, "我是 anima。");
  return assembleMorningInjection(db, {
    sessionId: "s1",
    project,
    personalityPath: pPath,
    clock: { now: () => new Date("2026-07-03T02:00:00.000Z") },
  });
}

describe("需求①：块 <150 token 且真的进了注入", () => {
  test("buildSelfStatusBlock 输出 <150 token", () => {
    const { db } = freshDb();
    for (let i = 0; i < 500; i++) insertReview(db, "2026-07-03T01:00:00.000Z");
    const block = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
    expect(estimateTokens(block)).toBeLessThan(150);
    // 真机器真值：含 schema / 阶段 / heal / live 记忆量
    expect(block).toContain("schema v");
    expect(block).toContain("live 记忆 500 条");
  });

  test("组装后的注入正文里确实出现这段块", () => {
    const { db, dir } = freshDb();
    const r = assemble(db, dir);
    expect(r.text).toContain("anima 机器真值·当前");
    const region = r.regions.find((x) => x.name === "selfStatus");
    expect(region).toBeTruthy();
    expect(region!.class).toBe("base");
  });
});

describe("需求②：现算不缓存——改 DB / env 下次注入跟着变", () => {
  test("加一条 live 记忆 → 下次注入 live 计数 +1（同一个 db，无缓存续命）", () => {
    const { db, dir } = freshDb();
    insertReview(db, "2026-07-03T01:00:00.000Z");
    const r1 = assemble(db, dir);
    expect(r1.text).toContain("live 记忆 1 条");
    insertReview(db, "2026-07-03T01:10:00.000Z");
    const r2 = assemble(db, dir);
    expect(r2.text).toContain("live 记忆 2 条");
    expect(r2.text).not.toContain("live 记忆 1 条");
  });

  test("改 DB meta.schema_version → 块跟着变（读库真值非代码常量）", () => {
    const { db } = freshDb();
    const b1 = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
    db.query("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    const b2 = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
    expect(b1).not.toBe(b2);
    expect(b2).toContain("schema v99");
  });

  test("翻 env flag（DAYSPLIT）→ 块跟着变；PROMOTE 显示位已随 autowall 埋葬", () => {
    const { db } = freshDb();
    const off = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
    expect(off).toContain("DAYSPLIT off");
    process.env.ANIMA_DAYSPLIT = "1";
    process.env.ANIMA_PROMOTE = "on"; // 死旋钮：翻了也不该出现在块里（TOMBSTONE-AUTOWALL）
    const on = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
    expect(on).toContain("DAYSPLIT on");
    expect(on).not.toContain("PROMOTE");
  });

  test("delete（失效）记忆 → 计数下降（invalid_at 生效）", () => {
    const { db } = freshDb();
    insertReview(db, "2026-07-03T01:00:00.000Z");
    insertReview(db, "2026-07-03T01:00:00.000Z");
    expect(buildSelfStatusBlock(db, 150)).toContain("live 记忆 2 条");
    db.query("UPDATE experiences SET invalid_at = '2026-07-03T02:00:00Z' WHERE id = 1").run();
    expect(buildSelfStatusBlock(db, 150)).toContain("live 记忆 1 条");
  });
});

describe("需求③：不碰向量模型——drop 掉 vec 表仍照常出块", () => {
  test("没有 vec_experiences 表也能构块（不依赖向量/模型）", () => {
    const { db } = freshDb();
    db.query("DROP TABLE IF EXISTS vec_experiences").run();
    // 若 selfStatus 触碰向量检索/模型，这里会抛或挂；应正常返回真值块
    const block = buildSelfStatusBlock(db, 150);
    expect(block).toContain("anima 机器真值");
    expect(estimateTokens(block)).toBeLessThan(150);
  });
});

describe("需求④：单独小配额、不挤真记忆", () => {
  test("经历区在饱和时仍能吃满自己的配额，selfStatus 的 150 不从记忆区扣", () => {
    const { db, dir } = freshDb();
    // 灌满 7 天内自评，足以撑爆经历区配额（1300）
    for (let i = 0; i < 200; i++) insertReview(db, "2026-07-02T01:00:00.000Z");
    const r = assemble(db, dir);
    const exp = r.regions.find((x) => x.name === "experiences")!;
    const self = r.regions.find((x) => x.name === "selfStatus")!;
    // 经历区应逼近其独立配额 1300，而非被 selfStatus 砍到 ~1150
    expect(exp.tokens).toBeGreaterThan(1200);
    // selfStatus 独立成区，且区配额就是 150
    expect(self.quota).toBe(150);
    expect(REGION_QUOTAS.experiences).toBe(1300); // 记忆区配额未被动过
  });

  test("总预算吃紧时，base 的 selfStatus 永不被裁，经历区先被砍", () => {
    const { db, dir } = freshDb();
    for (let i = 0; i < 200; i++) insertReview(db, "2026-07-02T01:00:00.000Z");
    const pPath = join(dir, "p.md");
    writeFileSync(pPath, "我是 anima。");
    const r = assembleMorningInjection(db, {
      sessionId: "s1",
      project: "proj",
      personalityPath: pPath,
      clock: { now: () => new Date("2026-07-03T02:00:00.000Z") },
      budget: 900, // 逼出裁剪
    });
    const self = r.regions.find((x) => x.name === "selfStatus")!;
    const full = buildSelfStatusBlock(db, 150);
    // base 段（selfStatus）内容完整幸存，未被总预算裁剪
    expect(self.content).toBe(scrubMoodViolations(full));
    // 经历区确实被砍（有裁剪告警）
    expect(r.warnings.some((w) => w.includes("裁") || w.includes("预算"))).toBe(true);
  });
});

describe("需求⑤：走主权清洗", () => {
  test("selfStatus 区内容是经 scrubMoodViolations 后的产物（进了主权管线）", () => {
    const { db, dir } = freshDb();
    insertReview(db, "2026-07-03T01:00:00.000Z");
    const r = assemble(db, dir);
    const self = r.regions.find((x) => x.name === "selfStatus")!;
    const raw = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);
    expect(self.content).toBe(scrubMoodViolations(raw));
  });

  test("最终主权闸扫描覆盖全文（含 selfStatus 段），无 mood 数值残留", () => {
    const { db, dir } = freshDb();
    insertReview(db, "2026-07-03T01:00:00.000Z", "心情 8 分"); // 故意塞违规 feeling
    const r = assemble(db, dir);
    // 全文不得出现「心情」紧贴数字的残留
    expect(/(?:心情|情绪|感受)[^\n0-9]{0,10}[0-9]/u.test(r.text)).toBe(false);
  });
});
