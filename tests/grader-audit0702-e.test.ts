// 独立验收考官 · AUDIT-2026-07-02 刀E（书签三件：rank6a 单独配额 / rank11 写口查重 / 限长截断）。
// 铁律：不改 src/、不碰生产库（~/.claude/anima）。每个用例临时目录建库、afterEach 清理。
// 对抗设计——专攻边界与误伤：配额几何（恰好装满/差一条/余量单向流）、stripEcho×截断×查重的先后顺序、
// IS NULL 空 session、作废不挡、历史多重复、截断上/下界 off-by-one、剥离把超长压回上限内。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { assembleMorningInjection, BOOKMARK_INJECT_QUOTA, REGION_QUOTAS } from "../src/inject";
import { addBookmark, BOOKMARK_MAX_CHARS } from "../src/bookmark";
import { estimateTokens } from "../src/tokens";
import { ANIMA_CONTEXT_CLOSE, ANIMA_CONTEXT_OPEN } from "../src/echo";

const NOW = "2026-06-21T22:00:00.000Z"; // 东八 = 06-22，故 occurredAt=NOW 的书签算"今天"
const clock = frozenClock(NOW);

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-grader0702e-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "home"), { recursive: true });
  const personalityPath = join(dir, "home", "personality.md");
  writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8"); // 小人格卡：绝不触发 4k 全局裁剪
  return { dbPath: join(dir, "home", "anima.db"), personalityPath };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type DB = ReturnType<typeof openDb>;
const bmCount = (db: DB) =>
  (db.query("SELECT count(*) c FROM experiences WHERE kind='bookmark'").get() as { c: number }).c;
const kindOf = (db: DB, id: number) =>
  (db.query("SELECT kind FROM experiences WHERE id=?").get(id) as { kind: string }).kind;
// 注入经历区（第 3 段）的行；书签行在前、自评行在后（与 injectedIds 顺序一致）
const expLines = (r: ReturnType<typeof assembleMorningInjection>) =>
  r.regions.find((x) => x.name === "experiences")!.content.split("\n");

function seedBookmarksToday(db: DB, n: number) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      insertExperience(
        db,
        {
          kind: "bookmark",
          // 等宽内容（第NN 两位定宽 + 定长正文）→ 每行 token 完全相等，配额几何可算
          content: `第${String(i).padStart(2, "0")}条感触：${"这瞬间值得记因为它揭示了系统层的真问题啊".repeat(2)}`,
          sourceSession: "s-today",
          occurredAt: NOW,
        },
        clock,
      ).id,
    );
  }
  return ids;
}

