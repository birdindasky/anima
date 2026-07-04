// SELFKNOW-SPEC #2 ★核心 —— 开会话自动注入「anima 机器真值·当前」小块。
// 验收（对齐蓝图 #2 与本轮任务）：
//  1. 注入块真出现在 <anima-context> 内，且明确标注「机器真值·当前」。
//  2. **现算非缓存**：改 DB 状态（meta.schema_version / 增删 live 记忆）→ 下次注入跟着变，同一 db 句柄
//     二次调用不复用旧值（无任何 memo/过期缓存）。
//  3. **token 不超单独小配额**：selfStatus 区 tokens ≤ REGION_QUOTAS.selfStatus（≤150），且为 base 不可压缩类。
//  4. **不挤真记忆**：重载记忆时经历区仍拿满自己的配额（selfStatus 一分不吃记忆预算），二者各自独立、总量在预算内。
//  5. **零模型依赖**：buildSelfStatusBlock 只吃 (db, maxTokens)——无 embed 入参、无往返；tiny 配额时硬截断生效。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { assembleMorningInjection, REGION_QUOTAS } from "../src/inject";
import { buildSelfStatusBlock } from "../src/selfStatus";
import { estimateTokens } from "../src/tokens";
import { ANIMA_CONTEXT_OPEN, ANIMA_CONTEXT_CLOSE } from "../src/echo";

const NOW = "2026-07-03T02:00:00.000Z";
const PROJECT = "/Users/tester/Projects/demo";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-selfstatus-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "anima-home"), { recursive: true });
  const personalityPath = join(dir, "anima-home", "personality.md");
  writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");
  return { dbPath: join(dir, "anima-home", "anima.db"), personalityPath };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function inject(db: ReturnType<typeof openDb>, personalityPath: string) {
  return assembleMorningInjection(db, {
    sessionId: "sess-selfstatus",
    project: PROJECT,
    personalityPath,
    clock: frozenClock(NOW),
  });
}
function ssRegion(out: ReturnType<typeof inject>) {
  return out.regions.find((r) => r.name === "selfStatus")!;
}
function liveCountInBlock(text: string): number {
  const m = text.match(/live 记忆 (\d+) 条/);
  return m ? Number(m[1]) : -1;
}

describe("#2 自知小块 —— 出现在 <anima-context> 且标注机器真值", () => {
  test("注入块真出现在 <anima-context> 内，标注「机器真值·当前」", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const out = inject(db, personalityPath);

    expect(out.text.startsWith(ANIMA_CONTEXT_OPEN)).toBe(true);
    expect(out.text.trimEnd().endsWith(ANIMA_CONTEXT_CLOSE)).toBe(true);
    // 标注：块头 + 现读免责声明都在
    expect(out.text).toContain("机器真值·当前");
    const ss = ssRegion(out);
    // 块内含最易记错的机器真值：schema 版本、夜跑阶段、自愈接线状态
    expect(ss.content).toContain("schema v");
    expect(ss.content).toContain("夜跑阶段");
    expect(ss.content).toContain("自愈 heal");
    // 治「自愈没实装」乌龙：heal 在夜跑阶段表里 → 块里如实标「已接线」+ 阶段列出 heal
    expect(ss.content).toContain("已接线");
    expect(ss.content).toContain("heal");
    // 块整段在最终注入文本里（未被裁掉）
    expect(out.text).toContain(ss.content.split("\n")[0]!);
  });
});

describe("#2 现算非缓存 —— 改 DB 状态下次注入跟着变", () => {
  test("改 meta.schema_version → 下次注入的块跟着变（不吃旧缓存）", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);

    const before = ssRegion(inject(db, personalityPath)).content;
    expect(before).toContain("schema v8"); // 默认库 = 代码当前版本

    // 只动 DB meta 真值（模拟迁库/漂移），代码常量不变
    db.query("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();

    const after = ssRegion(inject(db, personalityPath)).content;
    expect(after).toContain("schema v99"); // 同一 db 句柄二次调用 → 跟 DB 现值，非复用旧串
    expect(after).not.toContain("schema v8");
  });

  test("增删 live 记忆 → 块里的 live 计数现算跟着变", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);

    const c0 = liveCountInBlock(ssRegion(inject(db, personalityPath)).content);
    expect(c0).toBe(0);

    for (let i = 0; i < 3; i++) {
      insertExperience(
        db,
        { kind: "self_review", project: PROJECT, content: `记 ${i}`, occurredAt: NOW },
        clock,
      );
    }
    const c1 = liveCountInBlock(ssRegion(inject(db, personalityPath)).content);
    expect(c1).toBe(3); // 现算：+3

    // 作废一条 → live 计数减 1（活证：读的是当前 live 真值，不是首次快照）
    const id = (db.query("SELECT id FROM experiences LIMIT 1").get() as { id: number }).id;
    db.query("UPDATE experiences SET invalid_at = ? WHERE id = ?").run(NOW, id);
    const c2 = liveCountInBlock(ssRegion(inject(db, personalityPath)).content);
    expect(c2).toBe(2);
  });
});

describe("#2 单独小配额 —— token 不超、base 不可压缩", () => {
  test("selfStatus 区 tokens ≤ 配额（≤150）且为 base 类、不在压缩序列", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const ss = ssRegion(inject(db, personalityPath));

    expect(REGION_QUOTAS.selfStatus).toBeGreaterThan(0);
    expect(REGION_QUOTAS.selfStatus).toBeLessThanOrEqual(150); // 蓝图：<150 token 小块
    expect(ss.tokens).toBeLessThanOrEqual(REGION_QUOTAS.selfStatus);
    expect(ss.class).toBe("base"); // base = 不可压缩、不进 trimOrder
    expect(estimateTokens(ss.content)).toBeLessThan(150);
  });

  test("tiny 配额时硬截断生效（长度铁死不越配额）", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const tiny = buildSelfStatusBlock(db, 10);
    expect(estimateTokens(tiny)).toBeLessThanOrEqual(10);
  });
});

describe("#2 不挤真记忆 —— 经历区仍拿满自己配额", () => {
  test("重载记忆：经历区仍近满配额，selfStatus 与经历区各自独立，总量在预算内", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    // 灌 20 条长自评，足以撑满经历区（1300 token）——检验 selfStatus 没从经历配额里抠一分。
    for (let i = 0; i < 20; i++) {
      insertExperience(
        db,
        {
          kind: "self_review",
          project: PROJECT,
          content: `REVIEW_${i} ${"当天工作的流水细节写得很长很长很长。".repeat(6)}`,
          feeling: "平静",
          occurredAt: NOW,
        },
        clock,
      );
    }
    const out = inject(db, personalityPath);
    const exp = out.regions.find((r) => r.name === "experiences")!;
    const ss = ssRegion(out);

    // 经历区仍拿到接近满额的配额（selfStatus 没蚕食它）
    expect(exp.tokens).toBeGreaterThan(1100);
    expect(exp.tokens).toBeLessThanOrEqual(REGION_QUOTAS.experiences);
    // selfStatus 依旧在场、且未被算进经历区（两区内容互不包含）
    expect(ss.content).not.toContain("REVIEW_");
    expect(exp.content).not.toContain("机器真值·当前");
    // 总注入仍在默认预算内（小块没把总量顶爆）
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(4000);
  });
});
