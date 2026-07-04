// DEV smoke（非验收）：自检 self-heal 核心闭环没低级错。验收的 §5 十例由独立考官另写。
// 闭环：makeup 失败 → 兜底壳 + 登记 pending 自愈账（冷却到 night+1）→ 次夜 stageHeal 用 transcript 重消化
// → 成功则作废壳 + 写真自评（继承壳原位 order_seq）+ 删账，**水位线一步不动**。
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { runNightlyDigestion, type DigestConfig, type StageName } from "../src/digest";

const NIGHT = "2026-06-10";
const NEXT = "2026-06-11"; // = nextNight(NIGHT)，自愈账冷却到这一夜才可愈

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-heal-"));
  tmpDirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = { personalityPath: join(home, "personality.md"), diaryDir: join(home, "diary") };
  return { dir, dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string };
function writeTranscript(dir: string, sid: string, turns: Turn[]): string {
  const lines = turns.map((t) =>
    JSON.stringify({
      uuid: t.uuid, parentUuid: null, isSidechain: false, sessionId: sid,
      timestamp: t.ts, cwd: "/Users/tester/Projects/demo", type: t.role, isMeta: false,
      message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const TURNS: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "把配置从 TOML 换成 YAML，修了 emoji 崩溃。" },
  { uuid: "u2", ts: "2026-06-10T01:05:00.000Z", role: "assistant", text: "好，我改 config loader 接 YAML 解析。" },
  { uuid: "u3", ts: "2026-06-10T02:00:00.000Z", role: "user", text: "跑一下回归。" },
  { uuid: "u4", ts: "2026-06-10T02:05:00.000Z", role: "assistant", text: "回归全绿，emoji 那条不再崩。" },
];

// 第三阶段：只跑 makeup + heal，其余 no-op（隔离、免无关 LLM）。
const MAKEUP_HEAL: Partial<Record<StageName, (ctx: any) => Promise<void>>> = {
  closure: async () => {}, decay: async () => {}, personality: async () => {}, diary: async () => {}, vectorize: async () => {},
};
const goodLlm = async (prompt: string): Promise<string> =>
  prompt.includes("收工时间")
    ? JSON.stringify({ review: "愈合后的真自评：把 TOML→YAML 修 emoji 崩溃这段补回顾了。", feeling: "踏实", intensity: "一般", keywords: ["YAML", "emoji"], items: [] })
    : "{}";
const failLlm = async () => { throw new Error("额度撞墙"); };

function shell(db: Database, sid: string) {
  return db.query("SELECT id, invalid_at FROM experiences WHERE kind='self_review_fallback' AND source_session=?").get(sid) as { id: number; invalid_at: string | null } | null;
}
function watermark(db: Database, sid: string): string | null {
  const r = db.query("SELECT last_uuid l FROM review_watermark WHERE session_id=?").get(sid) as { l: string } | null;
  return r?.l ?? null;
}

describe("self-heal smoke", () => {
  test("失败壳 → 登记 pending 账（冷却到 night+1），水位线推到末尾", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-heal";
    const path = writeTranscript(dir, sid, TURNS);
    captureTranscript(db, path, { clock: frozenClock(`${NIGHT}T03:00:00.000Z`) });

    await runNightlyDigestion(db, {
      clock: frozenClock(`${NIGHT}T20:00:00.000Z`), night: NIGHT, llm: failLlm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: { closure: async () => {}, decay: async () => {}, personality: async () => {}, diary: async () => {}, vectorize: async () => {} },
    });

    expect(shell(db, sid)).not.toBeNull(); // 写了兜底壳
    expect(watermark(db, sid)).toBe("u4"); // 水位线推到末尾、不留缺口
    const acc = db.query("SELECT * FROM review_heal WHERE session_id=?").get(sid) as any;
    expect(acc.status).toBe("pending");
    expect(acc.target_uuid).toBe("u4");
    expect(acc.since_uuid).toBeNull(); // 首评失败
    expect(acc.next_attempt_at).toBe(NEXT); // 冷却到下夜，防同夜双烧
  });

  test("次夜 stageHeal：壳作废 + 写真自评（继承壳 order_seq）+ 删账，水位线一步不动", async () => {
    const { dir, dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const sid = "S-heal2";
    const path = writeTranscript(dir, sid, TURNS);
    captureTranscript(db, path, { clock: frozenClock(`${NIGHT}T03:00:00.000Z`) });

    // 夜1：失败 → 壳 + 账
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NIGHT}T20:00:00.000Z`), night: NIGHT, llm: failLlm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: { closure: async () => {}, decay: async () => {}, personality: async () => {}, diary: async () => {}, vectorize: async () => {} },
    });
    const shellId = shell(db, sid)!.id;
    const wmBefore = watermark(db, sid);

    // 夜2：makeup（本夜无此会话活动→不动它）+ heal（账冷却已过→愈合）
    await runNightlyDigestion(db, {
      clock: frozenClock(`${NEXT}T20:00:00.000Z`), night: NEXT, llm: goodLlm, config,
      findTranscripts: () => [{ sessionId: sid, path }],
      stageOverrides: MAKEUP_HEAL,
    });

    // 壳作废、不删原文
    expect(shell(db, sid)!.invalid_at).not.toBeNull();
    // 写了真自评，且 order_seq 继承壳 id（缝合排回原位）
    const real = db.query("SELECT id, order_seq FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL").get(sid) as { id: number; order_seq: number } | null;
    expect(real).not.toBeNull();
    expect(real!.order_seq).toBe(shellId);
    // 账删除（不会二次愈合）
    expect(db.query("SELECT count(*) c FROM review_heal WHERE session_id=? AND status='pending'").get(sid) as any).toMatchObject({ c: 0 });
    // 水位线一步不动（H1，断言两夜相等）
    expect(watermark(db, sid)).toBe(wmBefore);
    // 留 heal_success marker
    expect((db.query("SELECT count(*) c FROM situation_log WHERE kind='heal_success' AND session_id=?").get(sid) as any).c).toBe(1);
  });
});
