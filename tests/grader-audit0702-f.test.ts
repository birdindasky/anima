// 独立验收考官（AUDIT-2026-07-02 U30-③ 密钥脱敏第二条腿）——盲写，只据需求 + 现状源码。
// 需求：selfReview.assembleMaterial 咽喉处对对话正文（用户原话 + 助手文本）过 scrubSecrets（与
// capture.ts 同一把刀）；full / incremental / heal 三条素材路都被覆盖；evidenceText 与
// buildSelfReviewPrompt 的 prompt 里不得出现原密钥；普通对话逐字零误伤；截断（400 字符 slice /
// CONVERSATION_BUDGET 保头留尾）发生在脱敏之后，不把打码标记切成半截漏出原文。
//
// 攻击设计：① capture.ts scrubSecrets 支持的各 token 形态逐个过「对话路」——且刻意选 <20 字符的
// 打码片段，只有对应**专门规则**命中才会被打码（避开 20+ 高熵兜底），从而真正验证该规则到达了对话
// 路，而非被兜底顺手盖住；② 增量路（sinceUuid/targetUuid 切片）单独验，不是只有全量路；③ user 的
// string 形态与 blocks 形态、assistant 的 blocks 形态三条分支都盖；④ 助手 400 字符 slice——密钥恰跨
// 切点（用高熵串，切点后残段 <20 会逃过兜底，故能区分「先脱后截」对「先截后脱」）；⑤ CONVERSATION_
// BUDGET 截断——密钥打码标记恰跨截断点；⑥ 回归：秘密走 situation payload 老路仍被 capture 腿护住。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import {
  buildIncrementalMaterial,
  buildMaterial,
  buildSelfReviewPrompt,
  type Material,
} from "../src/selfReview";
import { captureTranscript } from "../src/capture";

const SID = "sess-audit0702f";
const TS = "2026-07-02T10:00:00.000Z";