// ══════════════════════════ 需求1 rank6a：书签单独配额 ══════════════════════════
describe("rank6a 书签单独小配额，不再吃空真自评", () => {
  test("头条几何：60 条今日书签 + 1 条昨日自评 → 自评必进（旧码：26 条书签填满 1300、自评被挤掉）", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    seedBookmarksToday(db, 60);
    const review = insertExperience(
      db,
      {
        kind: "self_review",
        content: `昨天的复盘：${"把水位线防回退守卫焊进原语层并让独立考官签字确认。".repeat(8)}`,
        occurredAt: "2026-06-20T22:00:00.000Z",
      },
      clock,
    );
    const r = assembleMorningInjection(db, { sessionId: "inj", project: null, personalityPath, clock });
    expect(r.injectedIds).toContain(review.id); // 核心：真自评没被书签海洋挤出
    const injectedBm = r.injectedIds.filter((id) => kindOf(db, id) === "bookmark");
    expect(injectedBm.length).toBeGreaterThan(0); // 不矫枉过正清零：书签仍有份额
    // cap 生效：注入的书签行 token 合计 ≤ 单独配额
    const bmTok = expLines(r)
      .slice(0, injectedBm.length)
      .reduce((s, l) => s + estimateTokens(l) + 1, 0);
    expect(bmTok).toBeLessThanOrEqual(BOOKMARK_INJECT_QUOTA);
    db.close();
  });

  test("恰好装满/差一条：等宽书签贪心填到配额边界（==quota 装得下，超一格即弃）", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    seedBookmarksToday(db, 30); // 远多于配额容量，逼贪心填到边界
    const r = assembleMorningInjection(db, { sessionId: "inj", project: null, personalityPath, clock });
    const injectedBm = r.injectedIds.filter((id) => kindOf(db, id) === "bookmark");
    const lines = expLines(r);
    const w = estimateTokens(lines[0]!) + 1; // 单行宽（等宽，任取其一）
    const n = injectedBm.length;
    // 装满不溢：n 行 ≤ 配额；差一条：再加一行必超（证明"跳过继续装"的贪心确实填到了边界，非提前收手）
    expect(n * w).toBeLessThanOrEqual(BOOKMARK_INJECT_QUOTA);
    expect((n + 1) * w).toBeGreaterThan(BOOKMARK_INJECT_QUOTA);
    db.close();
  });

  test("余量单向流：书签稀少 → 空出的配额自动让给自评（不是死切两半 650/650）", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "bookmark", content: "就一条小感触", sourceSession: "s", occurredAt: NOW }, clock);
    const rvIds: number[] = [];
    for (let i = 0; i < 12; i++) {
      rvIds.push(
        insertExperience(
          db,
          {
            kind: "self_review",
            content: `第${i}天复盘：${"这段把并发写库的水位线 CAS 焊死并复验。".repeat(3)}`,
            occurredAt: `2026-06-${16 + (i % 5)}T0${i % 8}:30:00.000Z`,
          },
          clock,
        ).id,
      );
    }
    const r = assembleMorningInjection(db, { sessionId: "inj", project: null, personalityPath, clock });
    const injectedRv = rvIds.filter((id) => r.injectedIds.includes(id)).length;
    // 若死切两半，自评只有 ~650 token（约 4 条）；余量真让给自评则应显著更多
    expect(injectedRv).toBeGreaterThanOrEqual(8);
    db.close();
  });

  test("渲染顺序零回归：书签行排在自评行之前", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "bookmark", content: "书签锚点词ZZZ", sourceSession: "s", occurredAt: NOW }, clock);
    insertExperience(db, { kind: "self_review", content: "自评锚点词QQQ的复盘内容够长够具体绝不空洞。", occurredAt: "2026-06-20T10:00:00.000Z" }, clock);
    const r = assembleMorningInjection(db, { sessionId: "inj", project: null, personalityPath, clock });
    const txt = r.regions.find((x) => x.name === "experiences")!.content;
    expect(txt.indexOf("书签锚点词ZZZ")).toBeGreaterThanOrEqual(0);
    expect(txt.indexOf("自评锚点词QQQ")).toBeGreaterThan(txt.indexOf("书签锚点词ZZZ"));
    db.close();
  });

  test("warnings 语义零回归：只出现既有 warning 文案，无新告警类型；结构完整", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    seedBookmarksToday(db, 40);
    const r = assembleMorningInjection(db, { sessionId: "inj", project: null, personalityPath, clock });
    // 允许出现"经历区超配额，已裁掉 N 条"（书签被 cap 属正当裁剪），但不得冒出别的新告警串
    for (const w of r.warnings) {
      expect(w).toMatch(/超配额|超总预算|主权检查/);
    }
    // 六区渲染与闭合标记完整
    expect(r.text.startsWith(ANIMA_CONTEXT_OPEN)).toBe(true);
    expect(r.text.trimEnd().endsWith(ANIMA_CONTEXT_CLOSE)).toBe(true);
    expect(r.regions.map((x) => x.name)).toEqual([
      "boundary",
      "personality",
      "experiences",
      "projectMemory",
      "permission",
      "anchor",
      "floor",
      "selfStatus", // SELFKNOW-SPEC #2：末位追加的「机器真值·当前」小块（base 现读）
    ]);
    db.close();
  });

  test("设计取舍（记录在案）：无自评时书签仍被 cap，不回灌整区（余量只单向流向自评）", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    seedBookmarksToday(db, 40); // 满屏书签、零自评、经历区有大量空位
    const r = assembleMorningInjection(db, { sessionId: "inj", project: null, personalityPath, clock });
    const injectedBm = r.injectedIds.filter((id) => kindOf(db, id) === "bookmark");
    const bmTok = expLines(r)
      .slice(0, injectedBm.length)
      .reduce((s, l) => s + estimateTokens(l) + 1, 0);
    // 即便经历区（1300）几乎全空，书签也不越过自己的小配额——需求明确「单独小配额 + 余量让给自评」的单向语义
    expect(bmTok).toBeLessThanOrEqual(BOOKMARK_INJECT_QUOTA);
    expect(injectedBm.length).toBeLessThan(40); // 确有书签被 cap 掉（非全进）
    db.close();
  });
});

