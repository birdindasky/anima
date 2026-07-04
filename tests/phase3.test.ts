// Phase 3 梦游（消化侧）— T3.1~T3.7（见 tests/TEST-PLAN.md）
// 消化时钟约定：night = (now - 12h) 的东八区日期；凌晨 3 点跑 → 消化昨天

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 本文件考的是 center 模式（daysplit 关）的补课语义;装机后 ANIMA_DAYSPLIT=1 会漂在环境里,
// 不钉死就会走错路(daysplit 语义在 makeup-daysplit.test.ts 里专门考,那边自己 set/restore)。
let savedDaysplit: string | undefined;
beforeAll(() => {
  savedDaysplit = process.env.ANIMA_DAYSPLIT;
  delete process.env.ANIMA_DAYSPLIT;
});
afterAll(() => {
  if (savedDaysplit === undefined) delete process.env.ANIMA_DAYSPLIT;
  else process.env.ANIMA_DAYSPLIT = savedDaysplit;
});

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { addBookmark } from "../src/bookmark";
import { captureTranscript } from "../src/capture";
import { emotionalCharge, imprintStrength, nightsBetween } from "../src/charge";
import { runNightlyDigestion, getDigestStages, type DigestConfig } from "../src/digest";
import { prepareSessionStart } from "../src/sessionStart";
import { listSituations, appendSituation } from "../src/situation";
import { claudeCli } from "../src/llm";

import { materializeFixture, DEMO_PROJECT } from "./fixtures/materialize";
const FIXTURE = materializeFixture(join(import.meta.dir, "fixtures", "transcript-day.jsonl"));
// 凌晨 3 点（UTC）跑消化 → night = 2026-06-10
const DIGEST_NOW = "2026-06-11T03:00:00.000Z";
const NIGHT = "2026-06-10";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-test-"));
  tmpDirs.push(dir);
  const home = join(dir, "anima-home");
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
    badgePath: join(home, "badge.txt"),
  };
  return { dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 按 prompt 标记分流的 mock LLM（消化各阶段 prompt 含不同标记词） */
function mockDigestLlm() {
  const calls: string[] = [];
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("收工时间")) {
      calls.push("review");
      return JSON.stringify({
        review: "补课自评：那天修权限回归测试，先挂后过，用户提醒配色要先问。",
        feeling: "踏实",
        intensity: "不大",
        keywords: ["权限", "补课"],
        items: [],
      });
    }
    if (prompt.includes("画上句号")) {
      calls.push("closure");
      return JSON.stringify({
        closure: "那天权限测试折腾了一阵，但最后修好了——已经过去了，留下的是经验。",
      });
    }
    if (prompt.includes("人格文档")) {
      calls.push("personality");
      return "# 人格卡\n\n我叫小满。NEW_PERSONA_VERSION 经过昨天的事，我更确定：视觉改动先问再动手。\n";
    }
    if (prompt.includes("写日记")) {
      calls.push("diary");
      return "今天大部分时间在和权限回归测试较劲。挂了两次才发现是 mock 没复位，改完那一刻挺痛快。用户提醒我配色的事以后先问——记住了。";
    }
    calls.push("unknown");
    return "{}";
  };
  return { llm, calls };
}

/** 造一晚的素材：当天的带情绪经历 */
function seedNight(db: ReturnType<typeof openDb>, clock = frozenClock("2026-06-10T10:00:00.000Z")) {
  addBookmark(
    db,
    { content: "权限测试连挂两次，有点上头", feeling: "烦", sessionId: "sess-x" },
    clock,
  );
  insertExperience(
    db,
    {
      kind: "self_review",
      content: "今天修好了权限回归测试，挂了两次才过。",
      feeling: "最后挺痛快",
      sourceSession: "sess-x",
    },
    clock,
  );
}

describe("电荷估算（纯函数基建）", () => {
  test("imprintStrength：烙印越厚强度越高；无烙印为 0", () => {
    const rich = { feeling: "恐慌到极点，到现在想起来还发抖", intensity: "满格" } as any;
    const thin = { feeling: "还行", intensity: null } as any;
    const none = { feeling: null, intensity: null } as any;
    expect(imprintStrength(rich)).toBeGreaterThan(imprintStrength(thin));
    expect(imprintStrength(none)).toBe(0);
  });

  test("按东八区日界计数", () => {
    const now = new Date("2026-06-11T03:00:00.000Z"); // 东八区 06-11 11:00
    expect(nightsBetween("2026-06-10T06:00:00.000Z", now)).toBe(1); // 东八区 06-10 14:00 → 1 夜前
    expect(nightsBetween("2026-06-11T01:00:00.000Z", now)).toBe(0); // 东八区 06-11 09:00 → 同一天
    expect(nightsBetween("2026-06-08T06:00:00.000Z", now)).toBe(3); // 东八区 06-08 14:00 → 3 夜前
  });
});

