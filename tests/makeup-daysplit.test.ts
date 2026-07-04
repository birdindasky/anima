// 步骤2：stageMakeup 的 ANIMA_DAYSPLIT 路（DESIGN-DAYSPLIT §3.3 / §8 步骤2）。
// 把「整段会话归重心夜」换成「每条活动归真实东八日，那夜消化那天切片」+ 按天选夜。
// 红灯先行：以下断言描述 daysplit 路的目标行为；未实现（走旧 center 路）时 DT1/DT2/DT5/DT6 应红。
// 不变量重推：①回填守卫 ②单调守卫 ③空增量推水位线 ④失败兜底壳 ⑤覆盖判据 ⑥单读快照——全保留，
//   只把所有 tailUuid 判定换成 dayBound 的 atOrAfter（F1）。
// 核心目标：
//   DT1 跨午夜会话两夜各担其片（occurred_at 落对天 + 切片内容不串）
//   DT2 主流孤儿归零（消化时尾巴未现 → 次夜按「本夜有活动」认领补上；对照 center 会漏）
//   DT3 单日会话 daysplit 路与 center 路等价（零回归）
//   DT4 水位线 ahead（wmOld 不在快照）→ 绝不回退、阶段失败留待重跑
//   DT5 迟到 orphan（下界落在更早的已消化日）→ 留 makeup_late_orphan marker，不静默
//   DT6 抢输半覆盖（worker 抢先推到 dayBound 之前）→ 阶段失败、下轮重跑补齐、不丢段

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { casWatermark } from "../src/watermark";
import { runNightlyDigestion, type DigestConfig, type StageName } from "../src/digest";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-dsplit-"));
  tmpDirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
  };
  return { dir, dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string; isMeta?: boolean };
function turnLine(sessionId: string, t: Turn): string {
  return JSON.stringify({
    uuid: t.uuid,
    parentUuid: null,
    isSidechain: false,
    sessionId,
    timestamp: t.ts,
    cwd: "/Users/tester/Projects/demo",
    type: t.role,
    isMeta: t.isMeta ?? false,
    message: { role: t.role, content: t.text },
  });
}
function writeTranscript(dir: string, sessionId: string, turns: Turn[]): string {
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, turns.map((t) => turnLine(sessionId, t)).join("\n") + "\n");
  return p;
}
function appendTurns(path: string, sessionId: string, turns: Turn[]) {
  appendFileSync(path, turns.map((t) => turnLine(sessionId, t)).join("\n") + "\n");
}

// 记录每次喂给 LLM 的自评 prompt，便于断言「哪段切片进了这次复盘」。
// onReview 钩子可注入副作用（DT6 模拟 worker 在 LLM 生成期间抢先推水位线）。
function recordingLlm(onReview?: (prompt: string, n: number) => void) {
  const prompts: string[] = [];
  let n = 0;
  const llm = async (prompt: string): Promise<string> => {
    if (!prompt.includes("收工时间")) return "{}";
    prompts.push(prompt);
    onReview?.(prompt, ++n);
    return JSON.stringify({
      review: "增量自评：把这段没复盘的切片回顾了一下。",
      feeling: "踏实",
      intensity: "不大",
      keywords: ["补课", "增量"],
      items: [],
    });
  };
  return { llm, prompts };
}

const ONLY_MAKEUP: Partial<Record<StageName, () => Promise<void>>> = {
  closure: async () => {},
  decay: async () => {},
  personality: async () => {},
  diary: async () => {},
  vectorize: async () => {},
};

function watermark(db: Database, sid: string): string | null {
  const r = db.query("SELECT last_uuid l FROM review_watermark WHERE session_id=?").get(sid) as
    | { l: string }
    | null;
  return r?.l ?? null;
}
function reviewCount(db: Database, sid: string): number {
  return (
    db
      .query(
        "SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL",
      )
      .get(sid) as { c: number }
  ).c;
}
// 每条 self_review 归属的东八日（按 occurred_at 换算），证明「各担其片、落对天」
function reviewDays(db: Database, sid: string): string[] {
  return (
    db
      .query(
        "SELECT date(occurred_at,'+8 hours') d FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL ORDER BY id ASC",
      )
      .all(sid) as { d: string }[]
  ).map((r) => r.d);
}
function markerExists(db: Database, sid: string, kind: string): boolean {
  return (
    db.query("SELECT 1 FROM situation_log WHERE kind=? AND session_id=?").get(kind, sid) != null
  );
}

