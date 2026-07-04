// 独立盲验收：work_action 工作动作记忆 端到端 + 对抗找纰漏。
// 本文件自写测试、自定标，绝不复用被测作者的断言。覆盖契约 1-9 + 额外对抗用例。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import {
  captureTranscript,
  classifyCommand,
  scrubSecrets,
  extractEvents,
  filterWorkMemoryEvents,
  TRANSCRIPT_ACTIVITY_KINDS,
} from "../src/capture";
import { listSituations, appendSituation } from "../src/situation";
import { insertExperience, searchExperiences } from "../src/experiences";
import { validateSelfReview } from "../src/validator";
import { generateSelfReview, storeSelfReviewResult, buildMaterial } from "../src/selfReview";
import { assembleMorningInjection } from "../src/inject";
import { runNightlyDigestion, type DigestConfig } from "../src/digest";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-blind-wm-"));
  tmpDirs.push(dir);
  const home = join(dir, "h");
  const config: DigestConfig = {
    personalityPath: join(home, "personality.md"),
    diaryDir: join(home, "diary"),
    badgePath: join(home, "badge.txt"),
  };
  return { dir, home, dbPath: join(home, "anima.db"), config };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── transcript JSONL fixture 构造器 ──────────────────────────────────────
let uuidSeq = 0;
function uid(p = "u"): string {
  return `${p}-${++uuidSeq}`;
}
const PROJ = "/Users/me/proj";
const SID = "sess-A";

