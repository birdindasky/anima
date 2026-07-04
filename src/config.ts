// 路径配置化 —— 发布接缝。优先级（后者覆盖前者）：默认值 < 配置文件 < 环境变量 < 显式 overrides
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AnimaConfig {
  /** 数据目录，默认 ~/.claude/anima */
  dataDir: string;
  dbPath: string;
  personalityPath: string;
  diaryDir: string;
  badgePath: string;
  /** hook 连败多少次报警，默认 3 */
  hookAlertThreshold: number;
}

function defaultDataDir(): string {
  return join(homedir(), ".claude", "anima");
}

function loadConfigFile(): Partial<AnimaConfig> {
  const path = process.env.ANIMA_CONFIG_PATH ?? join(defaultDataDir(), "config.json");
  if (!existsSync(path)) return {};
  // 配置文件损坏必须响亮失败（失败可见化），静默忽略会让用户莫名其妙
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<AnimaConfig>;
  } catch (e) {
    throw new Error(`anima 配置文件解析失败: ${path} — ${(e as Error).message}`);
  }
}

export function resolveConfig(overrides: Partial<AnimaConfig> = {}): AnimaConfig {
  const fromEnv: Partial<AnimaConfig> = {};
  if (process.env.ANIMA_DATA_DIR) fromEnv.dataDir = process.env.ANIMA_DATA_DIR;

  const merged = { ...loadConfigFile(), ...fromEnv, ...overrides };
  const dataDir = merged.dataDir ?? defaultDataDir();
  return {
    dataDir,
    dbPath: merged.dbPath ?? join(dataDir, "anima.db"),
    personalityPath: merged.personalityPath ?? join(dataDir, "personality.md"),
    diaryDir: merged.diaryDir ?? join(dataDir, "diary"),
    badgePath: merged.badgePath ?? join(dataDir, "badge.txt"),
    hookAlertThreshold: merged.hookAlertThreshold ?? 3,
  };
}
