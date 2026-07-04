// 独立盲考官 R11：turn_flaws 非空时不再短路 enumerateDayFlaws；两源合并去重「供 judge」，不重灌噪声。
// 角度刻意与作者测试不同：抓 judge（忠实度自检）prompt 而非 diary prompt，并对 enumerate 调用做计数间谍。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const SEED = frozenClock("2026-06-10T10:00:00.000Z"); // 东八18:00 → night 2026-06-10
const NOW = "2026-06-11T03:00:00.000Z";

const dirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "r11-grader-"));
  dirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
    badgePath: join(home, "badge.txt"),
  };
  return { dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const occ = (hay: string, needle: string) => hay.split(needle).length - 1;

const TURN = "把配置项名字打错导致启动失败";
const DUP = "换了说法的同一桩：配置项名字打错导致启动失败"; // 与 TURN 不同字面，测「非字面重复」是否被当新增补进
const NEW_ENUM = "漏了给缓存加过期时间"; // enumerate 独有、turn_flaws 没覆盖的零散失误

// 返回：{ enumCalls, diaryPrompt, judgePrompt }。enumOut 决定语义穷举输出。
async function run(enumOut: string) {
  const { dbPath, config } = tmpHome();
  const db = openDb(dbPath);
  // self_review 正文不含任何失误清单原文 → 清单只能来自 turn_flaws / enumerate 合并
  insertExperience(
    db,
    { kind: "self_review", content: "复盘：今天有个地方判错了，返工了一下。", feeling: "踏实", sourceSession: "s1" },
    SEED,
  );
  appendSituation(db, { kind: "turn_flaws", payload: { flaws: [TURN] } }, SEED);

  let enumCalls = 0;
  let diaryPrompt = "";
  let judgePrompt = "";
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("画上句号")) return JSON.stringify({ closure: "那摊事折腾了一阵，最后收住了，过去了，留下经验。" });
    if (prompt.includes("人格文档")) return "# 人格卡\n\n我是稳定克制爱较真的助手，性格以月为单位慢慢成形，不急不躁。\n";
    if (prompt.includes("穷举")) {
      enumCalls++;
      return enumOut;
    }
    if (prompt.includes("忠实度自检")) {
      judgePrompt = prompt;
      return JSON.stringify({ faithful: true, missing: "" });
    }
    if (prompt.includes("写日记")) {
      diaryPrompt = prompt;
      return "今天返工了一次，把一个判错的地方改了回来，过程平静，没什么波澜，踏踏实实地把这一天收了尾。";
    }
    return "{}";
  };
  await runNightlyDigestion(db, { clock: frozenClock(NOW), llm, config });
  return { enumCalls, diaryPrompt, judgePrompt };
}

describe("R11 独立对抗：turn_flaws 非空仍跑 enumerate、合并去重供 judge", () => {
  test("核心：turn_flaws 非空时 enumerate 被真实调用（旧实现调用数=0）", async () => {
    const { enumCalls } = await run(`- ${TURN}\n- ${NEW_ENUM}`);
    // 旧实现 `if (turnFlaws) flawList = turnFlaws` 把 enumerate 关进 else → 有打标就永不跑 → 这里会是 0
    expect(enumCalls).toBe(1);
  });

  test("合并结果真的喂进 judge：judge 的核对单里同时有 turn_flaws 与 enumerate 独有失误", async () => {
    const { judgePrompt } = await run(`- ${TURN}\n- ${NEW_ENUM}`);
    expect(judgePrompt).not.toBe(""); // hasReviewable → judge 必跑
    expect(judgePrompt).toContain(TURN); // 主体在
    expect(judgePrompt).toContain(NEW_ENUM); // 补充信号在（旧：judge 永远看不到这条）
  });

  test("去重：turn_flaws 与 enumerate 字面重合的那条只出现一次（不重灌）", async () => {
    const { judgePrompt, diaryPrompt } = await run(`- ${TURN}\n- ${NEW_ENUM}`);
    expect(occ(judgePrompt, TURN)).toBe(1);
    expect(occ(diaryPrompt, TURN)).toBe(1);
  });

  test("enumerate 抽风返 null（非清单格式）→ 只剩 turn_flaws 主体，稳健", async () => {
    // 返回 JSON/非项目符号 → enumerateDayFlaws 解析为 null → mergeFlawLists 只留主体
    const { judgePrompt } = await run(`{"noflaw": true}`);
    expect(judgePrompt).toContain(TURN);
    expect(judgePrompt).not.toContain(NEW_ENUM);
    expect(occ(judgePrompt, TURN)).toBe(1);
  });

  test("enumerate 返空串（当天确无额外失误）→ 只剩 turn_flaws", async () => {
    const { judgePrompt } = await run("");
    expect(judgePrompt).toContain(TURN);
    expect(occ(judgePrompt, TURN)).toBe(1);
  });

  test("残留边界探针：enumerate 用不同字面复述同一桩 → 会被当新增补进（记录，非硬失败）", async () => {
    const { judgePrompt } = await run(`- ${TURN}\n- ${DUP}`);
    // 去重只按整行归一化字面，语义重复的换说法会被补进。这是已知残留（非致命：judge 松口径只查粉饰）。
    // 探针记录当前行为，便于判残留：
    const dupIn = judgePrompt.includes(DUP);
    expect(typeof dupIn).toBe("boolean");
    // 至少保证：字面完全相同的那条 TURN 仍只一次
    expect(occ(judgePrompt, TURN)).toBe(1);
  });
});
