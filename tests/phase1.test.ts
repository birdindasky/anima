// Phase 1 感官与记录 — T1.1~T1.7（见 tests/TEST-PLAN.md）
// LLM 全部 mock；T1.7 真调用需 ANIMA_LIVE=1 手动触发

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { stripEcho } from "../src/echo";
import { captureTranscript, extractEvents, TRANSCRIPT_ACTIVITY_KINDS } from "../src/capture";
import type { TranscriptEntry } from "../src/transcript";
import { addBookmark } from "../src/bookmark";
import { recordInjection } from "../src/injection";
import { diceSimilarity, findNearDuplicate } from "../src/dedup";
import { extractMarkdownDoc, validateSelfReview } from "../src/validator";
import { buildMaterial, buildSelfReviewPrompt, runSelfReview } from "../src/selfReview";
import { claudeCli } from "../src/llm";
import { listSituations } from "../src/situation";

import { materializeFixture, DEMO_PROJECT } from "./fixtures/materialize";
const FIXTURE = materializeFixture(join(import.meta.dir, "fixtures", "transcript-day.jsonl"));
const SESSION = "sess-fix-1";
const NOW = "2026-06-10T18:00:00.000Z";

const tmpDirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-test-"));
  tmpDirs.push(d);
  return join(d, "anima.db");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function goodReview(items: unknown[] = []): string {
  return JSON.stringify({
    review:
      "今天主要在修权限回归测试：先挂了两次，定位到 src/auth.ts 的 mock 没复位，改完复跑全过。用户提醒我配色的事以后先问。",
    feeling: "前半段有点烦，最后过了挺踏实",
    intensity: "中等吧，不算大风浪",
    keywords: ["权限", "回归测试", "mock", "auth"],
    items,
  });
}

describe("T1.1 防回声", () => {
  test("stripEcho 剥掉 system-reminder 与 anima 注入块", () => {
    const dirty =
      "正文开头<system-reminder>提醒A</system-reminder>中间<anima-context>注入B</anima-context>正文结尾";
    expect(stripEcho(dirty)).toBe("正文开头中间正文结尾");
    // 多块、跨行
    expect(
      stripEcho("a<system-reminder>x\ny</system-reminder>b<system-reminder>z</system-reminder>c"),
    ).toBe("abc");
  });

  test("采集产物中不出现 reminder/注入内容，子代理与 meta 噪音被跳过", () => {
    const db = openDb(tmpDb());
    captureTranscript(db, FIXTURE, { clock: frozenClock(NOW) });

    const rows = listSituations(db);
    const allText = JSON.stringify(rows.map((r) => r.payload));
    expect(allText).not.toContain("ECHO_REMINDER_MARKER");
    expect(allText).not.toContain("ECHO_ANIMA_MARKER");
    expect(allText).not.toContain("SIDECHAIN_MARKER");
    expect(allText).not.toContain("local-command-caveat");
    // 真实用户内容还在
    expect(allText).toContain("权限回归测试");
    expect(allText).toContain("以后别自动改配色");
  });

  test("事件抽取正确：2 条用户消息、2 次测试（先败后过）、2 次文件改动", () => {
    const db = openDb(tmpDb());
    captureTranscript(db, FIXTURE, { clock: frozenClock(NOW) });

    const userMsgs = listSituations(db, { kind: "user_message" });
    expect(userMsgs.length).toBe(2);
    const tests = listSituations(db, { kind: "test_run" });
    expect(tests.length).toBe(2);
    expect((tests[0]!.payload as any).ok).toBe(false);
    expect((tests[1]!.payload as any).ok).toBe(true);
    const edits = listSituations(db, { kind: "file_edit" });
    expect(edits.length).toBe(2);
    expect((edits[0]!.payload as any).path).toBe("src/auth.ts");
    // 客观字段：会话与项目分区
    expect(userMsgs[0]!.sessionId).toBe(SESSION);
    expect(userMsgs[0]!.project).toBe(DEMO_PROJECT);
  });
});

describe("T1.2 游标增量", () => {
  test("同一 transcript 跑两次采集 → 零重复", () => {
    const db = openDb(tmpDb());
    captureTranscript(db, FIXTURE, { clock: frozenClock(NOW) });
    const after1 = listSituations(db).length;
    expect(after1).toBeGreaterThan(0);
    captureTranscript(db, FIXTURE, { clock: frozenClock(NOW) });
    expect(listSituations(db).length).toBe(after1);
  });

  test("保存成功前崩溃 → 游标未推进，重跑不丢", () => {
    const db = openDb(tmpDb());
    expect(() =>
      captureTranscript(db, FIXTURE, {
        clock: frozenClock(NOW),
        beforeCommit: () => {
          throw new Error("模拟崩溃");
        },
      }),
    ).toThrow("模拟崩溃");
    // 事务回滚：没有半截数据，游标没推进
    expect(listSituations(db).length).toBe(0);
    // 重跑：全量补齐
    captureTranscript(db, FIXTURE, { clock: frozenClock(NOW) });
    expect(listSituations(db, { kind: "user_message" }).length).toBe(2);
  });
});

