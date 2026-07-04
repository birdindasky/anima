// captureTranscript 单调守卫（codex round-6 IMPORTANT）：传入的快照若比 DB 采集游标还旧（不含游标那条），
// 绝不退化成"整段重采"——否则 situation_log 无唯一约束会重复插事件、游标回退。默认读路径不受影响。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript, getCursor } from "../src/capture";
import { readTranscriptEntries } from "../src/transcript";

const tmpDirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "anima-capmono-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTurns(dir: string, n: number): string {
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      uuid: `u${i + 1}`,
      parentUuid: null,
      isSidechain: false,
      sessionId: "sess-cap",
      timestamp: `2026-06-10T0${i + 1}:00:00.000Z`,
      cwd: "/proj",
      type: "user",
      isMeta: false,
      message: { role: "user", content: `用户第 ${i + 1} 句实质内容` },
    }),
  );
  const p = join(dir, "t.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
function sitCount(db: ReturnType<typeof openDb>): number {
  return (db.query("SELECT count(*) c FROM situation_log").get() as { c: number }).c;
}

describe("captureTranscript 单调守卫", () => {
  test("陈旧快照（不含当前游标）→ no-op：不重复采、游标不回退", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTurns(dir, 3); // u1,u2,u3 都是 user 回合 → 3 条 user_message
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T10:00:00.000Z") });
    expect(getCursor(db, path)).toBe("u3");
    const after1 = sitCount(db);
    expect(after1).toBe(3);

    // 喂一个只含 u1 的陈旧快照（不含当前游标 u3）→ 守卫 no-op
    const stale = readTranscriptEntries(path).slice(0, 1);
    const r = captureTranscript(db, path, { clock: frozenClock("2026-06-10T11:00:00.000Z"), entries: stale });
    expect(r.captured).toBe(0);
    expect(getCursor(db, path)).toBe("u3"); // 游标没回退到 u1
    expect(sitCount(db)).toBe(after1); // 没重复插事件
  });

  test("一致快照（含当前游标）→ 正常前向采集新尾巴", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTurns(dir, 3);
    captureTranscript(db, path, { clock: frozenClock("2026-06-10T10:00:00.000Z") });
    expect(getCursor(db, path)).toBe("u3");

    // 追加 u4，传完整快照（含游标 u3）→ 正常采 u4
    const path4 = writeTurns(dir, 4);
    const full = readTranscriptEntries(path4);
    const r = captureTranscript(db, path, { clock: frozenClock("2026-06-10T12:00:00.000Z"), entries: full });
    expect(r.captured).toBe(1); // 只新采 u4
    expect(getCursor(db, path)).toBe("u4");
    expect(sitCount(db)).toBe(4);
  });
});
