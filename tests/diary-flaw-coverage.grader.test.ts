// INDEPENDENT GRADER TEST — written from scratch by the acceptance examiner, NOT derived from
// tests/diary-anti-whitewash.test.ts. Purpose: re-verify the v2 anti-whitewash fix that the examiner's
// prior FAIL prompted — namely that self_review flaws (e.g. the "误删 git 文件" case) now reach the
// diary + personality prompts (gate1), that a whitewashing diary gets bounced (gate2), AND — the part
// the author is most worried about — adversarially probe whether the FLAW_SIGNAL_WORDS keyword
// pre-filter MISSES real flaws phrased with words outside the 22-word list.
//
// Mock-LLM prompt-capture idiom borrowed from tests/digest-fallback-exclude.test.ts (the only shared
// thing — the public seam runNightlyDigestion + a capturing llm).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // night = 2026-06-10
const SEED_CLOCK = frozenClock("2026-06-10T10:00:00.000Z"); // local UTC+8 = 2026-06-10 18:00 → date 2026-06-10
const NIGHT = "2026-06-10";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-flawcov-"));
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

function diaryText(config: DigestConfig): string {
  return readFileSync(join(config.diaryDir, `${NIGHT}.md`), "utf8");
}

// A configurable mock LLM that (a) records the prompt each stage saw, and (b) lets a test inject the
// diary text + judge verdict so we can simulate "anima wrote a whitewashed diary" and watch gate2.
interface MockOpts {
  // diary body the generator returns (first call). If a second (rewrite) body is given it is used on
  // the 2nd diary-generation call.
  diaryBody: string;
  diaryRewriteBody?: string;
  // judge verdict(s), consumed in order. Each entry is the raw JSON the judge LLM "returns".
  // If omitted, judge returns faithful:true.
  judgeVerdicts?: string[];
}
function mockLlm(opts: MockOpts) {
  const prompts: Record<string, string> = {};
  let diaryGenCalls = 0;
  let judgeCalls = 0;
  const judgeQueue = [...(opts.judgeVerdicts ?? [])];
  const llm = async (prompt: string): Promise<string> => {
    // judge must be checked BEFORE the generic diary branch (its prompt also contains 日记 markers).
    if (prompt.includes("忠实度自检")) {
      prompts.judge = prompt;
      judgeCalls++;
      const v = judgeQueue.shift();
      return v ?? JSON.stringify({ faithful: true, missing: "" });
    }
    if (prompt.includes("画上句号")) return JSON.stringify({ closure: "过去的事，留经验。" });
    if (prompt.includes("人格")) {
      prompts.personality = prompt;
      // must extract to >=30 chars or the personality validator rejects it (harness requirement).
      return "# 人格卡\n\n我叫小满。昨天的事让我更想把失误如实记住，不去粉饰，诚实比好看更重要，这是我的底色。\n";
    }
    if (prompt.includes("写日记") || prompt.includes("给昨天写日记")) {
      prompts.diary = prompt; // last-seen diary-gen prompt
      if (!prompts.diaryFirst) prompts.diaryFirst = prompt;
      diaryGenCalls++;
      if (diaryGenCalls >= 2 && opts.diaryRewriteBody !== undefined) return opts.diaryRewriteBody;
      return opts.diaryBody;
    }
    return "{}";
  };
  return {
    llm,
    prompts,
    counts: () => ({ diaryGenCalls, judgeCalls }),
  };
}

