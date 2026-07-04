// R1-promptsource（AUDIT-2026-07-03 R1 codex GO-WITH-GAPS 残留缺口）——红灯先行 → 转绿。
//
// 真相核实（快照库 + 真 transcript，7888 份，见 approach）：真实人类用户轮**并非总带 promptSource**——
// 旧版 harness 下 274 条真人对话原话（"压测一下""继续任务""同意你的方案"…）promptSource 缺失(null)。
// 因此写侧 isSyntheticUserTurn 的**文本兜底**（promptSource 缺失时才走）就是这些真人轮**唯一的闸**。
// 若真人正文恰以某合成前缀**开头**，旧兜底 trimStart().startsWith() 会把它整条误杀 → append-only 永久丢字。
//
// 风险最高的是**两条自然语言前导句**（真人可能亲手粘贴讨论，尤其本项目作者会贴 anima 自己的自评 prompt）：
//   · "Another Claude session sent a message:"（队友信封开场白）
//   · "你是 anima——这台机器上 Claude Code 的魂"（自评 prompt 开场白）
// 结构化 XML 标记（<command-name>/<task-notification>/<teammate-message>…）真人几乎不可能亲手打，保持行首锚定。
//
// 护栏（写侧兜底专用，读侧不动）：两条自然语言前导句**只在"紧跟的合成结构"同时在场**时才判合成——
//   队友信封须含 <teammate-message；自评 prompt 须含 <material>（真机 5467/5467 全含，见 approach）。
//   宁可漏挡个别合成轮（读侧仍以 isReadExcludedUserText / syntheticTextExclusionSql 兜存量），不可误杀真人原话。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { listSituations } from "../src/situation";
import { readTranscriptEntries } from "../src/transcript";
import { isSyntheticUserTurn, isHumanAuthoredTurn } from "../src/authorship";
import { frozenClock } from "../src/clock";

const SX = "sess-r1ps";
const CWD = "/proj";
const clock = frozenClock("2026-06-21T12:00:00.000Z");
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function newTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "r1ps-"));
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
// 真人轮：promptSource 缺失（旧 harness / 快照实测 274 条真人原话就是这样）
function humanNullPs(uuid: string, content: string) {
  return { type: "user", uuid, sessionId: SX, cwd: CWD, timestamp: ts(), message: { role: "user", content } };
}

// 前导句（与 authorship.SYNTHETIC_TEXT_PREFIXES 逐字一致）
const TEAMMATE_PREAMBLE = "Another Claude session sent a message:";
const SELFREVIEW_PREAMBLE = "你是 anima——这台机器上 Claude Code 的魂";
// 真机合成形态（前导句 + 紧跟的合成结构）
const GENUINE_TEAMMATE = 'Another Claude session sent a message:\n<teammate-message teammate_id="x" color="green">\n{"type":"idle_notification"}\n</teammate-message>';
const GENUINE_SELFREVIEW = "你是 anima——这台机器上 Claude Code 的魂。现在是收工时间，请以第一人称回顾今天这个会话。\n\n<material>\n## 对话节选\n用户：随便说\n</material>";
// 结构化 XML 合成轮（真人几乎不可能亲手打，行首锚定保持）
const TASK_NOTIF = "<task-notification>\n<task-id>b6mu3hrc7</task-id>\n<status>killed</status>\n</task-notification>";
const SLASH_CMD = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>";

describe("R1-promptsource 写侧兜底假阳性护栏（promptSource 缺失路径）", () => {
  test("真人以'你是 anima——…'开头讨论自评 prompt（无 <material>）+ promptSource 缺失 → 不误杀", () => {
    const human = `${SELFREVIEW_PREAMBLE} 这句开场白是从哪拼出来的？我想改一下措辞，缓存穿透独门标记`;
    const es = readTranscriptEntries(writeJsonl("a1.jsonl", [humanNullPs("u1", human)]));
    expect(es[0]!.promptSource).toBeNull();
    expect(isSyntheticUserTurn(es[0]!)).toBe(false); // 真人原话保住
    expect(isHumanAuthoredTurn(es[0]!)).toBe(true);
  });

  test("真人引用'Another Claude session sent a message:'（无 <teammate-message>）+ promptSource 缺失 → 不误杀", () => {
    const human = `Another Claude session sent a message: 这句话是队友机制打印的吗？为什么我这没看到，缓存击穿独门标记`;
    const es = readTranscriptEntries(writeJsonl("a2.jsonl", [humanNullPs("u1", human)]));
    expect(es[0]!.promptSource).toBeNull();
    expect(isSyntheticUserTurn(es[0]!)).toBe(false);
    expect(isHumanAuthoredTurn(es[0]!)).toBe(true);
  });

  test("回归：真机队友信封（含 <teammate-message>）+ promptSource 缺失 → 仍判合成被挡", () => {
    const es = readTranscriptEntries(writeJsonl("b1.jsonl", [humanNullPs("s1", GENUINE_TEAMMATE)]));
    expect(isSyntheticUserTurn(es[0]!)).toBe(true);
  });

  test("回归：真机自评回吐（含 <material>）+ promptSource 缺失 → 仍判合成被挡", () => {
    const es = readTranscriptEntries(writeJsonl("b2.jsonl", [humanNullPs("s2", GENUINE_SELFREVIEW)]));
    expect(isSyntheticUserTurn(es[0]!)).toBe(true);
  });

  test("回归：结构化 XML 合成轮（<task-notification>/<command-name>）+ promptSource 缺失 → 仍判合成被挡", () => {
    const es = readTranscriptEntries(writeJsonl("b3.jsonl", [humanNullPs("s3", TASK_NOTIF), humanNullPs("s4", SLASH_CMD)]));
    expect(isSyntheticUserTurn(es[0]!)).toBe(true);
    expect(isSyntheticUserTurn(es[1]!)).toBe(true);
  });

  test("端到端 captureTranscript：真人前导句原话落库，真机合成信封被丢", () => {
    const db = openDb(join(newTmp(), "e2e.db"));
    captureTranscript(db, writeJsonl("e2e.jsonl", [
      humanNullPs("u1", `${SELFREVIEW_PREAMBLE} 想改这句开场白，落库独门标记甲`),
      humanNullPs("u2", `Another Claude session sent a message: 这机制是啥，落库独门标记乙`),
      humanNullPs("s1", GENUINE_TEAMMATE),
      humanNullPs("s2", GENUINE_SELFREVIEW),
      humanNullPs("s3", TASK_NOTIF),
    ]), { clock });
    const texts = listSituations(db, { sessionId: SX })
      .filter((s) => s.kind === "user_message")
      .map((s) => String((s.payload as { text?: string }).text ?? ""));
    expect(texts.some((t) => t.includes("落库独门标记甲"))).toBe(true); // 真人自评 prompt 讨论保住
    expect(texts.some((t) => t.includes("落库独门标记乙"))).toBe(true); // 真人队友机制讨论保住
    expect(texts.some((t) => t.includes("<teammate-message"))).toBe(false); // 真机信封被丢
    expect(texts.some((t) => t.includes("<material>"))).toBe(false); // 真机自评回吐被丢
    expect(texts.some((t) => t.includes("<task-notification>"))).toBe(false); // 结构化合成被丢
  });
});
