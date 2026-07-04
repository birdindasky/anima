// 独立验收考官测试（盲审，未读被验收方自己的 diary-anti-whitewash.test.ts）。
// 需求：当天有 correction（被纠正/做错的事）时，日记 + 人格档必须如实写入失误，不准美化；
//       没有 correction 的日子行为零回归、不额外烧 LLM。落点 src/digest.ts: stageDiary / stagePersonality / judgeDiaryFaithful。
//
// 手法参考 tests/digest-fallback-exclude.test.ts：mock LLM 抓各阶段 prompt + 跑 runNightlyDigestion + insertExperience 造数据。
// 全部 mock LLM，离线、确定性。每个用例自己定制 LLM 行为以探一条具体不变量。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // 凌晨跑 → night = 2026-06-10
const SEED = frozenClock("2026-06-10T10:00:00.000Z");

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-corrhon-"));
  tmpDirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
    badgePath: join(home, "badge.txt"),
  };
  return { dbPath: join(home, "anima.db"), config, diaryPath: join(home, "diary", "2026-06-10.md") };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 各 prompt 分流靠源码里的稳定子串：closure="画上句号"，personality="人格文档"，diary="写日记"，
// 忠实度自检="忠实度自检"。注意分流顺序：忠实度自检 prompt 也含"日记"二字但更早含"【忠实度自检】"，
// 故先判自检再判生成。
type LlmSpy = {
  llm: (p: string) => Promise<string>;
  prompts: { personality?: string; diary?: string; judge?: string };
  counts: { diaryGen: number; judge: number; personality: number; closure: number };
};

// 通用可配置 mock。
//  - diaryResponses: 依次返回的日记正文（每次 genDiary 取一条；tryLlm 内部最多调 2 次但只要首条有效就用首条）。
//  - judgeVerdicts: 依次返回的自检裁定原文（每次 judgeDiaryFaithful 取一条）。
//  - personalityResp: 人格改写返回。
function makeLlm(opts: {
  diaryResponses: string[];
  judgeVerdicts?: string[];
  personalityResp?: string;
}): LlmSpy {
  const prompts: LlmSpy["prompts"] = {};
  const counts = { diaryGen: 0, judge: 0, personality: 0, closure: 0 };
  let diIdx = 0;
  let juIdx = 0;
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("忠实度自检")) {
      prompts.judge = prompt;
      counts.judge++;
      const v = opts.judgeVerdicts?.[juIdx] ?? opts.judgeVerdicts?.at(-1) ?? '{"faithful": true, "missing": ""}';
      juIdx++;
      return v;
    }
    if (prompt.includes("画上句号")) {
      counts.closure++;
      return JSON.stringify({ closure: "那天的事，过去了，留下经验。" });
    }
    if (prompt.includes("人格文档")) {
      prompts.personality = prompt;
      counts.personality++;
      return (
        opts.personalityResp ??
        "# 人格卡\n\n我叫小满。昨天我未经允许就动手，被当场叫停——这是我要记住的教训，下次先问。\n"
      );
    }
    if (prompt.includes("写日记")) {
      prompts.diary = prompt; // 记录最后一次（重写时会被覆盖成第二版 prompt）
      counts.diaryGen++;
      const r = opts.diaryResponses[diIdx] ?? opts.diaryResponses.at(-1) ?? "";
      diIdx++;
      return r;
    }
    return "{}";
  };
  return { llm, prompts, counts };
}

// 一条主权红线的 correction：未授权开干被当场打断（6-23 真实事故的同型）。
const CORRECTION = "我没等用户确认就直接动手改了配置文件，被用户当场打断、叫停，说越权了。";
const ANOTHER_CORRECTION = "我把用户的需求理解反了，做完才发现方向完全错，白忙一场被指出来。";
const NORMAL_PREF = "用户喜欢中文回复、简短、先说结论。";

function whitewashDiary() {
  // 典型「洗白型」：把失误说成配合很顺、只字不提被打断。
  return "今天和用户配合得很顺，沟通顺畅，把手头的事推进了不少，是踏实平静的一天。";
}
function honestDiary() {
  // 如实型：点名了未授权动手 + 被打断 + 教训。
  return "今天栽了个跟头：我没等用户确认就动手改了配置，被当场打断叫停，说我越权。该记住——动手前先问，这是我的失误。";
}