// ══════════════════════════ 需求2 rank11：写口查重（幂等） ══════════════════════════
describe("rank11 书签写口查重", () => {
  test("同会话同内容第二次：返回既有行、不落新条", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const a = addBookmark(db, { content: "这个修法真漂亮", sessionId: "s1" }, clock);
    const b = addBookmark(db, { content: "这个修法真漂亮", sessionId: "s1" }, clock);
    expect(b.id).toBe(a.id);
    expect(bmCount(db)).toBe(1);
    db.close();
  });

  test("跨会话同内容不误杀：两条各自落库", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const a = addBookmark(db, { content: "同一句感触", sessionId: "s1" }, clock);
    const b = addBookmark(db, { content: "同一句感触", sessionId: "s2" }, clock);
    expect(b.id).not.toBe(a.id);
    expect(bmCount(db)).toBe(2);
    db.close();
  });

  test("空 session（IS NULL 路径）同内容也去重；空 vs 具名 session 不互相误杀", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const a = addBookmark(db, { content: "无会话的感触" }, clock); // sessionId undefined → NULL
    const b = addBookmark(db, { content: "无会话的感触" }, clock); // NULL IS NULL → 命中 a
    expect(b.id).toBe(a.id);
    const c = addBookmark(db, { content: "无会话的感触", sessionId: "s1" }, clock); // 具名 ≠ NULL
    expect(c.id).not.toBe(a.id);
    expect(bmCount(db)).toBe(2);
    db.close();
  });

  test("已作废同内容不挡新写（查重只看 live）", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const a = addBookmark(db, { content: "曾经的感触", sessionId: "s1" }, clock);
    expect(invalidateExperience(db, a.id, clock)).toBe(true);
    const b = addBookmark(db, { content: "曾经的感触", sessionId: "s1" }, clock);
    expect(b.id).not.toBe(a.id); // 作废那条不算 live，新写照落
    db.close();
  });

  test("查重比较的是【剥回声后】的最终形态：带 <anima-context> 回声与不带的算同一条", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const a = addBookmark(db, { content: "这瞬间值得记", sessionId: "s1" }, clock);
    const echoed = `${ANIMA_CONTEXT_OPEN}上次注入的一堆记忆噪音${ANIMA_CONTEXT_CLOSE}这瞬间值得记`;
    const b = addBookmark(db, { content: echoed, sessionId: "s1" }, clock);
    expect(b.id).toBe(a.id); // 若查重比较的是原始入参而非剥后形态，这里会误落第二条
    expect(bmCount(db)).toBe(1);
    db.close();
  });

  test("查重比较的是【截断后】的最终形态：两条仅在 2000 字后不同 → 截断成同形 → 去重为一条", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const base = "长".repeat(BOOKMARK_MAX_CHARS + 10);
    const a = addBookmark(db, { content: base + "尾巴甲甲甲", sessionId: "s1" }, clock);
    const b = addBookmark(db, { content: base + "尾巴乙乙乙", sessionId: "s1" }, clock);
    expect(b.id).toBe(a.id); // 截断丢掉了区分尾巴 → 最终形态相同 → 幂等
    expect(bmCount(db)).toBe(1);
    db.close();
  });

  test("不过度去重：同会话不同内容照常两条", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    addBookmark(db, { content: "感触甲", sessionId: "s1" }, clock);
    addBookmark(db, { content: "感触乙", sessionId: "s1" }, clock);
    expect(bmCount(db)).toBe(2);
    db.close();
  });

  test("历史多条 live 重复（前置 bug 产物）：新写返回最早那条、绝不再添", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    // 绕过 addBookmark 直插两条同 content/session 的 live 行，模拟修前遗留
    const first = insertExperience(db, { kind: "bookmark", content: "历史重复", sourceSession: "s1", occurredAt: NOW }, clock).id;
    insertExperience(db, { kind: "bookmark", content: "历史重复", sourceSession: "s1", occurredAt: NOW }, clock);
    const again = addBookmark(db, { content: "历史重复", sessionId: "s1" }, clock);
    expect(again.id).toBe(first); // ORDER BY id ASC LIMIT 1 → 最早一条
    expect(bmCount(db)).toBe(2); // 没有新增第三条
    db.close();
  });
});

