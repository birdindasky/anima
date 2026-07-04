// 独立验收考官测试 — work-memory 采集层（§3A + §5.6 + §3C）
// 自写测试、自定标、自跑。不信被测方既有测试。专挑边界与对抗用例。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db";
import {
  classifyCommand,
  extractEvents,
  filterWorkMemoryEvents,
  scrubSecrets,
  TRANSCRIPT_ACTIVITY_KINDS,
} from "../src/capture";
import { appendSituation } from "../src/situation";
import { frozenClock } from "../src/clock";
import type { TranscriptEntry, ContentBlock } from "../src/transcript";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "grader-wc-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── 条目工厂 ──────────────────────────────────────────────
let clk = 0;
function nextTs(): string {
  // 默认每条 +1 分钟，避免去重窗口意外命中
  return new Date(Date.UTC(2026, 5, 21, 0, clk++ % 60, 0)).toISOString();
}
function asst(blocks: ContentBlock[], over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    type: "assistant",
    uuid: "a-" + Math.random().toString(36).slice(2),
    sessionId: "S",
    cwd: "/proj",
    timestamp: nextTs(),
    isMeta: false,
    isSidechain: false,
    role: "assistant",
    content: blocks,
    ...over,
  };
}
function userResult(blocks: ContentBlock[], over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    type: "user",
    uuid: "u-" + Math.random().toString(36).slice(2),
    sessionId: "S",
    cwd: "/proj",
    timestamp: nextTs(),
    isMeta: false,
    isSidechain: false,
    role: "user",
    content: blocks,
    ...over,
  };
}

/** 造一对 tool_use + tool_result，返回 [assistant, user] 两条 entry */
function toolPair(
  id: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
  tsOver?: { useTs?: string; resTs?: string },
): TranscriptEntry[] {
  const a = asst([{ type: "tool_use", id, name, input }], tsOver?.useTs ? { timestamp: tsOver.useTs } : {});
  const u = userResult(
    [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }],
    tsOver?.resTs ? { timestamp: tsOver.resTs } : {},
  );
  return [a, u];
}

function kinds(evts: { kind: string }[]) {
  return evts.map((e) => e.kind);
}