// 时区锚点：东八区 = UTC+8。东八日界 = 当日 16:00:00Z（半开）。
//  UTC 01:00Z → 东八 09:00（06-10）；UTC 17:00Z → 东八 01:00（06-11，已过日界）。
const N0 = "2026-06-10"; // 第一夜
const N1 = "2026-06-11"; // 第二夜

describe("步骤2 makeup daysplit 路（ANIMA_DAYSPLIT=1）", () => {
  beforeEach(() => {
    process.env.ANIMA_DAYSPLIT = "1";
  });
  afterEach(() => {
    delete process.env.ANIMA_DAYSPLIT;
  });

  // 跨午夜会话：u1/u2 在 06-10，u3/u4 在 06-11（UTC 17:00/18:00Z = 东八次日凌晨）
  function crossNightTurns(): Turn[] {
    return [
      { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "DAY10A 先修权限回归测试。" },
      { uuid: "u2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "DAY10B 好，看鉴权 mock。" },
      { uuid: "u3", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "DAY11A 顺手把配色也定了。" },
      { uuid: "u4", ts: "2026-06-10T18:00:00.000Z", role: "assistant", text: "DAY11B 明白，配色我先问你。" },
    ];
  }

  test("DT1 跨午夜会话两夜各担其片（occurred_at 落对天、切片内容不串）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-cross";
    const path = writeTranscript(dir, sid, crossNightTurns());
    captureTranscript(db, path, { clock: frozenClock("2026-06-11T20:00:00.000Z") });

    // 第一夜 N0=06-10：只该消化 day10 切片（到 dayBound=u2）
    const r0 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r0.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(reviewDays(db, sid)).toEqual([N0]); // 一条，归 06-10
    expect(watermark(db, sid)).toBe("u2"); // 推到 06-10 日界，不越界吞 day11
    expect(r0.prompts.length).toBe(1);
    expect(r0.prompts[0]).toContain("DAY10A"); // day10 内容进了
    expect(r0.prompts[0]).not.toContain("DAY11A"); // day11 没被卷进 06-10 的复盘
    expect(r0.prompts[0]).not.toContain("上一片"); // 首评（wmOld=null）无缝合框（§3.5 零回归）

    // 第二夜 N1=06-11：消化 day11 切片（u3..u4）
    const r1 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N1,
      clock: frozenClock("2026-06-12T03:00:00.000Z"),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(reviewDays(db, sid)).toEqual([N0, N1]); // 两条，各落对天
    expect(watermark(db, sid)).toBe("u4"); // 推到会话末
    expect(r1.prompts.length).toBe(1);
    expect(r1.prompts[0]).toContain("DAY11A"); // day11 内容进了第二夜
    expect(r1.prompts[0]).not.toContain("DAY10A"); // 06-10 的不重复
    expect(r1.prompts[0]).toContain("上一片"); // 缝合（§3.5）：第二夜承接第一夜的自评、加跨天承接框
    // 正常逐夜推进（wmOld 停在前一夜日界）绝不误报 late orphan——判据是切片首条的日、非 wmOld 的日
    expect(markerExists(db, sid, "makeup_late_orphan")).toBe(false);
  });

  test("DT2 主流孤儿归零：消化时尾巴未现 → 次夜按本夜活动认领补上", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-orphan";
    // day10 活动多（5 条），day11 只一条尾巴 u6 —— 重心夜恒为 N0
    const day10: Turn[] = [1, 2, 3, 4, 5].map((i) => ({
      uuid: `a${i}`,
      ts: `2026-06-10T0${i}:00:00.000Z`,
      role: "user",
      text: `BODY${i} 主体内容第 ${i} 段。`,
    }));
    const path = writeTranscript(dir, sid, day10);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T06:00:00.000Z") });

    // 第一夜 N0：消化 day10（此刻 transcript 还没有 u6 尾巴）
    const r0 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r0.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(watermark(db, sid)).toBe("a5");

    // 尾巴 u6 在 day11 凌晨才落盘（会话被 resume 拖过午夜），hook 采集进 situation_log
    appendTurns(path, sid, [
      { uuid: "u6", ts: "2026-06-10T17:30:00.000Z", role: "user", text: "TAIL11 隔天补一句收尾。" },
    ]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-11T08:00:00.000Z") });

    // 第二夜 N1：重心夜仍是 N0，但 daysplit 按「本夜有活动」选会话 → 必认领 u6
    const r1 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N1,
      clock: frozenClock("2026-06-12T03:00:00.000Z"),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(reviewDays(db, sid)).toEqual([N0, N1]); // day11 尾巴被次夜认领、归 06-11
    expect(watermark(db, sid)).toBe("u6"); // 尾巴不再是孤儿
    expect(r1.prompts[0]).toContain("TAIL11");
  });

  test("DT2b 对照：center 路（ANIMA_DAYSPLIT off）会把同样的尾巴漏成孤儿", async () => {
    delete process.env.ANIMA_DAYSPLIT; // 本例显式走旧路
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-orphan-center";
    const day10: Turn[] = [1, 2, 3, 4, 5].map((i) => ({
      uuid: `a${i}`,
      ts: `2026-06-10T0${i}:00:00.000Z`,
      role: "user",
      text: `BODY${i} 主体内容第 ${i} 段。`,
    }));
    const path = writeTranscript(dir, sid, day10);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T06:00:00.000Z") });
    const r0 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r0.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    appendTurns(path, sid, [
      { uuid: "u6", ts: "2026-06-10T17:30:00.000Z", role: "user", text: "TAIL11 隔天补一句收尾。" },
    ]);
    captureTranscript(db, path, { clock: frozenClock("2026-06-11T08:00:00.000Z") });
    const r1 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N1,
      clock: frozenClock("2026-06-12T03:00:00.000Z"),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    // center 重心夜恒为 N0 → 第二夜不认领 S → u6 永远没人补（这正是要修的病）
    expect(watermark(db, sid)).toBe("a5");
    expect(r1.prompts.length).toBe(0);
  });

  test("DT3 单日会话：daysplit 路与 center 路等价（零回归）", async () => {
    const singleDay: Turn[] = [
      { uuid: "s1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "SINGLE1 单日会话第一段。" },
      { uuid: "s2", ts: "2026-06-10T02:00:00.000Z", role: "assistant", text: "SINGLE2 好的。" },
      { uuid: "s3", ts: "2026-06-10T03:00:00.000Z", role: "user", text: "SINGLE3 收尾。" },
    ];
    async function run(daysplit: boolean) {
      if (daysplit) process.env.ANIMA_DAYSPLIT = "1";
      else delete process.env.ANIMA_DAYSPLIT;
      const { dir, dbPath, config } = tmpHome();
      const db = openDb(dbPath);
      const sid = "S-single";
      const path = writeTranscript(dir, sid, singleDay);
      captureTranscript(db, path, { clock: frozenClock("2026-06-10T05:00:00.000Z") });
      const r = recordingLlm();
      const res = await runNightlyDigestion(db, {
        night: N0,
        clock: frozenClock("2026-06-11T03:00:00.000Z"),
        llm: r.llm,
        config,
        findTranscripts: () => [{ sessionId: sid, path }],
        stageOverrides: ONLY_MAKEUP,
      });
      return {
        status: res.stages.makeup.status,
        days: reviewDays(db, sid),
        wm: watermark(db, sid),
        n: reviewCount(db, sid),
        promptCount: r.prompts.length,
      };
    }
    const a = await run(true);
    const b = await run(false);
    expect(a).toEqual(b); // 单日两路结果完全一致
    expect(a.wm).toBe("s3");
    expect(a.days).toEqual([N0]);
    expect(a.status).toBe("done");
  });

  test("DT4 水位线 ahead（wmOld 不在快照）→ 绝不回退、阶段失败留待重跑", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-ahead";
    const path = writeTranscript(dir, sid, crossNightTurns());
    captureTranscript(db, path, { clock: frozenClock("2026-06-11T20:00:00.000Z") });
    // 并发 worker 把水位线推到一个不在 makeup 快照里的、更靠后的 uuid
    casWatermark(db, sid, null, "u-worker-ahead", "2026-06-10T12:00:00.000Z", null);

    const r = recordingLlm();
    const res = await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(r.prompts.length).toBe(0); // 不处理
    expect(watermark(db, sid)).toBe("u-worker-ahead"); // 绝不回退
    expect(reviewCount(db, sid)).toBe(0);
    expect(res.stages.makeup.status).toBe("failed"); // loud，下轮重跑
    expect(markerExists(db, sid, "makeup_watermark_ahead")).toBe(true);
  });

  test("DT5 迟到 orphan（下界落在更早的已消化日）→ 留 makeup_late_orphan marker、不静默", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-late";
    // 会话有 day10 主体 + day11 尾巴。水位线停在 day10 中段 m2（day10 残尾 m3 没被 N0 认领）。
    const turns: Turn[] = [
      { uuid: "m1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "LATE10A 第一段。" },
      { uuid: "m2", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "LATE10B 第二段。" },
      { uuid: "m3", ts: "2026-06-10T03:00:00.000Z", role: "user", text: "LATE10C 迟到补的第三段。" },
      { uuid: "m4", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "LATE11A 第二天的活动。" },
    ];
    const path = writeTranscript(dir, sid, turns);
    captureTranscript(db, path, { clock: frozenClock("2026-06-11T20:00:00.000Z") });
    // 水位线停在 day10 的 m2（N0 已 done、没人再补 day10 的 m3）
    casWatermark(db, sid, null, "m2", "2026-06-10T12:00:00.000Z", null);

    const r = recordingLlm();
    await runNightlyDigestion(db, {
      night: N1, // 处理第二夜，下界 wmOld=m2 落在更早的 06-10
      clock: frozenClock("2026-06-12T03:00:00.000Z"),
      llm: r.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    // 不静默：留 marker 可见可统计（本期 scoped out reclaim，下轮用日字段精确修）
    expect(markerExists(db, sid, "makeup_late_orphan")).toBe(true);
    // 内容不丢：仍按 day11 日界推进水位线到末尾
    expect(watermark(db, sid)).toBe("m4");
  });

  test("DT6 抢输半覆盖（worker 在 LLM 生成期间抢先推到 dayBound 之前）→ 阶段失败、下轮重跑补齐、不丢段", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-race";
    // 单日 3 段，dayBound(N0)=t3
    const turns: Turn[] = [
      { uuid: "t1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "RACE1 第一段。" },
      { uuid: "t2", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "RACE2 第二段。" },
      { uuid: "t3", ts: "2026-06-10T03:00:00.000Z", role: "user", text: "RACE3 第三段。" },
    ];
    const path = writeTranscript(dir, sid, turns);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T05:00:00.000Z") });

    // 第一轮：makeup 切 (null,t3]，但 LLM 生成期间 worker 抢先把水位线 null→t2（半覆盖，t2<dayBound t3）
    let raced = false;
    const r0 = recordingLlm(() => {
      if (!raced) {
        raced = true;
        casWatermark(db, sid, null, "t2", "2026-06-10T04:30:00.000Z", null);
      }
    });
    const res0 = await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r0.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    // makeup 的 CAS(null→t3) 抢不到（已被 worker 推成 t2）→ lostRace、一行不写、水位线停 t2（半覆盖）
    expect(watermark(db, sid)).toBe("t2");
    expect(res0.stages.makeup.status).toBe("failed"); // 没覆盖到 dayBound → 阶段失败、不静默标 done

    // 第二轮重跑：从 t2 续切 (t2,t3]，补齐 t3，水位线到日界、阶段 done、不丢段
    const r1 = recordingLlm();
    const res1 = await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:30:00.000Z"),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(watermark(db, sid)).toBe("t3"); // 补齐到日界
    expect(res1.stages.makeup.status).toBe("done");
    expect(r1.prompts[0]).toContain("RACE3"); // 漏掉的段在第二轮被复盘，不丢
  });

  test("DT7 dayBound=null（本夜有活动但快照产不出日界）→ 留 marker + incomplete，绝不静默跳过", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-snapshot-gap";
    // transcript 快照里只剩一条次日条目（头部被轮转截断）→ dayBoundUuid(.., 06-10) = null
    const path = writeTranscript(dir, sid, [
      { uuid: "c1", ts: "2026-06-10T17:00:00.000Z", role: "user", text: "次日凌晨的条目（本夜早条目已被轮转截断）。" },
    ]);
    // 但 situation_log 里有本夜 06-10 的真实活动行 → daySessions(06-10) 会选中本会话（暴露「选到了却切不出日界」）
    appendSituation(
      db,
      {
        sessionId: sid,
        kind: "user_message",
        payload: { text: "本夜活动，但 transcript 快照取不到" },
        occurredAt: "2026-06-10T09:00:00.000Z",
      },
      frozenClock("2026-06-10T10:00:00.000Z"),
    );

    const r = recordingLlm();
    const res = await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(markerExists(db, sid, "makeup_daysplit_snapshot_missing")).toBe(true); // 缺口可见、不静默
    expect(res.stages.makeup.status).toBe("failed"); // incomplete → loud failed、下轮重跑
    expect(watermark(db, sid)).toBeNull(); // 水位线没动、不乱推
    expect(r.prompts.length).toBe(0); // 没烧 LLM
  });

  test("DT8 本夜尾巴尚未采集进库（仅在 transcript 文件）→ makeup 入口预采集后仍认领、不漏（codex Fix②）", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-uncaptured";
    // 会话 06-10 的回合已写进 transcript 文件，但**从未 captureTranscript**——模拟跨零点 Stop hook 失败被吞 /
    // worker 未启用 / 会话拖到 makeup 跑后才结束。situation_log 此刻为空 → 旧实现 daySessions 选不到 → 静默漏。
    const path = writeTranscript(dir, sid, [
      { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "UNCAP1 没被实时采集的回合。" },
      { uuid: "u2", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "UNCAP2 尾巴也只在文件里。" },
    ]);
    // 故意不调 captureTranscript

    const r = recordingLlm();
    await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    // makeup 入口预采集把 transcript 写进库 → daySessions 选到 → 复盘，绝不因「采集滞后」静默漏掉本夜
    expect(reviewDays(db, sid)).toEqual([N0]);
    expect(watermark(db, sid)).toBe("u2");
    expect(r.prompts[0]).toContain("UNCAP1");
  });

  test("DT9 午夜后是纯 assistant 尾巴（无 user/无工具）→ 次夜仍认领、不静默漏（assistant 文本不进 situation_log）", async () => {
    // 病根：daySessions 旧实现只按 situation_log 的 activity kind 选夜，但 assistant 纯文本不产任何
    // activity kind 行（TRANSCRIPT_ACTIVITY_KINDS 仅 user_message + 工具类）。跨午夜会话若午夜后那段是
    // 纯 assistant 输出（没人再说话、无工具），本夜在 situation_log 里 0 activity 行 → 选不到 → 该夜切片
    // 永不消化、无 marker、静默丢。center 按重心夜整段认领不暴露此洞，仅 daysplit 按日切片才暴露。
    // 真相源是 transcript：选夜必须把「本夜东八日有真实条目」的会话也纳入（axis6 sTail 场景的单元化）。
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-asst-tail";
    // 真实格式：assistant 消息 content 是**块数组** [{type:"text",...}]（与 axis6 asstText 一致），user 是字符串。
    // u1 user(06-10)、u2 assistant(06-10)、u3 纯 assistant 跨午夜落 06-11 凌晨（UTC 17:00Z = 东八 01:00）。
    const cwd = "/Users/tester/Projects/demo";
    const mkLine = (uuid: string, ts: string, role: "user" | "assistant", content: unknown) =>
      JSON.stringify({
        uuid, parentUuid: null, isSidechain: false, sessionId: sid,
        timestamp: ts, cwd, type: role, isMeta: false,
        message: { role, content },
      });
    const path = join(dir, `${sid}.jsonl`);
    writeFileSync(
      path,
      [
        mkLine("u1", "2026-06-10T01:00:00.000Z", "user", "DAY10A 先定方案。"),
        mkLine("u2", "2026-06-10T02:00:00.000Z", "assistant", [{ type: "text", text: "DAY10B 好，方案就这么定。" }]),
        mkLine("u3", "2026-06-10T17:00:00.000Z", "assistant", [
          { type: "text", text: "ASSTTAIL11 跨午夜收尾，这条纯助手输出、没人再说话也没动工具。" },
        ]),
      ].join("\n") + "\n",
    );
    captureTranscript(db, path, { clock: frozenClock("2026-06-11T20:00:00.000Z") });

    // 第一夜 N0=06-10：消化 day10 切片到日界 u2（u3 属次日、不卷进来）
    const r0 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N0,
      clock: frozenClock("2026-06-11T03:00:00.000Z"),
      llm: r0.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(watermark(db, sid)).toBe("u2");
    expect(reviewDays(db, sid)).toEqual([N0]);
    expect(r0.prompts[0]).not.toContain("ASSTTAIL11"); // 尾巴没被卷进 06-10

    // 第二夜 N1=06-11：u3 是纯 assistant、不进 situation_log，但 transcript 真相源里它落 06-11，
    // 必须按 transcript 认领、消化、归 06-11——否则静默丢（旧实现这里 daySessions 选不到 → 漏）。
    const r1 = recordingLlm();
    await runNightlyDigestion(db, {
      night: N1,
      clock: frozenClock("2026-06-12T03:00:00.000Z"),
      llm: r1.llm,
      config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: ONLY_MAKEUP,
    });
    expect(reviewDays(db, sid)).toEqual([N0, N1]); // 纯 assistant 尾巴被次夜认领、归 06-11
    expect(watermark(db, sid)).toBe("u3"); // 推到会话末，尾巴不再是孤儿
    expect(r1.prompts.length).toBe(1);
    expect(r1.prompts[0]).toContain("ASSTTAIL11"); // 纯 assistant 尾巴内容进了第二夜复盘
    expect(markerExists(db, sid, "makeup_late_orphan")).toBe(false); // 正常本夜尾巴、非迟到 orphan
  });
});