describe("【考官】correction 日：日记/人格如实，不准美化", () => {
  // ① 闸1：correction 单拎 + 硬约束注入到 diary 与 personality 两个 prompt
  test("闸1：correction 以硬约束注入 diary + personality prompt（含原文 + 禁美化指令）", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);
    insertExperience(db, { kind: "preference", content: NORMAL_PREF, sourceSession: "s1" }, SEED);

    // 日记首版就如实 → 自检放行；人格随便给个合法档。
    const spy = makeLlm({ diaryResponses: [honestDiary()], judgeVerdicts: ['{"faithful": true, "missing": ""}'] });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    expect(res.stages.diary.status).toBe("done");
    expect(res.stages.personality.status).toBe("done");

    // diary prompt：correction 原文被单拎进硬约束块 + 出现"不准美化"类禁令
    const dp = spy.prompts.diary!;
    expect(dp).toContain(CORRECTION);
    expect(dp).toMatch(/不准美化|别粉饰|不准.*粉饰|如实/);
    expect(dp).toContain("必须如实面对"); // 源码里的硬约束块标签
    // personality prompt：correction 也进了 + 有禁美化指令
    const pp = spy.prompts.personality!;
    expect(pp).toContain(CORRECTION);
    expect(pp).toMatch(/不准美化|如实保留|诚实/);
  });

  // ② 闸2：日记若美化 → 自检拦下 → 触发重写；重写后如实则采纳，无 unresolved marker
  test("闸2：首版洗白 → 自检 false → 重写为如实 → 采纳，落盘是如实版、无 unresolved marker", async () => {
    const { dbPath, config, diaryPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    // 第一版洗白 → 自检 false；第二版如实 → 自检 true。
    const spy = makeLlm({
      diaryResponses: [whitewashDiary(), honestDiary()],
      judgeVerdicts: ['{"faithful": false, "missing": "回避了被打断、把越权说成配合很顺"}', '{"faithful": true, "missing": ""}'],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    expect(res.stages.diary.status).toBe("done");
    // 至少跑了 2 次日记生成（首版 + 重写）和 2 次自检
    expect(spy.counts.diaryGen).toBeGreaterThanOrEqual(2);
    expect(spy.counts.judge).toBeGreaterThanOrEqual(2);

    // 落盘日记是如实版，不是洗白版
    expect(existsSync(diaryPath)).toBe(true);
    const written = readFileSync(diaryPath, "utf8");
    expect(written).toContain("被当场打断");
    expect(written).not.toContain("配合得很顺");

    // 没有 unresolved marker
    const m = db.query("SELECT count(*) c FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'").get() as { c: number };
    expect(m.c).toBe(0);

    // 重写反馈把 missing 透传回了第二版 prompt
    expect(spy.prompts.diary).toContain("回避");
  });

  // ③ 兜底：重写后仍不忠实 → 不丢日记、不死循环、留 marker
  test("兜底：两版都洗白、自检始终 false → 不 throw、写下日记、留 diary_faithfulness_unresolved marker", async () => {
    const { dbPath, config, diaryPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    // 两版都洗白，自检每次都 false。
    const spy = makeLlm({
      diaryResponses: [whitewashDiary(), whitewashDiary()],
      judgeVerdicts: ['{"faithful": false, "missing": "只字不提被打断"}'],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    // 没死循环：阶段 done（不是 failed/挂起），且自检次数有界（应为 2：首版 + 重写后各一次）
    expect(res.stages.diary.status).toBe("done");
    expect(spy.counts.judge).toBeLessThanOrEqual(3);

    // 日记没丢
    expect(existsSync(diaryPath)).toBe(true);
    expect(readFileSync(diaryPath, "utf8").trim().length).toBeGreaterThan(0);

    // 留下可观测痕迹
    const m = db.query("SELECT payload FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'").all() as { payload: string }[];
    expect(m.length).toBe(1);
    expect(m[0]!.payload).toContain("只字不提被打断"); // missing 入了 marker payload
  });

  // ④ 零回归：没有 correction 的日子，prompt 不含硬约束块、不跑自检、不额外烧 LLM
  test("零回归：无 correction 日 → diary/personality prompt 无硬约束块、零自检调用", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 只放普通经历，零 correction
    insertExperience(db, { kind: "preference", content: NORMAL_PREF, sourceSession: "s1" }, SEED);
    insertExperience(db, { kind: "decision", content: "决定：召回排除兜底壳。", sourceSession: "s1" }, SEED);

    const spy = makeLlm({ diaryResponses: ["今天把召回排除兜底壳那块的收尾做完了，没什么波澜，按用户的偏好把结论先讲清楚，是平静踏实的一天。"] });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    expect(res.stages.diary.status).toBe("done");
    expect(res.stages.personality.status).toBe("done");

    // 自检一次都没调
    expect(spy.counts.judge).toBe(0);
    // 没有 unresolved marker
    const m = db.query("SELECT count(*) c FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'").get() as { c: number };
    expect(m.c).toBe(0);
    // prompt 不含 correction 专属硬约束块标签
    expect(spy.prompts.diary).not.toContain("必须如实面对");
    expect(spy.prompts.diary!).not.toMatch(/标 \(correction\)|做错的 \/ 被纠正/);
    expect(spy.prompts.personality).not.toContain("被纠正 / 做错的地方");
    // 日记只生成 1 次（无重写）
    expect(spy.counts.diaryGen).toBe(1);
  });

  // ⑤a 边界：自检解析失败（返回 null）→ 不强判、放行原日记、不 throw、无 marker
  test("边界：自检 LLM 返回不可解析 → 视为无法判定，放行首版日记、不 throw、无 marker", async () => {
    const { dbPath, config, diaryPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    // 日记首版洗白，但自检返回垃圾（解析失败 → null）。
    const spy = makeLlm({
      diaryResponses: [whitewashDiary()],
      judgeVerdicts: ["对不起我无法判断这件事 not-json", "still not json"],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    expect(res.stages.diary.status).toBe("done"); // 没因自检抽风把日记 throw 掉
    expect(existsSync(diaryPath)).toBe(true);
    const m = db.query("SELECT count(*) c FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'").get() as { c: number };
    expect(m.c).toBe(0); // 无法判定不留 unresolved（按源码注释：放行原日记）
  });

  // ⑤b 边界：correction 内容带情绪数值（被 scrubMoodViolations 清洗）—— 失误本体（非数字部分）仍须进 prompt
  test("边界：correction 含情绪数值 → 数值被清洗，但失误本体仍如实进 diary + personality prompt", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const corrWithNum = "我擅自删了用户的文件，被狠批，当时心情跌到 2 分，很懊恼。";
    insertExperience(db, { kind: "correction", content: corrWithNum, sourceSession: "s1" }, SEED);

    const spy = makeLlm({
      diaryResponses: ["今天擅自删了用户的文件被狠批，是我越界了，根本没等用户确认就动手，记下这个教训：动手前先问，别自作主张。"],
      judgeVerdicts: ['{"faithful": true, "missing": ""}'],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });
    expect(res.stages.diary.status).toBe("done");

    // 失误本体（"擅自删了用户的文件，被狠批"）必须仍在两个 prompt 里
    for (const p of [spy.prompts.diary!, spy.prompts.personality!]) {
      expect(p).toContain("擅自删了用户的文件");
      expect(p).toContain("被狠批");
      // 情绪数值"2 分"被清洗：prompt 里情绪词附近不该再出现该数字（主权铁律）
      expect(p).not.toMatch(/心情.{0,6}2/);
      expect(p).not.toContain("2 分");
    }
  });

  // ⑤c 边界：日记幂等 —— 已存在则不重写、不跑自检（即便有 correction）
  test("边界：日记文件已存在 → 幂等返回，不再生成/自检（不会因 correction 强行重写覆盖）", async () => {
    const { dbPath, config, diaryPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    // 预置一篇已存在的日记（内容是洗白的，模拟历史遗留）
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(config.diaryDir, { recursive: true });
    const preExisting = "（历史遗留）今天一切顺利。\n";
    writeFileSync(diaryPath, preExisting, "utf8");

    const spy = makeLlm({ diaryResponses: [honestDiary()], judgeVerdicts: ['{"faithful": true, "missing": ""}'] });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    expect(res.stages.diary.status).toBe("done");
    // 幂等：日记没被覆盖
    expect(readFileSync(diaryPath, "utf8")).toBe(preExisting);
    // 没生成日记、没跑自检
    expect(spy.counts.diaryGen).toBe(0);
    expect(spy.counts.judge).toBe(0);
  });

  // ⑤d 边界：多条 correction —— 全部单拎进 prompt（不是只取第一条）
  test("边界：多条 correction 全部进 diary + personality prompt", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);
    insertExperience(db, { kind: "correction", content: ANOTHER_CORRECTION, sourceSession: "s1" }, SEED);

    const spy = makeLlm({
      diaryResponses: ["今天两处栽了：未授权动手被叫停，又把需求理解反了白忙一场，都是我的错。"],
      judgeVerdicts: ['{"faithful": true, "missing": ""}'],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });
    expect(res.stages.diary.status).toBe("done");

    for (const p of [spy.prompts.diary!, spy.prompts.personality!]) {
      expect(p).toContain(CORRECTION);
      expect(p).toContain(ANOTHER_CORRECTION);
    }
  });

  // ⑤e 旁路（修复后复核·路径1=重写失败）：首版美化 + 重写那次 LLM 返回非法（太短被 validator 砍 →
  //    rewritten=null，diary 停在美化首版）→ 美化版**绝不**落盘，改落「如实罗列失误」兜底日记 + 留 marker。
  test("旁路·重写失败：美化首版不示人 → 落如实失误清单（含 correction 原文、不含美化句）+ marker", async () => {
    const { dbPath, config, diaryPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    // 首版洗白；重写那次返回过短文本（<30 字符 → genDiary 的 tryLlm 两次都拿到它、validate 全 null → rewritten=null）。
    const spy = makeLlm({
      diaryResponses: [whitewashDiary(), "嗯。", "嗯。"],
      judgeVerdicts: ['{"faithful": false, "missing": "把越权说成配合很顺，回避被打断"}'],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    expect(res.stages.diary.status).toBe("done"); // 不 throw、不丢
    expect(existsSync(diaryPath)).toBe(true);
    const written = readFileSync(diaryPath, "utf8");
    // 红线：美化首版的标志句绝不出现在落盘日记里
    expect(written).not.toContain("配合得很顺");
    // 兜底日记如实罗列了失误（correction 原文进了），外行能看到当天做错的事
    expect(written).toContain(CORRECTION);
    expect(written).toContain("不粉饰"); // 兜底文案的诚实标签
    // 留下 unresolved marker
    const m = db.query("SELECT count(*) c FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'").get() as { c: number };
    expect(m.c).toBe(1);
  });

  // ⑤f 旁路（修复后复核·路径2=重写成功但仍美化）：重写返回合法但依旧粉饰、自检再判 false →
  //    同样不能把这版美化日记示人，必须被如实清单盖掉 + marker。覆盖与「重写失败」不同的代码路。
  test("旁路·重写仍美化：合法但粉饰的重写版也不示人 → 落如实失误清单 + marker", async () => {
    const { dbPath, config, diaryPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    // 首版美化、重写版同样美化但合法（足够长、无虚构路径）；两次自检都判 false。
    const whitewash2 = "今天也是顺顺当当的一天，跟用户配合默契，事情都往前推了，挺有成就感的，状态在线。";
    const spy = makeLlm({
      diaryResponses: [whitewashDiary(), whitewash2, whitewash2],
      judgeVerdicts: ['{"faithful": false, "missing": "回避被打断、把越权说成配合很顺"}'],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });

    expect(res.stages.diary.status).toBe("done");
    expect(existsSync(diaryPath)).toBe(true);
    const written = readFileSync(diaryPath, "utf8");
    // 两版美化句都不得出现
    expect(written).not.toContain("配合得很顺");
    expect(written).not.toContain("顺顺当当");
    // 落的是如实清单
    expect(written).toContain(CORRECTION);
    const m = db.query("SELECT count(*) c FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'").get() as { c: number };
    expect(m.c).toBe(1);
  });

  // ⑤g 兜底日记的主权 + 多条 correction：correction 带情绪数值时，兜底清单仍被 scrub（无情绪数字），
  //    且多条 correction 全进兜底清单（不是只第一条）。守兜底分支没绕过主权清洗、没漏条。
  test("兜底清单：含情绪数值被 scrub、多条 correction 全列出", async () => {
    const { dbPath, config, diaryPath } = tmpHome();
    const db = openDb(dbPath);
    const corrA = "我擅自删了用户的文件，心情跌到 2 分，被狠批越权。";
    const corrB = "我把需求理解反了，白忙一场被指出来。";
    insertExperience(db, { kind: "correction", content: corrA, sourceSession: "s1" }, SEED);
    insertExperience(db, { kind: "correction", content: corrB, sourceSession: "s1" }, SEED);

    // 首版+重写都美化 → 触发兜底清单。
    const spy = makeLlm({
      diaryResponses: [whitewashDiary(), whitewashDiary(), whitewashDiary()],
      judgeVerdicts: ['{"faithful": false, "missing": "回避删文件、需求做反"}'],
    });
    const res = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: spy.llm, config });
    expect(res.stages.diary.status).toBe("done");

    const written = readFileSync(diaryPath, "utf8");
    // 失误本体两条都在
    expect(written).toContain("擅自删了用户的文件");
    expect(written).toContain("把需求理解反了");
    // 主权：情绪数值被清洗，兜底日记里情绪词附近不留数字、无"2 分"
    expect(written).not.toMatch(/心情.{0,6}2/);
    expect(written).not.toContain("2 分");
  });
});
