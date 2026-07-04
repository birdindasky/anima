// 记忆检索（渐进披露）：默认索引行（每条 ≤100 token），按 ID 拉全文
// 二级兜底（速测修复 2026-06-11）：消化记忆查不到时翻原始流水——
// 消化措辞会漂移（"迁到"≠"迁移"），但用户原话是原始小票，永不漂移。
import type { Database } from "bun:sqlite";
import { relativeDayLabel, systemClock, type Clock } from "./clock";
import { dayWindow } from "./tz";
import {
  getExperienceForRecall,
  searchExperiences,
  searchExperiencesChrono,
  segmentQuery,
  type ExperienceRow,
} from "./experiences";
import { searchExperiencesHybrid, type QueryEmbedder } from "./hybridSearch";
import { scrubMoodNumbers, scrubMoodViolations } from "./sovereignty";
import { truncateToTokens } from "./tokens";
import { isReadExcludedUserText, syntheticTextExclusionSql } from "./authorship";
import { scrubSecrets } from "./capture";

export interface RecallOptions {
  project?: string;
  includeGlobal?: boolean;
  includeHistory?: boolean;
  limit?: number;
  clock?: Clock;
  /** 仅 hybrid 路：false 时退纯字面（一键逃生）。默认开。 */
  semantic?: boolean;
  /** DESIGN-WORK-TIMELINE §3A：'chrono'+有时间窗 → 走细粒度小票时间线（time-only，query 可空）。默认 relevance（零回归）。 */
  order?: "relevance" | "chrono";
  /** chrono 时间窗下界（含），UTC ISO；与 untilTs 成对，缺一不走 chrono 分叉。 */
  sinceTs?: string;
  /** chrono 时间窗上界（不含），UTC ISO。 */
  untilTs?: string;
  /** chrono 层选择：'memory'（默认，日记层优先、空退录像）/ 'actions'（强制录像层小票）。 */
  scope?: "memory" | "actions";
}

/** 暴露给 MCP 工具层做相对词解析（薄封装 tz.dayWindow，禁裸 Date）。 */
export function dayWindowFor(relWord: string, clock: Clock = systemClock) {
  return dayWindow(relWord, clock);
}

function isoOrNull(s: string): string | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * MCP recall 参数 → {query, RecallOptions}（DESIGN-WORK-TIMELINE §3C，纯函数零 LLM）。
 * since 是相对词(today/yesterday/this_week/Nd)→dayWindow 展开成 chrono 窗；ISO 绝对值→绝对窗(until 缺补当下)；
 * 无 since → relevance（零回归）；解析不了 → 不猜、退 relevance。query 可空。
 */
export function resolveRecallArgs(
  a: Record<string, unknown>,
  clock: Clock = systemClock,
): { query: string; opts: RecallOptions } {
  const query = typeof a.query === "string" ? a.query : "";
  const base: RecallOptions = {
    project: typeof a.project === "string" ? a.project : undefined,
    limit: typeof a.limit === "number" ? a.limit : undefined,
    clock,
  };
  // codex 终审 m2：显式 order 契约面——order='relevance' 时绕过 since→chrono 推断（明确要相关性搜）。
  if (a.order === "relevance") return { query, opts: base };
  const scope: "actions" | undefined = a.scope === "actions" ? "actions" : undefined;
  const since = typeof a.since === "string" ? a.since.trim() : "";
  if (since) {
    const win = dayWindow(since, clock);
    if (win) return { query, opts: { ...base, order: "chrono", scope, sinceTs: win.sinceTs, untilTs: win.untilTs } };
    const sinceTs = isoOrNull(since);
    if (sinceTs) {
      const untilTs = (typeof a.until === "string" ? isoOrNull(a.until) : null) ?? clock.now().toISOString();
      return { query, opts: { ...base, order: "chrono", scope, sinceTs, untilTs } };
    }
    // 解析不了 → 不猜、退 relevance（无时间窗）
  }
  return { query, opts: base };
}

/**
 * chrono 入口分叉（DESIGN-WORK-TIMELINE §2/§3A F-NEW-2）：显式 chrono + 时间窗成对才分叉，否则零回归。
 * 镜像 relevance 路兜底——日记层（蒸馏 experiences）优先、低噪；窗内无日记则退录像层（小票）。
 * scope='actions' 强制走录像层（要"按顺序的动作/命令"，绕过日记）。
 */
