// AUDIT-2026-06-29 A区#4 复现 + 修复验收：并发采集永久重复写 situation_log。
// Stop hook（每回合）与 worker 会同采一份 transcript、各持不同锁。旧码游标读在写事务外 → 两路按同一旧游标
// 算出同一段 fresh、都写 → situation_log 无唯一约束 → 同一动作两条、永久。
// 修：写事务 BEGIN IMMEDIATE + 事务内重读游标做 CAS——已被对手推进就整体让出（绝不重复写，剩余留下轮采）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript, getCursor } from "../src/capture";
import type { TranscriptEntry } from "../src/transcript";
import { listSituations } from "../src/situation";

const NOW = "2026-06-10T18:00:00.000Z";
const PATH = "/fake/transcript-s1.jsonl";

function entry(p: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    type: "user", uuid: "u", sessionId: "s1", cwd: "/p",
    timestamp: "2026-06-10T10:00:00.000Z", isMeta: false, isSidechain: false,
    role: "user", content: "", ...p,
  };
}
const ENTRIES: TranscriptEntry[] = [
  entry({ uuid: "u1", content: "第一句真话" }),
  entry({ uuid: "u2", content: "第二句真话" }),
];

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-cap4-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("并发采集去重（AUDIT A区#4）：游标 CAS 防同段双写", () => {
  test("我读完游标后对手抢先采同段 → 我让出，situation_log 不翻倍", () => {
    const db = tmpDb();
    const res = captureTranscript(db, PATH, {
      clock: frozenClock(NOW),
      entries: ENTRIES,
      // 模拟另一路(worker/hook)在我读游标后、进写事务前，抢先把同段采了并推进游标。
      afterRead: () => {
        const other = captureTranscript(db, PATH, { clock: frozenClock(NOW), entries: ENTRIES });
        expect(other.captured).toBe(2); // 对手成功采 2 条 user_message
      },
    });

    // 我方 CAS 命中 → 整体让出（不写第二份）
    expect(res.captured).toBe(0);
    expect(res.cursor).toBe("u2"); // 让出后返回已被对手推进的游标
    // 关键：每个 user_message 只有一条，没因并发翻倍成 4 条
    expect(listSituations(db, { kind: "user_message" }).length).toBe(2);
    expect(getCursor(db, PATH)).toBe("u2");
  });

  test("无并发 → 正常采集照常写入并推进游标（防过度修复）", () => {
    const db = tmpDb();
    const res = captureTranscript(db, PATH, { clock: frozenClock(NOW), entries: ENTRIES });
    expect(res.captured).toBe(2);
    expect(res.cursor).toBe("u2");
    expect(listSituations(db, { kind: "user_message" }).length).toBe(2);
    expect(getCursor(db, PATH)).toBe("u2");
  });
});
