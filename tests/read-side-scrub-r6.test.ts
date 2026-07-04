// R6（AUDIT-2026-07-03）复现 + 修复验收：读侧全程零 scrubSecrets + 高熵兜底网结构性失明。
// 两条独立验收：
//  ① 读侧兜底——所有面向模型 emit 记忆正文的点（inject.renderItem / recall.renderExperienceDetail /
//     renderMemoryDetail / searchRawReceipts 渲染）都统一过 scrubSecrets，独立于写侧是否脱敏，
//     给 append-only 存量补最后一道读时防线；裸密钥进库也再不会浮到模型面前。
//  ② 高熵网加固——补 AIza / slack webhook / sha1|sha256= 签名三条专用模式，且**绝不放宽**
//     "裸 hex 一律放行"的精度契约（git SHA / 纯 hex 仍不误杀，见 grader-blind 契约7）。
// 铁律守卫：三个 scrubber（scrubSecrets / scrubMoodViolations / scrubMoodNumbers）各自独立、绝不合并——
//   情绪数字是故意存进 feeling 列的主权数据，feeling 只走 scrubMoodNumbers，永不喂给 secret scrubber。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubSecrets } from "../src/capture";
import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { assembleMorningInjection } from "../src/inject";
import { renderExperienceDetail, renderMemoryDetail, searchMemoryIndex } from "../src/recall";

const NOW = "2026-07-03T02:00:00.000Z";
const clock = frozenClock(NOW);
const PROJECT = "/Users/tester/Projects/demo";

// 裸密钥（无 flag、无名字提示）：走前缀型规则打码。写侧就算漏了，读侧也得兜住。
const BARE_SECRET = "ghp_LIVEsecretTOKEN1234567890abcd";

