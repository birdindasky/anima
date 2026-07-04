// Phase 2 延续（注入侧）— T2.1~T2.6（见 tests/TEST-PLAN.md）

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience, searchExperiences, getExperience } from "../src/experiences";
import { addBookmark } from "../src/bookmark";
import { listInjectedExperienceIds } from "../src/injection";
import { assembleMorningInjection, REGION_QUOTAS } from "../src/inject";
import { estimateTokens } from "../src/tokens";
import { findMoodNumberViolations, scrubMoodNumbers, scrubMoodViolations } from "../src/sovereignty";
import { searchMemoryIndex, renderExperienceDetail, renderMemoryDetail } from "../src/recall";

const NOW = "2026-06-10T22:00:00.000Z";
const PROJECT = "/Users/tester/Projects/demo";

const tmpDirs: string[] = [];
function tmpHome(): { dir: string; dbPath: string; personalityPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "anima-test-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "anima-home"), { recursive: true });
  return {
    dir,
    dbPath: join(dir, "anima-home", "anima.db"),
    personalityPath: join(dir, "anima-home", "personality.md"),
  };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function daysAgoIso(days: number, hour = 10): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe("token 估算（基建 sanity）", () => {
  test("中文按字、英文按 ~4 字符折算", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("hello world!")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("T2.1 预算与配额", () => {
  test("灌超量素材 → 总量 ≤4k、各区不超配额、项目记忆存活、经历区先被裁", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    writeFileSync(personalityPath, `# 人格卡\n\n我叫小满。${"性格描述。".repeat(60)}\n`, "utf8");

    // 超量灌入：120 条肥自评 + 40 条今日肥书签 + 30 条项目记忆
    for (let i = 0; i < 120; i++) {
      insertExperience(
        db,
        {
          kind: "self_review",
          content: `第${i}天的自评回顾：${"那天的工作细节描述很长很长。".repeat(15)}`,
          occurredAt: daysAgoIso((i % 6) + 1),
        },
        clock,
      );
    }
    for (let i = 0; i < 40; i++) {
      addBookmark(
        db,
        { content: `今日书签${i}：${"当时的情境记录也不短。".repeat(12)}`, sessionId: `sess-a${i}` },
        clock,
      );
    }
    for (let i = 0; i < 30; i++) {
      insertExperience(
        db,
        {
          kind: "preference",
          project: PROJECT,
          content: `PROJ_MEM_${i} 用户在这个项目的偏好规则，条目不算短但都是干货。`,
          occurredAt: daysAgoIso(i % 9),
        },
        clock,
      );
    }

    const out = assembleMorningInjection(db, {
      sessionId: "sess-b",
      project: PROJECT,
      personalityPath,
      clock,
    });

    expect(estimateTokens(out.text)).toBeLessThanOrEqual(4000);
    for (const r of out.regions) {
      expect(r.tokens).toBeLessThanOrEqual(r.quota);
    }
    // 项目记忆存活
    expect(out.text).toContain("PROJ_MEM_");
    // 经历区被裁（160 条灌入不可能全进），且溢出有显式告警
    const expRegion = out.regions.find((r) => r.name === "experiences")!;
    expect(expRegion.tokens).toBeLessThanOrEqual(REGION_QUOTAS.experiences);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings.join("")).toContain("裁");
  });
});

describe("T2.2 排序公式（相关性是门槛，情绪只在相关集合内加权）", () => {
  test("无聊但相关 > 高情绪但无关；失效记忆情绪满格也不出现", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);

    const boring = insertExperience(
      db,
      { kind: "decision", content: "部署规则：先跑迁移脚本再发布，蓝绿切换收尾" },
      clock,
    );
    insertExperience(
      db,
      {
        kind: "event",
        content: "那天我把生产数据库删了，天都塌了",
        feeling: "恐慌到极点，到现在想起来还发抖",
        intensity: "满格",
      },
      clock,
    );
    const dead = insertExperience(
      db,
      {
        kind: "decision",
        content: "部署必须在周五晚上做",
        feeling: "印象深刻到不行",
        intensity: "满格",
      },
      clock,
    );
    invalidateExperience(db, dead.id, clock);

    const hits = searchExperiences(db, "部署");
    expect(hits.map((h) => h.uuid)).toContain(boring.uuid);
    // 高情绪但无关：相关性门槛直接挡掉
    expect(hits.map((h) => h.content).join()).not.toContain("生产数据库删了");
    // 已失效：硬过滤
    expect(hits.map((h) => h.uuid)).not.toContain(dead.uuid);

    // 同等相关时，带情绪烙印者排前
    const plain = insertExperience(db, { kind: "event", content: "部署流程有坑" }, clock);
    const felt = insertExperience(
      db,
      { kind: "event", content: "部署流程把我坑惨了", feeling: "烦死" },
      clock,
    );
    const ranked = searchExperiences(db, "部署流程");
    const idxFelt = ranked.findIndex((r) => r.uuid === felt.uuid);
    const idxPlain = ranked.findIndex((r) => r.uuid === plain.uuid);
    expect(idxFelt).toBeGreaterThanOrEqual(0);
    expect(idxPlain).toBeGreaterThanOrEqual(0);
    expect(idxFelt).toBeLessThan(idxPlain);
  });
});