function chronoFork(db: Database, query: string, opts: RecallOptions): IndexLine[] | null {
  if (opts.order !== "chrono" || !opts.sinceTs || !opts.untilTs) return null;
  const sinceTs = opts.sinceTs;
  const untilTs = opts.untilTs;
  // codex 终审 m1：日记层/录像层 includeGlobal 默认一致（都默认收全局 project IS NULL），别一层收一层漏。
  const includeGlobal = opts.includeGlobal ?? true;
  const receipts = () =>
    listReceiptsChrono(db, { sinceTs, untilTs, project: opts.project, includeGlobal, limit: opts.limit, query });
  if (opts.scope === "actions") return receipts();
  const now = (opts.clock ?? systemClock).now();
  const expRows = searchExperiencesChrono(db, query, {
    sinceTs,
    untilTs,
    project: opts.project,
    includeGlobal,
    includeHistory: opts.includeHistory,
    limit: opts.limit ?? 10,
  });
  if (expRows.length > 0) return experienceIndexLines(expRows, now);
  return receipts(); // 日记层空 → 退录像层（如"今天"还没夜里消化）
}

export type RecallSource = "experience" | "situation";

export interface IndexLine {
  id: number;
  uuid: string;
  line: string;
  source: RecallSource;
}

interface RawReceiptRow {
  id: number;
  text: string;
  occurred_at: string;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 原始流水检索（user_message 原话），与经历检索同一套切分与覆盖率规则 */
export function searchRawReceipts(
  db: Database,
  query: string,
  opts: { project?: string; includeGlobal?: boolean; limit?: number } = {},
): RawReceiptRow[] {
  const units = segmentQuery(query);
  if (units.length === 0) return [];
  const required = Math.floor(units.length / 2) + 1;
  const hay = "COALESCE(json_extract(s.payload, '$.text'), '')";
  const scoreExpr = units
    .map(() => `(CASE WHEN ${hay} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
    .join(" + ");
  const params: (string | number)[] = units.map((u) => `%${escapeLike(u)}%`);
  // 与经历检索同语义：限定 project 时按项目过滤，别项目的流水不越墙（哑雷）。
  // includeGlobal 默认 true：把全局流水（project IS NULL）一并纳入，与 searchExperiences 一致。
  const sitWhere = ["s.kind = 'user_message'"];
  if (opts.project !== undefined) {
    sitWhere.push((opts.includeGlobal ?? true) ? "(s.project = ? OR s.project IS NULL)" : "s.project = ?");
    params.push(opts.project);
  }
  // R1（AUDIT-2026-07-03）：存量 ~1400 条合成"假用户轮"（斜杠命令 / task-notification / 队友信封 /
  // 自评回吐）已污染 user_message，append-only 删不掉——读侧按文本形态排除，永不再浮到模型/召回面前。
  // 排除在 SQL 内做，保证 LIMIT 只数干净行（JS 后过滤会返回不足 limit 条）。
  const excl = syntheticTextExclusionSql(hay);
  sitWhere.push(excl.clause);
  params.push(...excl.params);
  params.push(required, opts.limit ?? 5);
  const rows = db
    .query(
      `SELECT * FROM (
         SELECT s.id, COALESCE(json_extract(s.payload, '$.text'), '') AS text,
                s.occurred_at, (${scoreExpr}) AS match_score
         FROM situation_log s WHERE ${sitWhere.join(" AND ")}
       )
       WHERE match_score >= ?
       ORDER BY match_score DESC, id DESC
       LIMIT ?`,
    )
    .all(...params) as (RawReceiptRow & { match_score: number })[];
  return rows;
}

/** work-action 小票 4 kind（DESIGN-WORK-TIMELINE §3A 细粒度路，与 capture.ts payload 对齐） */
export const CHRONO_RECEIPT_KINDS = ["user_message", "file_read", "command_run", "file_edit"] as const;

export interface ChronoReceiptOpts {
  sinceTs: string;
  untilTs: string;
  project?: string;
  includeGlobal?: boolean;
  kinds?: readonly string[];
  limit?: number;
  /** 可空软筛（codex 终审 F2）：OR LIKE over payload，命中命令/路径/原话/变更任一即收，不套覆盖率门槛。 */
  query?: string;
}

interface ChronoRow {
  id: number;
  kind: string;
  payload: string | null;
  occurred_at: string;
}

function parsePayloadObj(payload: string | null): Record<string, unknown> {
  try {
    return payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const asStr = (v: unknown) => (typeof v === "string" ? v : "");

/** 按 kind 渲一行小票摘要（字段名对 capture.ts:142-208 真实 payload；缺字段降级，绝不返空文案） */
function chronoReceiptLine(row: ChronoRow, now: string): string {
  const p = parsePayloadObj(row.payload);
  const s = asStr;
  let body: string;
  switch (row.kind) {
    case "user_message":
      body = s(p.text);
      break;
    case "command_run":
      body = `${s(p.command)}${p.ok === false ? "（失败）" : ""}`;
      break;
    case "file_edit":
      body = s(p.path);
      break;
    case "file_read":
      body = s(p.path);
      break;
    default:
      body = "";
  }
  if (!body) body = `（${row.kind} 无详情）`;
  // R6：读侧兜底——小票正文 emit 前过 scrubSecrets（scrub 先于截断）。
  return `#s${row.id} [${relativeDayLabel(row.occurred_at, now)}] (${row.kind}) ${truncateToTokens(scrubSecrets(body), 60)}`;
}

/**
 * 细粒度小票时间线（DESIGN-WORK-TIMELINE §3A，chrono 路入口分叉走这条，绕过 searchRawReceipts/receiptIndexLines）。
 * 纯时间窗 SQL：按 occurred_at（真实动作时间）DESC 排，**绝不用 created_at/id 主排**（F2）；左闭右开 [sinceTs, untilTs)；
 * 自带 project 墙（别项目不越墙，includeGlobal 收 project=NULL）；放开到 4 个 work-action kind。无 query、不做 LIKE 打分。
 */
export function listReceiptsChrono(db: Database, opts: ChronoReceiptOpts): IndexLine[] {
  const kinds = opts.kinds ?? CHRONO_RECEIPT_KINDS;
  const now = systemClock.now().toISOString();
  const where: string[] = [
    `s.kind IN (${kinds.map(() => "?").join(",")})`,
    "s.occurred_at >= ?",
    "s.occurred_at < ?",
  ];
  const params: (string | number)[] = [...kinds, opts.sinceTs, opts.untilTs];
  if (opts.project !== undefined) {
    where.push((opts.includeGlobal ?? true) ? "(s.project = ? OR s.project IS NULL)" : "s.project = ?");
    params.push(opts.project);
  }
  // R1（AUDIT-2026-07-03）：合成"假用户轮"污染只在 user_message 上——按文本形态排除，仅对 user_message
  // 生效（其它 kind 无 $.text，s.kind != 'user_message' 恒真、一律放行）。存量污染永不再进时间线小票。
  const chronoExcl = syntheticTextExclusionSql("COALESCE(json_extract(s.payload, '$.text'), '')");
  where.push(`(s.kind != 'user_message' OR ${chronoExcl.clause})`);
  params.push(...chronoExcl.params);
  // codex 终审 F2：query 软筛——非空时 OR LIKE（命中命令/路径/原话任一即收），
  // 不套覆盖率门槛（chrono 按时间排不按相关性）。空 query=窗内全取。
  // U38（AUDIT-2026-06-29 残余）：只匹配各 kind 的**正文字段**（与 chronoReceiptLine 渲染同口径），
  // 不再对整串 JSON payload LIKE——查询词撞 JSON 键名/骨架（command/path/text/ok）会假命中，软筛形同虚设。
  // 未列 kind 兜底回整串 payload：宁可多收，不静默漏收（opts.kinds 可传窗外 kind）。
  const units = opts.query ? segmentQuery(opts.query) : [];
  if (units.length > 0) {
    const hay = `CASE s.kind
        WHEN 'user_message' THEN COALESCE(json_extract(s.payload, '$.text'), '')
        WHEN 'command_run'  THEN COALESCE(json_extract(s.payload, '$.command'), '')
        WHEN 'file_edit'    THEN COALESCE(json_extract(s.payload, '$.path'), '')
        WHEN 'file_read'    THEN COALESCE(json_extract(s.payload, '$.path'), '')
        ELSE COALESCE(s.payload, '') END`;
    where.push(`(${units.map(() => `${hay} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    for (const u of units) params.push(`%${escapeLike(u)}%`);
  }
  params.push(opts.limit ?? 20);
  const rows = db
    .query(
      `SELECT s.id, s.kind, s.payload, s.occurred_at
       FROM situation_log s
       WHERE ${where.join(" AND ")}
       ORDER BY s.occurred_at DESC, s.id DESC
       LIMIT ?`,
    )
    .all(...params) as ChronoRow[];
  return rows.map((r) => ({ id: r.id, uuid: "", source: "situation" as const, line: chronoReceiptLine(r, now) }));
}

function experienceIndexLines(rows: ExperienceRow[], now: string): IndexLine[] {
  return rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    source: "experience" as const,
    line: `#${r.id} [${relativeDayLabel(r.occurredAt, now)}] (${r.kind}) ${truncateToTokens(
      scrubSecrets(scrubMoodViolations(r.content)), // R6：索引行正文读侧兜底
      60,
    )}${r.feeling ? " ※带情绪烙印" : ""}`,
  }));
}