describe("T3.6 电荷递减", () => {
  test("拨表过 3 夜单调递减；高光时刻衰减慢于平淡日常", () => {
    const row = (feeling: string, intensity: string | null) =>
      ({ feeling, intensity, occurredAt: "2026-06-10T20:00:00.000Z" }) as any;
    const highlight = row("那一刻真的特别痛快，整个人都亮了，值得记很久", "很冲");
    const mundane = row("还行", null);

    const at = (d: number) => new Date(`2026-06-1${d}T09:00:00.000Z`);
    // 单调递减
    const c1 = emotionalCharge(highlight, at(1));
    const c2 = emotionalCharge(highlight, at(2));
    const c3 = emotionalCharge(highlight, at(3));
    expect(c1).toBeGreaterThan(c2);
    expect(c2).toBeGreaterThan(c3);
    // 高光保留率 > 平淡保留率（衰减更慢）
    const keepHigh = c3 / emotionalCharge(highlight, at(1));
    const keepLow = emotionalCharge(mundane, at(3)) / emotionalCharge(mundane, at(1));
    expect(keepHigh).toBeGreaterThan(keepLow);
    // 原始小票永不改写：电荷是现算的，不碰行
  });
});

describe("T3.1 阶段独立", () => {
  test("写日记阶段抛异常 → 电荷递减照常完成，状态各自记录", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seedNight(db);
    const { llm } = mockDigestLlm();

    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      stageOverrides: {
        diary: async () => {
          throw new Error("日记爆了");
        },
      },
    });

    expect(result.night).toBe(NIGHT);
    expect(result.stages.decay.status).toBe("done");
    expect(result.stages.closure.status).toBe("done");
    expect(result.stages.diary.status).toBe("failed");
    expect(result.stages.diary.error).toContain("日记爆了");
    // 状态独立持久化在库
    const rows = db
      .query("SELECT stage, status FROM digest_runs WHERE night = ? ORDER BY stage")
      .all(NIGHT) as any[];
    expect(rows.find((r) => r.stage === "decay")!.status).toBe("done");
    expect(rows.find((r) => r.stage === "diary")!.status).toBe("failed");
    // 电荷快照真实存在
    expect(listSituations(db, { kind: "digest_decay_snapshot" }).length).toBe(1);

    // 修好日记后重跑：只补日记，已完成阶段跳过
    const { llm: llm2, calls } = mockDigestLlm();
    const second = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm: llm2,
      config,
    });
    expect(second.stages.diary.status).toBe("done");
    expect(second.skipped).toContain("decay");
    expect(second.skipped).toContain("closure");
    expect(calls).not.toContain("closure"); // 句号没有二次烧 LLM
  });
});

describe("T3.2 幂等", () => {
  test("同一晚消化跑两次 → 日记只有一篇、电荷快照只有一份", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seedNight(db);

    const r1 = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm: mockDigestLlm().llm,
      config,
    });
    expect(Object.values(r1.stages).every((s) => s.status === "done")).toBe(true);

    const diaryPath = join(config.diaryDir, `${NIGHT}.md`);
    const diary1 = readFileSync(diaryPath, "utf8");

    const { llm: llm2, calls } = mockDigestLlm();
    const r2 = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm: llm2,
      config,
    });
    expect(r2.skipped.length).toBe(getDigestStages().length); // 全部跳过
    expect(calls.length).toBe(0); // 一次 LLM 都没烧
    expect(readFileSync(diaryPath, "utf8")).toBe(diary1);
    expect(listSituations(db, { kind: "digest_decay_snapshot" }).length).toBe(1);
    const digests = db.query("SELECT count(*) c FROM experiences WHERE kind = 'digest'").get() as any;
    expect(digests.c).toBe(1);
  });
});

