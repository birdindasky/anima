// DESIGN-WORK-TIMELINE §3A：细粒度小票 chrono 路 listReceiptsChrono。
// 纯时间窗 SQL，按 occurred_at（真实动作时间）排，绝不用 created_at/id；放开到 4 个 work-action kind；
// 自带 project 墙；左闭右开 [sinceTs, untilTs)。红灯先行：实现前 recall.ts 无 listReceiptsChrono 导出。
//   F2 核心：occurred_at 与 created_at/id 倒挂时，排序跟 occurred_at 走
//   kind 过滤：只收 user_message/file_read/command_run/file_edit，排除 test_run/tool_error
//   左闭右开：since 含、until 不含
//   project 墙：别项目不越墙；includeGlobal 收 project=NULL
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { frozenClock } from "../src/clock";
import { listReceiptsChrono } from "../src/recall";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-chrono-${process.pid}-${n++}.db`));

// today 窗（钟在东八 06-13）：[2026-06-12T16:00Z, 2026-06-13T16:00Z)
const SINCE = "2026-06-12T16:00:00.000Z";
const UNTIL = "2026-06-13T16:00:00.000Z";

describe("listReceiptsChrono（细粒度小票时间线）", () => {
  test("F2：按 occurred_at 排，不随 created_at/id 倒挂", () => {
    const db = freshDb();
    // P 先插（id 小、created_at 早），但 occurredAt 晚；Q 后插（id 大、created_at 晚），occurredAt 早
    appendSituation(
      db,
      { kind: "command_run", project: "/proj", payload: { command: "git push" }, occurredAt: "2026-06-13T05:00:00.000Z" },
      frozenClock("2026-06-13T05:00:00.000Z"),
    );
    appendSituation(
      db,
      { kind: "command_run", project: "/proj", payload: { command: "bun test" }, occurredAt: "2026-06-13T01:00:00.000Z" },
      frozenClock("2026-06-13T09:00:00.000Z"),
    );
    const rows = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/proj" });
    // occurred_at DESC → P(05:00,id1) 在前、Q(01:00,id2) 在后；若错用 id/created_at DESC 则 Q 在前
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows[0]!.line).toContain("git push");
  });

  test("kind 过滤：只收 4 个 work-action kind，排除 test_run/tool_error", () => {
    const db = freshDb();
    const at = "2026-06-13T03:00:00.000Z";
    appendSituation(db, { kind: "user_message", project: "/p", payload: { text: "改个配置" }, occurredAt: at });
    appendSituation(db, { kind: "file_read", project: "/p", payload: { path: "/p/a.ts" }, occurredAt: at });
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git status" }, occurredAt: at });
    appendSituation(db, { kind: "file_edit", project: "/p", payload: { path: "/p/b.ts", change: "x" }, occurredAt: at });
    appendSituation(db, { kind: "test_run", project: "/p", payload: { command: "bun test", ok: true }, occurredAt: at });
    appendSituation(db, { kind: "tool_error", project: "/p", payload: { tool: "Read", snippet: "boom" }, occurredAt: at });
    const rows = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/p" });
    const kinds = rows.map((r) => r.id).length;
    expect(kinds).toBe(4); // 只 4 条 work-action
  });

  test("左闭右开：since 含、until 不含", () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_read", project: "/p", payload: { path: "/at-since" }, occurredAt: SINCE });
    appendSituation(db, { kind: "file_read", project: "/p", payload: { path: "/at-until" }, occurredAt: UNTIL });
    const rows = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/p" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.line).toContain("/at-since");
  });

  test("project 墙：别项目不越墙；includeGlobal 收 project=NULL", () => {
    const db = freshDb();
    const at = "2026-06-13T03:00:00.000Z";
    appendSituation(db, { kind: "file_read", project: "/mine", payload: { path: "/mine/x" }, occurredAt: at });
    appendSituation(db, { kind: "file_read", project: "/other", payload: { path: "/other/y" }, occurredAt: at });
    appendSituation(db, { kind: "file_read", project: null, payload: { path: "/global/z" }, occurredAt: at });
    const mine = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/mine", includeGlobal: true });
    const lines = mine.map((r) => r.line).join("|");
    expect(lines).toContain("/mine/x");
    expect(lines).toContain("/global/z"); // includeGlobal
    expect(lines).not.toContain("/other/y"); // 别项目不越墙
  });

  test("limit 生效", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++)
      appendSituation(db, { kind: "file_read", project: "/p", payload: { path: `/f${i}` }, occurredAt: `2026-06-13T0${i}:30:00.000Z` });
    const rows = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/p", limit: 2 });
    expect(rows.length).toBe(2);
  });
});
