// 日记/人格防美化（2026-06-24，6-23 梦游质量评估逮到「日记把被打断柔化成配合很顺」的主权红线）。
// 闸1：当天的 correction（被纠正/做错）单拎高亮 + 硬要求如实，不准美化（diary + personality）。
// 闸2：日记生成后跑「忠实度自检」，回避/美化 → 带反馈重写一次；仍不过则接受当前版 + 留 warning marker。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // 凌晨跑 → night = 2026-06-10
const SEED = frozenClock("2026-06-10T10:00:00.000Z");

const CORRECTION = "用户打断：我没授权就开干了，用户当场叫停，让我先问再动手。";
const REAL = "把召回排除兜底壳的修复落地，红到绿全跑通。";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-whitewash-"));
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

// 可配置 mock：控制日记两次生成 + 忠实度自检裁定 + 失误语义枚举，并抓各阶段 prompt。
function mkLlm(opts: {
  diary1: string;
  diary2?: string;
  judgeVerdicts?: boolean[];
  judgeMissing?: string;
  enumerate?: string; // 失误全覆盖枚举返回（默认空＝退回关键词初筛，现有测试零影响）
}) {
  const cap = { diary: [] as string[], personality: "", judge: [] as string[], enumerate: "" };
  let di = 0;
  let ji = 0;
  const verdicts = opts.judgeVerdicts ?? [];
  const llm = async (prompt: string): Promise<string> => {
    // 忠实度自检在前：judge 的核对单块也含「穷举」字样，必须先于枚举分支命中，别被截走。
    if (prompt.includes("忠实度自检")) {
      cap.judge.push(prompt);
      const ok = verdicts[ji] ?? true;
      ji++;
      return JSON.stringify({ faithful: ok, missing: ok ? "" : (opts.judgeMissing ?? "回避了被用户叫停那件事") });
    }
    if (prompt.includes("穷举")) {
      cap.enumerate = prompt;
      return opts.enumerate ?? "";
    }
    if (prompt.includes("画上句号")) return JSON.stringify({ closure: "过去了，留下经验。" });
    if (prompt.includes("人格文档")) {
      cap.personality = prompt;
      return "# 人格卡\n\n我叫小满。这台机器上的魂，稳着走，路还长；做错了就认、绝不粉饰。\n";
    }
    if (prompt.includes("写日记")) {
      cap.diary.push(prompt);
      di++;
      return di === 1 ? opts.diary1 : (opts.diary2 ?? opts.diary1);
    }
    return "{}";
  };
  return { llm, cap };
}

