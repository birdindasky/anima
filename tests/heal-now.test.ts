// healAllNow(一键立即全愈)验收。脚手架照 selfheal-acceptance:造假 transcript + mock LLM。
// 真值自定:全愈对所有 live 壳整段重嚼、无预算上限、按 transcript 真实回合重心纠日期、继承壳原位 order_seq;
// transcript 没了的壳不动、LLM 失败的留旧壳不写新壳。
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { insertExperience } from "../src/experiences";
import { healAllNow, type TranscriptRef } from "../src/digest";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-healnow-"));
  tmpDirs.push(dir);
  return { dir, dbPath: join(dir, "anima.db") };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = frozenClock(new Date("2026-06-20T12:00:00.000Z"));

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string };
function writeTranscript(dir: string, sid: string, turns: Turn[]): string {
  const lines = turns.map((t) =>
    JSON.stringify({
      uuid: t.uuid, parentUuid: null, isSidechain: false, sessionId: sid,
      timestamp: t.ts, cwd: "/Users/tester/Projects/demo", type: t.role,
      isMeta: false, message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
const goodLlm = async (prompt: string): Promise<string> =>
  prompt.includes("收工时间")
    ? JSON.stringify({ review: "愈合后的真自评：把这段失败切片补回顾了。", feeling: "踏实", intensity: "一般", keywords: ["愈合"], items: [] })
    : "{}";
const failLlm = async (): Promise<string> => {
  throw new Error("额度撞墙");
};

function turnsOn(day: string): Turn[] {
  return [
    { uuid: `${day}-u1`, ts: `${day}T01:00:00.000Z`, role: "user", text: `在 ${day} 把 config.ts 接了 YAML 解析。` },
    { uuid: `${day}-a1`, ts: `${day}T01:05:00.000Z`, role: "assistant", text: "好，改完跑回归全绿。" },
  ];
}
// 种一个 live 兜底壳 + 采集 transcript；壳故意错挂 wrongDate，验 healAllNow 用 transcript 重心纠正
function seedShell(db: Database, dir: string, sid: string, day: string, wrongDate: string) {
  const path = writeTranscript(dir, sid, turnsOn(day));
  captureTranscript(db, path, { clock });
  const shell = insertExperience(
    db,
    { kind: "self_review_fallback", project: "demo", content: "客观流水兜底摘要（占位）", sourceSession: sid, occurredAt: `${wrongDate}T04:00:00.000Z` },
    clock,
  );
  return { path, shellId: shell.id, sid };
}
const liveReview = (db: Database, sid: string) =>
  db.query("SELECT id, occurred_at, order_seq, content FROM experiences WHERE kind='self_review' AND source_session=? AND invalid_at IS NULL").get(sid) as
    | { id: number; occurred_at: string; order_seq: number; content: string }
    | null;
const shellRow = (db: Database, sid: string) =>
  db.query("SELECT id, invalid_at FROM experiences WHERE kind='self_review_fallback' AND source_session=?").get(sid) as { id: number; invalid_at: string | null } | null;

test("healAllNow：所有 live 壳整段重嚼成真自评，无预算上限，按 transcript 重心纠日期，继承壳原位 order_seq", async () => {
  const { dbPath, dir } = tmpHome();
  const db = openDb(dbPath);
  // 6 个壳全故意错挂 06-12；真实活动各在不同日 → 验全处理 + 纠日期
  const days = ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-13", "2026-06-14"];
  const seeds = days.map((d, i) => seedShell(db, dir, `sess-${i}`, d, "2026-06-12"));
  const refs: TranscriptRef[] = seeds.map((s) => ({ sessionId: s.sid, path: s.path }));

  const r = await healAllNow(db, { llm: goodLlm, findTranscripts: () => refs, clock, concurrency: 3 });

  expect(r.total).toBe(6);
  expect(r.healed).toBe(6);
  expect(r.failed).toBe(0);
  seeds.forEach((s, i) => {
    expect(shellRow(db, s.sid)!.invalid_at).not.toBeNull(); // 壳作废
    const rev = liveReview(db, s.sid)!;
    expect(rev).toBeTruthy();
    expect(rev.content).toContain("愈合后的真自评");
    expect(rev.occurred_at.slice(0, 10)).toBe(days[i]); // 日期=transcript 重心，非壳错挂的 06-12
    expect(rev.order_seq).toBe(s.shellId); // 继承壳原位
  });
  db.close();
});

test("healAllNow：transcript 没了的壳不动(noTranscript)；LLM 失败留旧壳、不写新壳(failed)；好了再愈", async () => {
  const { dbPath, dir } = tmpHome();
  const db = openDb(dbPath);
  const ok = seedShell(db, dir, "ok", "2026-06-10", "2026-06-10");
  seedShell(db, dir, "gone", "2026-06-10", "2026-06-10");
  const refs: TranscriptRef[] = [{ sessionId: "ok", path: ok.path }]; // 故意不含 gone

  // LLM 全失败：ok 试了但败、gone 无 transcript
  const rFail = await healAllNow(db, { llm: failLlm, findTranscripts: () => refs, clock, concurrency: 2 });
  expect(rFail.healed).toBe(0);
  expect(rFail.failed).toBe(1);
  expect(rFail.noTranscript).toBe(1);
  expect(liveReview(db, "ok")).toBeNull(); // 失败不写新自评
  expect(shellRow(db, "ok")!.invalid_at).toBeNull(); // 旧壳没作废，留着下次

  // LLM 好了再跑：ok 愈，gone 仍无 transcript、壳不动
  const rGood = await healAllNow(db, { llm: goodLlm, findTranscripts: () => refs, clock, concurrency: 2 });
  expect(rGood.healed).toBe(1);
  expect(rGood.noTranscript).toBe(1);
  expect(shellRow(db, "ok")!.invalid_at).not.toBeNull();
  expect(shellRow(db, "gone")!.invalid_at).toBeNull();
  db.close();
});
