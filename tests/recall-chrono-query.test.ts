// codex 终审 F2：scope='actions' 录像层 chrono 要支持 query 软筛（"config.ts 啥时候改的"按 config.ts 筛，
// 不退化成整窗流水）。query 可空=窗内全取；非空=OR 软筛(LIKE over payload)、不套覆盖率门槛。
// codex 终审 m1：chronoFork 日记层/录像层 includeGlobal 默认一致（都默认收全局）。
// 红灯先行：实现前 listReceiptsChrono 无 query 参数、receipts() 不传 query。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { frozenClock } from "../src/clock";
import { listReceiptsChrono, searchMemoryIndex } from "../src/recall";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-cq-${process.pid}-${n++}.db`));
const SINCE = "2026-06-12T16:00:00.000Z";
const UNTIL = "2026-06-13T16:00:00.000Z";
const clock = frozenClock("2026-06-13T03:00:00.000Z");
const at = "2026-06-13T03:00:00.000Z";

describe("录像层 chrono query 软筛（F2）+ includeGlobal 一致（m1）", () => {
  test("listReceiptsChrono 带 query → 只返命中 payload 的小票", () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_edit", project: "/p", payload: { path: "/p/config.ts", change: "yaml" }, occurredAt: at });
    appendSituation(db, { kind: "file_edit", project: "/p", payload: { path: "/p/server.ts", change: "x" }, occurredAt: at });
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "vim config.ts" }, occurredAt: at });
    const hit = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/p", query: "config.ts" });
    const lines = hit.map((r) => r.line).join("|");
    expect(hit.length).toBe(2); // config.ts 的 file_edit + vim config.ts
    expect(lines).toContain("config.ts");
    expect(lines).not.toContain("server.ts");
  });

  test("listReceiptsChrono 空 query → 窗内全取（不变）", () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_read", project: "/p", payload: { path: "/p/a" }, occurredAt: at });
    appendSituation(db, { kind: "file_read", project: "/p", payload: { path: "/p/b" }, occurredAt: at });
    expect(listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/p" }).length).toBe(2);
  });

  test("scope='actions' 透传 query：'config.ts 啥时候改的' 只返 config.ts 动作", () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_edit", project: "/p", payload: { path: "/p/config.ts", change: "yaml" }, occurredAt: at });
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git status" }, occurredAt: at });
    const out = searchMemoryIndex(db, "config.ts", { order: "chrono", scope: "actions", sinceTs: SINCE, untilTs: UNTIL, project: "/p", clock });
    expect(out.length).toBe(1);
    expect(out[0]!.line).toContain("config.ts");
  });

  test("m1：includeGlobal 默认（未指定）→ 录像层收全局 project=NULL", () => {
    const db = freshDb();
    appendSituation(db, { kind: "file_read", project: null, payload: { path: "/global/z" }, occurredAt: at });
    // 未传 includeGlobal → 应默认收全局（与日记层口径一致）
    const out = listReceiptsChrono(db, { sinceTs: SINCE, untilTs: UNTIL, project: "/p" });
    expect(out.map((r) => r.line).join("|")).toContain("/global/z");
  });
});
