// ~/.claude/anima/ 数据目录初始化：只补缺，绝不覆盖已有内容
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AnimaConfig } from "./config";

const PERSONALITY_PLACEHOLDER = `# 人格文档

（尚未出生 —— 等待出生仪式。此文件由它本人在出生与梦游消化中书写，人不代笔。）
`;

/** 创建数据目录骨架。幂等：已存在的文件一律不动。返回本次新建的路径列表。 */
export function initDataDir(config: AnimaConfig): { created: string[] } {
  const created: string[] = [];

  for (const dir of [config.dataDir, config.diaryDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  if (!existsSync(config.personalityPath)) {
    writeFileSync(config.personalityPath, PERSONALITY_PLACEHOLDER, "utf8");
    created.push(config.personalityPath);
  }
  if (!existsSync(config.badgePath)) {
    writeFileSync(config.badgePath, "", "utf8");
    created.push(config.badgePath);
  }
  return { created };
}
