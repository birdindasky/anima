// 独立盲考官 R3 对抗测试：失败的 file_edit（is_error 的 tool_result）不得产生"文件已改"事件。
// 旧行为（tool_use 时无条件落 file_edit）在这些断言下应为红；新行为（按 ok 门控）应为绿。
import { describe, expect, test } from "bun:test";
import { extractEvents } from "../src/capture";
import type { TranscriptEntry } from "../src/transcript";

function e(partial: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    type: "user",
    uuid: "u",
    sessionId: "s",
    cwd: "/p",
    timestamp: "2026-07-03T10:00:00.000Z",
    isMeta: false,
    isSidechain: false,
    role: "user",
    content: "",
    ...partial,
  };
}
// deno-lint-ignore no-explicit-any
const asst = (blocks: any[], uuid = "a") => e({ type: "assistant", uuid, role: "assistant", content: blocks });
// deno-lint-ignore no-explicit-any
const res = (blocks: any[], uuid = "u2") => e({ uuid, content: blocks });
// deno-lint-ignore no-explicit-any
const byKind = (evs: any[], kind: string) => evs.filter((x) => x.kind === kind);

const editUse = (id: string, name = "Edit") =>
  asst([
    {
      type: "tool_use",
      id,
      name,
      input: { file_path: "/proj/foo.ts", old_string: "AAA", new_string: "BBB" },
    },
  ]);

describe("R3：失败的编辑不产生 file_edit 幽灵事件", () => {
  test("Edit 报错(is_error:true, old_string 没匹配) → 零 file_edit，落 tool_error", () => {
    const ev = extractEvents([
      editUse("e1"),
      res([{
        type: "tool_result",
        tool_use_id: "e1",
        content: "String to replace not found in file.",
        is_error: true,
      }]),
    ]);
    expect(byKind(ev, "file_edit").length).toBe(0);
    expect(byKind(ev, "tool_error").length).toBe(1);
  });

  test('Write 报错("File has not been read yet") → 零 file_edit', () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/proj/new.ts", content: "x" } }]),
      res([{
        type: "tool_result",
        tool_use_id: "w1",
        content: "File has not been read yet. Read it first before writing to it.",
        is_error: true,
      }]),
    ]);
    expect(byKind(ev, "file_edit").length).toBe(0);
  });

  test("MultiEdit 报错 → 零 file_edit", () => {
    const ev = extractEvents([
      asst([{ type: "tool_use", id: "m1", name: "MultiEdit", input: { file_path: "/proj/a.ts", edits: [{ old_string: "a", new_string: "b" }] } }]),
      res([{ type: "tool_result", tool_use_id: "m1", content: "no match", is_error: true }]),
    ]);
    expect(byKind(ev, "file_edit").length).toBe(0);
  });

  test("成功的 Edit(is_error:false) → 恰好一条 file_edit（对照组，防过度门控）", () => {
    const ev = extractEvents([
      editUse("e2"),
      res([{ type: "tool_result", tool_use_id: "e2", content: "The file /proj/foo.ts has been updated.", is_error: false }]),
    ]);
    const fe = byKind(ev, "file_edit");
    expect(fe.length).toBe(1);
    expect(fe[0].payload.path).toBe("/proj/foo.ts");
    expect(fe[0].payload.tool).toBe("Edit");
    expect(typeof fe[0].payload.change).toBe("string");
  });

  test("成功 Edit + 之后失败 Edit 混流 → 只有成功那条落 file_edit", () => {
    const ev = extractEvents([
      editUse("ok1"),
      res([{ type: "tool_result", tool_use_id: "ok1", content: "updated", is_error: false }]),
      editUse("bad1"),
      res([{ type: "tool_result", tool_use_id: "bad1", content: "String to replace not found", is_error: true }]),
    ]);
    expect(byKind(ev, "file_edit").length).toBe(1);
    expect(byKind(ev, "tool_error").length).toBe(1);
  });
});
