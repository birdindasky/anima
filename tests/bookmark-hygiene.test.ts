// 书签三件（2026-07-02 批，AUDIT rank6a / rank11 / 限长）红灯先行：
//   rank6a 书签无条件排注入最前、不参与电荷加权 → 当天书签一多把真自评/digest 挤出经历区配额。
//         修＝书签单独小配额（BOOKMARK_INJECT_QUOTA），用不满自动让给自评，绝不整区挤空。
//   rank11 书签写口无查重 → 同会话同内容重复落库＝复读噪音+挤配额。修＝写口幂等（同会话同内容 live 已在则返回既有行）。
//   限长   书签 content 任意长原样落库。修＝超 BOOKMARK_MAX_CHARS 截断带标记。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { assembleMorningInjection } from "../src/inject";
import { addBookmark, BOOKMARK_MAX_CHARS } from "../src/bookmark";

const NOW = "2026-06-21T22:00:00.000Z"; // 东八 06-22 06:00 前后＝"今天"=06-22
const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-bmhyg-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "anima-home"), { recursive: true });
  const personalityPath = join(dir, "anima-home", "personality.md");
  writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");
  return { dbPath: join(dir, "anima-home", "anima.db"), personalityPath };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const clock = frozenClock(NOW);

const bookmarkCount = (db: ReturnType<typeof openDb>) =>
  (db.query("SELECT count(*) c FROM experiences WHERE kind='bookmark'").get() as { c: number }).c;

describe("rank6a 书签单独配额，不再挤空真自评", () => {
  test("当天海量书签 + 昨日长自评：自评必须还在注入里", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    // 构造铁证几何：60 条**等长**书签（每条渲染后 ~45 token）——旧码贪心填 1300 配额后，
    // 残余空隙必 < 单条书签行宽(~45)；自评行故意造 >160 token（内容超 160 截断上限），
    // 任何残隙都塞不进 → 旧码必挤掉自评（deterministic red），新码书签只占 300 → 自评必进。
    for (let i = 0; i < 60; i++) {
      insertExperience(
        db,
        {
          kind: "bookmark",
          content: `第${String(i).padStart(2, "0")}条感触：${"这瞬间值得记因为它揭示了系统层的真问题啊".repeat(2)}`,
          sourceSession: "s-today",
          occurredAt: NOW,
        },
        clock,
      );
    }
    const review = insertExperience(
      db,
      {
        kind: "self_review",
        content: `昨天的复盘：${"把水位线防回退守卫焊进原语层并让独立考官签字确认。".repeat(8)}`,
        occurredAt: "2026-06-20T22:00:00.000Z",
      },
      clock,
    );
    const r = assembleMorningInjection(db, { sessionId: "s-inject", project: null, personalityPath, clock });
    expect(r.injectedIds).toContain(review.id); // 旧码：书签把整个经历区吃光，自评被挤掉
    expect(r.injectedIds.length).toBeGreaterThan(1); // 书签也仍有份额（不是矫枉过正清零）
  });

  test("书签稀少时，余量自动让给自评（配额不是死切两半）", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "bookmark", content: "小感触一条", sourceSession: "s", occurredAt: NOW }, clock);
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        insertExperience(
          db,
          { kind: "self_review", content: `第${i}天的复盘：${"内容".repeat(30)}`, occurredAt: `2026-06-${16 + (i % 5)}T2${i % 2}:00:00.000Z` },
          clock,
        ).id,
      );
    }
    const r = assembleMorningInjection(db, { sessionId: "s-inject", project: null, personalityPath, clock });
    // 12 条中等自评合计远超 1000 token 也远超 (1300-书签小配额)——只要显著多条进来即证余量在自评手里
    expect(ids.filter((id) => r.injectedIds.includes(id)).length).toBeGreaterThanOrEqual(8);
  });
});

describe("rank11 书签写口查重（幂等）", () => {
  test("同会话同内容第二次落库返回既有行，库里只一条", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const a = addBookmark(db, { content: "这个修法真漂亮", sessionId: "s1" }, clock);
    const b = addBookmark(db, { content: "这个修法真漂亮", sessionId: "s1" }, clock);
    expect(b.id).toBe(a.id);
    expect(bookmarkCount(db)).toBe(1);
  });

  test("不同会话同内容不误杀；同会话不同内容照常两条", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    addBookmark(db, { content: "同一句感触", sessionId: "s1" }, clock);
    addBookmark(db, { content: "同一句感触", sessionId: "s2" }, clock);
    addBookmark(db, { content: "另一句感触", sessionId: "s1" }, clock);
    expect(bookmarkCount(db)).toBe(3);
  });

  test("已作废的同内容书签不挡新写（查重只看 live）", async () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const { invalidateExperience } = await import("../src/experiences");
    const a = addBookmark(db, { content: "曾经的感触", sessionId: "s1" }, clock);
    invalidateExperience(db, a.id, clock);
    const b = addBookmark(db, { content: "曾经的感触", sessionId: "s1" }, clock);
    expect(b.id).not.toBe(a.id);
  });
});

describe("限长：超长书签截断带标记", () => {
  test("超 BOOKMARK_MAX_CHARS 截断，正常长度原样", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const long = "长".repeat(BOOKMARK_MAX_CHARS + 500);
    const row = addBookmark(db, { content: long, sessionId: "s1" }, clock);
    expect(row.content.length).toBeLessThanOrEqual(BOOKMARK_MAX_CHARS + 20);
    expect(row.content).toContain("截断");

    const ok = addBookmark(db, { content: "正常长度的感触", sessionId: "s1" }, clock);
    expect(ok.content).toBe("正常长度的感触");
  });
});