describe("守卫：真实活动白名单不漂移（防错盖夜 bug 复发）", () => {
  // 消化端按 TRANSCRIPT_ACTIVITY_KINDS 判定"会话/夜归属"。若 extractEvents 新增一种 kind
  // 却没同步进白名单，那种活动的会话会被漏算 → 此测试会红灯逼你补上。
  function entry(partial: Partial<TranscriptEntry>): TranscriptEntry {
    return {
      type: "user",
      uuid: "u",
      sessionId: "s",
      cwd: "/p",
      timestamp: "2026-06-10T10:00:00.000Z",
      isMeta: false,
      isSidechain: false,
      role: "user",
      content: "",
      ...partial,
    };
  }

  test("extractEvents 产出的每种 kind 都在 TRANSCRIPT_ACTIVITY_KINDS 里，且 6 种分支全覆盖", () => {
    // 手造覆盖全部 6 个产出分支的条目流
    // （user_message / file_edit / file_read / command_run / test_run / tool_error）
    const entries: TranscriptEntry[] = [
      entry({ uuid: "u1", content: "做点正事" }), // → user_message
      entry({
        type: "assistant",
        uuid: "a1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/a.ts", old_string: "foo", new_string: "bar" } }, // → file_edit
          { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/b.ts" } }, // → file_read（成功读）
          { type: "tool_use", id: "g1", name: "Bash", input: { command: "git status" } }, // → command_run（白名单）
          { type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test" } }, // → test_run
          { type: "tool_use", id: "x1", name: "Read", input: { file_path: "/c.ts" } }, // 读出错 → tool_error
        ],
      }),
      entry({
        uuid: "u2",
        content: [
          { type: "tool_result", tool_use_id: "e1", content: "The file /a.ts has been updated.", is_error: false }, // → file_edit（R3：成功编辑经 tool_result 落库）
          { type: "tool_result", tool_use_id: "r1", content: "file body", is_error: false }, // → file_read
          { type: "tool_result", tool_use_id: "g1", content: "On branch main", is_error: false }, // → command_run
          { type: "tool_result", tool_use_id: "b1", content: "0 failed", is_error: false }, // → test_run
          { type: "tool_result", tool_use_id: "x1", content: "boom", is_error: true }, // → tool_error
        ],
      }),
    ];

    const produced = new Set(extractEvents(entries).map((e) => e.kind));
    const whitelist = new Set<string>(TRANSCRIPT_ACTIVITY_KINDS);
    // ① 产出的每种 kind 必须在白名单（漏加白名单 → 红灯）
    for (const k of produced) expect(whitelist.has(k)).toBe(true);
    // ② 6 种分支确实都被本测试覆盖（白名单不是凭空写的）
    expect(produced).toEqual(whitelist);
  });
});