describe("T2.7 经历区电荷加权（破 7 天断崖）", () => {
  test("注入选材按情绪电荷排序：高情绪的旧记忆排在无情绪的新琐事之前", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);

    // A：1 天前的无情绪琐事——纯新鲜度会让它排最前
    insertExperience(
      db,
      { kind: "self_review", content: "例行跑了一遍测试，绿了，没别的", occurredAt: daysAgoIso(1) },
      clock,
    );
    // B：4 天前的高情绪记忆——电荷半衰慢，应当压过更新但无情绪的 A
    insertExperience(
      db,
      {
        kind: "self_review",
        content: "线上库被我误删，整个人都懵了",
        feeling: "后怕到手还在抖，到现在想起来都发紧",
        intensity: "满格",
        occurredAt: daysAgoIso(4),
      },
      clock,
    );

    const out = assembleMorningInjection(db, { sessionId: "sess-charge", project: PROJECT, clock,
      personalityPath: join(tmpdir(), "no-such-personality.md") });
    const exp = out.regions.find((r) => r.name === "experiences")!.content;
    const idxB = exp.indexOf("线上库被我误删");
    const idxA = exp.indexOf("例行跑了一遍测试");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    // 电荷优先：B 在 A 之前（纯时间倒序则相反）
    expect(idxB).toBeLessThan(idxA);
    // 主权铁律：电荷数值只排序、绝不进注入文本
    expect(exp).not.toMatch(/电荷|charge|0\.\d{2,}/i);
  });
});

describe("T2.3 regions 隔离", () => {
  test("其他区被裁剪压缩后，人格段逐字未变、未混入流水段", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    const persona = `# 人格卡\n\n我叫小满。PERSONA_SENTINEL_LINE 这一行一个字都不能变。\n`;
    writeFileSync(personalityPath, persona, "utf8");

    // 灌爆经历区，强迫裁剪发生
    for (let i = 0; i < 80; i++) {
      insertExperience(
        db,
        {
          kind: "self_review",
          content: `自评${i}：${"流水内容重复又重复。".repeat(20)}`,
          occurredAt: daysAgoIso(1),
        },
        clock,
      );
    }

    const out = assembleMorningInjection(db, {
      sessionId: "sess-c",
      project: PROJECT,
      personalityPath,
      clock,
    });

    const personaRegion = out.regions.find((r) => r.name === "personality")!;
    expect(personaRegion.content).toBe(persona.trim());
    expect(personaRegion.class).toBe("core");
    // 人格内容没混进经历区
    const expRegion = out.regions.find((r) => r.name === "experiences")!;
    expect(expRegion.content).not.toContain("PERSONA_SENTINEL_LINE");
    // 全文恰好出现一次
    expect(out.text.split("PERSONA_SENTINEL_LINE").length - 1).toBe(1);
  });
});

describe("T2.4 当日跨会话", () => {
  test("上午会话 A 的书签出现在下午会话 B 的注入中，且记入注入台账", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");

    const morning = frozenClock("2026-06-10T20:00:00.000Z"); // 东八区 06-11 04:00，与 NOW(东八区 06-11 06:00)同一天
    const bm = addBookmark(
      db,
      {
        content: "上午联调把 OAuth 回调修通了，那一下挺爽",
        feeling: "爽",
        sessionId: "sess-morning",
      },
      morning,
    );

    const afternoon = frozenClock(NOW);
    const out = assembleMorningInjection(db, {
      sessionId: "sess-afternoon",
      project: PROJECT,
      personalityPath,
      clock: afternoon,
    });

    expect(out.text).toContain("OAuth 回调修通");
    expect(out.injectedIds).toContain(bm.id);
    expect(listInjectedExperienceIds(db, "sess-afternoon")).toContain(bm.id);
  });
});

