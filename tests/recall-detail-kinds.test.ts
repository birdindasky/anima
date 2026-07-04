// DESIGN-WORK-TIMELINE §3D：recall_detail 放开 kind。放开 chrono 返回 file_read/command_run/file_edit 后，
// 对这些 #s 拉全文不能再返"没这条记忆"。按 kind 取对应 payload 字段渲染，缺字段降级、绝不返 NULL。
// 红灯先行：实现前 renderMemoryDetail 的 situation 路只认 kind='user_message'。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { frozenClock } from "../src/clock";
import { renderMemoryDetail } from "../src/recall";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-detail-${process.pid}-${n++}.db`));
const clock = frozenClock("2026-06-13T03:00:00.000Z");
const at = "2026-06-13T03:00:00.000Z";

describe("recall_detail 放开 work-action kind", () => {
  test("command_run：拉全文含 command + 输出（不返 null）", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git push origin main", category: "git", ok: true, output: "Everything up-to-date" }, occurredAt: at });
    const out = renderMemoryDetail(db, "situation", r.id, { clock });
    expect(out).not.toBeNull();
    expect(out!).toContain("git push origin main");
    expect(out!).toContain("Everything up-to-date");
  });

  test("file_edit：拉全文含 path + change", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "file_edit", project: "/p", payload: { path: "/p/config.ts", tool: "Edit", change: "TOML→YAML" }, occurredAt: at });
    const out = renderMemoryDetail(db, "situation", r.id, { clock });
    expect(out).not.toBeNull();
    expect(out!).toContain("/p/config.ts");
    expect(out!).toContain("TOML→YAML");
  });

  test("file_read：拉全文含 path", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "file_read", project: "/p", payload: { path: "/p/server.ts" }, occurredAt: at });
    const out = renderMemoryDetail(db, "situation", r.id, { clock });
    expect(out).not.toBeNull();
    expect(out!).toContain("/p/server.ts");
  });

  test("user_message：旧行为不变（仍能拉全文原话）", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "user_message", project: "/p", payload: { text: "把配置换成 YAML", uuid: "u1" }, occurredAt: at });
    const out = renderMemoryDetail(db, "situation", r.id, { clock });
    expect(out).not.toBeNull();
    expect(out!).toContain("把配置换成 YAML");
  });

  test("非 work-action kind（test_run）仍返 null（不暴露非时间线小票）", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "test_run", project: "/p", payload: { command: "bun test", ok: true }, occurredAt: at });
    expect(renderMemoryDetail(db, "situation", r.id, { clock })).toBeNull();
  });
});
