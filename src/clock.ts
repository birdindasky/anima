// 可注入时钟：衰减、半衰期、隔夜判定全部依赖它，真实时间不可测（TEST-PLAN 规矩 4）
import { localDayIndex } from "./tz";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FrozenClock extends Clock {
  /** 拨表：前进指定毫秒数 */
  advance(ms: number): void;
  /** 直接设到某个时刻 */
  set(iso: string): void;
}

/** 相对时间标签（按东八区日界）：[今天]/[昨天]/[N天前] */
export function relativeDayLabel(occurredAtIso: string, now: Date): string {
  const diff = localDayIndex(now) - localDayIndex(occurredAtIso);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  return `${diff}天前`;
}

export function frozenClock(iso: string): FrozenClock {
  let current = new Date(iso).getTime();
  if (Number.isNaN(current)) throw new Error(`frozenClock: 非法时间 "${iso}"`);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (newIso: string) => {
      const t = new Date(newIso).getTime();
      if (Number.isNaN(t)) throw new Error(`frozenClock.set: 非法时间 "${newIso}"`);
      current = t;
    },
  };
}