function userText(text: string, ts: string, sessionId = SID, cwd = PROJ) {
  return {
    type: "user",
    uuid: uid(),
    sessionId,
    cwd,
    timestamp: ts,
    message: { role: "user", content: text },
  };
}
function assistantToolUse(
  blocks: { id: string; name: string; input: Record<string, unknown> }[],
  ts: string,
  sessionId = SID,
  cwd = PROJ,
) {
  return {
    type: "assistant",
    uuid: uid(),
    sessionId,
    cwd,
    timestamp: ts,
    message: {
      role: "assistant",
      content: blocks.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input })),
    },
  };
}
function userToolResult(
  results: { tool_use_id: string; content: unknown; is_error?: boolean }[],
  ts: string,
  sessionId = SID,
  cwd = PROJ,
) {
  return {
    type: "user",
    uuid: uid(),
    sessionId,
    cwd,
    timestamp: ts,
    message: {
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
    },
  };
}
function writeJsonl(home: string, objs: unknown[]): string {
  const p = join(home, `transcript-${++uuidSeq}.jsonl`);
  // 确保目录存在
  rmSync(join(home, "_"), { force: true, recursive: true });
  const fs = require("node:fs");
  fs.mkdirSync(home, { recursive: true });
  writeFileSync(p, objs.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  return p;
}

function kindsIn(rows: { kind: string }[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) m[r.kind] = (m[r.kind] ?? 0) + 1;
  return m;
}

// ═══════════════════════════════════════════════════════════════════════
// 契约 1：采集 — 真 transcript → captureTranscript → situation_log
// ═══════════════════════════════════════════════════════════════════════
describe("[1] 采集", () => {
  test("file_read / command_run / file_edit 落库；非白名单不采；Read出错不产file_read", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const T = "2026-06-20T10:00:00.000Z";
    const objs = [
      userText("开工", T),
      assistantToolUse(
        [
          { id: "t1", name: "Read", input: { file_path: "/Users/me/proj/src/foo.ts" } },
          { id: "t2", name: "Bash", input: { command: "git commit -m 'wip'" } },
          { id: "t3", name: "Bash", input: { command: "ls -la" } }, // 非白名单
          { id: "t4", name: "Read", input: { file_path: "/Users/me/proj/nope.ts" } }, // 出错
          { id: "t5", name: "Edit", input: { file_path: "/Users/me/proj/a.ts", old_string: "const x=1", new_string: "const x=2" } },
        ],
        T,
      ),
      userToolResult(
        [
          { tool_use_id: "t1", content: "file contents SECRET-CONTENT-DO-NOT-STORE" },
          { tool_use_id: "t2", content: "[main abc123] wip\n 1 file changed" },
          { tool_use_id: "t3", content: "foo bar baz" },
          { tool_use_id: "t4", content: "Error: ENOENT no such file", is_error: true },
          { tool_use_id: "t5", content: "ok" },
        ],
        T,
      ),
    ];
    const tp = writeJsonl(home, objs);
    const res = captureTranscript(db, tp, { clock: frozenClock(T) });
    expect(res.captured).toBeGreaterThan(0);
    const rows = listSituations(db, { sessionId: SID });
    const k = kindsIn(rows);

    // file_read 只采成功的 t1，t4 出错不产 file_read
    const reads = rows.filter((r) => r.kind === "file_read");
    expect(reads.length).toBe(1);
    expect((reads[0]!.payload as any).path).toBe("/Users/me/proj/src/foo.ts");
    // file_read 只存路径，不存内容
    expect(JSON.stringify(reads[0]!.payload)).not.toContain("SECRET-CONTENT");

    // command_run：只采白名单 git，ls 不采
    const cmds = rows.filter((r) => r.kind === "command_run");
    expect(cmds.length).toBe(1);
    expect((cmds[0]!.payload as any).category).toBe("git");
    expect((cmds[0]!.payload as any).command).toContain("git commit");
    expect((cmds[0]!.payload as any).ok).toBe(true);
    expect((cmds[0]!.payload as any).output).toContain("wip");
    // ls 绝不出现
    expect(rows.some((r) => r.kind === "command_run" && JSON.stringify(r.payload).includes("ls -la"))).toBe(false);

    // file_edit：带变更摘要
    const edits = rows.filter((r) => r.kind === "file_edit");
    expect(edits.length).toBe(1);
    expect((edits[0]!.payload as any).change).toContain("const x=1");
    expect((edits[0]!.payload as any).change).toContain("const x=2");

    // t4 出错 → tool_error，不是 file_read
    expect(k.tool_error ?? 0).toBe(1);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 2：蒸馏 — work_action item 落库为 kind='work_action'
// ═══════════════════════════════════════════════════════════════════════
describe("[2] 蒸馏", () => {
  test("工作事件进 evidenceText；stub LLM 返 work_action → experiences 出现 kind=work_action", async () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const T = "2026-06-20T11:00:00.000Z";
    // 先把工作事件采进 situation_log
    const objs = [
      userText("把 config.ts 改了", T),
      assistantToolUse([{ id: "c1", name: "Bash", input: { command: "git push origin main" } }], T),
      userToolResult([{ tool_use_id: "c1", content: "pushed 3 commits" }], T),
      assistantToolUse(
        [{ id: "e1", name: "Edit", input: { file_path: "/Users/me/proj/config.ts", old_string: "TOML", new_string: "YAML" } }],
        T,
      ),
      userToolResult([{ tool_use_id: "e1", content: "ok" }], T),
    ];
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock(T) });

    const material = buildMaterial(db, { transcriptPath: tp, sessionId: SID });
    // evidenceText 含工作事件
    expect(material.evidenceText).toContain("command_run");
    expect(material.evidenceText).toContain("config.ts");
    expect(material.evidenceText).toContain("git push");

    const stubLlm = async () =>
      JSON.stringify({
        review: "今天把 config.ts 从 TOML 换成 YAML，并 push 了。",
        feeling: "",
        intensity: "",
        keywords: ["config.ts"],
        items: [
          {
            type: "work_action",
            content: "把 config.ts 的 TOML 解析换成 YAML；git push origin main 推了 3 个 commit",
            keywords: ["config.ts", "YAML", "git", "push"],
          },
        ],
      });
    const gen = await generateSelfReview({ material, llm: stubLlm });
    expect(gen.ok).toBe(true);
    storeSelfReviewResult(db, gen, { material, clock: frozenClock(T) });

    const wa = db.query("SELECT * FROM experiences WHERE kind='work_action'").all() as any[];
    expect(wa.length).toBe(1);
    expect(wa[0].content).toContain("config.ts");
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 3：feeling 恒 NULL
// ═══════════════════════════════════════════════════════════════════════
describe("[3] feeling 恒 NULL", () => {
  test("带 feeling 的 work_action item，落库后 feeling 仍为 NULL", async () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const T = "2026-06-20T12:00:00.000Z";
    // 直接构造一份带 feeling 的 work_action item 经 store 路径
    const material = {
      sessionId: "s-feel",
      project: PROJ,
      conversation: [],
      events: [],
      bookmarks: [],
      evidenceText: "git push deploy.sh 部署降40%",
    };
    // validator 会从 LLM 输出读 items；我们让 LLM 在 item 里塞 feeling 字段
    const stubLlm = async () =>
      JSON.stringify({
        review: "复盘",
        feeling: "整体松了口气",
        intensity: "中",
        keywords: ["部署"],
        items: [
          {
            type: "work_action",
            content: "部署 deploy.sh，体积降40%",
            keywords: ["deploy.sh", "部署"],
            feeling: "松了口气", // 恶意：item 里塞情绪
            intensity: "强",
          },
        ],
      });
    const gen = await generateSelfReview({ material: material as any, llm: stubLlm });
    expect(gen.ok).toBe(true);
    storeSelfReviewResult(db, gen, { material: material as any, clock: frozenClock(T) });

    const wa = db.query("SELECT * FROM experiences WHERE kind='work_action'").all() as any[];
    expect(wa.length).toBe(1);
    // 铁律：work_action.feeling 必须 NULL
    expect(wa[0].feeling).toBeNull();
    expect(wa[0].intensity).toBeNull();
    db.close();
  });

  test("work_action 不进 mood/closure（feeling IS NOT NULL）路 —— 即便有人手动给它塞 feeling", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    // 极端对抗：绕过 store，直接 insert 一条 feeling 非空的 work_action（模拟漂移）
    // 验 closure/decay 是否靠 feeling IS NOT NULL 把它捞进去（设计称 work_action.feeling=NULL 天然不进；
    // 但若漂移给了 feeling，则 closure 会捞它 —— 这是设计文档承认的"靠 feeling=NULL"假设。本测试坐实这个假设的边界。）
    const seed = frozenClock("2026-06-10T10:00:00.000Z");
    insertExperience(db, { kind: "work_action", content: "git deploy 降40%", feeling: null }, seed);
    // closure 查 feeling IS NOT NULL → feeling=NULL 的 work_action 不进
    const captured: string[] = [];
    const llm = async (prompt: string) => {
      if (prompt.includes("画上句号")) {
        captured.push(prompt);
        return JSON.stringify({ closure: "过去了。" });
      }
      if (prompt.includes("人格文档")) return "# 人格\n\n稳定。\n";
      if (prompt.includes("写日记")) return "今天平静。没什么特别。再丧也照跑测试照做验证，干净。";
      return "{}";
    };
    const r = await runNightlyDigestion(db, { clock: frozenClock("2026-06-11T03:00:00.000Z"), llm, config });
    // closure 阶段：feeling=NULL 的 work_action 不该出现在句号素材里（无情绪日 → 不造句号）
    expect(captured.length).toBe(0);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 4：召回命中
// ═══════════════════════════════════════════════════════════════════════
describe("[4] 召回命中", () => {
  test("searchExperiences 按文件名/命令名/关键词命中 work_action；不被 RECALL_EXCLUDE 误排", () => {
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    const seed = frozenClock("2026-06-20T10:00:00.000Z");
    insertExperience(
      db,
      {
        kind: "work_action",
        content: "把 config.ts 的 TOML 解析换成 YAML，修了 emoji 崩溃",
        keywords: ["config.ts", "YAML", "TOML", "emoji"],
        project: PROJ,
      },
      seed,
    );
    // 文件名命中
    expect(searchExperiences(db, "config.ts").some((r) => r.kind === "work_action")).toBe(true);
    // 关键词命中
    expect(searchExperiences(db, "YAML").some((r) => r.kind === "work_action")).toBe(true);
    // 内容词命中
    expect(searchExperiences(db, "emoji 崩溃").some((r) => r.kind === "work_action")).toBe(true);

    // 命令名命中
    insertExperience(
      db,
      { kind: "work_action", content: "跑 migration 先卡外键，加索引后过", keywords: ["migration", "外键", "索引"] },
      seed,
    );
    expect(searchExperiences(db, "migration").some((r) => r.kind === "work_action")).toBe(true);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 5：注入命中
// ═══════════════════════════════════════════════════════════════════════
describe("[5] 注入命中", () => {
  test("近7天本项目 work_action 进注入；>7天不注；不挤掉 preference/decision", () => {
    const { dbPath, home } = tmpHome();
    require("node:fs").mkdirSync(home, { recursive: true });
    const db = openDb(dbPath);
    const now = new Date("2026-06-20T10:00:00.000Z");
    const clk = frozenClock(now.toISOString());
    const recent = frozenClock("2026-06-19T10:00:00.000Z"); // 近7天
    const old = frozenClock("2026-06-01T10:00:00.000Z"); // >7天

    insertExperience(db, { kind: "work_action", content: "近期：git deploy v0.2 体积降40%", keywords: ["deploy"], project: PROJ }, recent);
    insertExperience(db, { kind: "work_action", content: "陈旧：很久以前改了 old.ts", keywords: ["old.ts"], project: PROJ }, old);
    insertExperience(db, { kind: "preference", content: "用户偏好：回复用中文", project: PROJ }, recent);
    insertExperience(db, { kind: "decision", content: "决策：架构选 worker 方案 C", project: PROJ }, recent);

    const personalityPath = join(home, "personality.md");
    writeFileSync(personalityPath, "# 人格\n\n稳。\n", "utf8");
    const res = assembleMorningInjection(db, {
      sessionId: "inj-1",
      project: PROJ,
      personalityPath,
      clock: clk,
    });
    // 近7天 work_action 进注入
    expect(res.text).toContain("git deploy v0.2");
    // >7天 work_action 不注
    expect(res.text).not.toContain("很久以前改了 old.ts");
    // 持久记忆不被挤掉
    expect(res.text).toContain("回复用中文");
    expect(res.text).toContain("worker 方案 C");
    db.close();
  });

  test("大量 work_action 不把 preference/decision 挤出注入（持久记忆优先）", () => {
    const { dbPath, home } = tmpHome();
    require("node:fs").mkdirSync(home, { recursive: true });
    const db = openDb(dbPath);
    const clk = frozenClock("2026-06-20T10:00:00.000Z");
    const recent = frozenClock("2026-06-19T23:00:00.000Z");
    // 灌 30 条近期 work_action（比注入限量 15 多，且更新 → 若混进同一 IN 会按近因霸占）
    for (let i = 0; i < 30; i++) {
      insertExperience(
        db,
        { kind: "work_action", content: `work动作${i}：跑了 cmd${i}`, keywords: [`cmd${i}`], project: PROJ },
        frozenClock(`2026-06-19T2${i % 4}:0${i % 9}:00.000Z`),
      );
    }
    insertExperience(db, { kind: "preference", content: "用户偏好：MUST保留中文回复", project: PROJ }, recent);
    insertExperience(db, { kind: "decision", content: "决策：MUST保留架构C", project: PROJ }, recent);

    const personalityPath = join(home, "personality.md");
    writeFileSync(personalityPath, "# 人格\n\n稳。\n", "utf8");
    const res = assembleMorningInjection(db, { sessionId: "inj-2", project: PROJ, personalityPath, clock: clk });
    expect(res.text).toContain("MUST保留中文回复");
    expect(res.text).toContain("MUST保留架构C");
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 6：F-A 致命 — work_action 绝不进日记/人格素材
// ═══════════════════════════════════════════════════════════════════════
describe("[6] F-A 半公开日记泄漏防线", () => {
  test("work_action 内容不进日记素材、不进人格素材；真 self_review/decision 照常进", async () => {
    const { dbPath, config } = tmpHome();
    const db = openDb(dbPath);
    const seed = frozenClock("2026-06-10T10:00:00.000Z");
    const SECRET_MARKER = "WORKACTION-RAW-FLOW-curl-token-xyz";
    insertExperience(
      db,
      { kind: "work_action", content: `${SECRET_MARKER} 部署命令原始流水`, keywords: ["deploy"], sourceSession: "s-wa" },
      seed,
    );
    insertExperience(db, { kind: "self_review", content: "真自评：今天收尾顺利。", feeling: "踏实", sourceSession: "s-real" }, seed);
    insertExperience(db, { kind: "decision", content: "决策：日记排除 work_action。", sourceSession: "s-real" }, seed);

    const prompts: Record<string, string> = {};
    const llm = async (prompt: string) => {
      if (prompt.includes("画上句号")) return JSON.stringify({ closure: "过去了。" });
      if (prompt.includes("人格文档")) {
        prompts.personality = prompt;
        return "# 人格卡\n\n我叫小满。经过昨天，我更确定要把机械流水挡在记忆之外，只留蒸馏过的叙事。\n";
      }
      if (prompt.includes("写日记")) {
        prompts.diary = prompt;
        return "今天把收尾做完，红到绿一次过，独立考官签字，踏实。再丧也照跑测试。";
      }
      return "{}";
    };
    const r = await runNightlyDigestion(db, { clock: frozenClock("2026-06-11T03:00:00.000Z"), llm, config });
    expect(r.stages.diary.status).toBe("done");
    expect(r.stages.personality.status).toBe("done");

    // 日记素材：绝不含 work_action 原始流水
    expect(prompts.diary ?? "").not.toContain(SECRET_MARKER);
    expect(prompts.diary ?? "").not.toContain("部署命令原始流水");
    // 人格素材：绝不含 work_action
    expect(prompts.personality ?? "").not.toContain(SECRET_MARKER);
    // 真内容照常进
    expect(prompts.personality ?? "").toContain("真自评");
    expect(prompts.diary ?? "").toContain("真自评");
    expect(prompts.personality ?? "").toContain("决策：");

    // 二重保险：落盘的日记文件不含原始流水
    const diaryFile = join(config.diaryDir, "2026-06-10.md");
    if (existsSync(diaryFile)) {
      expect(readFileSync(diaryFile, "utf8")).not.toContain(SECRET_MARKER);
    }
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 7：隐私 scrub
// ═══════════════════════════════════════════════════════════════════════
describe("[7] 隐私 scrub", () => {
  test("已知前缀密钥被打码", () => {
    expect(scrubSecrets("sk-abcdef1234567890ABCD")).toContain("[REDACTED]");
    expect(scrubSecrets("ghp_abcdefghij1234567890")).toContain("[REDACTED]");
    expect(scrubSecrets("gho_ABCDEFGHIJ1234567890")).toContain("[REDACTED]");
    expect(scrubSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED]");
    expect(scrubSecrets("xoxb-1234567890-abcdef")).toContain("[REDACTED]");
    expect(scrubSecrets("Authorization: Bearer eyJhbGciOiABCDEF123456")).toContain("[REDACTED]");
  });

  test("flag 后的值被打码（--token / --password / -H Authorization）", () => {
    expect(scrubSecrets("curl --token=abc123secret https://x")).toContain("[REDACTED]");
    expect(scrubSecrets("deploy --password supersecret")).toContain("[REDACTED]");
    expect(scrubSecrets('curl -H "Authorization: tokenvalue123" https://x')).toContain("[REDACTED]");
  });

  test("BEGIN PRIVATE KEY 整块打码", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const out = scrubSecrets(pem);
    expect(out).toContain("[REDACTED KEY]");
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
  });

  test("git 40位小写 hex SHA 不被误杀", () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
    expect(scrubSecrets(`git checkout ${sha}`)).toContain(sha);
    expect(scrubSecrets(`commit ${sha} fixed bug`)).toContain(sha);
    // 12位短 SHA 也不杀
    expect(scrubSecrets("a1b2c3d4e5f6")).toContain("a1b2c3d4e5f6");
  });

  test("高熵串（大小写数字混合 ≥20）被打码，但纯 hex/纯路径不杀", () => {
    expect(scrubSecrets("token=Ab3Cd9Ef2Gh5Ij8Kl1Mn4Op")).toContain("[REDACTED]");
    // 长路径（无数字或非混合）不杀
    expect(scrubSecrets("/Users/me/projects/anima/src/digest.ts")).toContain("digest.ts");
    expect(scrubSecrets("/very/long/path/to/some/deeply/nested/directory/file")).toContain("directory");
  });

  test("scrub 在截断之前对全量跑：密钥落在被省略中段也不漏（端到端）", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const T = "2026-06-20T10:00:00.000Z";
    // 构造一个超长输出：密钥埋在中段（首尾各150字之外）
    const head = "A".repeat(160);
    const tail = "B".repeat(160);
    const secret = "ghp_MIDDLESECRETkey1234567890";
    const longOut = `${head} ${secret} ${tail}`;
    const objs = [
      assistantToolUse([{ id: "c1", name: "Bash", input: { command: "gh api /user" } }], T),
      userToolResult([{ tool_use_id: "c1", content: longOut }], T),
    ];
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock(T) });
    const cmds = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "command_run");
    expect(cmds.length).toBe(1);
    const payloadStr = JSON.stringify(cmds[0]!.payload);
    // 密钥即便在中段，也不该残留（scrub 必须先于截断）
    expect(payloadStr).not.toContain("ghp_MIDDLESECRET");
    expect(payloadStr).not.toContain("MIDDLESECRETkey");
    db.close();
  });

  test("命令本身含密钥 → 整条命令不采，只留分类+成败", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const T = "2026-06-20T10:00:00.000Z";
    const objs = [
      assistantToolUse([{ id: "c1", name: "Bash", input: { command: "curl -H 'Authorization: Bearer eyJsupersecrettoken123' https://api.x" } }], T),
      userToolResult([{ tool_use_id: "c1", content: "ok" }], T),
    ];
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock(T) });
    const cmds = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "command_run");
    expect(cmds.length).toBe(1);
    const p = cmds[0]!.payload as any;
    expect(p.command).not.toContain("supersecrettoken");
    expect(p.category).toBe("net"); // 分类仍保留
    expect(p.ok).toBe(true);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 8：采集量上限 / 去重
// ═══════════════════════════════════════════════════════════════════════
describe("[8] cap / 去重", () => {
  test("file_read ≤50（单次 capture 内）", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const blocks: { id: string; name: string; input: Record<string, unknown> }[] = [];
    const results: { tool_use_id: string; content: unknown }[] = [];
    // 60 个不同文件、时间错开避免去重
    const baseT = Date.parse("2026-06-20T10:00:00.000Z");
    const objs: unknown[] = [];
    for (let i = 0; i < 60; i++) {
      const ts = new Date(baseT + i * 60_000).toISOString(); // 每个间隔1分钟（>?不重要，路径不同）
      const id = `r${i}`;
      objs.push(assistantToolUse([{ id, name: "Read", input: { file_path: `/p/file${i}.ts` } }], ts));
      objs.push(userToolResult([{ tool_use_id: id, content: "x" }], ts));
    }
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock("2026-06-20T11:00:00.000Z") });
    const reads = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "file_read");
    expect(reads.length).toBe(50);
    // 溢出 marker
    const overflow = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "work_capture_overflow");
    expect(overflow.length).toBe(1);
    expect((overflow[0]!.payload as any).droppedReads).toBe(10);
    db.close();
  });

  test("command_run ≤30", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const baseT = Date.parse("2026-06-20T10:00:00.000Z");
    const objs: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      const ts = new Date(baseT + i * 1000).toISOString();
      const id = `c${i}`;
      objs.push(assistantToolUse([{ id, name: "Bash", input: { command: `git log -n ${i}` } }], ts));
      objs.push(userToolResult([{ tool_use_id: id, content: "x" }], ts));
    }
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock("2026-06-20T11:00:00.000Z") });
    const cmds = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "command_run");
    expect(cmds.length).toBe(30);
    db.close();
  });

  test("同文件 10 分钟内重复 Read 只采 1 次", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const T1 = "2026-06-20T10:00:00.000Z";
    const T2 = "2026-06-20T10:05:00.000Z"; // 5分钟后，同文件
    const T3 = "2026-06-20T10:30:00.000Z"; // 30分钟后，超去重窗
    const objs = [
      assistantToolUse([{ id: "r1", name: "Read", input: { file_path: "/p/same.ts" } }], T1),
      userToolResult([{ tool_use_id: "r1", content: "x" }], T1),
      assistantToolUse([{ id: "r2", name: "Read", input: { file_path: "/p/same.ts" } }], T2),
      userToolResult([{ tool_use_id: "r2", content: "x" }], T2),
      assistantToolUse([{ id: "r3", name: "Read", input: { file_path: "/p/same.ts" } }], T3),
      userToolResult([{ tool_use_id: "r3", content: "x" }], T3),
    ];
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock("2026-06-20T11:00:00.000Z") });
    const reads = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "file_read");
    // T1 采，T2 去重（5分钟<10），T3 采（30分钟>10）
    expect(reads.length).toBe(2);
    db.close();
  });

  test("既有库存计入：跨多次 capture cap 仍生效", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const baseT = Date.parse("2026-06-20T10:00:00.000Z");
    // 第一次 capture：25 条 cmd
    const objs1: unknown[] = [];
    for (let i = 0; i < 25; i++) {
      const ts = new Date(baseT + i * 1000).toISOString();
      objs1.push(assistantToolUse([{ id: `a${i}`, name: "Bash", input: { command: `git log ${i}` } }], ts));
      objs1.push(userToolResult([{ tool_use_id: `a${i}`, content: "x" }], ts));
    }
    const tp1 = writeJsonl(home, objs1);
    captureTranscript(db, tp1, { clock: frozenClock("2026-06-20T11:00:00.000Z") });
    let cmds = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "command_run");
    expect(cmds.length).toBe(25);

    // 第二次 capture（同 session，新 transcript）：再来 20 条，cap=30 → 只能再进 5 条
    const objs2: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      const ts = new Date(baseT + 100_000 + i * 1000).toISOString();
      objs2.push(assistantToolUse([{ id: `b${i}`, name: "Bash", input: { command: `git diff ${i}` } }], ts));
      objs2.push(userToolResult([{ tool_use_id: `b${i}`, content: "x" }], ts));
    }
    const tp2 = writeJsonl(home, objs2);
    captureTranscript(db, tp2, { clock: frozenClock("2026-06-20T11:30:00.000Z") });
    cmds = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "command_run");
    expect(cmds.length).toBe(30); // 25 + 5（既有库存计入）
    db.close();
  });

  test("cmd 触顶按类别优先级丢低信号（保 deploy/install，丢 net/other）", () => {
    // filterWorkMemoryEvents 单元测：cap 假设已满到 28，剩 2 个 allowance；给 4 条不同类
    const { dbPath } = tmpHome();
    const db = openDb(dbPath);
    // 预灌 28 条占位（既有库存）
    const seed = frozenClock("2026-06-20T09:00:00.000Z");
    for (let i = 0; i < 28; i++) {
      appendSituation(db, { sessionId: "capS", kind: "command_run", payload: { command: `git x${i}`, category: "git", ok: true } }, seed);
    }
    const mk = (cat: string, cmd: string) => ({
      sessionId: "capS",
      project: PROJ,
      kind: "command_run",
      payload: { command: cmd, category: cat, ok: true },
      occurredAt: "2026-06-20T10:00:00.000Z",
    });
    const events = [mk("net", "curl a"), mk("deploy", "deploy b"), mk("net", "wget c"), mk("install", "npm install d")];
    const out = filterWorkMemoryEvents(db, events as any);
    const kept = out.filter((e) => e.kind === "command_run").map((e) => (e.payload as any).category);
    // 只剩 2 allowance → 应保 deploy + install（高优先级），丢 net x2
    expect(kept.sort()).toEqual(["deploy", "install"]);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 契约 9：铁律
// ═══════════════════════════════════════════════════════════════════════
describe("[9] 铁律", () => {
  test("新 kind 在 TRANSCRIPT_ACTIVITY_KINDS", () => {
    expect(TRANSCRIPT_ACTIVITY_KINDS).toContain("file_read");
    expect(TRANSCRIPT_ACTIVITY_KINDS).toContain("command_run");
    // file_edit 既有
    expect(TRANSCRIPT_ACTIVITY_KINDS).toContain("file_edit");
  });

  test("采集层 extractEvents 是纯函数、零 LLM（不碰网络/异步）", () => {
    // extractEvents 同步返回，无 Promise
    const out = extractEvents([]);
    expect(Array.isArray(out)).toBe(true);
  });

  test("work_capture_overflow marker 不在 TRANSCRIPT_ACTIVITY_KINDS（不毒化夜归属）", () => {
    expect(TRANSCRIPT_ACTIVITY_KINDS).not.toContain("work_capture_overflow");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 对抗找纰漏区
// ═══════════════════════════════════════════════════════════════════════
describe("[对抗] scrub 绕过尝试", () => {
  test("换行变体：密钥后跟换行", () => {
    expect(scrubSecrets("token: ghp_abcdefghij1234567890\nnext line")).toContain("[REDACTED]");
  });

  test("大小写变体 Bearer", () => {
    expect(scrubSecrets("authorization: bearer eyJhbGciOiABCDEF12345678")).toContain("[REDACTED]");
    expect(scrubSecrets("BEARER eyJhbGciOiABCDEF12345678")).toContain("[REDACTED]");
  });

  test("AWS secret access key (40字 base64含+/) — 高熵兜底是否盖到", () => {
    // AWS secret = 40 chars base64，常含大小写数字。设计②高熵串：连续≥20混合
    const awsSecret = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12";
    const out = scrubSecrets(`aws_secret=${awsSecret}`);
    // 期望被高熵或 flag 兜住
    expect(out).toContain("[REDACTED]");
  });

  test("纯小写 hex 64位（sha256）不被高熵误杀（无大写）", () => {
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(scrubSecrets(sha256)).toContain(sha256);
  });

  test("URL 里的 ?token= query 参数是否漏（潜在纰漏探测）", () => {
    // curl https://x?token=AbC123dEf456GhI789jK —— flag 正则要求 --token，query 形式 ?token= 不匹配
    const out = scrubSecrets("curl https://api.x/?token=AbC123dEf456GhI789jKLM");
    // 这里靠高熵串兜底（20位混合）
    expect(out).toContain("[REDACTED]");
  });

  // ── N-1 修复回归（coordinator 补两条正则：URL query 敏感参数 + basic-auth 密码）──
  test("[N-1 回归] 短 URL query token 被打码（不再靠高熵）", () => {
    expect(scrubSecrets("curl https://api.example.com?token=AbC123dEf456GhX")).not.toContain("AbC123dEf456GhX");
    expect(scrubSecrets("curl https://x?api_key=abcdef123456")).not.toContain("abcdef123456");
    expect(scrubSecrets("curl 'https://x?page=2&secret=Sh0rtT0k'")).not.toContain("Sh0rtT0k");
  });
  test("[N-1 回归] basic-auth / URI-scheme 密码被打码", () => {
    expect(scrubSecrets("git clone https://user:p4ssw0rd123@github.com/x/y.git")).not.toContain("p4ssw0rd123");
    expect(scrubSecrets("psql postgres://dbuser:dbpass123@localhost:5432/db")).not.toContain("dbpass123");
  });
  test("[N-1 回归] 两条新正则不误伤正常命令（page/sort/port/scp/ssh）", () => {
    expect(scrubSecrets("curl 'https://x?page=2&sort=name'")).toContain("page=2");
    expect(scrubSecrets("curl 'https://x?page=2&sort=name'")).toContain("sort=name");
    expect(scrubSecrets("curl http://localhost:3000/api/x")).toContain("localhost:3000");
    expect(scrubSecrets("curl https://example.com:8443/path")).toContain("example.com:8443");
    expect(scrubSecrets("scp file user@host:/path")).toContain("user@host");
    expect(scrubSecrets("ssh git@github.com")).toContain("git@github.com");
  });
  test("[N-1 回归] 含 query token 的命令端到端被整条抑制；输出端 ?secret= 就地打码", () => {
    const { home, dbPath } = tmpHome();
    const db = openDb(dbPath);
    const T = "2026-06-20T10:00:00.000Z";
    const objs = [
      assistantToolUse([{ id: "c1", name: "Bash", input: { command: "curl https://api.x?token=AbC123dEf456GhX" } }], T),
      userToolResult([{ tool_use_id: "c1", content: "webhook https://h?secret=Sh0rtT0ken99 set" }], T),
    ];
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock(T) });
    const p = listSituations(db, { sessionId: SID }).filter((r) => r.kind === "command_run")[0]!.payload as any;
    expect(p.command).not.toContain("AbC123dEf456GhX");
    expect(p.output).not.toContain("Sh0rtT0ken99");
    expect(p.category).toBe("net");
    db.close();
  });
});

describe("[对抗] 蒸馏事实接地", () => {
  test("work_action content 编造不存在的文件路径 → 被事实接地拦掉", () => {
    const evidence = "command_run git push";
    const raw = JSON.stringify({
      review: "复盘",
      feeling: "",
      intensity: "",
      keywords: [],
      items: [{ type: "work_action", content: "改了 /fake/nonexistent.ts 的解析", keywords: ["nonexistent.ts"] }],
    });
    const res = validateSelfReview(raw, evidence);
    expect(res.ok).toBe(false);
  });

  test("work_action content 超 200 字 → 被丢弃（不毁整份自评）", () => {
    const evidence = "config.ts";
    const longContent = "改了 config.ts " + "啊".repeat(250);
    const raw = JSON.stringify({
      review: "复盘",
      feeling: "",
      intensity: "",
      keywords: [],
      items: [
        { type: "work_action", content: longContent, keywords: ["config.ts"] },
        { type: "work_action", content: "改了 config.ts 短的", keywords: ["config.ts"] },
      ],
    });
    const res = validateSelfReview(raw, evidence);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const was = res.value.items.filter((i) => i.type === "work_action");
      expect(was.length).toBe(1); // 长的被丢，短的留
      expect(was[0]!.content).toContain("短的");
    }
  });
});

describe("[对抗] 端到端：采集→蒸馏→召回→注入 全链路接上", () => {
  test("一条工作动作走完全程，召回与注入双命中", async () => {
    const { home, dbPath } = tmpHome();
    require("node:fs").mkdirSync(home, { recursive: true });
    const db = openDb(dbPath);
    const T = "2026-06-20T10:00:00.000Z";
    const objs = [
      userText("部署一下", T),
      assistantToolUse([{ id: "c1", name: "Bash", input: { command: "vercel deploy --prod" } }], T),
      userToolResult([{ tool_use_id: "c1", content: "Deployed: bundle 40% smaller" }], T),
    ];
    const tp = writeJsonl(home, objs);
    captureTranscript(db, tp, { clock: frozenClock(T) });

    const material = buildMaterial(db, { transcriptPath: tp, sessionId: SID });
    const stubLlm = async () =>
      JSON.stringify({
        review: "部署了，体积降40%。",
        feeling: "",
        intensity: "",
        keywords: ["deploy"],
        items: [{ type: "work_action", content: "vercel deploy --prod，bundle 体积降40%", keywords: ["vercel", "deploy", "部署"] }],
      });
    const gen = await generateSelfReview({ material, llm: stubLlm });
    expect(gen.ok).toBe(true);
    storeSelfReviewResult(db, gen, { material, clock: frozenClock("2026-06-20T10:30:00.000Z") });

    // 召回命中
    const recalled = searchExperiences(db, "vercel 部署", { project: PROJ, includeGlobal: true });
    expect(recalled.some((r) => r.kind === "work_action")).toBe(true);

    // 注入命中
    const personalityPath = join(home, "personality.md");
    writeFileSync(personalityPath, "# 人格\n\n稳。\n", "utf8");
    const inj = assembleMorningInjection(db, {
      sessionId: "e2e-inj",
      project: PROJ,
      personalityPath,
      clock: frozenClock("2026-06-20T23:00:00.000Z"),
    });
    expect(inj.text).toContain("vercel deploy");
    db.close();
  });
});