// 二级兜底：翻原始流水（消化记忆为空时才翻，渐进披露不被流水刷屏）。
// 与经历检索同语义按 project 过滤——经历空时的兜底路绝不把别项目的原话越墙带出。
function receiptIndexLines(
  db: Database,
  query: string,
  now: string,
  limit: number,
  opts: { project?: string; includeGlobal?: boolean } = {},
): IndexLine[] {
  return searchRawReceipts(db, query, { limit, project: opts.project, includeGlobal: opts.includeGlobal }).map((r) => ({
    id: r.id,
    uuid: "",
    source: "situation" as const,
    line: `#s${r.id} [${relativeDayLabel(r.occurred_at, now)}] (流水原文) ${truncateToTokens(
      scrubSecrets(r.text), // R6：流水兜底索引正文读侧兜底
      60,
    )}`,
  }));
}

/** 纯字面召回（同步，行为不变；hybrid 不可用时的兜底入口）。 */
export function searchMemoryIndex(db: Database, query: string, opts: RecallOptions = {}): IndexLine[] {
  const forked = chronoFork(db, query, opts);
  if (forked) return forked;
  const now = (opts.clock ?? systemClock).now();
  const rows = searchExperiences(db, query, {
    project: opts.project,
    includeGlobal: opts.includeGlobal ?? true,
    includeHistory: opts.includeHistory,
    limit: opts.limit ?? 10,
  });
  if (rows.length > 0) return experienceIndexLines(rows, now);
  return receiptIndexLines(db, query, now, opts.limit ?? 5, {
    project: opts.project,
    includeGlobal: opts.includeGlobal,
  });
}