const tmpDirs: string[] = [];
function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "anima-r6-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "anima-home"), { recursive: true });
  const personalityPath = join(dir, "anima-home", "personality.md");
  writeFileSync(personalityPath, "# 人格卡\n\n我叫小满。\n", "utf8");
  return { dbPath: join(dir, "anima-home", "anima.db"), personalityPath };
}
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "anima-r6db-"));
  tmpDirs.push(dir);
  return openDb(join(dir, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("R6 读侧兜底：面向模型 emit 记忆正文的点统一 scrubSecrets", () => {
  test("inject.renderItem（走 assembleMorningInjection）：注入正文里的裸密钥被打码", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    insertExperience(
      db,
      {
        kind: "self_review",
        project: PROJECT,
        content: `今天调好了部署，用的密钥是 ${BARE_SECRET} 记一下。`,
        feeling: "踏实",
        intensity: "较强",
        occurredAt: NOW,
      },
      clock,
    );
    const out = assembleMorningInjection(db, { sessionId: "r6-inj", project: PROJECT, personalityPath, clock });
    expect(out.text).not.toContain(BARE_SECRET);
    expect(out.text).toContain("[REDACTED]");
  });

  test("recall.renderExperienceDetail（走 renderMemoryDetail source=experience）：全文里的裸密钥被打码", () => {
    const db = freshDb();
    const r = insertExperience(
      db,
      { kind: "decision", project: PROJECT, content: `决定把密钥换成 ${BARE_SECRET}，别泄漏。`, feeling: "警觉" },
      clock,
    );
    const out = renderMemoryDetail(db, "experience", r.id, { clock, project: PROJECT });
    expect(out).not.toBeNull();
    expect(out!).not.toContain(BARE_SECRET);
    expect(out!).toContain("[REDACTED]");
  });

  test("recall.renderMemoryDetail situation 分支（user_message 原话）：裸密钥被打码", () => {
    const db = freshDb();
    const r = appendSituation(
      db,
      { kind: "user_message", project: PROJECT, payload: { text: `帮我用 ${BARE_SECRET} 登一下`, uuid: "u1" }, occurredAt: NOW },
    );
    const out = renderMemoryDetail(db, "situation", r.id, { clock });
    expect(out).not.toBeNull();
    expect(out!).not.toContain(BARE_SECRET);
    expect(out!).toContain("[REDACTED]");
  });

  test("recall.renderMemoryDetail situation 分支（command_run 输出）：输出里的裸密钥被打码", () => {
    const db = freshDb();
    const r = appendSituation(
      db,
      { kind: "command_run", project: PROJECT, payload: { command: "git remote -v", category: "git", ok: true, output: `origin ${BARE_SECRET}` }, occurredAt: NOW },
    );
    const out = renderMemoryDetail(db, "situation", r.id, { clock });
    expect(out).not.toBeNull();
    expect(out!).not.toContain(BARE_SECRET);
    expect(out!).toContain("[REDACTED]");
  });

  test("searchRawReceipts 渲染（经历空→翻原始流水的兜底索引）：小票里的裸密钥被打码", () => {
    const db = freshDb();
    // 无经历 → searchMemoryIndex 落到 receiptIndexLines（翻 user_message 原文）。
    appendSituation(
      db,
      { kind: "user_message", project: PROJECT, payload: { text: `部署密钥泄漏了：${BARE_SECRET}`, uuid: "u2" }, occurredAt: NOW },
    );
    const lines = searchMemoryIndex(db, "密钥泄漏", { project: PROJECT, clock });
    const joined = lines.map((l) => l.line).join("\n");
    expect(joined).toContain("流水原文"); // 确认真走到了兜底流水路
    expect(joined).not.toContain(BARE_SECRET);
    expect(joined).toContain("[REDACTED]");
  });

  test("经历索引行（experienceIndexLines，走 searchMemoryIndex）：正文快照里的裸密钥被打码", () => {
    const db = freshDb();
    insertExperience(
      db,
      { kind: "decision", project: PROJECT, content: `密钥轮换：新值 ${BARE_SECRET}`, feeling: "警觉" },
      clock,
    );
    const lines = searchMemoryIndex(db, "密钥轮换", { project: PROJECT, clock });
    const joined = lines.map((l) => l.line).join("\n");
    expect(joined).not.toContain(BARE_SECRET);
    expect(joined).toContain("[REDACTED]");
  });
});

describe("R6 铁律：三 scrubber 各自独立——feeling 列不被 secret scrubber 动", () => {
  test("content 与 feeling 两条不变式独立：content 密钥被打码，feeling 情绪原样（不被 [REDACTED]）", () => {
    const db = freshDb();
    const r = insertExperience(
      db,
      { kind: "self_review", project: PROJECT, content: `密钥 ${BARE_SECRET} 收好了。`, feeling: "踏实又有点累" },
      clock,
    );
    const out = renderMemoryDetail(db, "experience", r.id, { clock, project: PROJECT })!;
    // content：secret scrubber 生效
    expect(out).not.toContain(BARE_SECRET);
    expect(out).toContain("[REDACTED]");
    // feeling：走 scrubMoodNumbers，情绪词原样保留、绝不被 secret scrubber 打成 [REDACTED]
    expect(out).toContain("感受：踏实又有点累");
  });

  test("feeling 里的情绪数字不被 secret scrubber 误伤：仍由主权闸 scrubMoodNumbers 处理（剥数字、非 REDACTED）", () => {
    const db = freshDb();
    const r = insertExperience(
      db,
      { kind: "self_review", project: PROJECT, content: "今天很顺。", feeling: "心情不错 打 8 分" },
      clock,
    );
    const out = renderExperienceDetail(db, r.id, { clock, project: PROJECT })!;
    // 主权铁律：情绪数字剥掉（不喂回模型），但绝不出现 secret scrubber 的 [REDACTED]。
    expect(out).toContain("心情不错");
    expect(out).not.toContain("[REDACTED]");
    expect(out).not.toMatch(/8\s*分/); // 情绪数字已被主权闸剥除
  });
});

describe("R6 高熵网加固：补专用模式，且不放宽裸 hex 精度契约", () => {
  test("Google API key（AIza + 35 位）被打码", () => {
    const gkey = "AIza" + "b".repeat(35); // 39 位，前缀独一
    const out = scrubSecrets(`GOOGLE_KEY=${gkey}`);
    expect(out).not.toContain(gkey);
    expect(out).toContain("[REDACTED]");
  });

  test("Slack incoming webhook 完整 URL 被打码（路径即凭证）", () => {
    const hook = "https://hooks.slack.com/services/T00000000/B00000000/" + "X".repeat(24);
    const out = scrubSecrets(`webhook: ${hook}`);
    expect(out).not.toContain("X".repeat(24));
    expect(out).toContain("[REDACTED]");
  });

  test("Webhook 签名（sha256=/sha1= 明确上下文里的 hex 值）被打码", () => {
    const sig = "e3b0c44298fc1c149afbf4c8996fb924"; // 32 位小写 hex
    const out = scrubSecrets(`X-Hub-Signature-256: sha256=${sig}`);
    expect(out).not.toContain(sig);
    expect(out).toContain("[REDACTED]");
    // sha1= 同理
    expect(scrubSecrets("sha1=a94a8fe5ccb19ba61c4c0873d391e987")).not.toContain("a94a8fe5ccb19ba61c4c0873d391e987");
  });

  test("精度契约不退：裸 hex / git SHA / 大写 hex / 路径仍不被误杀", () => {
    // 裸 64 位小写 hex（sha256，无签名前缀）——仍放行，不误当密钥。
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(scrubSecrets(sha256)).toContain(sha256);
    // 裸 40 位 git SHA（有/无 git 上下文都放行）
    const sha40 = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
    expect(scrubSecrets(`commit ${sha40} ok`)).toContain(sha40);
    expect(scrubSecrets(sha40)).toContain(sha40);
    // 纯大写 40 hex 放行（无小写，"宁可漏打码非密钥"）
    const upperHex = "A1B2C3D4E5F6071829304A5B6C7D8E9F0A1B2C3D";
    expect(scrubSecrets(upperHex)).toContain(upperHex);
    // 路径放行
    expect(scrubSecrets("/Users/me/projects/anima/src/digest.ts")).toContain("digest.ts");
  });
});