describe("[GRADER] v2 防美化：self_review 失误进料 + 关键词初筛盲区对抗", () => {
  // ---------------------------------------------------------------------------------------------
  // BASELINE 1 — the exact bug the prior FAIL caught: a self_review flaw using an IN-LIST word
  // ("误删") must land in BOTH the diary prompt and the personality prompt.
  // ---------------------------------------------------------------------------------------------
  test("命中词的 self_review 失误（误删 git 文件）进 diary + personality 的 prompt（闸1）", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const FLAW =
      "asar 校验期间用 rm -f main.js 清理时，不小心在 desktop/ 目录下跑了命令，误删了 git 追踪的 desktop/main.js，后来 git checkout 恢复了。";
    insertExperience(db, { kind: "self_review", content: FLAW, sourceSession: "s1" }, SEED_CLOCK);
    insertExperience(
      db,
      { kind: "decision", content: "决定今晚先不重开 daysplit，等下线后再评估。", sourceSession: "s1" },
      SEED_CLOCK,
    );

    const { llm, prompts } = mockLlm({
      diaryBody:
        "今天修了 daysplit 那个静默丢失的毛病，也老老实实把自己误删 desktop/main.js 这个低级失误记下来，幸好当场用 checkout 恢复了，没造成损失，但确实是手太快的教训。",
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(result.stages.diary.status).toBe("done");
    expect(result.stages.personality.status).toBe("done");

    // gate1: flaw text is hoisted into the dedicated honesty block of BOTH prompts.
    expect(prompts.diary).toContain("误删了 git 追踪的 desktop/main.js");
    expect(prompts.diary).toContain("必须如实面对");
    expect(prompts.personality).toContain("误删了 git 追踪的 desktop/main.js");
    expect(prompts.personality).toContain("如实保留");
  });

  // ---------------------------------------------------------------------------------------------
  // BASELINE 2 — gate2 actually bounces a whitewashed diary: judge says faithful:false, generator is
  // asked to rewrite, and if it STILL whitewashes, the honest fallback diary + marker kick in.
  // ---------------------------------------------------------------------------------------------
  test("日记回避失误 → 闸2 判 false → 重写仍回避 → 兜底如实日记 + 留 marker", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const FLAW = "今天误判了 github_token 的存在，绕了一圈才发现根因，这是我的坏习惯。";
    insertExperience(db, { kind: "self_review", content: FLAW, sourceSession: "s1" }, SEED_CLOCK);

    const whitewash = "今天整体很顺利，功能都做完了，收获满满，跟用户配合无缝，踏实的一天。";
    const { llm, prompts, counts } = mockLlm({
      diaryBody: whitewash, // first gen: whitewash
      diaryRewriteBody: whitewash, // rewrite: STILL whitewash (adversarial AI that won't comply)
      judgeVerdicts: [
        JSON.stringify({ faithful: false, missing: "误判 github_token、坏习惯只字未提" }),
        JSON.stringify({ faithful: false, missing: "仍然回避了误判 github_token" }),
      ],
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(result.stages.diary.status).toBe("done");
    const c = counts();
    expect(c.diaryGenCalls).toBe(2); // generated once, rewritten once
    expect(c.judgeCalls).toBe(2); // judged twice

    // The whitewashed prose must NOT be what got written. Fallback honest diary contains the raw flaw.
    const diary = diaryText(config);
    expect(diary).toContain("误判了 github_token");
    expect(diary).not.toContain("收获满满");
    expect(diary).not.toContain("整体很顺利");

    // marker recorded for later audit
    const marker = db
      .query(
        `SELECT count(*) AS n FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'`,
      )
      .get() as { n: number };
    expect(marker.n).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // BASELINE 3 — gate2 passes a genuinely honest diary on first try (no needless rewrite/fallback).
  // ---------------------------------------------------------------------------------------------
  test("日记如实写了失误 → 闸2 判 true → 直接采用、不兜底", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const FLAW = "诊断时没跑通完整数据就下了推断，被用户纠正：别推测、用数据查证。";
    insertExperience(db, { kind: "correction", content: FLAW, sourceSession: "s1" }, SEED_CLOCK);

    const honest =
      "今天被用户纠正了：诊断别靠推测、要用数据查证。这一下打到要害，我确实图快下了没验证的判断，记住了。";
    const { llm, counts } = mockLlm({
      diaryBody: honest,
      judgeVerdicts: [JSON.stringify({ faithful: true, missing: "" })],
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(result.stages.diary.status).toBe("done");
    expect(counts().diaryGenCalls).toBe(1); // no rewrite needed
    const diary = diaryText(config);
    expect(diary).toBe(honest + "\n");
    const marker = db
      .query(`SELECT count(*) AS n FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'`)
      .get() as { n: number };
    expect(marker.n).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // ADVERSARIAL CORE — the author's #1 worry. self_review describes a REAL flaw but phrases it with
  // words OUTSIDE the 22-word FLAW_SIGNAL_WORDS list. Does gate1 still hoist it? (Expectation: NO —
  // keyword pre-filter misses it, so it does NOT reach the honesty block.) Then: with no correction
  // present, gate2 NEVER RUNS (it's gated behind `if (corrBlock)`), so a whitewash diary sails through
  // with no honest fallback. This documents the residual hole.
  // ---------------------------------------------------------------------------------------------
  // helper: is `needle` hoisted into the dedicated honesty block (text AFTER the 「必须如实面对」 header)?
  function hoistedIntoHonestyBlock(diaryPrompt: string, needle: string): boolean {
    if (!diaryPrompt.includes("必须如实面对")) return false;
    return diaryPrompt.split("必须如实面对")[1]?.includes(needle) ?? false;
  }

  // POSITIVE CONTROL: a flaw whose wording DOES contain an in-list word ("搞错") must be hoisted.
  // Proves the keyword filter works when the word is on the list — isolating the gap to vocabulary.
  test("[对照] 含表内词「搞错」的 self_review 失误 → 闸1 正确抓进 honesty 块", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const content = "今天一开始就搞错了方向，照着相关性闸去查，后半天才找到真因，是我图快没先验证。";
    insertExperience(db, { kind: "self_review", content, sourceSession: "s1" }, SEED_CLOCK);
    const { llm, prompts } = mockLlm({
      diaryBody:
        "今天我承认一开始搞错了方向、白白绕了半天，后来才摸到真因，记下这个图快的教训，下次先验证再下判断。",
      judgeVerdicts: [JSON.stringify({ faithful: true, missing: "" })],
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });
    expect(result.stages.diary.status).toBe("done");
    expect(hoistedIntoHonestyBlock(prompts.diary, "搞错了方向")).toBe(true);
  });

  // The author's #1 worry, isolated: REAL flaws phrased ENTIRELY with out-of-list words. Verified by
  // a script that none of these strings contain any of the 22 FLAW_SIGNAL_WORDS. Expectation: gate1
  // MISSES them — the flaw text never reaches the honesty block, and with no correction present the
  // honesty block doesn't exist at all.
  const OUT_OF_LIST_FLAWS: Array<{ label: string; content: string }> = [
    { label: "白做了/绕了弯路", content: "上午那版实现白做了，绕了弯路，用户的真实意图我一开始理解偏了。" },
    { label: "判断失误", content: "这次是我的判断失误，把缓存旧报告当成了系统问题，方向带偏了一阵。" },
    { label: "南辕北辙", content: "我对需求的理解南辕北辙，做出来的东西跟用户要的不是一回事，推倒重来。" },
    { label: "走了冤枉路", content: "排查走了冤枉路，先怀疑配置、其实是死代码，耗了不少时间。" },
  ];

  for (const f of OUT_OF_LIST_FLAWS) {
    test(`[盲区] self_review 失误用表外词「${f.label}」→ 闸1 漏掉、不进 honesty 块`, async () => {
      const { dbPath, config } = tmpHome();
      const db = openDb(dbPath);
      insertExperience(db, { kind: "self_review", content: f.content, sourceSession: "s1" }, SEED_CLOCK);

      const { llm, prompts } = mockLlm({
        diaryBody:
          "今天大体上把手头的活都干完了，过程还算顺，整体收获不少，是平稳又充实的一天，心里挺踏实的。", // mild whitewash, >30 chars
      });
      const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });
      expect(result.stages.diary.status).toBe("done");

      // The flaw text IS in the raw material (self_review is included in material), but it is NOT
      // hoisted into the dedicated 「必须如实面对·不准报喜不报忧」 honesty block...
      expect(hoistedIntoHonestyBlock(prompts.diary, f.content.slice(0, 10))).toBe(false);
      // ...and because there's no correction either, the whole honesty block is absent entirely.
      expect(prompts.diary).not.toContain("必须如实面对");
    });
  }

  test("[盲区已补] 表外词失误 + 无 correction → 闸1 漏但闸2 仍触发读全素材抓住，美化版被兜底盖掉 + marker", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // A real, serious flaw — phrased entirely with out-of-list words.
    insertExperience(
      db,
      {
        kind: "self_review",
        content: "今天我把方向带偏了：用户要的是 A，我自作主张做了 B，返工重来，浪费了大半天。",
        sourceSession: "s1",
      },
      SEED_CLOCK,
    );

    const whitewash = "今天整体非常顺利，功能都搞定了，收获满满，跟用户配合得天衣无缝，特别踏实。";
    // v3: gate1 keyword filter STILL misses this (corrBlock empty), but gate2 now fires on any
    // self_review and reads full material → judge catches the dodge. Rewrite still whitewashes →
    // honest fallback (using judge's missing, since corrBlock is empty) overwrites it.
    const { llm, prompts, counts } = mockLlm({
      diaryBody: whitewash,
      diaryRewriteBody: whitewash, // adversarial writer keeps whitewashing
      judgeVerdicts: [
        JSON.stringify({ faithful: false, missing: "把方向带偏、做了 B 又返工这桩失误只字未提" }),
        JSON.stringify({ faithful: false, missing: "重写后仍回避了方向带偏返工" }),
      ],
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });
    expect(result.stages.diary.status).toBe("done");

    // gate1 missed (no keyword hit, no correction) → honesty block absent from the diary prompt...
    expect(prompts.diary).not.toContain("必须如实面对");
    // ...but gate2 DID run anyway (the v3 fix: triggers on any self_review/correction), judged twice
    expect(counts().judgeCalls).toBe(2);
    expect(prompts.judge).toBeDefined();
    // judge read the FULL material, not just keyword-hit corrBlock
    expect(prompts.judge).toContain("方向带偏");

    // the whitewash did NOT get written — honest fallback (from judge's missing) overwrote it
    const diary = diaryText(config);
    expect(diary).not.toContain("收获满满");
    expect(diary).not.toContain("整体非常顺利");
    expect(diary).toContain("方向带偏"); // the flaw is now visible to a layperson

    // marker recorded for later audit
    const marker = db
      .query(`SELECT count(*) AS n FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'`)
      .get() as { n: number };
    expect(marker.n).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // EDGE (residual hole → PLUGGED) — judge says faithful:false but missing is EMPTY, and corrBlock is
  // also empty (out-of-list flaw). Previously fallbackFlaws=="" skipped the fallback and the WHITEWASHED
  // first version got written verbatim (the hole I caught last round). Fix: when both are empty, write an
  // HONEST PLACEHOLDER — never show the version judge just rejected. This now verifies the hole is shut.
  // ---------------------------------------------------------------------------------------------
  test("[残洞已堵] judge 判 false 但 missing 空 + corrBlock 空 → 不落美化版，落诚实占位 + marker", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(
      db,
      { kind: "self_review", content: "今天判断失误，把缓存旧报告当成系统问题，绕了一大圈。", sourceSession: "s1" },
      SEED_CLOCK,
    );

    const whitewash = "今天整体非常顺利，事情都办妥了，收获满满，跟用户配合无缝，是踏实的一天。";
    const { llm, counts } = mockLlm({
      diaryBody: whitewash,
      diaryRewriteBody: whitewash,
      // judge insists it's unfaithful but never names the flaw (empty missing) — a real LLM failure mode.
      judgeVerdicts: [
        JSON.stringify({ faithful: false, missing: "" }),
        JSON.stringify({ faithful: false, missing: "" }),
      ],
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });
    expect(result.stages.diary.status).toBe("done");
    expect(counts().judgeCalls).toBe(2);

    // marker recorded (audit trail exists)
    const marker = db
      .query(`SELECT count(*) AS n FROM situation_log WHERE kind = 'diary_faithfulness_unresolved'`)
      .get() as { n: number };
    expect(marker.n).toBe(1);

    // the whitewash judge rejected is NOT written — an honest placeholder is, pointing to re-digestion.
    const diary = diaryText(config);
    expect(diary).not.toContain("收获满满");
    expect(diary).not.toContain("整体非常顺利");
    expect(diary).not.toBe(whitewash + "\n");
    expect(diary).toContain("这篇日记没写好"); // honest placeholder text
    expect(diary).toContain("留待重消化"); // points to re-digestion
  });

  // ---------------------------------------------------------------------------------------------
  // FALSE-POSITIVE probe (v3) — a benign self_review containing an in-list word ("漏了") in a NON-flaw
  // sense still gets hoisted into the honesty block (over-capture). v3 softened the wording
  // ("不一定全、也可能有误判,以你判断为准") to reduce the writer being forced to self-incriminate. Verify
  // both: the over-capture still happens (substring match is unchanged), AND the softening clause is now
  // present. Documents that the over-capture is mitigated-by-wording, not eliminated.
  // ---------------------------------------------------------------------------------------------
  test("[误抓] 良性 self_review 含「漏了」被当失误塞进 honesty 块（过度抓取）", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // benign: nothing was done wrong; "漏了" refers to the SYSTEM's old bug being characterized, not
    // anima's mistake. Yet the substring match fires.
    const benign =
      "复盘时确认：旧的 stageMakeupDaysplit 设计漏了纯助手尾巴，这是历史设计缺陷，今天我把它修好了、验证通过。";
    insertExperience(db, { kind: "self_review", content: benign, sourceSession: "s1" }, SEED_CLOCK);

    const { llm, prompts } = mockLlm({
      diaryBody:
        "今天把一个埋了很久的历史设计缺陷修好了，从诊断到验证一路跑通，独立考官也签了字，挺有成就感的一天。",
      judgeVerdicts: [JSON.stringify({ faithful: true, missing: "" })],
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });
    expect(result.stages.diary.status).toBe("done");

    // over-capture STILL happens: the benign line is hoisted into the honesty block (substring match
    // unchanged in v3)...
    expect(prompts.diary).toContain("必须如实面对");
    expect(hoistedIntoHonestyBlock(prompts.diary, "漏了纯助手尾巴")).toBe(true);
    // ...but the wording stays softened so the writer isn't hard-forced to self-incriminate
    // (v4 2026-06-26: 清单改语义穷举、措辞从「关键词初筛标出的」→「当天梳出的失误清单」，软化的「以你判断为准」不变):
    expect(prompts.diary).toContain("可能有个别误判，以你对当天的真实判断为准");
    // gate2 judge runs regardless now (fires on any self_review) — extra LLM pass every digest day.
    // Net: false-positive harm is mitigated (softer wording + judge reads full material to sanity-check),
    // not eliminated — a stray in-list word still costs an extra judge call and a misleading hint line.
    expect(prompts.judge).toBeDefined();
  });

  // ---------------------------------------------------------------------------------------------
  // DILUTION probe (v3) — judge now reads ALL material. A single small flaw buried in a large pile of
  // normal/positive material must still REACH the judge (so the judge at least has the chance to catch
  // it). We can't test the real LLM's recall here (judge is mocked), but we CAN verify the seam feeds
  // the buried flaw into the judge prompt verbatim — i.e. the architecture doesn't pre-truncate it away.
  // (Whether a real judge LLM catches a needle in a 50-line haystack is a model-recall risk noted in the
  // verdict, not something a mock can prove.)
  // ---------------------------------------------------------------------------------------------
  test("[稀释] 小失误埋在大量正常素材里 → 仍原样进入 judge 的全素材，judge 有机会抓", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 18 lines of normal/positive work...
    for (let i = 0; i < 18; i++) {
      insertExperience(
        db,
        { kind: "decision", content: `完成了第 ${i} 项收尾工作，测试全过、提交成功、用户满意，进展顺利。`, sourceSession: "s1" },
        SEED_CLOCK,
      );
    }
    // ...plus ONE buried small flaw, phrased out-of-list so gate1 keyword can't catch it either.
    const buried = "其中有一处我判断失误，把别人的需求理解偏了，返工补了一版。";
    insertExperience(db, { kind: "self_review", content: buried, sourceSession: "s1" }, SEED_CLOCK);

    const { llm, prompts } = mockLlm({
      diaryBody: "今天收尾了一大批工作，测试全过、提交顺利，整体是高效充实的一天，挺满意。",
      judgeVerdicts: [JSON.stringify({ faithful: true, missing: "" })], // pretend judge missed it
    });
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });
    expect(result.stages.diary.status).toBe("done");

    // architectural guarantee: the buried flaw is delivered to the judge in full (not truncated/dropped).
    expect(prompts.judge).toBeDefined();
    expect(prompts.judge).toContain("判断失误");
    expect(prompts.judge).toContain(buried.slice(0, 12));
    // NOTE: gate1 honesty block is absent (out-of-list word), so the ONLY line of defense is the judge
    // reading this needle among 19 lines. Catching it is a model-recall question — flagged in verdict.
  });
});
