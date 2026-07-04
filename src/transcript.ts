// Claude Code transcript（JSONL）解析与游标定位
import { existsSync, readFileSync } from "node:fs";

export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface TranscriptEntry {
  type: "user" | "assistant";
  uuid: string;
  sessionId: string | null;
  cwd: string | null;
  timestamp: string | null;
  isMeta: boolean;
  isSidechain: boolean;
  /** auto-compact 生成的续接摘要行（机器写的、非用户原话）。R1：绝不当对话/记忆采集。 */
  isCompactSummary: boolean;
  /** 仅在 transcript UI 可见、不属真实对话流的行（compact 摘要共此标志）。与 isCompactSummary 同义防御。 */
  isVisibleInTranscriptOnly: boolean;
  /** harness 注入来源标记（R1，AUDIT-2026-07-03）：'system'=系统合成轮（task-notification 等）。
   *  写侧 authorship.isSyntheticUserTurn 的权威元数据信号；真实用户轮不带此值/非 system。 */
  promptSource: string | null;
  role: string;
  /** string 原文或块数组，原样保留 */
  content: string | ContentBlock[];
}

/**
 * R1（AUDIT-2026-07-02）：该条目是否"不可作为对话/记忆采集"的机器续接摘要。
 * auto-compact 的摘要行是 type:"user"、1-3 万字纯字符串，若当用户原话吞下会：已复盘内容二次复盘、
 * 挤爆自评素材预算、检索霸榜。两标志实测完美共现，取或防御（未来 Claude Code 只发其一也拦得住）。
 * **只在采集/素材两个消费点跳过，不从 readTranscriptEntries 剔除**——保住 uuid/窗口/水位线定位空间。
 */
export function isCompactSummaryEntry(e: TranscriptEntry): boolean {
  return e.isCompactSummary || e.isVisibleInTranscriptOnly;
}

/** 读取 transcript 的 user/assistant 条目；坏行容忍跳过 */
export function readTranscriptEntries(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return [];
  const entries: TranscriptEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 坏行不致命
    }
    if ((obj.type !== "user" && obj.type !== "assistant") || !obj.uuid) continue;
    entries.push({
      type: obj.type,
      uuid: obj.uuid,
      sessionId: obj.sessionId ?? null,
      cwd: obj.cwd ?? null,
      timestamp: obj.timestamp ?? null,
      isMeta: obj.isMeta === true,
      isSidechain: obj.isSidechain === true,
      isCompactSummary: obj.isCompactSummary === true,
      isVisibleInTranscriptOnly: obj.isVisibleInTranscriptOnly === true,
      promptSource: typeof obj.promptSource === "string" ? obj.promptSource : null,
      role: obj.message?.role ?? obj.type,
      content: obj.message?.content ?? "",
    });
  }
  return entries;
}

