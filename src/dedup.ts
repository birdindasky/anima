// 衍生回显抑制：自评产物与已存记忆近重复去重——防记忆复述通胀【Codex审计】
// 相似度 = 归一化文本字符 bigram 的 Dice 系数（CJK 友好，零依赖）
import type { Database } from "bun:sqlite";
import { mapExperienceRow, type ExperienceRow } from "./experiences";

export const DEDUP_THRESHOLD = 0.55;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(text: string): Set<string> {
  const n = normalize(text);
  if (n.length < 2) return new Set(n ? [n] : []);
  const set = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
  return set;
}

export function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  return (2 * common) / (A.size + B.size);
}

export interface DedupOptions {
  threshold?: number;
  /** 最多回看多少条近期在库经历 */
  scanLimit?: number;
}

/** 在库近重复检测：候选文本撞上已存活跃经历 → 返回被撞的那条 */
export function findNearDuplicate(
  db: Database,
  text: string,
  opts: DedupOptions = {},
): ExperienceRow | null {
  const threshold = opts.threshold ?? DEDUP_THRESHOLD;
  const rows = db
    .query(
      `SELECT * FROM experiences
       WHERE expired_at IS NULL AND invalid_at IS NULL
       ORDER BY id DESC LIMIT ?`,
    )
    .all(opts.scanLimit ?? 500) as any[];
  for (const row of rows) {
    if (diceSimilarity(text, row.content) >= threshold) return mapExperienceRow(row);
  }
  return null;
}