/**
 * 混合召回（异步，字面+语义）。embed 注入（生产传 embedQuery）。语义出错/无向量自动退字面，
 * 经历全空再翻原始流水。「随说随想起」走这条。
 */
export async function searchMemoryIndexHybrid(
  db: Database,
  query: string,
  embed: QueryEmbedder,
  opts: RecallOptions = {},
): Promise<IndexLine[]> {
  const forked = chronoFork(db, query, opts);
  if (forked) return forked;
  const now = (opts.clock ?? systemClock).now();
  const rows = await searchExperiencesHybrid(db, query, embed, {
    project: opts.project,
    includeGlobal: opts.includeGlobal ?? true,
    includeHistory: opts.includeHistory,
    limit: opts.limit ?? 10,
    semantic: opts.semantic,
  });
  if (rows.length > 0) return experienceIndexLines(rows, now);
  return receiptIndexLines(db, query, now, opts.limit ?? 5, {
    project: opts.project,
    includeGlobal: opts.includeGlobal,
  });
}

/** 按来源+ID 拉全文（"e"/"experience" 走经历，"s"/"situation" 走流水原话） */
export function renderMemoryDetail(
  db: Database,
  source: RecallSource,
  id: number,
  opts: { clock?: Clock; project?: string } = {},
): string | null {
  if (source === "experience") return renderExperienceDetail(db, id, opts);
  const clock = opts.clock ?? systemClock;
  // DESIGN-WORK-TIMELINE §3D：放开到 4 个 work-action kind；非这些 kind 不暴露（返 null）。
  // codex 终审 F1：放开 kind 后必须按 project 隔离——#s 全局自增，没墙会跨项目拉别项目动作流水/路径。
  // 给了 project：别项目不返、含全局 project IS NULL；不给 project：维持旧行为（向后兼容）。
  const sql = opts.project !== undefined
    ? `SELECT id, kind, payload, occurred_at FROM situation_log WHERE id = ? AND (project = ? OR project IS NULL)`
    : `SELECT id, kind, payload, occurred_at FROM situation_log WHERE id = ?`;
  const row = (opts.project !== undefined
    ? db.query(sql).get(id, opts.project)
    : db.query(sql).get(id)) as ChronoRow | null;
  if (!row || !(CHRONO_RECEIPT_KINDS as readonly string[]).includes(row.kind)) return null;
  const p = parsePayloadObj(row.payload);
  const day = relativeDayLabel(row.occurred_at, clock.now());
  switch (row.kind) {
    case "user_message": {
      const text = asStr(p.text);
      if (!text) return null; // 空原话维持旧行为（返 null）
      // R1（AUDIT-2026-07-03）：存量合成"假用户轮" + compact 摘要污染——按 id 拉全文也挡住（读侧最后
      // 一道防线，索引层 searchRawReceipts/listReceiptsChrono 已不返它，此处兜任意 id 直取；同一读侧前缀源）。
      if (isReadExcludedUserText(text)) return null;
      // R6：读侧兜底——按 id 拉全文的原始流水也过 scrubSecrets（合成判定用原文，emit 用脱敏后文本）。
      return `#s${row.id} [${day}] (流水原文，用户原话)\n${scrubSecrets(text)}`;
    }
    case "command_run": {
      const lines = [`#s${row.id} [${day}] (命令${p.category ? ` ${asStr(p.category)}` : ""}${p.ok === false ? " · 失败" : ""})`];
      if (asStr(p.command)) lines.push(scrubSecrets(asStr(p.command))); // R6：命令正文读侧兜底
      if (asStr(p.output)) lines.push(`输出：${scrubSecrets(asStr(p.output))}`); // R6：输出正文读侧兜底
      return lines.join("\n");
    }
    case "file_edit": {
      const lines = [`#s${row.id} [${day}] (编辑${p.tool ? ` ${asStr(p.tool)}` : ""})`];
      lines.push(scrubSecrets(asStr(p.path)) || "（无路径）"); // R6：路径读侧兜底
      if (asStr(p.change)) lines.push(`变更：${scrubSecrets(asStr(p.change))}`); // R6：变更摘要读侧兜底
      return lines.join("\n");
    }
    case "file_read":
      return `#s${row.id} [${day}] (读取)\n${scrubSecrets(asStr(p.path)) || "（无路径）"}`; // R6：路径读侧兜底
    default:
      return null;
  }
}

export function renderExperienceDetail(
  db: Database,
  id: number,
  opts: { clock?: Clock; project?: string } = {},
): string | null {
  const clock = opts.clock ?? systemClock;
  // 带墙取数（AUDIT A区#2）：按 project 隔离 + 恒过滤作废/过期/兜底壳，别让 recall_detail 成绕墙后门。
  const row = getExperienceForRecall(db, id, opts.project);
  if (!row) return null;
  const parts = [
    `#${row.id} [${relativeDayLabel(row.occurredAt, clock.now())}] (${row.kind})${
      row.project ? ` @${row.project}` : ""
    }`,
    scrubSecrets(scrubMoodViolations(row.content)), // R6：经历全文读侧兜底
  ];
  if (row.feeling) parts.push(`感受：${scrubMoodNumbers(row.feeling)}`);
  if (row.keywords.length) parts.push(`关键词：${row.keywords.join("、")}`);
  // 已失效/过期行不会走到这里（getExperienceForRecall 恒过滤）→ 不再返作废全文，旧的「已失效」软提示分支移除。
  return parts.join("\n");
}