const tmpDirs: string[] = [];
function mkdir(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-audit0702f-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTranscript(lines: unknown[]): string {
  const p = join(mkdir(), "t.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}
function openTmpDb(): ReturnType<typeof openDb> {
  return openDb(join(mkdir(), "anima.db"));
}

function userString(uuid: string, content: string, ts = TS) {
  return { type: "user", uuid, sessionId: SID, cwd: "/proj", timestamp: ts, message: { role: "user", content } };
}
function userBlocks(uuid: string, text: string, ts = TS) {
  return { type: "user", uuid, sessionId: SID, cwd: "/proj", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } };
}
function assistantText(uuid: string, text: string, ts = TS) {
  return { type: "assistant", uuid, sessionId: SID, cwd: "/proj", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** 把所有会出网/入库的素材面拼成一条 haystack：对话节选 + evidenceText + 真正的 prompt 全文。 */
function haystack(m: Material): string {
  return [m.conversation.join("\n"), m.evidenceText, buildSelfReviewPrompt(m)].join("\n----\n");
}

// ── ① 各密钥形态逐个过「对话正文」全量路（user string 分支）───────────────────
// frag = 打码后应消失的原文片段；刻意多为 <20 字符 → 只有对应专门规则命中才会被打掉，
// 用它区分「规则真到了对话路」与「被 20+ 高熵兜底顺手盖住」。
const FORMS: { name: string; secret: string; frag: string }[] = [
  { name: "sk- 前缀 token", secret: "sk-live_9fJqKLmNp3rStUvWxYz", frag: "9fJqKLmNp3rStUvWxYz" },
  { name: "GitHub PAT ghp_", secret: "ghp_AbCdEf0123456789GhIjKl", frag: "AbCdEf0123456789GhIjKl" },
  { name: "AWS AKIA", secret: "AKIAIOSFODNN7EXAMPLE", frag: "AKIAIOSFODNN7EXAMPLE" },
  { name: "Slack xoxb", secret: "xoxb-111-AbCdEfGh9012", frag: "AbCdEfGh9012" },
  { name: "JWT eyJ", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk", frag: "SflKxwRJSMeKKF2QT4fwpMeJf36POk" },
  { name: "Bearer 头", secret: "Bearer aQ9zXcVbNmLkJhGfDsAp1234", frag: "aQ9zXcVbNmLkJhGfDsAp1234" },
  { name: "PEM 私钥", secret: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkPmSecretBody\n-----END PRIVATE KEY-----", frag: "MIIEvQIBADANBgkPmSecretBody" },
  { name: "--token= flag", secret: "--token=FlagValu3SecretXyz", frag: "FlagValu3SecretXyz" },
  { name: "curl -u user:pass", secret: "-u admin:Bas1cAuthPwSecret", frag: "Bas1cAuthPwSecret" },
  { name: "-H X-Api-Key 头", secret: "-H 'X-Api-Key: Head3rKeySecretVal'", frag: "Head3rKeySecretVal" },
  { name: "URL query token", secret: "https://api.example.com/v1?access_token=UrlQ3ryTokenSecret&page=2", frag: "UrlQ3ryTokenSecret" },
  { name: "URL basic-auth //user:pass@", secret: "mongodb://dbuser:Db1PasswordSecret@cluster.example.com:27017", frag: "Db1PasswordSecret" },
  { name: "JSON body 敏感 key", secret: '{"client_secret":"Js0nSecretValueXyz"}', frag: "Js0nSecretValueXyz" },
  { name: "psql -p 密码", secret: "psql -p Pg1PasswordSecret -h localhost", frag: "Pg1PasswordSecret" },
  { name: "名字带敏感词赋值", secret: "DB_PASSWORD=Nam3dPwdSecretVal", frag: "Nam3dPwdSecretVal" },
  { name: "高熵兜底 20+ 混合", secret: "Zx9Kq2Wm7Pv4Ln8Rt3Bc6Yd", frag: "Zx9Kq2Wm7Pv4Ln8Rt3Bc6Yd" },
];

describe("① 全量路 · 对话正文各密钥形态脱敏（user string 分支）", () => {
  for (const f of FORMS) {
    test(f.name, () => {
      const db = openTmpDb();
      const path = writeTranscript([userString("u1", `请帮我配置服务 ${f.secret} 谢谢`)]);
      const m = buildMaterial(db, { transcriptPath: path, sessionId: SID });
      const hay = haystack(m);
      expect(hay).not.toContain(f.frag); // 原文不得随 prompt/evidenceText 出网
      expect(hay).toContain("[REDACTED"); // 确实打码了
      expect(hay).toContain("请帮我配置服务"); // 正文进了素材（防 not.toContain 空过）
    });
  }
});

// ── ② user blocks 形态 与 assistant blocks 形态两条分支 ──────────────────────
describe("② 分支覆盖 · user blocks / assistant blocks 也脱敏", () => {
  test("user 的 blocks（非 string）形态脱敏", () => {
    const db = openTmpDb();
    const path = writeTranscript([userBlocks("u1", "块形态密钥 ghp_UserBlockSecret6789abcd 结束")]);
    const hay = haystack(buildMaterial(db, { transcriptPath: path, sessionId: SID }));
    expect(hay).not.toContain("UserBlockSecret6789abcd");
    expect(hay).toContain("[REDACTED");
  });
  test("assistant 的 text block 形态脱敏（走 我： 前缀分支）", () => {
    const db = openTmpDb();
    const path = writeTranscript([assistantText("a1", "我回显了配置 sk-live_AsstEchoSecret12345 完成")]);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SID });
    expect(m.conversation.join("\n")).toContain("我："); // 确认确实走了 assistant 分支
    expect(haystack(m)).not.toContain("AsstEchoSecret12345");
    expect(haystack(m)).toContain("[REDACTED");
  });
});

// ── ③ 助手 400 字符 slice：密钥恰跨切点，脱敏须先于截断 ─────────────────────
describe("③ 助手 400 字符 slice · 密钥跨切点不漏原文（脱敏先于截断）", () => {
  test("高熵密钥起于第 385 字符（切点后残段 <20 会逃过兜底）→ 仍不漏", () => {
    const db = openTmpDb();
    const token = "Zx9Kq2Wm7Pv4Ln8Rt3Bc6Yd"; // 24 字符高熵，独立成词（前置非词字符 。）
    const partialIfBuggy = "Zx9Kq2Wm7Pv4Ln8"; // 若「先截后脱」：切点只留前 15 字符 <20 → 逃过高熵 → 泄漏
    const text = "。".repeat(385) + token; // token 起于第 385 字符，恰跨 400 切点
    const path = writeTranscript([assistantText("a1", text)]);
    const hay = haystack(buildMaterial(db, { transcriptPath: path, sessionId: SID }));
    expect(hay).not.toContain(token);
    expect(hay).not.toContain(partialIfBuggy); // 命门：区分脱敏/截断顺序
  });
});

// ── ④ CONVERSATION_BUDGET 截断：打码标记恰跨截断点，不漏原文 ────────────────
describe("④ CONVERSATION_BUDGET 截断 · 脱敏先于截断、标记切半不漏原文", () => {
  test(">16000 字符触发保头留尾，头/尾区密钥均已打码", () => {
    const db = openTmpDb();
    const headFrag = "BudgetHeadSecretAAA1234"; // 落在头 5000 边界附近
    const tailFrag = "BudgetTailSecretBBB1234"; // 落在尾 10000 区
    const path = writeTranscript([
      userString("b0", "。".repeat(4985)), // 把下一条密钥推到第 ~4995 字符，其 [REDACTED] 恰跨 5000
      userString("b1", `密钥 sk-live_${headFrag}`),
      userString("b2", "。".repeat(12000)), // 中段：会被截掉
      userString("b3", `密钥 ghp_${tailFrag}`),
    ]);
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SID });
    expect(m.conversation.join("\n")).toContain("[中间截断]"); // 确认确实触发了截断
    const hay = haystack(m);
    expect(hay).not.toContain(headFrag);
    expect(hay).not.toContain(tailFrag);
    expect(hay).toContain("[REDACTED");
  });
});

// ── ⑤ 增量路（切片）也脱敏——不是只有全量路；含 heal 形态（带 slicePos 上界）──
describe("⑤ 增量 / heal 素材路 · 切片同样脱敏", () => {
  function incSetup() {
    const db = openTmpDb();
    const path = writeTranscript([
      userString("u1", "前段密钥 sk-live_IncrFrontSecret111aa xxx", "2026-07-02T10:00:00.000Z"),
      assistantText("u2", "前段回答", "2026-07-02T10:01:00.000Z"),
      userString("u3", "后段密钥 ghp_IncrBackSecret222bb yyy", "2026-07-02T10:02:00.000Z"),
      assistantText("u4", "后段回答", "2026-07-02T10:03:00.000Z"),
    ]);
    return { db, path };
  }
  test("前半切片 since=null target=u2：user 密钥脱敏", () => {
    const { db, path } = incSetup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SID, sinceUuid: null, targetUuid: "u2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const hay = haystack(r.material);
      expect(hay).toContain("前段密钥"); // 该片正文在
      expect(hay).not.toContain("IncrFrontSecret111aa");
      expect(hay).toContain("[REDACTED");
    }
  });
  test("后半切片 since=u2 target=u4：user 密钥脱敏（不混前段）", () => {
    const { db, path } = incSetup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SID, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const hay = haystack(r.material);
      expect(hay).not.toContain("IncrBackSecret222bb");
      expect(hay).not.toContain("IncrFrontSecret111aa"); // 前段本就不该混进（保序也保脱敏）
      expect(hay).toContain("[REDACTED");
    }
  });
  test("heal 形态（带 slicePos 上界）素材同样脱敏", () => {
    const { db, path } = incSetup();
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SID, sinceUuid: "u2", targetUuid: "u4", slicePos: 999999 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(haystack(r.material)).not.toContain("IncrBackSecret222bb");
  });
});

