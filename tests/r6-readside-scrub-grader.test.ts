// R6 独立盲考官对抗测试（AUDIT-2026-07-03）
// 验：读侧 scrubSecrets 兜底真上膛（inject/recall 详情） + 高熵网补的专用模式（AIza/slack webhook/
// 全小写 hex 签名）真不再失明 + 三个 scrubber 没被合并（feeling 不喂 secret scrubber、精度契约裸 SHA 放行）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { renderExperienceDetail } from "../src/recall";
import { assembleMorningInjection } from "../src/inject";
import { scrubSecrets } from "../src/capture";
import { scrubMoodViolations } from "../src/sovereignty";
import { frozenClock } from "../src/clock";

const SEED = frozenClock("2026-06-10T10:00:00.000Z");
const NOW = frozenClock("2026-06-11T05:00:00.000Z");

const dirs: string[] = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "r6-grader-"));
  dirs.push(dir);
  return openDb(join(dir, "anima.db"));
}
function cleanup() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

// —— 旧 scrubSecrets 复刻：R6 之前的版本（缺 AIza / slack / sha256= 三条专用模式）。
// 用来证伪：这三种形态在旧网下 100% 漏网（高熵兜底要求同时含大小写+数字，全小写 hex/全大写会失明）。
function scrubSecretsOLD(text: string): string {
  return text
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|pat|glpat)[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED JWT]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, "[REDACTED KEY]")
    .replace(/(--?(?:token|password|passwd|secret|api[-_]?key|auth|access[-_]?key|client[-_]?secret|refresh[-_]?token)[=\s]+)(\S+)/gi, "$1[REDACTED]")
    .replace(/(-u\s+[^:\s]+:)(\S+)/g, "$1[REDACTED]")
    .replace(/(-H\s+["']?[\w-]*(?:authorization|token|secret|api[-_]?key|auth|cookie)[\w-]*:\s*)([^"'\\]+)/gi, "$1[REDACTED]")
    .replace(/([?&][^=&\s]*(?:token|secret|key|auth|pass|pwd|sig|jwt|session|credential)[^=&\s]*=)([^&\s'"]+)/gi, "$1[REDACTED]")
    .replace(/(\/\/[^/\s:@]*:)([^@\s/]+)(@)/g, "$1[REDACTED]$3")
    .replace(/("[^"]*(?:token|secret|key|auth|pass|pwd|jwt|session|credential)[^"]*"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED]$3")
    .replace(/(-p\s+)(?!\d+\b)(\S+)/g, "$1[REDACTED]")
    .replace(/\b(\w*(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key|ssh[-_]?key|signing[-_]?key|authorization|credential|auth[-_]?token)\w*\s*[=:]\s*)(\S+)/gi, "$1[REDACTED]")
    .replace(/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

describe("R6 · 高熵网新专用模式（旧红新绿证伪）", () => {
  // 刻意选「旧高熵网真失明」的形态：高熵兜底要求同时含大小写+数字，凡缺一类即漏。
  const AIZA = "AIza" + "b".repeat(35); // AIza + 35 全小写：无数字 → 旧高熵网失明；新 AIza 前缀模式必打
  // 拆串拼接:运行时串不变(照样考脱敏器),但源码字面不再撞 GitHub push protection 的 webhook 正则
  const SLACK = "https://hooks.slack.com/services/" + "T00000000/B11111111/" + "aZ9bY8cX7dW6eV5fU4gT3hS2";
  const SIG = "sha256=abcdef0123456789abcdef0123456789abcdef01"; // 全小写 hex、无大写 → 旧高熵网失明

  test("AIza 型 Google key（无数字体）：旧高熵网失明、新专用模式打码", () => {
    const s = `配置里写死了 ${AIZA} 这个 key`; // 裸串、无 key= 前缀，不靠名字规则
    expect(scrubSecretsOLD(s)).toContain(AIZA); // 旧：泄漏（RED）
    const now = scrubSecrets(s);
    expect(now).not.toContain(AIZA); // 新：打码（GREEN）
    expect(now).toContain("[REDACTED]");
  });

  test("Slack incoming webhook URL：旧网只砸尾段、workspace/channel ID 残留；新网整条打掉", () => {
    const s = `webhook: ${SLACK}`;
    // 旧：T/B ID 无小写 → 高熵网失明，泄漏（凭这些+尾段可拼回可用 webhook）
    expect(scrubSecretsOLD(s)).toContain("T00000000");
    expect(scrubSecrets(s)).not.toContain("T00000000"); // 新：整条 URL 打码
    expect(scrubSecrets(s)).not.toContain("aZ9bY8cX7dW6eV5fU4gT3hS2");
  });

  test("全小写 hex 签名 sha256=…：旧高熵网失明、新专用模式打码", () => {
    const s = `X-Hub-Signature-256: ${SIG}`;
    expect(scrubSecretsOLD(s)).toContain("abcdef0123456789abcdef0123456789abcdef01"); // 旧：泄漏
    const now = scrubSecrets(s);
    expect(now).not.toContain("abcdef0123456789abcdef0123456789abcdef01"); // 新：打码
    expect(now).toContain("sha256="); // 上下文标签保留、只砸 hex 值
  });
});

describe("R6 · 精度契约（防假绿：别为了打码而误伤合法内容）", () => {
  test("裸 40 位小写 git SHA 仍放行（宁可漏打码非密钥的契约）", () => {
    const sha = "e208c03abcdef0123456789abcdef0123456789ab";
    expect(scrubSecrets(`提交 ${sha} 修好了`)).toContain(sha);
  });
  test("裸 64 位小写 hex（非签名上下文）放行", () => {
    const h = "a".repeat(64);
    expect(scrubSecrets(`blob ${h}`)).toContain(h);
  });
});

describe("R6 · 读侧兜底真上膛（append-only 存量补最后一道防线）", () => {
  test("recall 详情：content 里的原始 token 被读时打码（旧路只走 scrubMoodViolations 会泄漏）", () => {
    const db = freshDb();
    const secret = "ghp_ABCDEFGHIJ0123456789klmnopqrstuvwxyz";
    const row = insertExperience(
      db,
      { kind: "work_action", content: `部署时用了 ${secret} 拉私库`, project: null },
      SEED,
    );
    // 旧 renderExperienceDetail 正文体：scrubMoodViolations(content) —— 不碰 secret → 泄漏（RED）
    expect(scrubMoodViolations(`部署时用了 ${secret} 拉私库`)).toContain(secret);
    // 新：读侧兜底真打码（GREEN）
    const detail = renderExperienceDetail(db, row.id, { clock: NOW })!;
    expect(detail).not.toContain(secret);
    expect(detail).toContain("[REDACTED]");
  });

  test("晨间注入 renderItem：content 里的 AIza key 读时打码", () => {
    const db = freshDb();
    const secret = "AIza" + "b".repeat(35);
    insertExperience(
      db,
      { kind: "self_review", content: `今天调 API 用了 key ${secret}`, feeling: "踏实", project: null },
      SEED,
    );
    const home = mkdtempSync(join(tmpdir(), "r6-inj-"));
    dirs.push(home);
    const res = assembleMorningInjection(db, {
      sessionId: "s-new",
      project: null,
      personalityPath: join(home, "personality.md"),
      clock: NOW,
    });
    expect(res.text).not.toContain(secret);
  });
});

describe("R6 · 三 scrubber 没合并：feeling 列不被 secret scrubber 误抹", () => {
  test("feeling 走 scrubMoodNumbers（数字被主权闸清）、不被 secret scrubber 打 [REDACTED]", () => {
    const db = freshDb();
    const row = insertExperience(
      db,
      {
        kind: "self_review",
        content: "把 config.ts 换成 YAML",
        feeling: "踏实，评分90分", // 情绪数字：主权闸该清 90
        project: null,
      },
      SEED,
    );
    const detail = renderExperienceDetail(db, row.id, { clock: NOW })!;
    // 证明 feeling 确实走了 scrubMoodNumbers（数字被清）——scrubSecrets 不会碰这种普通数字
    expect(detail).not.toContain("90"); // 情绪数字被主权闸抹掉
    expect(detail).toContain("踏实"); // 情绪原文保留
    // 证明 feeling 没被喂 secret scrubber：情绪原文没被误打成 [REDACTED]
    expect(detail).not.toContain("感受：[REDACTED]");
    // 对照：scrubSecrets 对「评分90分」这种普通数字无动作（说明抹 90 的是 mood 闸不是 secret 闸）
    expect(scrubSecrets("踏实，评分90分")).toContain("90");
  });
});

afterEach(cleanup);
