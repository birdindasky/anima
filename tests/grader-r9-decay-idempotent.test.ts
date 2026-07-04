// 独立盲考官 R9：decay 阶段崩溃窗口重跑不双写快照。
// 证伪导向：honest 计数（不按 dedup_key 过滤，按 payload.night 数真实快照条数），
// 并含一个"旧行为"对照组证明——去掉 dedupKey 的同场景会双写。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const SEED_CLOCK = frozenClock("2026-06-10T10:00:00.000Z");
const DIGEST_NOW = "2026-06-11T03:00:00.000Z";
const NIGHT = "2026-06-10";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "grader-r9-"));
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

function llmOk() {
  return async (prompt: string): Promise<string> => {
    if (prompt.includes("画上句号")) return JSON.stringify({ closure: "那摊事过去了，留下经验。" });
    if (prompt.includes("人格文档")) return "# 人格卡\n\n我是一个稳定、克制、爱较真的助手，性格以月为单位慢慢成形。\n";
    if (prompt.includes("穷举")) return "";
    if (prompt.includes("忠实度自检")) return JSON.stringify({ faithful: true, missing: "" });
    if (prompt.includes("写日记")) return "今天把一个小东西收了尾，过程很平静，踏实地结束了这一天。";
    return "{}";
  };
}

// 诚实计数：数该夜的真实 digest_decay_snapshot 行数（按 payload.night），不靠 dedup_key 过滤，
// 这样即使旧代码写出 dedup_key=NULL 的重复快照也会被数到。
function honestSnapCount(db: ReturnType<typeof openDb>): number {
  return (
    db
      .query(
        "SELECT count(*) c FROM situation_log WHERE kind = 'digest_decay_snapshot' AND json_extract(payload,'$.night') = ?",
      )
      .get(NIGHT) as { c: number }
  ).c;
}

function seed(db: ReturnType<typeof openDb>) {
  insertExperience(
    db,
    { kind: "self_review", content: "复盘：今天把一个洞收尾了。", feeling: "踏实", sourceSession: "s1" },
    SEED_CLOCK,
  );
}

describe("R9 decay 幂等（独立考官）", () => {
  test("首跑落一份快照", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seed(db);
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmOk(), config });
    expect(honestSnapCount(db)).toBe(1);
  });

  test("崩溃窗口重跑一次：done 标记删除后 decay 重跑，快照仍只一份（旧 bug=两份）", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seed(db);
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmOk(), config });
    expect(honestSnapCount(db)).toBe(1);

    // 崩溃窗口：decay 快照已提交、record(decay,done) 未提交 → 删标记
    db.query("DELETE FROM digest_runs WHERE night = ? AND stage = 'decay'").run(NIGHT);
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmOk(), config });
    expect(honestSnapCount(db)).toBe(1);
  });

  test("反复崩溃三次：连续删标记重跑，快照永远一份", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    seed(db);
    await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmOk(), config });
    for (let i = 0; i < 3; i++) {
      db.query("DELETE FROM digest_runs WHERE night = ? AND stage = 'decay'").run(NIGHT);
      await runNightlyDigestion(db, { clock: frozenClock(DIGEST_NOW), llm: llmOk(), config });
    }
    expect(honestSnapCount(db)).toBe(1);
  });

  // 对照组：证明"旧行为"（append 不带 dedupKey）在同场景下会双写 —— 即 dedupKey 是承重的根因修复点。
  test("对照：不带 dedupKey 的两次 append（模拟旧 decay）→ 真会双写两份", async () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    seed(db);
    // 手动模拟旧 stageDecay：两次 append，无 dedupKey（旧代码就是这样）
    appendSituation(db, { kind: "digest_decay_snapshot", payload: { night: NIGHT, charges: [] } }, frozenClock(DIGEST_NOW));
    appendSituation(db, { kind: "digest_decay_snapshot", payload: { night: NIGHT, charges: [] } }, frozenClock(DIGEST_NOW));
    expect(honestSnapCount(db)).toBe(2); // 旧行为红：双写坐实
  });

  // 底层保证：带同一稳定 dedupKey 的两次 append 命中唯一索引 → 只一行，且回查返回同一行 id。
  test("底层：同 dedupKey 两次 append 只落一行、返回同一行", async () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const key = `digest_decay_snapshot:${NIGHT}`;
    const a = appendSituation(db, { kind: "digest_decay_snapshot", payload: { night: NIGHT, charges: [1] }, dedupKey: key });
    const b = appendSituation(db, { kind: "digest_decay_snapshot", payload: { night: NIGHT, charges: [2] }, dedupKey: key });
    expect(honestSnapCount(db)).toBe(1);
    expect(b.id).toBe(a.id); // 弹回时回查到先落的那行，保留最先的快照
  });
});