describe("T2.5 渐进披露", () => {
  test("检索默认返回索引行（每条 ≤100 token），按 ID 取全文成功", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);

    const longContent = `部署手册第一章：${"完整的部署细节描述，包含每一步的命令与回滚预案。".repeat(20)}`;
    const row = insertExperience(db, { kind: "decision", content: longContent }, clock);
    insertExperience(db, { kind: "event", content: "部署演练顺利完成" }, clock);

    const index = searchMemoryIndex(db, "部署", { clock });
    expect(index.length).toBeGreaterThanOrEqual(2);
    for (const line of index) {
      expect(estimateTokens(line.line)).toBeLessThanOrEqual(100);
      expect(line.line).toContain(`#${line.id}`);
    }
    // 索引行是截断的，全文按 ID 拉取完整
    const detail = renderExperienceDetail(db, row.id, { clock });
    expect(detail).toContain(longContent);
    expect(getExperience(db, row.id)!.content).toBe(longContent);
  });
});

describe("速测回归修复②：词汇漂移召回缺口——查不到消化记忆时翻原始流水（2026-06-11 实测暴露）", () => {
  test("消化措辞漂移时，原话仍可从流水原文召回（带 s 前缀标识）", async () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    const { appendSituation } = await import("../src/situation");

    // 消化后的经历换了说法（"迁到"），针在原话里（"迁移"覆盖不到经历）
    insertExperience(
      db,
      { kind: "preference", content: "文档从 Notion 迁到 Obsidian，纯 markdown 进 git" },
      clock,
    );
    appendSituation(
      db,
      {
        sessionId: "s1",
        kind: "user_message",
        payload: { text: "工具链上有个变化：文档工具从 Notion 迁移到 Obsidian，离线和 diff 都好用" },
      },
      clock,
    );

    const hits = searchMemoryIndex(db, "文档工具 迁移", { clock });
    expect(hits.length).toBeGreaterThan(0);
    const raw = hits.find((h) => h.source === "situation");
    expect(raw).toBeDefined();
    expect(raw!.line).toContain("#s");
    expect(raw!.line).toContain("流水");
    // 按 ref 拉全文，针在场
    const detail = renderMemoryDetail(db, raw!.source, raw!.id);
    expect(detail).toContain("Obsidian");

    // 消化记忆能命中时，不翻流水（渐进披露不被流水刷屏）
    const direct = searchMemoryIndex(db, "Notion Obsidian", { clock });
    expect(direct.some((h) => h.source === "experience")).toBe(true);
    expect(direct.some((h) => h.source === "situation")).toBe(false);
  });

  test("流水兜底不破坏陷阱诚实：查无就是查无", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    insertExperience(db, { kind: "event", content: "部署演练顺利完成" }, clock);
    expect(searchMemoryIndex(db, "MySQL 版本 升级", { clock })).toHaveLength(0);
  });
});