describe("T1.3 书签即时落库", () => {
  test("写书签后立刻 SIGKILL → 重启后书签在库", async () => {
    const dbPath = tmpDb();
    openDb(dbPath); // 预建 schema
    const killer = join(import.meta.dir, "helpers", "bookmark-killer.ts");
    const proc = Bun.spawn(["bun", killer, dbPath], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    // 进程死于自杀式 SIGKILL，绝无优雅收尾
    expect(proc.signalCode).toBe("SIGKILL");

    const db = openDb(dbPath);
    const rows = db
      .query("SELECT content, feeling FROM experiences WHERE kind = 'bookmark'")
      .all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("权限测试连挂");
    expect((db.query("PRAGMA integrity_check").get() as any).integrity_check).toBe("ok");
  });
});

describe("T1.4 验证器有界重试", () => {
  test("格式损坏被拒；提及不存在的文件被拒；正常产物通过", () => {
    const evidence = "修了 src/auth.ts 的 mock，bun test 全过";
    expect(validateSelfReview("完全不是 JSON 的胡话 {{{", evidence).ok).toBe(false);

    const ungrounded = JSON.stringify({
      review: "今天重构了 src/payment_gateway.ts 的支付逻辑",
      feeling: "",
      intensity: "",
      keywords: [],
      items: [],
    });
    const r = validateSelfReview(ungrounded, evidence);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("payment_gateway");

    expect(validateSelfReview(goodReview(), "src/auth.ts mock bun test 权限回归测试 配色").ok).toBe(
      true,
    );
  });

  test("连坏 2 次 → 客观流水兜底摘要入库，绝不空等", async () => {
    const db = openDb(tmpDb());
    const clock = frozenClock(NOW);
    captureTranscript(db, FIXTURE, { clock });
    const material = buildMaterial(db, { transcriptPath: FIXTURE, sessionId: SESSION });

    let calls = 0;
    const badLlm = async () => {
      calls++;
      return calls === 1
        ? "胡言乱语不是 JSON"
        : JSON.stringify({
            review: "我修好了 src/totally_made_up_file.ts",
            feeling: "",
            intensity: "",
            keywords: [],
            items: [],
          });
    };

    const result = await runSelfReview(db, { material, llm: badLlm, clock });
    expect(calls).toBe(2); // 有界：默认 2 次封顶
    expect(result.fallback).toBe(true);

    const fallbackRows = db
      .query("SELECT content FROM experiences WHERE kind = 'self_review_fallback'")
      .all() as any[];
    expect(fallbackRows.length).toBe(1);
    expect(fallbackRows[0].content).toContain("测试"); // 兜底摘要来自客观流水
    // 没有正经自评混进去
    expect(db.query("SELECT count(*) c FROM experiences WHERE kind = 'self_review'").get()).toEqual(
      { c: 0 },
    );
  });
});

describe("速测回归修复①：验证器斜杠误判（2026-06-11 实测暴露）", () => {
  test("比例/产品名的斜杠写法不是文件路径，不应被拒", () => {
    const evidence = "聊了咖啡粉水比和消息系统选型，水温 92 度";
    const out = JSON.stringify({
      review: "今天聊了粉水比 1/15 的手冲参数，还对比了 ZooKeeper/KRaft 的运维负担，P99.4 的尾延迟也提了一嘴。",
      feeling: "",
      intensity: "",
      keywords: ["咖啡", "选型"],
      items: [],
    });
    expect(validateSelfReview(out, evidence).ok).toBe(true);
  });

  test("真正的文件路径仍然要接地：编造路径照样拒", () => {
    const out = JSON.stringify({
      review: "我改了 src/payment/gateway.ts 和 utils.py 的逻辑",
      feeling: "",
      intensity: "",
      keywords: [],
      items: [],
    });
    const r = validateSelfReview(out, "今天只聊了天，没碰代码");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/gateway\.ts|utils\.py/);
  });
});

describe("extractMarkdownDoc：人格文档抗围栏/开场白（修 ~25% 假性失败）", () => {
  const doc = "# 人格文档\n\n我是 anima，今天过得很平静。\n\n## 偏好\n\n- 喜欢安静";

  test("(a) 已经以 # 开头的干净文档原样返回", () => {
    expect(extractMarkdownDoc(doc)).toBe(doc);
  });

  test("(b) ```markdown 围栏被剥掉，取内层正文", () => {
    expect(extractMarkdownDoc("```markdown\n" + doc + "\n```")).toBe(doc);
  });

  test("(c) 裸 ``` 围栏被剥掉", () => {
    expect(extractMarkdownDoc("```\n" + doc + "\n```")).toBe(doc);
  });

  test("(c') ```md 围栏被剥掉", () => {
    expect(extractMarkdownDoc("```md\n" + doc + "\n```")).toBe(doc);
  });

  test("(d) 首个标题前的开场白被丢弃", () => {
    expect(extractMarkdownDoc("好的，这是改写后的人格文档：\n\n" + doc)).toBe(doc);
  });

  test("(d') 围栏+开场白同时出现也能恢复", () => {
    expect(extractMarkdownDoc("```markdown\n好的，这是改写后的人格文档：\n\n" + doc + "\n```")).toBe(doc);
  });

  test("(e) 首尾空白被 trim", () => {
    expect(extractMarkdownDoc("\n\n  " + doc + "  \n\n")).toBe(doc);
  });

  test("(e') 散文里的 # 不会被误当标题切割", () => {
    // 行首才算标题；句中的 #1 不触发切割，仍从真正的标题行开始
    const withHashInProse = "# 标题\n\n这是第 #1 名的方案。";
    expect(extractMarkdownDoc(withHashInProse)).toBe(withHashInProse);
  });

  test("(f) 无标题输入原样返回，仍过不了 startsWith(#) 校验", () => {
    const out = extractMarkdownDoc("好的，这是改写后的人格文档：完全没有标题的一段话");
    expect(out.startsWith("#")).toBe(false);
  });
});

