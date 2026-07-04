// LLM 客户端：headless claude -p，三重隔离防递归（事故 2026-06-12）：
//   ① --setting-sources ""  → 不加载 user/project settings：不触发任何 hooks、不启用任何插件
//   ② --strict-mcp-config   → 不启动任何 MCP server 子进程
//   ③ ANIMA_HEADLESS=1      → anima 自家 hooks 见此标记秒退（万一隔离参数失效的兜底）
import { existsSync } from "node:fs";

export type LlmClient = (prompt: string) => Promise<string>;

// launchd 用最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin，不含 /opt/homebrew/bin），
// 裸调 "claude" 会 "Executable not found in $PATH"，每个 LLM 阶段挂、夜夜降级
// （2026-06-15 实锤，原误诊为"撞额度墙"）。故必须解析绝对路径，不依赖 PATH。
const CLAUDE_BIN_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  `${process.env.HOME ?? ""}/.claude/local/claude`,
];

export function resolveClaudeBin(
  env: NodeJS.ProcessEnv = process.env,
  candidates: string[] = CLAUDE_BIN_CANDIDATES,
  exists: (p: string) => boolean = existsSync,
): string {
  const override = env.ANIMA_CLAUDE_BIN;
  if (override && exists(override)) return override;
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return "claude"; // 兜底：靠 PATH（交互 shell 有；launchd 无 → 上面已解析绝对路径）
}

let activeChild: ReturnType<typeof Bun.spawn> | null = null;

/** 安全停止当前 headless claude 子进程（digest 收到 SIGTERM 时调用） */
export function killActiveLlmChild(): void {
  try {
    activeChild?.kill();
  } catch {
    // 子进程已退出
  }
}

// 自评止血（2026-06-18）：haiku 过度推理（9-13k 输出，含 thinking）常跑过 120s 墙 →
// Bun.spawn timeout 杀掉 → 重试再挂落 fallback 空壳，专杀长会话（材料越多越易撞墙）。
// `claude -p` 无 --max-tokens/关 thinking 旗标（CLI 不支持），当前架构唯一稳妥止血＝抬超时：
// 把"超时丢数据"换成"慢但跑完、数据不丢"。夜间 batch 没人等，时限放宽安全。
// `ANIMA_LLM_TIMEOUT_MS` 让 launchd/ops 不改码也能调（>0 才生效，否则用 param 默认）。
export function resolveLlmTimeout(
  defaultMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envTimeout = Number(env.ANIMA_LLM_TIMEOUT_MS);
  return Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : defaultMs;
}

export function claudeCli(model = "haiku", timeoutMs = 120_000): LlmClient {
  const effectiveTimeout = resolveLlmTimeout(timeoutMs);
  return async (prompt: string) => {
    // prompt 走 stdin 而非 argv：消化大日的 personality/diary/自评 prompt 可达 MB 级，
    // 当 argv 传会撞 ARG_MAX（`Argument list too long`，连 LLM 都起不来）。
    // `claude -p` 不带 prompt 参数时从 stdin 读取。
    const proc = Bun.spawn(
      [
        resolveClaudeBin(),
        "-p",
        "--model",
        model,
        "--setting-sources",
        "",
        "--strict-mcp-config",
      ],
      {
        stdin: new TextEncoder().encode(prompt),
        stdout: "pipe",
        stderr: "pipe",
        timeout: effectiveTimeout,
        env: { ...process.env, ANIMA_HEADLESS: "1" },
      },
    );
    activeChild = proc;
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`claude -p 失败（exit ${exitCode}）: ${stderr.slice(0, 300)}`);
      }
      return stdout.trim();
    } finally {
      activeChild = null;
    }
  };
}
