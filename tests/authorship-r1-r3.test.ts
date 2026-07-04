// R1 + R3（AUDIT-2026-07-03 全项目第一性原理审查）红灯先行 → 转绿的验收测试。
//
// R1：采集把 harness 合成的"假用户轮次"当用户原话记进永久库。旧采集只有 isMeta/isSidechain +
//     isCompactSummary 两道闸；斜杠命令展开（<command-name>/<command-message>/<command-args>）、
//     后台 <task-notification>、<local-command-stdout>、队友信封（"Another Claude session sent a
//     message:" + <teammate-message>）、以及 anima 自己 self-review prompt 被子代理回吐（自我复读
//     回声环）全部漏进 kind='user_message'。生产快照实测污染 ~1400 条。
//     修：新增 authorship 单一事实源谓词——写侧（capture）不落库 + 读侧（recall/selfReview）跳过存量。
//
// R3：唯独 file_edit 在 assistant 的 tool_use 块**无条件**落库（此时无 tool_result、无从知成败）；
//     失败的 Edit 照样产一条"文件已改"幽灵、且同 id 的 tool_result 又落一条 tool_error（双记）。
//     修：落库挪到 tool_result 分支按 ok(is_error!==true) 门控，与 Bash/Read/test 一致。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { extractEvents, captureTranscript } from "../src/capture";
import { appendSituation, listSituations } from "../src/situation";
import { searchRawReceipts, listReceiptsChrono, renderMemoryDetail } from "../src/recall";
import { buildMaterial } from "../src/selfReview";
import { readTranscriptEntries } from "../src/transcript";
import {
  isSyntheticUserText,
  isSyntheticUserTurn,
  isHumanAuthoredTurn,
} from "../src/authorship";
import { frozenClock } from "../src/clock";
import type { TranscriptEntry, ContentBlock } from "../src/transcript";