/** 游标之后的增量条目；游标找不到时（极少：文件被重写）从头全量，靠库层幂等兜底 */
export function entriesAfter(
  entries: TranscriptEntry[],
  cursorUuid: string | null,
): TranscriptEntry[] {
  if (!cursorUuid) return entries;
  const idx = entries.findIndex((e) => e.uuid === cursorUuid);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

/** entriesBetween 的结果：要么切到了（含实际覆盖到的末条 uuid），要么 target 还不可见 */
export type EntriesSlice =
  | { ok: true; entries: TranscriptEntry[]; lastUuid: string | null }
  | { ok: false; reason: "target_not_visible" };

/**
 * 增量切片 `(sinceUuid 之后 .. targetUuid 含]`，给 worker 增量自评用
 * （F-3，DESIGN-WORKER-RESUME §v5.7）。上下界两种"找不到"语义**必须区分**：
 *  - `sinceUuid`（下界＝水位线）找不到：文件被重写/轮转——保守从头取（夹带的旧回合由库层去重兜底，安全）。
 *  - `targetUuid`（上界＝入队快照）找不到：worker 与 Claude Code 并发读写 live transcript，target 那条
 *    可能还没落到 worker 看到的文件视图 → **绝不退化全量**（否则吞进 target 之后的 live 内容、却只把水位线
 *    推到旧 target → 推过头 → 后续真该复盘的回合被误判已做 → 永久漏，比纯夜跑还糟）。返回 `{ok:false}`，
 *    调用方留 pending/backoff、等下一轮，绝不烧 LLM、绝不推水位线。
 * `targetUuid` 省略/null ＝ 取到文件末尾（非 worker 路径）。
 * `lastUuid` ＝ 本次**实际覆盖到的末条 uuid**；水位线只能推到它（不是入队时的 target 快照，§SEVERE-2），
 *  且调用方须保证水位线单调不回退。
 */
export function entriesBetween(
  entries: TranscriptEntry[],
  sinceUuid: string | null,
  targetUuid?: string | null,
): EntriesSlice {
  // 下界：sinceUuid 之后；找不到则从头（保守，库层去重兜）
  let start = 0;
  if (sinceUuid) {
    const sinceIdx = entries.findIndex((e) => e.uuid === sinceUuid);
    start = sinceIdx === -1 ? 0 : sinceIdx + 1;
  }
  // 上界：targetUuid（含）；找不到 → 不可见，绝不退化全量；省略 → 到末尾
  let end = entries.length; // exclusive
  if (targetUuid) {
    const targetIdx = entries.findIndex((e) => e.uuid === targetUuid);
    if (targetIdx === -1) return { ok: false, reason: "target_not_visible" };
    end = targetIdx + 1;
  }
  const sliced = start < end ? entries.slice(start, end) : []; // start>end（target 在 since 之前）→ 空
  const lastUuid =
    sliced.length > 0
      ? sliced[sliced.length - 1]!.uuid
      : (targetUuid ?? (entries.length > 0 ? entries[entries.length - 1]!.uuid : null));
  return { ok: true, entries: sliced, lastUuid };
}

/**
 * 东八日 `day`（如 "2026-06-17"）的**日界 uuid**：返回 `entries` 中最后一条
 * `timestamp` **严格早于** `${day}T16:00:00.000Z`（＝东八次日 00:00）的 uuid；无则 null。
 * 半开（DESIGN-DAYSPLIT §3.1 / codex F4）：恰好 16:00:00.000Z 的条目属**次日**，不含本日。
 * timestamp 为 null 的条目跳过。比较用 canonical ISO-UTC（Z、毫秒）字典序＝时序，与转写器输出一致。
 */
export function dayBoundUuid(entries: TranscriptEntry[], day: string): string | null {
  const boundary = `${day}T16:00:00.000Z`;
  let last: string | null = null;
  for (const ent of entries) {
    if (ent.timestamp !== null && ent.timestamp < boundary) last = ent.uuid;
  }
  return last;
}

/**
 * 顺序判定（DESIGN-DAYSPLIT §3.2 / codex F1）：`a` 是否在快照里**到达或越过** `b`。
 * - `b === null`（覆盖"无"）→ `true`（vacuous）。
 * - `a === null`（水位线为空＝在一切之前）、b 非空 → `false`。
 * - a、b 都非空：任一**不在快照** → `"unsafe"`（未知，调用方按 incomplete/requeue 走，绝不当 true/false）；
 *   否则 `idx(a) >= idx(b)`。
 * 完成/跳过/覆盖/单调一律用它，**绝不 `===` 比 UUID**（旧 `==tail` 安全仅因 tail 恒末条；dayBound 非末条、
 * worker 可能已推过水位线 → 相等失败但其实已覆盖）。
 */
export function atOrAfter(
  entries: TranscriptEntry[],
  a: string | null,
  b: string | null,
): boolean | "unsafe" {
  if (b === null) return true;
  if (a === null) return false;
  const ia = entries.findIndex((ent) => ent.uuid === a);
  const ib = entries.findIndex((ent) => ent.uuid === b);
  if (ia === -1 || ib === -1) return "unsafe";
  return ia >= ib;
}

/** tool_result 的 content 可能是字符串或文本块数组，拍平成文本 */
export function flattenResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}