// ── ⑥ 回归：秘密走 situation payload 老路，仍被 capture 腿护住 ─────────────────
describe("⑥ 回归 · situation payload 老路仍被 capture 腿护住", () => {
  test("命令含密钥整条不采 + git 输出里的密钥被 scrub", () => {
    const db = openTmpDb();
    const path = writeTranscript([
      { type: "assistant", uuid: "c1", sessionId: SID, cwd: "/proj", timestamp: "2026-07-02T10:00:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "git push https://x:ghp_CaptureCmdSecret111aa@github.com/r.git" } }] } },
      { type: "user", uuid: "c2", sessionId: SID, cwd: "/proj", timestamp: "2026-07-02T10:00:05.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Everything up-to-date" }] } },
      { type: "assistant", uuid: "c3", sessionId: SID, cwd: "/proj", timestamp: "2026-07-02T10:01:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "git remote -v" } }] } },
      { type: "user", uuid: "c4", sessionId: SID, cwd: "/proj", timestamp: "2026-07-02T10:01:05.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "origin  https://deploy:0utputRemoteSecret222bb@github.com/r.git (push)" }] } },
    ]);
    captureTranscript(db, path, { clock: frozenClock("2026-07-03T00:00:00.000Z") });
    const m = buildMaterial(db, { transcriptPath: path, sessionId: SID });
    const events = m.events.join("\n");
    expect(events).toContain("command_run"); // 确实采到了（防空过）
    expect(events).not.toContain("CaptureCmdSecret111aa"); // 命令含密钥 → 整条未采
    expect(events).not.toContain("0utputRemoteSecret222bb"); // 输出里的密钥 → scrub
    expect(haystack(m)).not.toContain("0utputRemoteSecret222bb");
  });
});

// ── ⑦ 普通对话逐字零误伤（precision：不该打的一律不打）─────────────────────
describe("⑦ 普通对话逐字零误伤", () => {
  test("SHA / 路径 / 端口 / 版本 / 散文均不被打码", () => {
    const db = openTmpDb();
    const normal =
      "我们把配置从 TOML 换成 YAML 修了崩溃，提交 a1b2c3d4e5f67890abcdef1234567890abcdef12，" +
      "改了 ~/Projects/anima/src/db.ts，服务跑在 localhost:5432，版本 v0.2.1，函数 getUserById 正常。";
    const path = writeTranscript([userString("u1", normal)]);
    const conv = buildMaterial(db, { transcriptPath: path, sessionId: SID }).conversation.join("\n");
    expect(conv).not.toContain("[REDACTED");
    for (const tok of [
      "a1b2c3d4e5f67890abcdef1234567890abcdef12", // 40 位小写 hex SHA（无大写 → 不触发高熵）
      "~/Projects/anima/src/db.ts",
      "localhost:5432",
      "v0.2.1",
      "getUserById",
      "TOML",
      "YAML",
    ]) {
      expect(conv).toContain(tok);
    }
  });
});
