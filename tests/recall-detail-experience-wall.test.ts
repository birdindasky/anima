// AUDIT-2026-06-29 A区#2 复现 + 修复验收：recall_detail 的 experience 路径过去只 `WHERE id=?`，
// 按编号能拉别项目 / 已作废 / 兜底壳的全文，唯一守卫是一行软文字「已失效」（模型可无视）。
// 修：renderExperienceDetail 走 getExperienceForRecall——项目墙 + 恒过滤作废/过期/壳。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { renderMemoryDetail, renderExperienceDetail } from "../src/recall";

const clock = frozenClock("2026-06-15T09:00:00.000Z");
const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-rd2-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 走公共入口 renderMemoryDetail(source='experience')，即 MCP recall_detail 真实调用面。
function detail(db: ReturnType<typeof openDb>, id: number, project?: string) {
  return renderMemoryDetail(db, "experience", id, { clock, project });
}

describe("recall_detail experience 路径：项目墙 + 排除作废/壳（AUDIT A区#2）", () => {
  test("给了 project：别项目记忆不越墙；全局(project=null)与本项目可见", () => {
    const db = tmpDb();
    const other = insertExperience(db, { kind: "decision", project: "other-proj", content: "别项目的机密决定 XYZ" }, clock);
    const global = insertExperience(db, { kind: "preference", project: null, content: "全局偏好 ABC" }, clock);
    const mine = insertExperience(db, { kind: "decision", project: "anima", content: "本项目决定 MINE" }, clock);

    expect(detail(db, other.id, "anima")).toBeNull(); // 别项目：拉不到
    expect(detail(db, global.id, "anima")).toContain("全局偏好"); // 全局：可见
    expect(detail(db, mine.id, "anima")).toContain("本项目决定"); // 本项目：可见
  });

  test("已作废记忆：recall_detail 返 null（不再吐作废全文 + 软提示）", () => {
    const db = tmpDb();
    const dead = insertExperience(db, { kind: "decision", project: "anima", content: "这条已经被推翻了 OLD" }, clock);
    invalidateExperience(db, dead.id, clock);
    expect(detail(db, dead.id, "anima")).toBeNull();
    expect(detail(db, dead.id)).toBeNull(); // 不给 project 也照样挡作废
  });

  test("兜底壳：按编号也拉不到（digest_fallback / self_review_fallback）", () => {
    const db = tmpDb();
    const dShell = insertExperience(
      db,
      { kind: "digest_fallback", project: null, content: "这一天有 5 条带情绪的记录，原文都在库里，回头可以翻。" },
      clock,
    );
    const sShell = insertExperience(
      db,
      { kind: "self_review_fallback", project: "anima", content: "客观流水兜底摘要（自评失败 2 次）" },
      clock,
    );
    expect(detail(db, dShell.id, "anima")).toBeNull();
    expect(detail(db, sShell.id, "anima")).toBeNull();
    expect(detail(db, dShell.id)).toBeNull(); // 不给 project 也挡壳
  });

  test("不给 project：维持向后兼容（不加项目墙），但作废/壳仍恒挡", () => {
    const db = tmpDb();
    const other = insertExperience(db, { kind: "decision", project: "other-proj", content: "别项目内容 noWall" }, clock);
    // 与流水 #s 详情同约定：没传 project 时不设墙（已知残留=缺口#2 MCP 归一化，留后续）。此处固化当前约定。
    expect(renderExperienceDetail(db, other.id, { clock })).toContain("别项目内容");
  });

  test("正常 live 本项目记忆：全文 + 感受 + 关键词照常返回", () => {
    const db = tmpDb();
    const r = insertExperience(
      db,
      { kind: "decision", project: "anima", content: "完整全文内容 FULLTEXT", feeling: "踏实", keywords: ["决策", "记忆"] },
      clock,
    );
    const out = detail(db, r.id, "anima");
    expect(out).toContain("FULLTEXT");
    expect(out).toContain("感受");
    expect(out).toContain("决策");
  });
});