describe("T2.6 主权铁律（机器版）", () => {
  test("scrub/检查器单元行为", () => {
    expect(findMoodNumberViolations("今天心情 8/10，不错").length).toBeGreaterThan(0);
    expect(findMoodNumberViolations("情绪值 85% 高涨").length).toBeGreaterThan(0);
    expect(findMoodNumberViolations("修了 3 个测试，跑了 2 次")).toHaveLength(0);
    expect(findMoodNumberViolations("状态码 404 排查完毕")).toHaveLength(0);
    expect(scrubMoodNumbers("心情 8/10 吧")).not.toMatch(/\d/);
  });

  test("注入产物全文不含心情数值/百分比/情绪分数；工作数字不受伤", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");

    // 投毒：经历的感受字段里夹带数字心情
    addBookmark(
      db,
      { content: "修了 3 个测试，跑了 2 次才过", feeling: "心情 8/10 吧", sessionId: "s1" },
      clock,
    );
    insertExperience(
      db,
      {
        kind: "self_review",
        content: "今天整体顺利，下午联调一次过",
        feeling: "情绪值 85%，飘了",
        intensity: "9 分",
        occurredAt: daysAgoIso(1),
      },
      clock,
    );

    const out = assembleMorningInjection(db, {
      sessionId: "sess-d",
      project: PROJECT,
      personalityPath,
      clock,
    });

    expect(findMoodNumberViolations(out.text)).toHaveLength(0);
    // 工作数字是事实，不能被误伤
    expect(out.text).toContain("修了 3 个测试");
    // 感受还在，只是数字没了
    expect(out.text).toContain("心情");
    expect(out.text).not.toMatch(/心情[^\n]{0,10}\d/);
    expect(out.text).not.toMatch(/\d\s*\/\s*10/);
    expect(out.text).not.toMatch(/\d+\s*%，飘/);
  });

  test("scrubMoodViolations：外科清洗——情绪数字清掉、工作事实数字保留，不变式恒空", () => {
    // 情绪词邻近数字被清，清洗后零违规
    expect(findMoodNumberViolations(scrubMoodViolations("今天心情 8/10，不错"))).toHaveLength(0);
    expect(findMoodNumberViolations(scrubMoodViolations("情绪值 85% 高涨"))).toHaveLength(0);
    expect(findMoodNumberViolations(scrubMoodViolations("心情大概 7 分"))).toHaveLength(0);
    // 多数字情绪行（外科不够 → 兜底抹光该行数字）也零违规
    expect(findMoodNumberViolations(scrubMoodViolations("心情 8 然后 9 分忽上忽下"))).toHaveLength(0);
    // 不变式：任意违规输入清洗后恒空
    for (const s of ["心情 8/10", "情绪 9 分了", "mood 7 / 10", "感受：85% 满意", "情绪值高达 100%"]) {
      expect(findMoodNumberViolations(scrubMoodViolations(s))).toHaveLength(0);
    }
    // 工作事实数字（无情绪词的行）原样保留——commit 号、bug 数、状态码不被误伤
    expect(scrubMoodViolations("修了 3 个测试，commit 089eb44")).toBe("修了 3 个测试，commit 089eb44");
    expect(scrubMoodViolations("状态码 404 排查完毕")).toBe("状态码 404 排查完毕");
    // 多行：只动违规行，别行的事实数字完好
    const multi = scrubMoodViolations("复盘时心情 8 分\n这次修了 5 个 bug，commit 089eb44");
    expect(findMoodNumberViolations(multi)).toHaveLength(0);
    expect(multi).toContain("5 个 bug");
    expect(multi).toContain("089eb44");
  });

  test("全角数字也被堵：中文输入法易产出的 ８５％ / ８/１０ / ８分 不漏过", () => {
    // 检测器认全角（半角 \d 不认全角是历史盲点）
    expect(findMoodNumberViolations("心情 ８/１０").length).toBeGreaterThan(0);
    expect(findMoodNumberViolations("情绪值 ８５％ 高涨").length).toBeGreaterThan(0);
    expect(findMoodNumberViolations("心情 ８ 分").length).toBeGreaterThan(0);
    // 清洗器也认全角 → 不变式对全角同样恒空
    for (const s of ["心情 ８/１０", "情绪值 ８５％", "心情 ８ 分", "８/１０ 的心情", "mood ８/１０", "心情 ８５％ 高涨"]) {
      expect(findMoodNumberViolations(scrubMoodViolations(s))).toHaveLength(0);
    }
    // scrubMoodNumbers（感受字段兜底全剥）也认全角
    expect(scrubMoodNumbers("心情 ８/１０ 吧")).not.toMatch(/[0-9０-９]/);
    // 无情绪词的全角工作数字仍保留（不波及事实）
    expect(scrubMoodViolations("修了 ３ 个 bug")).toBe("修了 ３ 个 bug");
    // \p{Nd} 一举堵死所有数字形态——阿拉伯-印度数字也不漏
    expect(findMoodNumberViolations("心情 ٨/١٠").length).toBeGreaterThan(0);
    expect(findMoodNumberViolations(scrubMoodViolations("情绪 ٨٥٪ 还行"))).toHaveLength(0);
  });

  test("经历正文里的心情数字：被外科清洗保留整行，不触发'丢弃整行'最后闸", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const clock = frozenClock(NOW);
    writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");

    // 投毒：心情数字夹在经历【正文】里（不是 feeling 字段——旧码只洗 feeling，正文会漏到最后闸被丢整行）
    insertExperience(
      db,
      {
        kind: "self_review",
        content: "复盘时心情 8 分，但这次修了 5 个 bug、跑了 3 次测试才过",
        occurredAt: daysAgoIso(1),
      },
      clock,
    );

    const out = assembleMorningInjection(db, {
      sessionId: "sess-content-poison",
      project: PROJECT,
      personalityPath,
      clock,
    });

    // 铁律：注入文本零心情数值违规
    expect(findMoodNumberViolations(out.text)).toHaveLength(0);
    // 整行没被丢——正文还在（工作事实"修了"保留），不是整段被最后闸扔掉
    expect(out.text).toContain("修了");
    expect(out.text).toContain("跑了");
    // 上游已兜住 → 最后一道闸不再 load-bearing（不应出现"丢弃 N 行"告警）
    expect(out.warnings.some((w) => w.includes("丢弃"))).toBe(false);
  });
});