const SX = "sess-r1r3";
const CWD = "/proj";
const clock = frozenClock("2026-06-21T12:00:00.000Z");
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function newTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "r1r3-"));
  tmpDirs.push(d);
  return d;
}
function writeJsonl(name: string, lines: unknown[]): string {
  const p = join(newTmp(), name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}
let tsN = 0;
function ts(): string {
  return new Date(Date.UTC(2026, 5, 21, 10, tsN++ % 60, 0)).toISOString();
}

// ── 真机形态的合成"假用户轮"正文（照抄生产快照）────────────────────────────
const SLASH_CMD = "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>";
const CMD_MESSAGE = "<command-message>find-skills</command-message>\n<command-name>/find-skills</command-name>\n<command-args>x</command-args>";
const TASK_NOTIF = "<task-notification>\n<task-id>b6mu3hrc7</task-id>\n<status>killed</status>\n<summary>Background command was stopped</summary>\n</task-notification>";
const LOCAL_STDOUT = "<local-command-stdout>Set model to Fable 5 and saved as your default</local-command-stdout>";
const TEAMMATE = 'Another Claude session sent a message:\n<teammate-message teammate_id="subj-examiner" color="green">\n{"type":"idle_notification"}\n</teammate-message>';
// anima 自评 prompt 回吐（自我复读回声环）——照抄 buildSelfReviewPrompt 开头
const SELFREVIEW_ECHO = "你是 anima——这台机器上 Claude Code 的魂。现在是收工时间，请以第一人称回顾今天这个会话，写给未来的自己看。\n\n<material>\n## 对话节选\n用户：随便说\n</material>";

const ALL_SYNTHETIC = { SLASH_CMD, CMD_MESSAGE, TASK_NOTIF, LOCAL_STDOUT, TEAMMATE, SELFREVIEW_ECHO };

// entry 工厂（含 promptSource，默认 null）
function userLine(uuid: string, content: string | ContentBlock[], extra: Record<string, unknown> = {}) {
  return { type: "user", uuid, sessionId: SX, cwd: CWD, timestamp: ts(), message: { role: "user", content }, ...extra };
}
function asstBlocks(uuid: string, blocks: ContentBlock[]) {
  return { type: "assistant", uuid, sessionId: SX, cwd: CWD, timestamp: ts(), message: { role: "assistant", content: blocks } };
}
function toolResult(uuid: string, blocks: ContentBlock[]) {
  return { type: "user", uuid, sessionId: SX, cwd: CWD, timestamp: ts(), message: { role: "user", content: blocks } };
}

// 直接喂给 extractEvents 的 TranscriptEntry（content 在顶层，非 message.content）
function teEntry(type: "user" | "assistant", uuid: string, content: string | ContentBlock[]): TranscriptEntry {
  return {
    type, uuid, sessionId: SX, cwd: CWD, timestamp: ts(),
    isMeta: false, isSidechain: false, isCompactSummary: false, isVisibleInTranscriptOnly: false,
    promptSource: null, role: type, content,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// R1-A authorship 谓词单元测试（单一事实源）
// ═══════════════════════════════════════════════════════════════════════════
describe("R1-A authorship 谓词", () => {
  test("isSyntheticUserText：六种合成形态全命中", () => {
    for (const [name, body] of Object.entries(ALL_SYNTHETIC)) {
      expect(isSyntheticUserText(body)).toBe(true);
    }
  });

  test("isSyntheticUserText：行首带空白仍命中（trimStart）", () => {
    expect(isSyntheticUserText("   \n" + TASK_NOTIF)).toBe(true);
  });

  test("isSyntheticUserText：真实用户原话不命中（零误伤）", () => {
    expect(isSyntheticUserText("帮我把 config.ts 的 TOML 换成 YAML")).toBe(false);
    expect(isSyntheticUserText("缓存穿透问题应该怎么解决才稳妥")).toBe(false);
    expect(isSyntheticUserText("")).toBe(false);
    expect(isSyntheticUserText(null)).toBe(false);
    expect(isSyntheticUserText(undefined)).toBe(false);
  });

  test("isSyntheticUserText：标记出现在正文中间（非行首）不命中——修的是行首锚定不是内容嗅探", () => {
    // 真实用户可能引用/讨论这些标记；只要不是以它开头就不误杀
    expect(isSyntheticUserText("我想问下 <command-name> 这个标签是干嘛的")).toBe(false);
    expect(isSyntheticUserText("日志里看到 <task-notification> 之后就卡住了，为什么")).toBe(false);
  });

  test("isSyntheticUserTurn：promptSource=system 权威判定（正文再普通也算合成）", () => {
    const es = readTranscriptEntries(
      writeJsonl("ps.jsonl", [userLine("p1", "这看起来像普通话但来自系统", { promptSource: "system" })]),
    );
    expect(isSyntheticUserTurn(es[0]!)).toBe(true);
    expect(isHumanAuthoredTurn(es[0]!)).toBe(false);
  });

  test("isSyntheticUserTurn：assistant 条目一律 false（只判用户轮）", () => {
    const es = readTranscriptEntries(
      writeJsonl("as.jsonl", [asstBlocks("a1", [{ type: "text", text: "我：<command-name> 只是我在解释" }])]),
    );
    expect(isSyntheticUserTurn(es[0]!)).toBe(false);
  });

  test("isHumanAuthoredTurn：真实用户轮 true，合成轮 false", () => {
    const es = readTranscriptEntries(
      writeJsonl("h.jsonl", [userLine("r1", "真实问题"), userLine("s1", SLASH_CMD)]),
    );
    expect(isHumanAuthoredTurn(es[0]!)).toBe(true);
    expect(isHumanAuthoredTurn(es[1]!)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1-B 写侧：合成轮不落 user_message；真实轮照落
// ═══════════════════════════════════════════════════════════════════════════
describe("R1-B 写侧 extractEvents/captureTranscript", () => {
  test("六种合成 string 轮全部不落 user_message，真实轮落", () => {
    const lines: unknown[] = [userLine("real1", "缓存穿透独门标记问题")];
    let i = 0;
    for (const body of Object.values(ALL_SYNTHETIC)) lines.push(userLine(`syn${i++}`, body));
    lines.push(userLine("real2", "数据库连接池独门标记问题"));
    const db = openDb(join(newTmp(), "a.db"));
    captureTranscript(db, writeJsonl("syn.jsonl", lines), { clock });
    const texts = listSituations(db, { sessionId: SX })
      .filter((s) => s.kind === "user_message")
      .map((s) => String((s.payload as { text?: string }).text ?? ""));
    expect(texts).toContain("缓存穿透独门标记问题");
    expect(texts).toContain("数据库连接池独门标记问题");
    expect(texts.length).toBe(2); // 只有两条真实的
    // 合成标记一个都不许留
    expect(texts.some((t) => t.includes("<command-name>") || t.includes("<task-notification>") || t.includes("你是 anima——这台机器上"))).toBe(false);
  });

  test("promptSource=system 的 task-notification 不落库（元数据权威）", () => {
    const db = openDb(join(newTmp(), "b.db"));
    captureTranscript(db, writeJsonl("ps2.jsonl", [
      userLine("p1", "后台任务被杀了", { promptSource: "system" }),
      userLine("r1", "真实的话保留"),
    ]), { clock });
    const texts = listSituations(db, { sessionId: SX }).filter((s) => s.kind === "user_message").map((s) => String((s.payload as { text?: string }).text));
    expect(texts).toEqual(["真实的话保留"]);
  });

  test("合成轮以 block(text) 形态出现也不落库", () => {
    const db = openDb(join(newTmp(), "bl.db"));
    captureTranscript(db, writeJsonl("blk.jsonl", [
      userLine("s1", [{ type: "text", text: TASK_NOTIF }] as unknown as ContentBlock[]),
      userLine("r1", "真实 block 原话独门标记"),
    ]), { clock });
    const texts = listSituations(db, { sessionId: SX }).filter((s) => s.kind === "user_message").map((s) => String((s.payload as { text?: string }).text));
    expect(texts).toContain("真实 block 原话独门标记");
    expect(texts.some((t) => t.includes("<task-notification>"))).toBe(false);
  });

  test("零误伤：真实用户引用 <command-name> 标记但不以它开头 → 照常落库", () => {
    const disguised = "帮我查一下 <command-name> 这个尖括号标签在 transcript 里是什么意思，缓存击穿独门标记";
    const db = openDb(join(newTmp(), "d.db"));
    captureTranscript(db, writeJsonl("dis.jsonl", [userLine("u1", disguised)]), { clock });
    const texts = listSituations(db, { sessionId: SX }).filter((s) => s.kind === "user_message").map((s) => String((s.payload as { text?: string }).text));
    expect(texts.some((t) => t.includes("缓存击穿独门标记"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1-C 读侧：存量污染（直接插库模拟 ~1388 条）永不再浮到模型/召回面前
// ═══════════════════════════════════════════════════════════════════════════
describe("R1-C 读侧 recall 对存量合成行不再返回", () => {
  const MARK = "zqxwmarker"; // 合成行与真实行都含它，用于制造"若不排除就会被召回"
  function seedPollution(db: ReturnType<typeof openDb>) {
    // 直接 append（模拟历史采集时落进库的合成 user_message，绕过写侧新闸）
    appendSituation(db, { sessionId: SX, project: CWD, kind: "user_message", payload: { text: `${TASK_NOTIF} ${MARK}`, uuid: "p1" }, occurredAt: "2026-06-20T10:00:00.000Z" }, clock);
    appendSituation(db, { sessionId: SX, project: CWD, kind: "user_message", payload: { text: `${SLASH_CMD} ${MARK}`, uuid: "p2" }, occurredAt: "2026-06-20T10:01:00.000Z" }, clock);
    // 真实行（含同一 MARK，且 id 更小——证明排除在 SQL 内做、LIMIT 只数干净行）
    appendSituation(db, { sessionId: SX, project: CWD, kind: "user_message", payload: { text: `${MARK} 这是真实用户原话甲`, uuid: "r1" }, occurredAt: "2026-06-20T09:00:00.000Z" }, clock);
    appendSituation(db, { sessionId: SX, project: CWD, kind: "user_message", payload: { text: `${MARK} 这是真实用户原话乙`, uuid: "r2" }, occurredAt: "2026-06-20T09:01:00.000Z" }, clock);
  }

  test("searchRawReceipts：合成行不返回，真实行返回；LIMIT 只数干净行", () => {
    const db = openDb(join(newTmp(), "c.db"));
    seedPollution(db);
    const rows = searchRawReceipts(db, MARK, { limit: 2 });
    // 合成行 id 更大、若不排除会靠 id DESC 顶掉真实行；排除后 limit=2 拿到的必须全是真实行
    expect(rows.length).toBe(2);
    expect(rows.every((r) => !r.text.includes("<task-notification>") && !r.text.includes("<command-name>"))).toBe(true);
    expect(rows.every((r) => r.text.includes("真实用户原话"))).toBe(true);
  });

  test("listReceiptsChrono：窗内合成 user_message 被排除，真实 user_message 与其它 kind 保留", () => {
    const db = openDb(join(newTmp(), "cc.db"));
    seedPollution(db);
    // 同窗放一条 file_edit（非 user_message，不该被合成闸误伤）
    appendSituation(db, { sessionId: SX, project: CWD, kind: "file_edit", payload: { path: "src/keep.ts", tool: "Edit", change: "- a | + b" }, occurredAt: "2026-06-20T09:30:00.000Z" }, clock);
    const lines = listReceiptsChrono(db, { sinceTs: "2026-06-20T00:00:00.000Z", untilTs: "2026-06-21T00:00:00.000Z", limit: 50 }).map((l) => l.line);
    const joined = lines.join("\n");
    expect(joined).toContain("真实用户原话甲");
    expect(joined).toContain("真实用户原话乙");
    expect(joined).toContain("src/keep.ts"); // file_edit 保留（合成闸只作用于 user_message）
    expect(joined).not.toContain("<task-notification>");
    expect(joined).not.toContain("<command-name>");
  });

  test("renderMemoryDetail：按 id 直取合成 user_message → null（读侧最后一道防线）", () => {
    const db = openDb(join(newTmp(), "cd.db"));
    seedPollution(db);
    const synRow = db.query("SELECT id FROM situation_log WHERE json_extract(payload,'$.text') LIKE '<task-notification>%'").get() as { id: number };
    const realRow = db.query("SELECT id FROM situation_log WHERE json_extract(payload,'$.text') LIKE '%真实用户原话甲%'").get() as { id: number };
    expect(renderMemoryDetail(db, "situation", synRow.id)).toBeNull();
    expect(renderMemoryDetail(db, "situation", realRow.id)).toContain("真实用户原话甲");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1-D selfReview.assembleMaterial：合成轮不进对话素材
// ═══════════════════════════════════════════════════════════════════════════
describe("R1-D assembleMaterial 对话素材排除合成轮", () => {
  test("合成 string 轮不进 conversation/evidenceText，真实对话在", () => {
    const db = openDb(join(newTmp(), "m.db"));
    const p = writeJsonl("mat.jsonl", [
      userLine("u1", "真实提问独门锚点甲"),
      userLine("s1", TASK_NOTIF),
      userLine("s2", SELFREVIEW_ECHO),
      userLine("u2", "真实提问独门锚点乙"),
    ]);
    const m = buildMaterial(db, { transcriptPath: p, sessionId: SX });
    const conv = m.conversation.join("\n");
    expect(conv).toContain("真实提问独门锚点甲");
    expect(conv).toContain("真实提问独门锚点乙");
    expect(conv).not.toContain("<task-notification>");
    expect(conv).not.toContain("你是 anima——这台机器上"); // 自评回吐不自我复读
    expect(m.evidenceText).not.toContain("<task-notification>");
  });

  test("promptSource=system 轮也不进对话素材", () => {
    const db = openDb(join(newTmp(), "m2.db"));
    const p = writeJsonl("mat2.jsonl", [
      userLine("p1", "系统合成的一句看似正常的话", { promptSource: "system" }),
      userLine("u2", "真实的只此一条锚点"),
    ]);
    const conv = buildMaterial(db, { transcriptPath: p, sessionId: SX }).conversation.join("\n");
    expect(conv).toContain("真实的只此一条锚点");
    expect(conv).not.toContain("系统合成的一句看似正常的话");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R3 file_edit 门控：失败的 Edit 不再产"文件已改"幽灵
// ═══════════════════════════════════════════════════════════════════════════
describe("R3 file_edit 落库门控（tool_result 按 ok）", () => {
  test("失败的 Edit（is_error）→ 零 file_edit，仅一条 tool_error（不再双记）", () => {
    const evts = extractEvents([
      teEntry("assistant", "a1", [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x.ts", old_string: "没匹配的旧串", new_string: "新串" } }]),
      teEntry("user", "u1", [{ type: "tool_result", tool_use_id: "e1", content: "String to replace not found in file.", is_error: true }]),
    ]);
    expect(evts.filter((e) => e.kind === "file_edit").length).toBe(0); // 幽灵编辑被杀
    expect(evts.filter((e) => e.kind === "tool_error").length).toBe(1); // 只留真实失败记录
  });

  test("成功的 Edit → 一条 file_edit{path,tool,change}，零 tool_error", () => {
    const evts = extractEvents([
      teEntry("assistant", "a1", [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x.ts", old_string: "TOML", new_string: "YAML" } }]),
      teEntry("user", "u1", [{ type: "tool_result", tool_use_id: "e1", content: "The file /x.ts has been updated.", is_error: false }]),
    ]);
    const fe = evts.filter((e) => e.kind === "file_edit");
    expect(fe.length).toBe(1);
    const p = fe[0]!.payload as Record<string, unknown>;
    expect(p.path).toBe("/x.ts");
    expect(p.tool).toBe("Edit");
    expect(String(p.change)).toContain("TOML");
    expect(String(p.change)).toContain("YAML");
    expect(evts.some((e) => e.kind === "tool_error")).toBe(false);
  });

  test("Edit 有 tool_use 但本切片内**无** tool_result → 不落 file_edit（成败未知、保守不记）", () => {
    const evts = extractEvents([
      teEntry("assistant", "a1", [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } }]),
    ]);
    expect(evts.some((e) => e.kind === "file_edit")).toBe(false);
  });

  test("Write / MultiEdit 成功也走 tool_result 门控", () => {
    const evts = extractEvents([
      teEntry("assistant", "a1", [
        { type: "tool_use", id: "w1", name: "Write", input: { file_path: "/n.ts", content: "hello" } },
        { type: "tool_use", id: "m1", name: "MultiEdit", input: { file_path: "/m.ts", edits: [{}, {}] } },
      ]),
      teEntry("user", "u1", [
        { type: "tool_result", tool_use_id: "w1", content: "File created.", is_error: false },
        { type: "tool_result", tool_use_id: "m1", content: "Applied 2 edits.", is_error: false },
      ]),
    ]);
    const paths = evts.filter((e) => e.kind === "file_edit").map((e) => (e.payload as { path?: string }).path);
    expect(paths).toContain("/n.ts");
    expect(paths).toContain("/m.ts");
  });

  test("端到端 captureTranscript：失败 edit 不进 situation_log，成功 edit 进", () => {
    const db = openDb(join(newTmp(), "r3e.db"));
    const p = writeJsonl("r3.jsonl", [
      asstBlocks("a1", [
        { type: "tool_use", id: "ok1", name: "Edit", input: { file_path: "/good.ts", old_string: "x", new_string: "y" } },
        { type: "tool_use", id: "bad1", name: "Edit", input: { file_path: "/ghost.ts", old_string: "无匹配", new_string: "z" } },
      ]),
      toolResult("u1", [
        { type: "tool_result", tool_use_id: "ok1", content: "The file /good.ts has been updated.", is_error: false },
        { type: "tool_result", tool_use_id: "bad1", content: "String to replace not found in file.", is_error: true },
      ]),
    ]);
    captureTranscript(db, p, { clock });
    const edits = listSituations(db, { sessionId: SX }).filter((s) => s.kind === "file_edit").map((s) => (s.payload as { path?: string }).path);
    expect(edits).toContain("/good.ts");
    expect(edits).not.toContain("/ghost.ts"); // 幽灵编辑永不入 append-only 库
  });
});