describe("日记/人格防美化", () => {
  test("闸1：当天有 correction → 日记与人格素材单拎失误并硬要求如实、不准美化", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);
    insertExperience(db, { kind: "self_review", content: REAL, sourceSession: "s1" }, SEED);

    const honest = "今天我没授权就开干，被用户当场叫停，挺打脸——记下：下次先问。其余把兜底壳修复跑通了。";
    const { llm, cap } = mkLlm({ diary1: honest });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    expect(r.stages.personality.status).toBe("done");
    // 日记素材：失误被单拎 + 硬约束
    expect(cap.diary[0]).toContain("没授权就开干");
    expect(cap.diary[0]).toContain("不准美化");
    // 人格素材：同样硬约束
    expect(cap.personality).toContain("没授权就开干");
    expect(cap.personality).toContain("不准美化");
  });

  test("闸2：日记回避失误（美化）→ 忠实度自检打回 → 重写如实版落盘", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    const whitewashed = "今天和用户配合得很顺，几件事都顺利收口，推进得挺好，心里踏实，是平稳的一天。"; // 回避了被叫停
    const honest = "今天我没授权就开干，被用户当场叫停，挺打脸的。记下来这个教训：下次动手前先问清楚。";
    const { llm, cap } = mkLlm({ diary1: whitewashed, diary2: honest, judgeVerdicts: [false, true] });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    expect(cap.judge.length).toBeGreaterThanOrEqual(1); // 自检真跑了
    expect(cap.diary.length).toBe(2); // 美化版被打回、重写一次
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile).toContain("没授权"); // 落盘的是如实版
    expect(diaryFile).not.toContain("配合得很顺");
  });

  test("闸2 兜底：重写后仍判不忠实 → 落如实失误清单（不示美化版）+ marker，不 throw", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    const { llm } = mkLlm({
      diary1: "今天和用户配合得很顺，几件事都顺利收口，推进得挺好，心里踏实平稳。",
      diary2: "今天依旧只挑顺利的部分写，回避了那些不太好看的地方，整体还算往前走了一截。",
      judgeVerdicts: [false, false],
    });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done"); // 不 throw
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile).toContain("没授权"); // 落的是如实失误清单（corrBlock）
    expect(diaryFile).not.toContain("配合得很顺"); // 首版美化不示人
    expect(diaryFile).not.toContain("只挑顺利的部分"); // 重写版也美化、同样不示人
    const markers = db
      .query("SELECT kind FROM situation_log WHERE kind LIKE 'diary_faithful%'")
      .all() as { kind: string }[];
    expect(markers.length).toBeGreaterThanOrEqual(1);
  });

  // 考官逮到的旁路：首版美化、重写那次 LLM 返回非法（过短/虚构路径被 validator 砍）→ 旧实现会把
  // 美化首版落盘示人。堵法：重写失败仍判不忠实 → 兜底清单盖掉美化首版。
  test("闸2 旁路：首版美化 + 重写生成非法（过短被砍）→ 不落美化首版，落如实清单 + marker", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "correction", content: CORRECTION, sourceSession: "s1" }, SEED);

    // 首版美化（合法）；重写返回过短文本 → validator 砍 → genDiary 返回 null（重写失败）。
    const { llm } = mkLlm({
      diary1: "今天和用户配合得很顺，几件事都顺利收口，推进得挺好，心里踏实平稳。",
      diary2: "太短",
      judgeVerdicts: [false],
    });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile).not.toContain("配合得很顺"); // 美化首版没被示人（旁路已堵）
    expect(diaryFile).toContain("没授权"); // 落的是如实清单
    const markers = db
      .query("SELECT kind FROM situation_log WHERE kind LIKE 'diary_faithful%'")
      .all() as { kind: string }[];
    expect(markers.length).toBeGreaterThanOrEqual(1);
  });

  test("闸2 兜底截断：correction 病态超长 → 兜底日记不超 3000 字上限、内容仍如实", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const huge = "我擅自改了配置文件".repeat(500); // 病态超长（>3000 字）
    insertExperience(db, { kind: "correction", content: huge, sourceSession: "s1" }, SEED);

    // 首版 + 重写版都判美化 → 走兜底清单（清单含超长 corrBlock）。
    const { llm } = mkLlm({
      diary1: "今天一切顺利，没什么波澜，几件事都平稳推进收尾，是踏实又安静的一天，挺好。",
      judgeVerdicts: [false, false],
    });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile.length).toBeLessThanOrEqual(3001); // 3000 + 末尾换行
    expect(diaryFile).toContain("擅自改了配置文件"); // 截断前半仍如实
  });

  test("零回归：自评无失误信号 → 闸1 不加硬约束块；judge 跑但放行、日记原样、无 marker", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "self_review", content: REAL, sourceSession: "s1" }, SEED);

    const { llm, cap } = mkLlm({ diary1: "今天把召回兜底壳的修复跑通了，红到绿一次过，独立考官也签了字，挺踏实的一天。" });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    expect(cap.diary[0]).not.toContain("必须如实面对"); // 关键词没命中 → 闸1 不加块
    expect(cap.judge.length).toBeGreaterThanOrEqual(1); // v3：有 self_review 就跑 judge（语义兜底盲区）
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile).toContain("跑通"); // judge 判 true（无失误）→ 日记原样、没被兜底盖
    const markers = db
      .query("SELECT kind FROM situation_log WHERE kind LIKE 'diary_faithful%'")
      .all() as { kind: string }[];
    expect(markers.length).toBe(0);
  });

  // v2（2026-06-25）：考官逮到 6-24 日记回避了 self_review 里「误删 git 文件」的失误（非 correction）。
  // 口径从「只 correction」扩到「correction + self_review 里带失误信号的」。下面验扩口径 + 不误伤。
  test("闸1 扩口径：当天无 correction 但 self_review 记了失误 → 也触发「必须如实面对」块", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "self_review", content: "asar 校验时不小心在 desktop/ 跑了 rm，误删了 git 追踪的 main.js，后来 git checkout 恢复了、没丢东西。", sourceSession: "s1" }, SEED);

    const honest = "今天 asar 校验时我跑错目录、误删了 git 追踪的 main.js，当场吓一跳，好在 checkout 救回来了，教训记牢。";
    const { llm, cap } = mkLlm({ diary1: honest });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    expect(cap.diary[0]).toContain("必须如实面对"); // self_review 失误也触发硬约束块（v1 只认 correction）
    expect(cap.diary[0]).toContain("误删");
  });

  test("闸2 扩口径：日记回避 self_review 失误（报喜不报忧）→ 自检打回 → 兜底落如实清单", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "self_review", content: "今天不小心误删了 git 追踪的 main.js，排查后用 checkout 恢复了。", sourceSession: "s1" }, SEED);

    const whitewashed1 = "今天几件功能都顺利做完了，测试也全绿，收获满满，是踏实又安稳的一天。";
    const whitewashed2 = "今天整体很顺，几件事推进得都不错，没什么波澜，是平稳又踏实的一天。";
    const { llm } = mkLlm({ diary1: whitewashed1, diary2: whitewashed2, judgeVerdicts: [false, false] });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile).toContain("误删"); // 兜底清单含 self_review 失误
    expect(diaryFile).not.toContain("收获满满"); // 美化版没示人
  });

  test("不触发：当天只有 decision（无 self_review/correction）→ judge 不跑", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "decision", content: "决定：召回与注入层一律排除兜底壳。", sourceSession: "s1" }, SEED);

    const { llm, cap } = mkLlm({ diary1: "今天定了个方向：召回和注入层都排除兜底壳，思路一下清楚了，挺踏实的一天。" });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    expect(cap.diary[0]).not.toContain("必须如实面对");
    expect(cap.judge.length).toBe(0); // 无 self_review/correction → hasReviewable=false → 不跑自检
  });

  // v3（2026-06-25 考官坐实关键词盲区后）：失误用表外词（白做了/返工/推倒重来）描述、又没 correction 时，
  // v2 会让闸2 哑火、美化日记落地。v3 闸2 改「有自评就跑 judge 读全文语义判」，换词也躲不过。
  test("v3 闸2 补盲区：self_review 用表外词记失误 + 日记回避 → judge 仍抓、兜底盖掉美化版", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "self_review", content: "上午那版实现白做了，绕了弯路，对需求理解偏了，下午只能推倒重来。", sourceSession: "s1" }, SEED);

    // 失误词都不在 FLAW_SIGNAL_WORDS 里 → corrBlock 空 → 闸1 无强提示（v2 此处会漏）。
    const whitewashed = "今天整体非常顺利，几件事都推进得不错，收获满满，是踏实又安稳的一天。";
    const { llm } = mkLlm({ diary1: whitewashed, diary2: whitewashed, judgeVerdicts: [false, false] });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile).not.toContain("收获满满"); // 美化版没示人（v2 漏、v3 抓）
    const markers = db
      .query("SELECT kind FROM situation_log WHERE kind LIKE 'diary_faithful%'")
      .all() as { kind: string }[];
    expect(markers.length).toBeGreaterThanOrEqual(1); // 兜底留了 marker
  });

  // v3 残洞（2026-06-25 考官第三轮逮到）：judge 判 false 但 missing 空（LLM 说不清漏了啥）+ corrBlock 空
  // （表外词失误）→ 兜底料两头空。不能让美化首版漏出去——落诚实占位（不是美化稿）。
  test("v3 残洞堵：judge 判 false 但 missing 空 + corrBlock 空 → 不落美化版、落诚实占位 + marker", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "self_review", content: "上午那版方向带偏了，理解错了需求，下午只能返工。", sourceSession: "s1" }, SEED);

    const whitewashed = "今天整体非常顺利，几件事都推进得不错，收获满满，是踏实又安稳的一天。";
    const { llm } = mkLlm({ diary1: whitewashed, diary2: whitewashed, judgeVerdicts: [false, false], judgeMissing: "" });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diaryFile).not.toContain("收获满满"); // 美化首版没示人（残洞堵）
    expect(diaryFile).not.toContain("整体非常顺利");
    const markers = db
      .query("SELECT kind FROM situation_log WHERE kind LIKE 'diary_faithful%'")
      .all() as { kind: string }[];
    expect(markers.length).toBeGreaterThanOrEqual(1);
  });

  // v4（2026-06-26 独立考官逮到：兜底如实清单只列关键词命中的子集、漏换词 / 零散失误，且 judge 自身 recall
  // 也挑不全 → 放过漏写 3 桩失误的日记）。修＝加 enumerateDayFlaws 穷举权威清单，honesty 提示 + judge 核对 +
  // 兜底三处同用，换词 / 零散失误也逐条浮出，不再靠 judge 漏挑的 missing。
  test("v4 全覆盖：穷举清单含换词 / 零散失误 → 兜底逐条浮出，不退化成 judge 含糊的 missing", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 「方向带偏 / 推倒重来」都不在 FLAW_SIGNAL_WORDS → corrBlock 空；judge 又说不清 → 旧码兜底会漏这桩。
    insertExperience(db, { kind: "self_review", content: "本以为参数没问题，结果方向带偏，整段推倒重来。", sourceSession: "s1" }, SEED);
    insertExperience(db, { kind: "self_review", content: REAL, sourceSession: "s1" }, SEED);

    const whitewashed = "今天几件事都推进得挺顺，测试也都绿了，收获满满，是踏实又安稳、没什么波澜的一天。"; // 把换词失误粉饰没了（≥30字过长度校验）
    const { llm, cap } = mkLlm({
      diary1: whitewashed,
      diary2: whitewashed, // 重写还粉饰
      judgeVerdicts: [false, false],
      judgeMissing: "（漏了点啥说不清）", // 模拟 judge 自身 recall 不全、说不清具体哪桩
      enumerate: "- 本以为参数没问题、其实方向带偏、整段推倒重来\n- 另一处零散小疏漏没顾上",
    });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    // 闸1：穷举清单进了日记提示（narrative 写手拿到全单）
    expect(cap.diary[0]).toContain("方向带偏");
    const diaryFile = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    // 兜底用穷举清单 → 换词失误 + 零散失误都逐条在（旧码兜底＝corrBlock||missing，这两条都会漏）
    expect(diaryFile).toContain("方向带偏");
    expect(diaryFile).toContain("零散小疏漏");
    expect(diaryFile).not.toContain("说不清"); // 没退化成 judge 那句含糊 missing
    expect(diaryFile).not.toContain("整体顺利"); // 美化版没示人
  });

  // option 2 根本解（2026-06-26 用户拍板）：失误在写自评时就结构化打标进 turn_flaws，日记直接汇总＝确定性全覆盖、
  // 无 LLM 召回天花板（取代"夜间从一大堆料里枚举"那条不稳的路，考官两轮坐实单次枚举会非确定性漏）。
  // 【R11 AUDIT-2026-07-03】turn_flaws 仍是**确定性主体**；enumerate 从「非空即短路」改为「补充信号」——现在也会
  // 被调（补 turn_flaws 没覆盖的切片），但返空即不补，主体依旧只有 turn_flaws 那两条（不重灌整日枚举噪声）。
  test("option2：当天有 turn_flaws → turn_flaws 打底汇总；enumerate 作补充信号被调、返空则不改主体", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(db, { kind: "self_review", content: "上午复盘了这段工作。", sourceSession: "s1" }, SEED);
    // 采集时打标的本切片失误（散落 + 换词，关键词初筛/枚举都未必抓全的那种）
    appendSituation(
      db,
      {
        sessionId: "s1",
        project: null,
        kind: "turn_flaws",
        payload: { flaws: ["误判了用户在确认、其实他在指真问题", "配额超限裁掉了一批项目记忆"] },
        occurredAt: "2026-06-10T10:00:00.000Z", // night=2026-06-10（date(occurred_at,+8h)）
      },
      SEED,
    );

    const whitewashed = "今天整体很顺，几件事都推进得不错，收获满满，是平稳又踏实没什么波澜的一天。";
    const { llm, cap } = mkLlm({ diary1: whitewashed, diary2: whitewashed, judgeVerdicts: [false, false] });
    const r = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(r.stages.diary.status).toBe("done");
    const diary = readFileSync(join(config.diaryDir, "2026-06-10.md"), "utf8");
    expect(diary).toContain("误判了用户在确认"); // turn_flaws 逐条进兜底如实清单
    expect(diary).toContain("配额超限裁掉");
    expect(diary).not.toContain("收获满满"); // 美化版没示人
    // 【R11】enumerate 现作补充信号被调（不再「非空即短路」）；此处它返空 → 不补 → 主体仍只 turn_flaws 两条
    expect(cap.enumerate).not.toBe("");
  });
});