describe("T3.3 补课", () => {
  test("某会话无收工自评 → 夜间消化从 transcript 补出自评", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 当天有流水但没有自评（模拟直接关终端）
    captureTranscript(db, FIXTURE, { clock: frozenClock("2026-06-10T10:00:00.000Z") });
    const before = db
      .query("SELECT count(*) c FROM experiences WHERE kind LIKE 'self_review%'")
      .get() as any;
    expect(before.c).toBe(0);

    const { llm } = mockDigestLlm();
    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: "sess-fix-1", path: FIXTURE }],
    });

    expect(result.stages.makeup.status).toBe("done");
    const review = db
      .query("SELECT content, source_session FROM experiences WHERE kind = 'self_review'")
      .get() as any;
    expect(review).not.toBeNull();
    expect(review.source_session).toBe("sess-fix-1");
    expect(review.content).toContain("补课自评");
  });

  test("被作废的 fallback 自评不占坑 → 额度恢复后 makeup 重补出真自评", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 当天有流水
    captureTranscript(db, FIXTURE, { clock: frozenClock("2026-06-10T10:00:00.000Z") });
    // 事故夜额度撞墙时写下的兜底自评，事后被软作废（打 invalid_at）
    const fb = insertExperience(
      db,
      {
        kind: "self_review_fallback",
        content: "（兜底）本地数数：12 条经历，列了几个文件。",
        sourceSession: "sess-fix-1",
      },
      frozenClock("2026-06-10T16:00:00.000Z"),
    );
    invalidateExperience(db, fb.id, frozenClock("2026-06-10T17:00:00.000Z"));

    const { llm } = mockDigestLlm();
    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: "sess-fix-1", path: FIXTURE }],
    });

    expect(result.stages.makeup.status).toBe("done");
    // 作废的 fallback 不算"已自评" → 该会话被重补出真 self_review
    const review = db
      .query(
        "SELECT content, source_session FROM experiences WHERE kind = 'self_review' AND invalid_at IS NULL",
      )
      .get() as any;
    expect(review).not.toBeNull();
    expect(review.source_session).toBe("sess-fix-1");
    expect(review.content).toContain("补课自评");
  });

  test("makeup 补的自评归属到所属夜 N，而非消化时刻（否则 closure/人格/日记按夜选会漏）", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    captureTranscript(db, FIXTURE, { clock: frozenClock("2026-06-10T10:00:00.000Z") });

    const { llm } = mockDigestLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW), // 消化时刻在 night 的次日（2026-06-11）
      llm,
      config,
      findTranscripts: () => [{ sessionId: "sess-fix-1", path: FIXTURE }],
    });

    // 自评（及其提炼项）的 occurred_at 本地日期必须落在 night（2026-06-10），
    // 否则 stageClosure/stagePersonality（按 ${SQL_LOCAL_OCCURRED_DATE}=night 选素材）会全部漏掉。
    const row = db
      .query(
        "SELECT substr(datetime(occurred_at,'+8 hours'),1,10) d FROM experiences WHERE kind='self_review' AND source_session='sess-fix-1'",
      )
      .get() as { d: string };
    expect(row.d).toBe(NIGHT);
  });

  test("makeup 走兜底时写的 self_review_failed 流水归属夜 N，不盖成消化时刻（否则毒化次日会话归属）", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    captureTranscript(db, FIXTURE, { clock: frozenClock("2026-06-10T10:00:00.000Z") });
    // LLM 永远失败 → makeup 走客观兜底，写下 self_review_failed 流水
    const failingLlm = async () => {
      throw new Error("额度撞墙");
    };
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW), // 消化时刻在夜 N+1（2026-06-11）
      llm: failingLlm,
      config,
      findTranscripts: () => [{ sessionId: "sess-fix-1", path: FIXTURE }],
    });
    // 这条 marker 带 session_id；若盖成消化时刻（2026-06-11），下次消化会把 sess-fix-1
    // 当成 2026-06-11 的活动会话拽进去错标。它必须落在所属夜 N（2026-06-10）。
    const marker = db
      .query(
        "SELECT substr(datetime(occurred_at,'+8 hours'),1,10) d FROM situation_log WHERE kind='self_review_failed' AND session_id='sess-fix-1'",
      )
      .get() as { d: string } | null;
    expect(marker).not.toBeNull();
    expect(marker!.d).toBe(NIGHT);
  });

  test("会话当夜只有消化产物 marker（无真实活动）→ 不被 daySessions 拉进当夜补自评", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 一个"幽灵"会话：夜 N 只有一条 self_review_failed 流水（消化产物，非真实活动），别无他物
    appendSituation(
      db,
      { sessionId: "sess-ghost", kind: "self_review_failed", payload: { attempts: 2 } },
      frozenClock("2026-06-10T12:00:00.000Z"), // 本地 2026-06-10 = 夜 N
    );
    // 给它备一份真带 sess-ghost 的 transcript，证明"即便能补也不该补"
    const ghostPath = dbPath.replace(/anima\.db$/, "ghost.jsonl");
    writeFileSync(
      ghostPath,
      [
        `{"type":"user","uuid":"g1","sessionId":"sess-ghost","cwd":"/tmp/ghost","timestamp":"2026-06-10T11:00:00.000Z","message":{"role":"user","content":"幽灵会话说了句话"}}`,
        `{"type":"assistant","uuid":"g2","sessionId":"sess-ghost","cwd":"/tmp/ghost","timestamp":"2026-06-10T11:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"幽灵会话的回应"}]}}`,
      ].join("\n"),
      "utf8",
    );

    const { llm } = mockDigestLlm();
    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm,
      config,
      findTranscripts: () => [{ sessionId: "sess-ghost", path: ghostPath }],
    });

    // 归夜只认真实活动（user_message/file_edit/test_run/tool_error）；marker 不算 → 幽灵不被补自评
    const review = db
      .query(
        "SELECT count(*) c FROM experiences WHERE source_session='sess-ghost' AND kind LIKE 'self_review%'",
      )
      .get() as { c: number };
    expect(review.c).toBe(0);
  });

  test("跨午夜会话整段归'重心夜'：只在真实活动最多的那夜被复盘一次，不切片", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // sess-split 跨 6-10/6-11：6-10 仅 2 条活动、6-11 有 5 条 → 重心夜 = 6-11
    // （occurred_at 存 UTC；本地日 = +8h。UTC 02:00 → 东八区当天 10:00）
    const tpath = dbPath.replace(/anima\.db$/, "split.jsonl");
    const line = (uuid: string, day: string, text: string) =>
      `{"type":"user","uuid":"${uuid}","sessionId":"sess-split","cwd":"/p","timestamp":"${day}T02:00:00.000Z","message":{"role":"user","content":"${text}"}}`;
    writeFileSync(
      tpath,
      [
        line("d1", "2026-06-10", "第一天开个头"),
        line("d2", "2026-06-10", "第一天再说一句"),
        line("d3", "2026-06-11", "第二天接着干"),
        line("d4", "2026-06-11", "第二天继续"),
        line("d5", "2026-06-11", "第二天又一句"),
        line("d6", "2026-06-11", "第二天再来"),
        line("d7", "2026-06-11", "第二天收尾"),
      ].join("\n"),
      "utf8",
    );
    // 采进库：situation_log 得到 2 条 6-10 + 5 条 6-11 的真实活动
    captureTranscript(db, tpath, { clock: frozenClock("2026-06-11T03:00:00.000Z") });

    const { llm } = mockDigestLlm();
    const findT = () => [{ sessionId: "sess-split", path: tpath }];
    // ① 先消化非重心夜 6-10 → 不该复盘 sess-split
    await runNightlyDigestion(db, {
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      night: "2026-06-10",
      llm,
      config,
      findTranscripts: findT,
    });
    const after10 = db
      .query("SELECT count(*) c FROM experiences WHERE source_session='sess-split' AND kind='self_review'")
      .get() as { c: number };
    expect(after10.c).toBe(0);

    // ② 再消化重心夜 6-11 → 复盘一次，且归属 6-11
    await runNightlyDigestion(db, {
      clock: frozenClock("2026-06-12T03:00:00.000Z"),
      night: "2026-06-11",
      llm,
      config,
      findTranscripts: findT,
    });
    const rows = db
      .query(
        "SELECT date(occurred_at,'+8 hours') d FROM experiences WHERE source_session='sess-split' AND kind='self_review'",
      )
      .all() as { d: string }[];
    expect(rows.length).toBe(1); // 整段只复盘一次，不切片
    expect(rows[0]!.d).toBe("2026-06-11"); // 归重心夜
  });
});

