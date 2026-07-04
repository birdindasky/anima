// anima 全系统统一时区：固定 UTC 偏移（安装时按本机时钟写入 config，之后不漂移）。
// 存储仍是 UTC（toISOString 带 Z，无歧义、可排序、不迁老数据）；
// 凡"算哪一天 / 今天昨天 / 夜数 / 哪一夜该消化"一律按此偏移换算。
// 取值优先级：env ANIMA_TZ_OFFSET_MINUTES > config.json tzOffsetMinutes > 480（UTC+8，
// 历史默认，保测试确定性）。写一次不改写（setup-config.ts）：偏移决定历史会话归属哪一夜，
// 用了几个月后悄悄改会重排旧账。DST 地区：偏移按安装时快照，跨令时日界差 1 小时，属已知取舍。
// 模块加载期读一次并缓存；不 import config.ts（那边有目录副作用，这里保持零依赖纯函数）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readOffsetMinutes(): number {
  const fromEnv = process.env.ANIMA_TZ_OFFSET_MINUTES;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) <= 14 * 60) return n;
  }
  try {
    const dataDir = process.env.ANIMA_DATA_DIR ?? join(homedir(), ".claude", "anima");
    const configPath = process.env.ANIMA_CONFIG_PATH ?? join(dataDir, "config.json");
    if (existsSync(configPath)) {
      const n = JSON.parse(readFileSync(configPath, "utf8")).tzOffsetMinutes;
      if (Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) <= 14 * 60) return n;
    }
  } catch {
    // 配置坏了不挡路：退默认，whoami 能暴露实际生效值
  }
  return 480;
}

export const TZ_OFFSET_MINUTES = readOffsetMinutes();
/** 兼容旧引用；可能为小数（如 UTC+5:30 → 5.5），别再用它拼 SQL，用 sqlLocalDate。 */
export const TZ_OFFSET_HOURS = TZ_OFFSET_MINUTES / 60;
const OFFSET_MS = TZ_OFFSET_MINUTES * 60_000;

/** 把时刻换算成东八区日历日 'YYYY-MM-DD'（入参 Date 或 ISO 串） */
export function localDate(t: Date | string): string {
  const ms = (typeof t === "string" ? new Date(t) : t).getTime() + OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 东八区"日序号"（以东八区午夜为界），用于数夜数 / 相对日差 */
export function localDayIndex(t: Date | string): number {
  const ms = (typeof t === "string" ? new Date(t) : t).getTime() + OFFSET_MS;
  return Math.floor(ms / 86_400_000);
}

/** SQL 修饰符：'+480 minutes' 之类（SQLite date() 认 NNN minutes，含负）。 */
const SQL_TZ_MODIFIER = `${TZ_OFFSET_MINUTES >= 0 ? "+" : ""}${TZ_OFFSET_MINUTES} minutes`;

/** SQL 片段：把任意 UTC 时刻列换算成本地日历日（列名可带表别名，如 'sl.occurred_at'）。 */
export function sqlLocalDate(col: string): string {
  return `date(${col}, '${SQL_TZ_MODIFIER}')`;
}

/** SQL 片段：把存储的 UTC occurred_at 列换算成本地日历日。
    SQLite 实测 date('2026-06-12T18:00:00.000Z','+480 minutes') = '2026-06-13' */
export const SQL_LOCAL_OCCURRED_DATE = sqlLocalDate("occurred_at");

const DAY_MS = 86_400_000;

/** 东八区"日序号"D 对应的 UTC 起始毫秒（东八区 D 日 00:00 = 该 UTC 时刻）。
    与 localDayIndex 互逆：localDayIndex(eastDayStartMs(D)/1000…)==D。 */
function eastDayStartMs(dayIndex: number): number {
  return dayIndex * DAY_MS - OFFSET_MS;
}

/**
 * 相对词 → 东八区自然日窗口（DESIGN-WORK-TIMELINE §3B）。
 * 左闭右开 [sinceTs, untilTs)，输出 UTC ISO 串（与库 occurred_at 同格式，可字符串比较）。
 * 支持：today / yesterday / this_week（滚动 7 天）/ Nd（含今天的近 N 天，N≥1）。
 * 走注入 Clock（结构类型 {now():Date}，禁裸 Date.now）；未知/非法相对词返 null（不猜，调用方退相关性召回）。
 */
export function dayWindow(
  relWord: string,
  clock: { now(): Date },
): { sinceTs: string; untilTs: string } | null {
  const todayIdx = localDayIndex(clock.now());
  const w = relWord.trim().toLowerCase();
  let sinceIdx: number;
  let untilIdx: number; // 排他上界日序号

  if (w === "today") {
    sinceIdx = todayIdx;
    untilIdx = todayIdx + 1;
  } else if (w === "yesterday") {
    sinceIdx = todayIdx - 1;
    untilIdx = todayIdx;
  } else if (w === "this_week") {
    sinceIdx = todayIdx - 6; // 滚动 7 天（含今天）
    untilIdx = todayIdx + 1;
  } else {
    const m = /^(\d+)d$/.exec(w);
    if (!m) return null;
    const n = parseInt(m[1]!, 10);
    if (n < 1) return null; // N 必须 ≥1
    sinceIdx = todayIdx - (n - 1);
    untilIdx = todayIdx + 1;
  }

  return {
    sinceTs: new Date(eastDayStartMs(sinceIdx)).toISOString(),
    untilTs: new Date(eastDayStartMs(untilIdx)).toISOString(),
  };
}