// ══════════════════════════════════════════════════════════
// 条1：file_read — 成功只存 path，绝不存内容；出错不产 file_read
// ══════════════════════════════════════════════════════════
describe("条1 file_read", () => {
  test("Read 成功只存 {path}，文件内容绝不入库", () => {
    const SECRET_BODY = "这里是文件正文 TOP_SECRET_BODY_CONTENT 不该出现";
    const evts = extractEvents(toolPair("r1", "Read", { file_path: "/proj/a.ts" }, SECRET_BODY));
    const reads = evts.filter((e) => e.kind === "file_read");
    expect(reads.length).toBe(1);
    const p = reads[0]!.payload as Record<string, unknown>;
    expect(p.path).toBe("/proj/a.ts");
    // payload 只有 path，没有任何内容字段
    expect(Object.keys(p)).toEqual(["path"]);
    expect(JSON.stringify(reads[0]!.payload)).not.toContain("TOP_SECRET_BODY_CONTENT");
  });

  test("Read 出错 → 不产 file_read，走 tool_error", () => {
    const evts = extractEvents(toolPair("r1", "Read", { file_path: "/proj/missing.ts" }, "ENOENT no such file", true));
    expect(evts.some((e) => e.kind === "file_read")).toBe(false);
    expect(evts.some((e) => e.kind === "tool_error")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// 条2：command_run — 白名单 / 非白名单 / 失败语义
// ══════════════════════════════════════════════════════════
describe("条2 command_run", () => {
  test("白名单命令成功 → command_run，含 command/category/ok/output", () => {
    const evts = extractEvents(toolPair("g1", "Bash", { command: "git status" }, "On branch main"));
    const cr = evts.filter((e) => e.kind === "command_run");
    expect(cr.length).toBe(1);
    const p = cr[0]!.payload as Record<string, unknown>;
    expect(p.category).toBe("git");
    expect(p.ok).toBe(true);
    expect(p.command).toBe("git status");
    expect(p.output).toContain("On branch main");
  });

  test("非白名单 Bash（ls/cd/cat/echo/pwd）成功时啥都不采", () => {
    for (const cmd of ["ls -la", "cd /tmp", "cat foo.txt", "echo hi", "pwd", "grep x f", "mkdir d"]) {
      const evts = extractEvents(toolPair("c", "Bash", { command: cmd }, "some output"));
      // 不该产 command_run / file_read / tool_error / test_run；成功的非白名单完全静默
      expect(kinds(evts)).toEqual([]);
    }
  });

  test("非白名单 Bash 失败时也不产 command_run（仍走 tool_error）", () => {
    const evts = extractEvents(toolPair("c", "Bash", { command: "ls /nope" }, "No such file", true));
    expect(evts.some((e) => e.kind === "command_run")).toBe(false);
    expect(evts.some((e) => e.kind === "tool_error")).toBe(true);
  });

  test("白名单命令失败 → command_run ok:false（不是 tool_error）", () => {
    const evts = extractEvents(toolPair("g1", "Bash", { command: "git push" }, "rejected: non-fast-forward", true));
    const cr = evts.filter((e) => e.kind === "command_run");
    expect(cr.length).toBe(1);
    expect((cr[0]!.payload as Record<string, unknown>).ok).toBe(false);
    // 不应同时产 tool_error
    expect(evts.some((e) => e.kind === "tool_error")).toBe(false);
  });

  test("classifyCommand 分类与优先级：deploy/install>git>build>net；非白名单=null", () => {
    expect(classifyCommand("docker build .")).toBe("deploy"); // docker 命中 deploy 优先
    expect(classifyCommand("kubectl apply -f x")).toBe("deploy");
    expect(classifyCommand("npm install lodash")).toBe("install");
    expect(classifyCommand("bun add zod")).toBe("install");
    expect(classifyCommand("git commit -m x")).toBe("git");
    expect(classifyCommand("make build")).toBe("build");
    expect(classifyCommand("tsc -p .")).toBe("build");
    expect(classifyCommand("curl https://x")).toBe("net");
    expect(classifyCommand("gh pr list")).toBe("net");
    expect(classifyCommand("ls -la")).toBeNull();
    expect(classifyCommand("cat /etc/passwd")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════
// 条3：file_edit 增强 — 带变更摘要但不存全文
// ══════════════════════════════════════════════════════════
describe("条3 file_edit 增强", () => {
  test("Edit 带 change 摘要，path/tool 在", () => {
    // R3（AUDIT-2026-07-03）：成功编辑落库改到 tool_result 分支按 ok 门控——补配对 tool_result（真机 Edit 恒有）。
    const evts = extractEvents([
      asst([{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x.ts", old_string: "foo()", new_string: "bar()" } }]),
      userResult([{ type: "tool_result", tool_use_id: "e1", content: "The file /x.ts has been updated.", is_error: false }]),
    ]);
    const fe = evts.filter((e) => e.kind === "file_edit");
    expect(fe.length).toBe(1);
    const p = fe[0]!.payload as Record<string, unknown>;
    expect(p.path).toBe("/x.ts");
    expect(p.tool).toBe("Edit");
    expect(typeof p.change).toBe("string");
    expect(p.change).toContain("foo()");
    expect(p.change).toContain("bar()");
  });

  test("Write 不把全文写进 change（只记长度+首行）", () => {
    const huge = "function boom(){\n" + "X".repeat(50_000) + "\n}";
    const evts = extractEvents([
      asst([{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/big.ts", content: huge } }]),
      userResult([{ type: "tool_result", tool_use_id: "w1", content: "File created successfully.", is_error: false }]),
    ]);
    const p = (evts.find((e) => e.kind === "file_edit")!.payload as Record<string, unknown>);
    const change = p.change as string;
    expect(change.length).toBeLessThan(300); // 截断后远小于全文
    expect(change).not.toContain("X".repeat(500)); // 没有大 blob
  });
});

// ══════════════════════════════════════════════════════════
// 条4：截断（F-2）command 首尾各150、edit 首尾各100，不存大 blob
// ══════════════════════════════════════════════════════════
describe("条4 截断 F-2", () => {
  test("command 输出截断：首尾各 ~150，中段省略，远小于原文", () => {
    const big = "H".repeat(150) + "M".repeat(10_000) + "T".repeat(150);
    const evts = extractEvents(toolPair("g1", "Bash", { command: "git log" }, big));
    const out = (evts.find((e) => e.kind === "command_run")!.payload as Record<string, unknown>).output as string;
    expect(out.length).toBeLessThan(big.length);
    expect(out.length).toBeLessThan(500);
    expect(out.startsWith("H".repeat(150))).toBe(true);
    expect(out.endsWith("T".repeat(150))).toBe(true);
    expect(out).toContain("省略");
    // 中段巨量 M 不得整体保留
    expect(out).not.toContain("M".repeat(200));
  });

  test("短输出不截断（<=head+tail 原样）", () => {
    const evts = extractEvents(toolPair("g1", "Bash", { command: "git status" }, "short"));
    const out = (evts.find((e) => e.kind === "command_run")!.payload as Record<string, unknown>).output as string;
    expect(out).toBe("short");
  });

  test("edit 摘要截断到首尾各 ~100", () => {
    const longOld = "A".repeat(5000);
    const longNew = "B".repeat(5000);
    const evts = extractEvents([
      asst([{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x.ts", old_string: longOld, new_string: longNew } }]),
      userResult([{ type: "tool_result", tool_use_id: "e1", content: "The file /x.ts has been updated.", is_error: false }]),
    ]);
    const change = (evts.find((e) => e.kind === "file_edit")!.payload as Record<string, unknown>).change as string;
    expect(change.length).toBeLessThan(300);
    expect(change).not.toContain("A".repeat(200));
  });
});

// ══════════════════════════════════════════════════════════
// 条5：隐私 scrub（命门）
// ══════════════════════════════════════════════════════════
describe("条5 scrub 命门", () => {
  test("①已知前缀打码 sk-/ghp_/AKIA/xox/Bearer/PEM", () => {
    expect(scrubSecrets("key sk-ABCDEFGH12345678 done")).not.toContain("ABCDEFGH12345678");
    expect(scrubSecrets("ghp_abcdEFGH1234567890 x")).not.toContain("ghp_abcdEFGH1234567890");
    expect(scrubSecrets("AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(scrubSecrets("xoxb-1234567890-abcdef")).not.toContain("xoxb-1234567890-abcdef");
    expect(scrubSecrets("Authorization: Bearer abc.def.ghi123")).not.toContain("abc.def.ghi123");
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBVERYSECRET\n-----END RSA PRIVATE KEY-----";
    const sp = scrubSecrets(pem);
    expect(sp).not.toContain("MIIBVERYSECRET");
  });

  test("②高熵串打码，但 git 40 位小写 hex SHA 不被误杀（codex n-3）", () => {
    const sha = "a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d"; // 40 hex 纯小写
    expect(scrubSecrets(`commit ${sha} ok`)).toContain(sha); // 不能动
    // 短 SHA 也不能动
    const shortSha = "a1b2c3d4e5f6";
    expect(scrubSecrets(`at ${shortSha}`)).toContain(shortSha);
    // 真高熵（含大小写+数字 >=20）应打码
    const entropy = "Ab3Kf9Zx7Qw2Lm5Np8Rt4Vy6Hs1Dg0Bc";
    expect(scrubSecrets(`token=${entropy}`)).not.toContain(entropy);
  });

  test("②对抗：纯大写40hex(罕见)与含大小写hex仍误杀风险——大写hex SHA 检查", () => {
    // git SHA 标准是小写。若输出含大写 hex（如某些工具），高熵规则要求同时含大小写+数字
    // 纯大写 hex 无小写 → 不该被高熵规则杀（但也不是真密钥，放行可接受）
    const upperHex = "A1B2C3D4E5F6071829304A5B6C7D8E9F0A1B2C3D";
    // 无小写 → 高熵规则(需同时大小写)放行，符合"宁可漏打码非密钥"
    expect(scrubSecrets(upperHex)).toContain(upperHex);
  });

  test("③--token/--password/-H Authorization 后的值打码", () => {
    expect(scrubSecrets("gh auth --token=ghxSECRETVALUE123")).not.toContain("ghxSECRETVALUE123");
    expect(scrubSecrets("mysql --password supersecretpw")).not.toContain("supersecretpw");
    expect(scrubSecrets('curl -H "Authorization: tok_abc123XYZ"')).not.toContain("tok_abc123XYZ");
    expect(scrubSecrets("login --api-key=AKsdf9821kjlsd")).not.toContain("AKsdf9821kjlsd");
  });

  test("④命令本身含疑似密钥 → 整条命令不采，只留分类+成败", () => {
    const cmd = "curl -H 'Authorization: Bearer sk-livesecret12345678' https://api.x";
    const evts = extractEvents(toolPair("c1", "Bash", { command: cmd }, "200 OK"));
    const cr = evts.find((e) => e.kind === "command_run");
    expect(cr).toBeDefined();
    const p = cr!.payload as Record<string, unknown>;
    // 整条命令不采
    expect(p.command).not.toContain("sk-livesecret12345678");
    expect(p.command).not.toContain("Bearer");
    // 但分类+成败仍在
    expect(p.category).toBe("net");
    expect(p.ok).toBe(true);
  });

  test("⑤scrub 在截断之前对全量跑：密钥跨 150 字 head 切口不泄漏残片", () => {
    // 把密钥放在恰好跨越 head=150 的边界：前面填 140 字，密钥 30 字 → 跨切口
    const filler = "y".repeat(140);
    const secret = "ghp_aBcDeFgH1234567890wxyz"; // 26 字，从第140位起，跨越150
    const tail = "z".repeat(10_000);
    const output = filler + secret + tail;
    const evts = extractEvents(toolPair("g1", "Bash", { command: "git remote -v" }, output));
    const out = (evts.find((e) => e.kind === "command_run")!.payload as Record<string, unknown>).output as string;
    // 完整密钥不得出现
    expect(out).not.toContain("ghp_aBcDeFgH1234567890wxyz");
    // 任何长度>=8的密钥残片都不该泄漏（切口处可能留前缀）
    expect(out).not.toMatch(/ghp_[A-Za-z0-9]{4,}/);
  });

  test("⑤补强：高熵密钥落在被省略的中段也要被打码（截断前已 scrub）", () => {
    const entropy = "Ab3Kf9Zx7Qw2Lm5Np8Rt4Vy6Hs1Dg0Bc";
    // 密钥在中段（>150 且 <len-150）
    const output = "h".repeat(300) + " " + entropy + " " + "t".repeat(300);
    const evts = extractEvents(toolPair("g1", "Bash", { command: "git log" }, output));
    const out = (evts.find((e) => e.kind === "command_run")!.payload as Record<string, unknown>).output as string;
    expect(out).not.toContain(entropy);
  });

  test("tool_error snippet 也 scrub（密钥不从报错路泄漏）", () => {
    const evts = extractEvents(
      toolPair("x1", "Read", { file_path: "/p" }, "failed sk-leak1234567890abcd here", true),
    );
    const te = evts.find((e) => e.kind === "tool_error");
    expect(te).toBeDefined();
    expect(JSON.stringify(te!.payload)).not.toContain("sk-leak1234567890abcd");
  });
});

// ══════════════════════════════════════════════════════════
// 条6：采集量上限 + 去重（既有库存计入）
// ══════════════════════════════════════════════════════════
describe("条6 cap + dedup", () => {
  test("同文件 10 分钟内重复 Read 只采 1 次", () => {
    const db = tmpDb();
    const base = Date.UTC(2026, 5, 21, 3, 0, 0);
    const mk = (offMin: number) => {
      const ts = new Date(base + offMin * 60_000).toISOString();
      return {
        sessionId: "S",
        project: "/p",
        occurredAt: ts,
        kind: "file_read",
        payload: { path: "/same.ts" },
      };
    };
    // 0min, 5min, 9min → 同文件 10 分钟窗内，应只留 1
    const out = filterWorkMemoryEvents(db, [mk(0), mk(5), mk(9)]);
    const reads = out.filter((e) => e.kind === "file_read");
    expect(reads.length).toBe(1);
    // 应有溢出 marker
    expect(out.some((e) => e.kind === "work_capture_overflow")).toBe(true);
  });

  test("同文件超 10 分钟后可再采", () => {
    const db = tmpDb();
    const base = Date.UTC(2026, 5, 21, 3, 0, 0);
    const mk = (offMin: number) => ({
      sessionId: "S",
      project: "/p",
      occurredAt: new Date(base + offMin * 60_000).toISOString(),
      kind: "file_read",
      payload: { path: "/same.ts" },
    });
    // 0min 和 11min → 超窗，2 条都留
    const out = filterWorkMemoryEvents(db, [mk(0), mk(11)]);
    expect(out.filter((e) => e.kind === "file_read").length).toBe(2);
  });

  test("file_read cap=50 且既有库存计入：库里已 48 条 → 本批只放 2", () => {
    const db = tmpDb();
    const clock = frozenClock("2026-06-21T05:00:00.000Z");
    // 预填 48 条既有 file_read（不同路径，避免去重）
    for (let i = 0; i < 48; i++) {
      appendSituation(
        db,
        { sessionId: "S", project: "/p", kind: "file_read", payload: { path: `/old${i}.ts` }, occurredAt: "2026-06-20T00:00:00.000Z" },
        clock,
      );
    }
    // 本批 10 条新 read（不同路径，不同时间避免去重）
    const batch = Array.from({ length: 10 }, (_, i) => ({
      sessionId: "S",
      project: "/p",
      occurredAt: new Date(Date.UTC(2026, 5, 21, 5, i, 0)).toISOString(),
      kind: "file_read" as const,
      payload: { path: `/new${i}.ts` },
    }));
    const out = filterWorkMemoryEvents(db, batch);
    const keptReads = out.filter((e) => e.kind === "file_read");
    expect(keptReads.length).toBe(2); // 50-48
    expect(out.some((e) => e.kind === "work_capture_overflow")).toBe(true);
  });

  test("command_run cap=30 且既有库存计入：库里 28 → 本批只放 2", () => {
    const db = tmpDb();
    const clock = frozenClock("2026-06-21T05:00:00.000Z");
    for (let i = 0; i < 28; i++) {
      appendSituation(
        db,
        { sessionId: "S", project: "/p", kind: "command_run", payload: { command: `git x${i}`, category: "git", ok: true }, occurredAt: "2026-06-20T00:00:00.000Z" },
        clock,
      );
    }
    const batch = Array.from({ length: 8 }, (_, i) => ({
      sessionId: "S",
      project: "/p",
      occurredAt: new Date(Date.UTC(2026, 5, 21, 5, i, 0)).toISOString(),
      kind: "command_run" as const,
      payload: { command: `git y${i}`, category: "git", ok: true },
    }));
    const out = filterWorkMemoryEvents(db, batch);
    expect(out.filter((e) => e.kind === "command_run").length).toBe(2);
  });

  test("command cap 触顶按类别优先级丢低信号：deploy/install 留，net/build 先丢", () => {
    const db = tmpDb();
    const clock = frozenClock("2026-06-21T05:00:00.000Z");
    // 库里塞 28 条，剩 allowance=2
    for (let i = 0; i < 28; i++) {
      appendSituation(
        db,
        { sessionId: "S", project: "/p", kind: "command_run", payload: { command: `git x${i}`, category: "git", ok: true }, occurredAt: "2026-06-20T00:00:00.000Z" },
        clock,
      );
    }
    const c = (cat: string, tag: string, i: number) => ({
      sessionId: "S",
      project: "/p",
      occurredAt: new Date(Date.UTC(2026, 5, 21, 5, i, 0)).toISOString(),
      kind: "command_run" as const,
      payload: { command: tag, category: cat, ok: true },
    });
    // 混合：2 net, 1 build, 1 deploy, 1 install → allowance=2 应留 deploy+install
    const batch = [c("net", "curl-a", 0), c("build", "tsc-b", 1), c("deploy", "docker-c", 2), c("install", "npm-d", 3), c("net", "curl-e", 4)];
    const out = filterWorkMemoryEvents(db, batch);
    const kept = out.filter((e) => e.kind === "command_run").map((e) => (e.payload as Record<string, unknown>).command);
    expect(kept.length).toBe(2);
    expect(kept).toContain("docker-c"); // deploy 最高优先
    expect(kept).toContain("npm-d"); // install 次之
    expect(kept).not.toContain("curl-a"); // net 被丢
    expect(kept).not.toContain("tsc-b"); // build 被丢
  });

  test("溢出留 marker 且 marker 不在 TRANSCRIPT_ACTIVITY_KINDS", () => {
    expect(TRANSCRIPT_ACTIVITY_KINDS).not.toContain("work_capture_overflow" as never);
  });

  test("无溢出时不产 marker；非 work-memory 事件原样保序直通", () => {
    const db = tmpDb();
    const events = [
      { sessionId: "S", project: "/p", occurredAt: "2026-06-21T05:00:00.000Z", kind: "user_message", payload: { text: "hi" } },
      { sessionId: "S", project: "/p", occurredAt: "2026-06-21T05:01:00.000Z", kind: "file_read", payload: { path: "/a.ts" } },
      { sessionId: "S", project: "/p", occurredAt: "2026-06-21T05:02:00.000Z", kind: "test_run", payload: { command: "bun test", ok: true } },
    ];
    const out = filterWorkMemoryEvents(db, events);
    expect(out.some((e) => e.kind === "work_capture_overflow")).toBe(false);
    expect(kinds(out)).toEqual(["user_message", "file_read", "test_run"]);
  });
});

// ══════════════════════════════════════════════════════════
// 条7：铁律 + 零回归
// ══════════════════════════════════════════════════════════
describe("条7 铁律 + 零回归", () => {
  test("新 kind file_read/command_run 在 TRANSCRIPT_ACTIVITY_KINDS 中", () => {
    expect(TRANSCRIPT_ACTIVITY_KINDS).toContain("file_read");
    expect(TRANSCRIPT_ACTIVITY_KINDS).toContain("command_run");
  });

  test("子代理(isSidechain)与 meta 条目跳过（命令记忆不算子代理经历）", () => {
    const pair = toolPair("g1", "Bash", { command: "git status" }, "ok");
    const sided = pair.map((e) => ({ ...e, isSidechain: true }));
    expect(extractEvents(sided)).toEqual([]);
    const meta = pair.map((e) => ({ ...e, isMeta: true }));
    expect(extractEvents(meta)).toEqual([]);
  });

  test("老行为不退步：test_run 先败后过仍正确", () => {
    const fail = toolPair("t1", "Bash", { command: "bun test" }, "3 failed", false);
    const pass = toolPair("t2", "Bash", { command: "bun test" }, "0 failed", false);
    const evts = extractEvents([...fail, ...pass]);
    const tr = evts.filter((e) => e.kind === "test_run");
    expect(tr.length).toBe(2);
    expect((tr[0]!.payload as Record<string, unknown>).ok).toBe(false);
    expect((tr[1]!.payload as Record<string, unknown>).ok).toBe(true);
    // test 命令不被当 command_run 重复采
    expect(evts.some((e) => e.kind === "command_run")).toBe(false);
  });

  test("user_message 老行为不退步", () => {
    const evts = extractEvents([userResult([{ type: "text", text: "帮我修个 bug" }] as ContentBlock[], { content: "帮我修个 bug" as never })]);
    // 纯字符串内容路径
    const evts2 = extractEvents([
      { ...userResult([]), content: "帮我修个 bug" },
    ]);
    expect(evts2.some((e) => e.kind === "user_message" && (e.payload as Record<string, unknown>).text === "帮我修个 bug")).toBe(true);
  });
});