describe("T3.4 人格快照", () => {
  test("改写前快照存在、与新内容有差异、可回滚", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seedNight(db);
    const oldPersona = "# 人格卡\n\n我叫小满。OLD_PERSONA_VERSION 谨慎而好奇。\n";
    writeFileSync(config.personalityPath, oldPersona, "utf8");

    await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm: mockDigestLlm().llm,
      config,
    });

    const snapshotPath = join(
      join(config.personalityPath, "..", "personality.versions"),
      `${NIGHT}.md`,
    );
    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = readFileSync(snapshotPath, "utf8");
    const current = readFileSync(config.personalityPath, "utf8");
    expect(snapshot).toBe(oldPersona); // 快照=改写前原文 → 可回滚
    expect(current).toContain("NEW_PERSONA_VERSION");
    expect(current).not.toBe(snapshot);
  });
});

describe("T3.5 开工不阻塞", () => {
  test("有积压消化时 SessionStart 500ms 内返回注入，消化标记异步出现", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seedNight(db);
    writeFileSync(config.personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");

    let digestionDone: Promise<unknown> | null = null;
    const clock = frozenClock("2026-06-11T01:00:00.000Z"); // 东八区 06-11 09:00，晨间跑 → nightOf=06-10

    const t0 = performance.now();
    const result = prepareSessionStart(db, {
      sessionId: "sess-morning",
      project: null,
      personalityPath: config.personalityPath,
      clock,
      spawnDigestion: () => {
        // 模拟后台进程：异步跑，绝不 await 在主路径上
        digestionDone = runNightlyDigestion(db, {
          clock,
          llm: mockDigestLlm().llm,
          config,
        });
      },
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(500);
    expect(result.text).toContain("<anima-context>");
    expect(result.text).toContain("权限"); // 注入用现有数据立即组装
    expect(result.digestionSpawned).toBe(true);

    // 消化标记随后异步出现
    await digestionDone!;
    const rows = db.query("SELECT count(*) c FROM digest_runs WHERE night = ?").get(NIGHT) as any;
    expect(rows.c).toBe(getDigestStages().length);

    // 第二次开工：积压已清，不再重复拉起
    const again = prepareSessionStart(db, {
      sessionId: "sess-noon",
      project: null,
      personalityPath: config.personalityPath,
      clock,
      spawnDigestion: () => {
        throw new Error("不该被调用");
      },
    });
    expect(again.digestionSpawned).toBe(false);
  });
});

describe("T3.7 真消化冒烟（@live，ANIMA_LIVE=1 手动触发）", () => {
  test.skipIf(!process.env.ANIMA_LIVE)(
    "真跑一次完整夜间消化：日记产出、过验证器",
    async () => {
      const { dbPath, config } = tmpHome();
      const db = openDb(dbPath);
      seedNight(db);
      writeFileSync(config.personalityPath, "# 人格卡\n\n我叫小满。好奇，话不多。\n", "utf8");

      const result = await runNightlyDigestion(db, {
        clock: frozenClock(DIGEST_NOW),
        llm: claudeCli("haiku"),
        config,
      });

      expect(result.stages.closure.status).toBe("done");
      expect(result.stages.diary.status).toBe("done");
      const diary = readFileSync(join(config.diaryDir, `${NIGHT}.md`), "utf8");
      expect(diary.length).toBeGreaterThan(30);
      console.log("=== @live 日记原文 ===\n" + diary);
      console.log("=== @live 人格卡 ===\n" + readFileSync(config.personalityPath, "utf8"));
    },
    300_000,
  );
});

describe("T3.8 夜跑算指纹（Phase 2 语义指纹自动补算）", () => {
  const liveCount = (db: ReturnType<typeof openDb>) =>
    (db.query("SELECT count(*) c FROM experiences WHERE expired_at IS NULL AND invalid_at IS NULL").get() as { c: number }).c;
  const vecCount = (db: ReturnType<typeof openDb>) =>
    (db.query("SELECT count(*) c FROM vec_experiences").get() as { c: number }).c;

  test("传入 embed：vectorize 阶段给当晚所有新记忆补上向量指纹", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seedNight(db);
    // 桩 embed：不碰 ONNX，返回定长确定向量
    const calls: number[] = [];
    const embed = async (texts: string[]) => {
      calls.push(texts.length);
      return texts.map(() => Float32Array.from([0.1, 0.2, 0.3]));
    };

    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm: mockDigestLlm().llm,
      config,
      embed,
    });

    expect(result.stages.vectorize.status).toBe("done");
    const live = liveCount(db);
    expect(live).toBeGreaterThan(0);
    // 全部 live 经历都拿到指纹（含 makeup 自评、消化 digest 行）
    expect(vecCount(db)).toBe(live);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(live);
  });

  test("不传 embed：vectorize 安全空跑（不碰模型、不报错、零向量）——保单测离线", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seedNight(db);

    const result = await runNightlyDigestion(db, {
      clock: frozenClock(DIGEST_NOW),
      llm: mockDigestLlm().llm,
      config,
    });

    expect(result.stages.vectorize.status).toBe("done");
    expect(vecCount(db)).toBe(0);
  });
});
