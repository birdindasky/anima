// 情绪电荷：估计现算的纯函数——不存任何情绪数值，历史永不作废。
// 物理模型抄人类睡眠的作业：电荷随"睡过的夜数"半衰；烙印越厚半衰期越长（高光衰减慢）。
// 主权注记：电荷数值只给机器排序和人看（/mood），永不进注入文本。
import { localDayIndex } from "./tz";

export interface ChargeSource {
  feeling: string | null;
  intensity: string | null;
  occurredAt: string;
}

/** 烙印强度 1..1.5：有感受原文即打底 1，另有强度自述再 +0.5。
 *  不拿感受篇幅当强度代理（R7，方向反了）：话多≠情绪重——一句"崩了"可以比一段
 *  无情绪流水账更烈。只认"有没有感受原文"与"有没有强度自述"两个信号。 */
export function imprintStrength(row: Pick<ChargeSource, "feeling" | "intensity">): number {
  if (!row.feeling || !row.feeling.trim()) return 0;
  return 1 + (row.intensity ? 0.5 : 0);
}

/** 按东八区日界数"睡过的夜"；时钟回拨产生的负年龄按 0 处理（E1 兜底） */
export function nightsBetween(occurredAtIso: string, now: Date): number {
  const diff = localDayIndex(now) - localDayIndex(occurredAtIso);
  return Math.max(0, diff);
}

/** 电荷 = 强度 × 0.5^(夜数/半衰期)；半衰期 = 1 + 强度×2（3..4 夜） */
export function emotionalCharge(row: ChargeSource, now: Date): number {
  const strength = imprintStrength(row);
  if (strength === 0) return 0;
  const halfLifeNights = 1 + strength * 2;
  return strength * Math.pow(0.5, nightsBetween(row.occurredAt, now) / halfLifeNights);
}