// ══════════════════════════ 需求3 限长：截断带标记 ══════════════════════════
describe("限长 书签 content 截断", () => {
  test("上界 off-by-one：恰好 MAX 逐字不动，MAX+1 截断带标记", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const exact = "字".repeat(BOOKMARK_MAX_CHARS);
    const rowExact = addBookmark(db, { content: exact, sessionId: "s1" }, clock);
    expect(rowExact.content).toBe(exact); // == 上限：不截
    expect(rowExact.content.length).toBe(BOOKMARK_MAX_CHARS);

    const over = "字".repeat(BOOKMARK_MAX_CHARS + 1);
    const rowOver = addBookmark(db, { content: over, sessionId: "s2" }, clock);
    expect(rowOver.content).not.toBe(over); // 被改动（非逐字）
    // 真内容部分恰好截到上限：正好 MAX 个"字"后接标记（不是 MAX+1）
    const leadZi = rowOver.content.match(/^字+/)![0].length;
    expect(leadZi).toBe(BOOKMARK_MAX_CHARS);
    expect(rowOver.content).toContain("截断"); // 带可见标记
    expect(rowOver.content.length).toBeLessThanOrEqual(BOOKMARK_MAX_CHARS + 20); // 标记开销有界
    db.close();
  });

  test("正常长度逐字不动（含标点）", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const normal = "权限测试连挂三次，那一下真有点上头——但没放手。";
    const row = addBookmark(db, { content: normal, sessionId: "s1" }, clock);
    expect(row.content).toBe(normal);
    db.close();
  });

  test("剥回声在截断之前：超长原文里塞大段回声，剥掉后落回上限内 → 不截断、真感触逐字保留", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const real = "真感触".repeat(300); // 900 字，远在上限内
    const raw = `${ANIMA_CONTEXT_OPEN}${"噪".repeat(BOOKMARK_MAX_CHARS)}${ANIMA_CONTEXT_CLOSE}${real}`;
    expect(raw.length).toBeGreaterThan(BOOKMARK_MAX_CHARS); // 原始入参超上限
    const row = addBookmark(db, { content: raw, sessionId: "s1" }, clock);
    expect(row.content).toBe(real); // 剥后未超上限 → 不截、逐字
    expect(row.content).not.toContain("截断");
    db.close();
  });

  test("上限常量可导出且为正整数", () => {
    expect(Number.isInteger(BOOKMARK_MAX_CHARS)).toBe(true);
    expect(BOOKMARK_MAX_CHARS).toBeGreaterThan(0);
    expect(BOOKMARK_INJECT_QUOTA).toBeGreaterThan(0);
    expect(BOOKMARK_INJECT_QUOTA).toBeLessThanOrEqual(REGION_QUOTAS.experiences);
  });
});
