// work-memory 采集量上限 + 去重（§3A F-1）：filterWorkMemoryEvents
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { filterWorkMemoryEvents } from "../src/capture";
import { openDb } from "../src/db";
import { appendSituation, type SituationInput } from "../src/situation";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-caps-${Date.now()}-${n++}.db`));
const ts = (min: number) => new Date(Date.UTC(2026, 5, 21, 10, min, 0)).toISOString();
const read = (path: string, min: number, sid = "s"): SituationInput => ({
  sessionId: sid,
  project: "/p",
  kind: "file_read",
  payload: { path },
  occurredAt: ts(min),
});
const cmd = (category: string, min: number, sid = "s"): SituationInput => ({
  sessionId: sid,
  project: "/p",
  kind: "command_run",
  payload: { command: "x", category, ok: true, output: "" },
  occurredAt: ts(min),
});
const reads = (out: SituationInput[]) => out.filter((e) => e.kind === "file_read");
const cmds = (out: SituationInput[]) => out.filter((e) => e.kind === "command_run");
const hasOverflow = (out: SituationInput[]) => out.some((e) => e.kind === "work_capture_overflow");

describe("同文件 10 分钟去重", () => {
  test("10 分钟内重复 Read 同 path → 只采 1 次", () => {
    const out = filterWorkMemoryEvents(freshDb(), [read("/a", 0), read("/a", 5), read("/b", 0)]);
    expect(reads(out).length).toBe(2); // /a 去重、/b 留
  });

  test("超过 10 分钟同 path → 都采", () => {
    const out = filterWorkMemoryEvents(freshDb(), [read("/a", 0), read("/a", 20)]);
    expect(reads(out).length).toBe(2);
  });

  test("既有库存的同 path 近期 read 也参与去重", () => {
    const db = freshDb();
    appendSituation(db, read("/a", 0));
    const out = filterWorkMemoryEvents(db, [read("/a", 3)]); // 距上次 3 分钟
    expect(reads(out).length).toBe(0);
  });
});

describe("按会话采集量上限", () => {
  test("file_read 超 50 → 只留 50 + 溢出 marker", () => {
    const events = Array.from({ length: 60 }, (_, i) => read(`/f${i}`, i)); // 60 distinct path、错开时间不触发去重
    const out = filterWorkMemoryEvents(freshDb(), events);
    expect(reads(out).length).toBe(50);
    expect(hasOverflow(out)).toBe(true);
  });

  test("既有库存计入 cap：已 50 条 → 新 read 被丢", () => {
    const db = freshDb();
    for (let i = 0; i < 50; i++) appendSituation(db, read(`/old${i}`, i));
    const out = filterWorkMemoryEvents(db, [read("/new", 0)]);
    expect(reads(out).length).toBe(0);
    expect(hasOverflow(out)).toBe(true);
  });

  test("command_run 超 30 → 留 30，按类别优先级丢低信号（net 先丢，deploy 全留）", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => cmd("deploy", i)),
      ...Array.from({ length: 30 }, (_, i) => cmd("net", i)),
    ];
    const out = filterWorkMemoryEvents(freshDb(), events);
    expect(cmds(out).length).toBe(30);
    expect(cmds(out).filter((e) => (e.payload as { category: string }).category === "deploy").length).toBe(5);
    expect(cmds(out).filter((e) => (e.payload as { category: string }).category === "net").length).toBe(25);
    expect(hasOverflow(out)).toBe(true);
  });
});

describe("非 work 事件直通不受影响", () => {
  test("无 read/cmd 的批次原样返回（不查库不加 marker）", () => {
    const out = filterWorkMemoryEvents(freshDb(), [
      { sessionId: "s", project: "/p", kind: "user_message", payload: { text: "hi" } },
      { sessionId: "s", project: "/p", kind: "file_edit", payload: { path: "/a", tool: "Edit" } },
    ]);
    expect(out.length).toBe(2);
    expect(hasOverflow(out)).toBe(false);
  });
});
