// codex 终审 F1：recall_detail 放开 kind 后无 project 墙——#s 全局自增，被枚举就能跨项目拉
// 别项目的命令输出/文件路径。修：renderMemoryDetail 的 situation 路支持 project 过滤（给了 project 就
// 别项目不返、含全局 project=NULL）；MCP recall_detail 透传 project。
// 红灯先行：实现前 situation 查询只 WHERE id=?，无 project 墙。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { frozenClock } from "../src/clock";
import { renderMemoryDetail } from "../src/recall";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-dp-${process.pid}-${n++}.db`));
const clock = frozenClock("2026-06-13T03:00:00.000Z");
const at = "2026-06-13T03:00:00.000Z";

describe("recall_detail project 墙（F1 跨项目隔离）", () => {
  test("给了 project：本项目的小票能拉", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "command_run", project: "/mine", payload: { command: "git push" }, occurredAt: at });
    expect(renderMemoryDetail(db, "situation", r.id, { clock, project: "/mine" })).toContain("git push");
  });

  test("给了 project：别项目的小票拉不到（返 null，不越墙）", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "command_run", project: "/other", payload: { command: "secret-deploy --token X" }, occurredAt: at });
    expect(renderMemoryDetail(db, "situation", r.id, { clock, project: "/mine" })).toBeNull();
  });

  test("给了 project：全局小票（project=NULL）仍可拉（includeGlobal 语义）", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "file_read", project: null, payload: { path: "/global/x" }, occurredAt: at });
    expect(renderMemoryDetail(db, "situation", r.id, { clock, project: "/mine" })).toContain("/global/x");
  });

  test("不给 project：维持旧行为（任意项目可拉，向后兼容）", () => {
    const db = freshDb();
    const r = appendSituation(db, { kind: "file_read", project: "/whatever", payload: { path: "/whatever/y" }, occurredAt: at });
    expect(renderMemoryDetail(db, "situation", r.id, { clock })).toContain("/whatever/y");
  });
});
