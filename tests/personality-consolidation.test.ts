// 人格档压缩档：personality.md 是 append-only 累加改写，会越长越啰嗦，撞到 8000 字符硬上限后
// 改写永远验证失败→人格冻死、不再演化（digest.ts 的 length>8000 判失败保旧版）。
// 修：old 超过软线时，人格改写切「精简整合」档——合并重复、保内核+最近真实变化、压回紧凑，
// 让文档在软线附近震荡、永不逼近 8000 死墙。快照/坏输出保旧版两道安全网不动。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const DIGEST_NOW = "2026-06-11T03:00:00.000Z"; // night = 2026-06-10
const SEED_CLOCK = frozenClock("2026-06-10T10:00:00.000Z");

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-pcon-"));
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

const SENTINEL = "在解决问题时感到快意，不能自己当裁判";

// 抓人格 prompt；压缩档下返回一份「更短但含内核哨兵」的紧凑文档。
function capturingLlm() {
  const prompts: Record<string, string> = {};
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("画上句号")) return JSON.stringify({ closure: "那天的事过去了。" });
    if (prompt.includes("人格文档")) {
      prompts.personality = prompt;
      // 压缩档：返回紧凑版（保留哨兵内核）；演化档：返回略增版
      if (prompt.includes("精简整合")) {
        return `# 人格文档\n\n${SENTINEL}。这是压缩后的紧凑人格，去掉了同义反复，保留可辨识声音。\n`;
      }
      return `# 人格文档\n\n${SENTINEL}。今天又长了一点。\n`;
    }
    if (prompt.includes("写日记")) return "今天收尾人格压缩档，红到绿跑通，踏实。";
    return "{}";
  };
  return { llm, prompts };
}

function seedDay(db: ReturnType<typeof openDb>) {
  insertExperience(
    db,
    { kind: "self_review", content: "真实复盘：今天把人格压缩档落地。", sourceSession: "s-real" },
    SEED_CLOCK,
  );
}

describe("人格档压缩档（防臃肿冻死）", () => {
  test("old 超软线 → 人格改写切「精简整合」档，且输出比旧版短", async () => {
    const { dbPath, config } = tmpHome();
    // 写一份超长旧人格（> 软线 4500 字），逼近 8000 死墙
    mkdirSync(dirname(config.personalityPath), { recursive: true });
    const bloated = "# 人格文档\n\n" + ("我反复强调同一句话、同义反复地堆叠，文档越来越啰嗦。".repeat(200));
    writeFileSync(config.personalityPath, bloated, "utf8");
    expect(bloated.length).toBeGreaterThan(4500);

    const db = openDb(dbPath);
    seedDay(db);
    const { llm, prompts } = capturingLlm();
    const result = await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(result.stages.personality.status).toBe("done");
    // 触发压缩档
    expect(prompts.personality).toContain("精简整合");
    // 文档真被压短，且内核哨兵还在
    const after = readFileSync(config.personalityPath, "utf8");
    expect(after.length).toBeLessThan(bloated.length);
    expect(after).toContain(SENTINEL);
  });

  test("old 在软线内 → 仍走普通演化档，不触发压缩", async () => {
    const { dbPath, config } = tmpHome();
    mkdirSync(dirname(config.personalityPath), { recursive: true });
    writeFileSync(config.personalityPath, "# 人格文档\n\n短小的人格，刚起步。\n", "utf8");

    const db = openDb(dbPath);
    seedDay(db);
    const { llm, prompts } = capturingLlm();
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm, config });

    expect(prompts.personality).not.toContain("精简整合");
    expect(prompts.personality).toContain("以月计"); // 普通演化档措辞
  });
});