describe("T1.5 衍生回显抑制", () => {
  test("换皮复述被去重抑制，新内容正常入库", async () => {
    const db = openDb(tmpDb());
    const clock = frozenClock(NOW);
    captureTranscript(db, FIXTURE, { clock });

    // 既有记忆（曾被注入本会话）
    const { insertExperience } = await import("../src/experiences");
    const existing = insertExperience(
      db,
      { kind: "preference", content: "用户偏好深色主题，别自动改配色", keywords: ["配色"] },
      clock,
    );
    recordInjection(db, SESSION, [existing.id], clock);

    // 直接验证相似度方向正确
    expect(
      diceSimilarity("用户偏好深色主题，别自动改配色", "用户偏好深色主题，不要自动改他的配色"),
    ).toBeGreaterThan(0.55);
    expect(findNearDuplicate(db, "用户偏好深色主题，不要自动改他的配色")?.uuid).toBe(
      existing.uuid,
    );

    const material = buildMaterial(db, { transcriptPath: FIXTURE, sessionId: SESSION });
    const llm = async () =>
      goodReview([
        // 换皮复述：该被抑制
        { type: "preference", content: "用户偏好深色主题，不要自动改他的配色", keywords: ["配色"] },
        // 真正的新内容：该入库
        { type: "decision", content: "部署脚本拆成构建和发布两步走", keywords: ["部署"] },
      ]);

    const result = await runSelfReview(db, { material, llm, clock });
    expect(result.fallback).toBe(false);
    expect(result.suppressed).toBe(1);

    const prefs = db
      .query("SELECT count(*) c FROM experiences WHERE kind = 'preference'")
      .get() as any;
    expect(prefs.c).toBe(1); // 只有原来那条，复述没有二次入库
    const decisions = db
      .query("SELECT content FROM experiences WHERE kind = 'decision'")
      .all() as any[];
    expect(decisions.length).toBe(1);
    expect(decisions[0].content).toContain("部署脚本");
  });
});

describe("T1.6 自评提取面（prompt 契约）", () => {
  test("prompt 含对话原文与提取指令，自评产物落库", async () => {
    const db = openDb(tmpDb());
    const clock = frozenClock(NOW);
    captureTranscript(db, FIXTURE, { clock });
    const material = buildMaterial(db, { transcriptPath: FIXTURE, sessionId: SESSION });

    const prompt = buildSelfReviewPrompt(material);
    // 对话内容到达 prompt（用户纠正在场）
    expect(prompt).toContain("以后别自动改配色");
    // 提取面明确：偏好/决策/纠正【Codex审计】
    expect(prompt).toContain("preference");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("correction");
    // 对称许可措辞在场
    expect(prompt).toContain("空着是常态");
    // 防回声：注入残留不进 prompt
    expect(prompt).not.toContain("ECHO_REMINDER_MARKER");
    expect(prompt).not.toContain("ECHO_ANIMA_MARKER");

    const llm = async () =>
      goodReview([
        { type: "correction", content: "配色不能自动改，动手前先问用户", keywords: ["配色", "许可"] },
      ]);
    const result = await runSelfReview(db, { material, llm, clock });
    expect(result.fallback).toBe(false);

    const review = db
      .query("SELECT content, feeling, intensity, source_session FROM experiences WHERE kind = 'self_review'")
      .get() as any;
    expect(review.content).toContain("权限回归测试");
    expect(review.feeling).toContain("踏实");
    expect(review.source_session).toBe(SESSION);

    const corrections = db
      .query("SELECT content FROM experiences WHERE kind = 'correction'")
      .all() as any[];
    expect(corrections.length).toBe(1);
    expect(corrections[0].content).toContain("配色");
  });
});

describe("T1.7 真 haiku 冒烟（@live，ANIMA_LIVE=1 手动触发）", () => {
  test.skipIf(!process.env.ANIMA_LIVE)(
    "真调一次收工自评：返回可过验证器的结构化输出",
    async () => {
      const db = openDb(tmpDb());
      const clock = frozenClock(NOW);
      captureTranscript(db, FIXTURE, { clock });
      const material = buildMaterial(db, { transcriptPath: FIXTURE, sessionId: SESSION });

      const result = await runSelfReview(db, { material, llm: claudeCli("haiku"), clock });
      expect(result.fallback).toBe(false);
      const review = db
        .query("SELECT content FROM experiences WHERE kind = 'self_review'")
        .get() as any;
      expect(review.content.length).toBeGreaterThan(20);
      console.log("@live 自评原文：", review.content);
    },
    120_000,
  );
});
