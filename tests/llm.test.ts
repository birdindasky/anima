import { test, expect } from "bun:test";
import { resolveClaudeBin, resolveLlmTimeout } from "../src/llm";

// 事故回归守卫：launchd 用最小 PATH（不含 /opt/homebrew/bin），裸调 "claude" 会
// "Executable not found in $PATH"，导致每个 LLM 阶段挂、夜夜降级（2026-06-15 实锤）。
// resolveClaudeBin 必须解析出绝对路径，不依赖环境 PATH。

test("resolveClaudeBin: ANIMA_CLAUDE_BIN 存在则优先用它", () => {
  const r = resolveClaudeBin(
    { ANIMA_CLAUDE_BIN: "/custom/claude" } as NodeJS.ProcessEnv,
    ["/opt/homebrew/bin/claude"],
    (p) => p === "/custom/claude",
  );
  expect(r).toBe("/custom/claude");
});

test("resolveClaudeBin: 命中第一个存在的绝对路径候选（与 PATH 无关）", () => {
  const r = resolveClaudeBin(
    {} as NodeJS.ProcessEnv,
    ["/nope/claude", "/opt/homebrew/bin/claude"],
    (p) => p === "/opt/homebrew/bin/claude",
  );
  expect(r).toBe("/opt/homebrew/bin/claude");
});

test("resolveClaudeBin: 环境变量指向的路径不存在时忽略它，继续探候选", () => {
  const r = resolveClaudeBin(
    { ANIMA_CLAUDE_BIN: "/gone/claude" } as NodeJS.ProcessEnv,
    ["/opt/homebrew/bin/claude"],
    (p) => p === "/opt/homebrew/bin/claude",
  );
  expect(r).toBe("/opt/homebrew/bin/claude");
});

test("resolveClaudeBin: 全无候选 → 兜底裸 'claude'（靠 PATH，交互 shell 有效）", () => {
  const r = resolveClaudeBin({} as NodeJS.ProcessEnv, ["/nope/claude"], () => false);
  expect(r).toBe("claude");
});

test("resolveClaudeBin: 本机真实解析必须是绝对路径（launchd 安全）", () => {
  const r = resolveClaudeBin();
  expect(r.startsWith("/")).toBe(true);
});

// 超时止血（2026-06-18）：抬上限把"haiku 过度推理撞 120s 墙→落 fallback 空壳"换成
// "慢但跑完、数据不丢"。env ANIMA_LLM_TIMEOUT_MS 让 launchd/ops 不改码即可调。

test("resolveLlmTimeout: 无 env 覆盖 → 用传入默认", () => {
  expect(resolveLlmTimeout(300_000, {} as NodeJS.ProcessEnv)).toBe(300_000);
});

test("resolveLlmTimeout: env 设了正数 → 覆盖默认", () => {
  expect(
    resolveLlmTimeout(120_000, { ANIMA_LLM_TIMEOUT_MS: "240000" } as NodeJS.ProcessEnv),
  ).toBe(240_000);
});

test("resolveLlmTimeout: env 非法/非正数 → 忽略，回落默认", () => {
  const env = (v: string) => ({ ANIMA_LLM_TIMEOUT_MS: v }) as NodeJS.ProcessEnv;
  expect(resolveLlmTimeout(300_000, env("abc"))).toBe(300_000); // 非数字
  expect(resolveLlmTimeout(300_000, env("0"))).toBe(300_000); // 0 不算覆盖
  expect(resolveLlmTimeout(300_000, env("-5"))).toBe(300_000); // 负数忽略
  expect(resolveLlmTimeout(300_000, env(""))).toBe(300_000); // 空串忽略
});
