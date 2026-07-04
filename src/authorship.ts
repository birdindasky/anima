// 采集主权闸②（R1，AUDIT-2026-07-03）：识别 harness 塞进 transcript 的**合成"假用户轮次"**。
// 它们 type:"user" 却非人写——斜杠命令展开、后台 task-notification、本地命令回显、队友/子代理信封、
// 以及 anima 自己 self-review prompt 被子代理回吐（自我复读回声环，正是 echo.ts 立项要杀的循环）。
// 旧采集只有两道闸（isMeta/isSidechain + isCompactSummary），这些合成轮全部漏进 kind='user_message'，
// 推翻"user_message=用户原话"这条地基不变量、破 echo 防线、且不可逆积累（生产快照实测已污染 ~1400 条）。
//
// 单一事实源：写侧（capture.extractEvents，**权威**=entry 元数据 promptSource + 文本形态）与
// 读侧（recall.searchRawReceipts/listReceiptsChrono、selfReview.assembleMaterial——所有把 user_message
// 正文喂给模型的点）共用这同一组判据。写侧堵住新污染落库，读侧让存量污染永不再浮到模型面前
// （append-only 不物删、不改 schema、不动生产库）。
import type { TranscriptEntry } from "./transcript";

// 两条**自然语言前导句**（非 XML 标记，真人可能亲手粘贴讨论）。读侧仍按行首锚定排除存量污染；
// 写侧兜底另配"紧跟的合成结构"才判合成（见 isWriteFallbackSyntheticText），避免误杀真人原话。
/** 队友/子代理信封开场白——真机恒紧跟 `<teammate-message` 结构（快照 126/126 全含）。 */
export const TEAMMATE_PREAMBLE = "Another Claude session sent a message:" as const;
/** anima 自评 prompt 开场白（本项目作者尤其可能贴来讨论）——真机恒紧跟 `<material>` 结构（快照 5467/5467 全含）。 */
export const SELFREVIEW_PROMPT_PREAMBLE = "你是 anima——这台机器上 Claude Code 的魂" as const;

/**
 * 合成轮的"文本形态"指纹——**一律行首锚定**（trim 起手后 startsWith）。
 * 行首锚定 = 零误伤铁律：真实用户即使正文里**引用/粘贴**这些标记，也几乎不会以它**开头**
 * （与 compact R1-D 同哲学，不做内容嗅探）。生产快照实证：含任一标记的 user_message 行 1445 条
 * **全部**以某标记开头、残差 0，故行首锚定既完备又零误伤。
 * **读侧专用**（isReadExcludedUserText / syntheticTextExclusionSql）——写侧兜底另有更保守判据。
 */
export const SYNTHETIC_TEXT_PREFIXES: readonly string[] = [
  // 斜杠命令展开（/clear、/find-skills…）：<command-name>/<command-message>/<command-args>
  "<command-name>",
  "<command-message>",
  "<command-args>",
  // 本地命令回显（Set model to…、Set effort level…）
  "<local-command-stdout>",
  "<local-command-stderr>",
  // 后台任务状态回吐（promptSource=system）
  "<task-notification>",
  // 队友/子代理信封（多智能体：也可能直接以标签开头）
  "<teammate-message",
  TEAMMATE_PREAMBLE,
  // anima 自评 prompt 被子代理回吐 = 自我强化回声环（echo.ts 立项要杀的复读循环）
  SELFREVIEW_PROMPT_PREAMBLE,
] as const;

/**
 * compact 摘要读侧兜底前缀（R1-gaps，AUDIT-2026-07-03）。
 * 写侧靠 isCompactSummaryEntry 的**标志位**（isCompactSummary/isVisibleInTranscriptOnly）拦 compact——
 * 但该守卫上线前，旧库已把 auto-compact 续接摘要落成 kind='user_message'（生产快照实测 25 条），存量行
 * 只剩正文、无标志可查。compact 摘要正文恒以此机器续接句开头（真机 257 条核对），行首锚定纳入读侧排除，
 * 让存量 compact 污染与合成轮一样永不再浮到检索/详情。真实用户几乎不会以整句英文机器续接语开头 → 零误伤。
 */
export const COMPACT_SUMMARY_TEXT_PREFIX =
  "This session is being continued from a previous conversation" as const;

/**
 * **读侧专用**排除前缀单一事实源：合成"假用户轮"（SYNTHETIC_TEXT_PREFIXES）+ compact 摘要存量污染。
 * compact 前缀**只挂这里、绝不进 isSyntheticUserText（写侧兜底也用它）**——写侧的 compact 由
 * isCompactSummaryEntry 的**标志位**（isCompactSummary/isVisibleInTranscriptOnly）拦；若在写侧按正文
 * startsWith 嗅探 compact，会误杀"真人照抄这句机器续接语开头"的真实消息（grader R1-D 零误伤铁律）。
 * 读侧只面对**已存正文、无标志可查**的存量行，才需按前缀兜底。isReadExcludedUserText（renderMemoryDetail
 * 详情兜底）与 syntheticTextExclusionSql（索引层 SQL）共用它——保证「按 id 直取 / 字面检索 / 时间线小票」
 * 三条读侧路口径完全一致，绝不一路排一路漏。
 */
const READSIDE_EXCLUSION_PREFIXES: readonly string[] = [
  ...SYNTHETIC_TEXT_PREFIXES,
  COMPACT_SUMMARY_TEXT_PREFIX,
];

/**
 * **读侧**判据：从**已存 payload 文本**判这条 user_message 是不是合成"假用户轮"
 * （斜杠命令 / task-notification / 队友信封 / 自评回吐）。**不含 compact**（见 READSIDE_EXCLUSION_PREFIXES）。
 * 处理合成存量污染（~1400 条）。**写侧兜底不用它**——写侧走更保守的 isWriteFallbackSyntheticText
 * （真人可能亲手粘贴两条自然语言前导句，读侧排存量可放宽、写侧丢库不可误杀真人原话）。
 */
export function isSyntheticUserText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trimStart();
  for (const p of SYNTHETIC_TEXT_PREFIXES) if (t.startsWith(p)) return true;
  return false;
}

/**
 * 写侧兜底专用**结构化 XML 标记**子集（SYNTHETIC_TEXT_PREFIXES 里以 `<` 开头者）：真人几乎不可能以这些
 * **字面标签**开头打字，行首锚定即高置信。两条自然语言前导句不在此列（另配紧跟结构，见下）。
 */
const WRITE_FALLBACK_STRUCTURAL_PREFIXES: readonly string[] = SYNTHETIC_TEXT_PREFIXES.filter((p) =>
  p.startsWith("<"),
);

/**
 * **写侧兜底判据**（isSyntheticUserTurn 在 promptSource **缺失**时才走）——比读侧 isSyntheticUserText 更保守。
 * 真相核实（快照 + 7888 份真 transcript）：真实人类用户轮**并非总带 promptSource**——旧 harness 下 274 条
 * 真人对话原话（"压测一下""继续任务""同意你的方案"…）promptSource=null。故此兜底就是这些真人轮**唯一的闸**，
 * 一旦误判即 append-only **永久丢真人原话**（R1 codex GO-WITH-GAPS 残留）。只对**极高置信、真人几乎不可能
 * 亲手打的确切合成形态**生效：① 结构化 XML 标记行首锚定；② 两条自然语言前导句须**"前缀后紧跟合成结构"**——
 * 队友信封含 `<teammate-message`、自评 prompt 含 `<material>`（真机各 126/126、5467/5467 全含）——避免真人恰以
 * 该句开头讨论时被误杀（本项目作者尤其可能贴 anima 自己的自评 prompt）。宁可漏挡个别合成轮（读侧 SQL/详情
 * 兜底仍以 READSIDE_EXCLUSION_PREFIXES 排存量），不可误杀真人原话（用户铁律 precision>recall 于真人字）。
 */
export function isWriteFallbackSyntheticText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trimStart();
  for (const p of WRITE_FALLBACK_STRUCTURAL_PREFIXES) if (t.startsWith(p)) return true;
  if (t.startsWith(TEAMMATE_PREAMBLE) && t.includes("<teammate-message")) return true;
  if (t.startsWith(SELFREVIEW_PROMPT_PREAMBLE) && t.includes("<material>")) return true;
  return false;
}

/**
 * **读侧兜底判据**（renderMemoryDetail 按 id 直取全文时用）：这条已存 user_message 正文是不是
 * "非用户原话"——合成"假用户轮" 或 compact 摘要存量污染。与 syntheticTextExclusionSql（索引层 SQL）
 * 同一 READSIDE_EXCLUSION_PREFIXES 单一事实源。**写侧绝不用它**（compact 由标志位拦，见上）。
 */
export function isReadExcludedUserText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trimStart();
  for (const p of READSIDE_EXCLUSION_PREFIXES) if (t.startsWith(p)) return true;
  return false;
}

/**
 * 合成来源的 promptSource（entry 元数据，写侧权威信号）：'system' = 系统合成轮（task-notification 等），
 * 连正文都不用看即可判定。真实用户轮 promptSource 不在此集。
 */
const SYNTHETIC_PROMPT_SOURCES = new Set<string>(["system"]);

/** 从 entry 拍平出"用户轮正文"（string 原样 / block 数组取 text 块拼接），供写侧文本形态判。 */
function userTurnText(entry: TranscriptEntry): string {
  if (typeof entry.content === "string") return entry.content;
  let s = "";
  for (const b of entry.content) if (b.type === "text" && typeof b.text === "string") s += b.text;
  return s;
}

/**
 * 写侧三分裁决（D2-quarantine，用户拍板：启发式不配销毁权，铁证可以）：
 * - 'synthetic_confirmed'：promptSource==='system' 权威元数据**铁证**——一旦存在即定谳、绝不再文本嗅探
 *   （'system' 及未来合成来源＝合成；其它值＝真人，真人打的字**即便以合成标签开头**也不误杀，R1-gaps）。
 *   铁证合成轮写侧照旧不落库（销毁权只给铁证）。
 * - 'synthetic_suspect'：promptSource **缺失**（null——旧库/斜杠展开等不带此字段；快照实测 33% 真人轮缺
 *   promptSource=热路径，其中 274 条真人原话 null）且**更保守**的 isWriteFallbackSyntheticText 长相命中
 *   ——只是**嫌疑**，不配销毁：capture 落 kind='user_message_suspect' 隔离行（见 capture.extractEvents）。
 * - 'human'：其余——照常落 user_message。
 * 非 user 条目恒 'human'（只裁"用户轮"，assistant 的 tool_use 不受影响）。
 */
export type UserTurnVerdict = "human" | "synthetic_confirmed" | "synthetic_suspect";

export function classifyUserTurn(entry: TranscriptEntry): UserTurnVerdict {
  if (entry.type !== "user") return "human";
  if (entry.promptSource) {
    return SYNTHETIC_PROMPT_SOURCES.has(entry.promptSource) ? "synthetic_confirmed" : "human";
  }
  return isWriteFallbackSyntheticText(userTurnText(entry)) ? "synthetic_suspect" : "human";
}

/**
 * "非真人轮"并集判据＝铁证 ∪ 嫌疑（classifyUserTurn != 'human'）。**素材侧**（selfReview.assembleMaterial）
 * 继续用它整条跳过：material 是派生的、宁缺勿污，嫌疑行也不进对话素材——与写侧"隔离进库"不矛盾
 * （库里全文还在，翻案一条 UPDATE 复活；素材随时可重建）。非 user 条目一律 false。
 */
export function isSyntheticUserTurn(entry: TranscriptEntry): boolean {
  return entry.type === "user" && classifyUserTurn(entry) !== "human";
}

/** 人写用户轮：type==='user' 且非合成。非 user 条目 false。 */
export function isHumanAuthoredTurn(entry: TranscriptEntry): boolean {
  return entry.type === "user" && !isSyntheticUserTurn(entry);
}

/**
 * SQL 侧前导空白剥除集：与 JS trimStart 对齐的 ASCII 空白——tab(9)/LF(10)/VT(11)/FF(12)/CR(13)/space(32)。
 * SQLite `LTRIM(X)` 单参**只剥空格(0x20)**、漏 \n\t——与 JS trimStart（全剥）口径不一致会让"行首带换行/
 * 制表符的合成/compact 行"在 SQL 兜底漏网（renderMemoryDetail 的 JS trimStart 仍兜，但**索引层纯 SQL**的
 * searchRawReceipts/listReceiptsChrono 会把它顶进召回结果）。显式传剥除集，两侧统一处理前导空白（R1-gaps）。
 * （trimStart 另剥若干 Unicode 空白，真实 transcript 正文不含 → 此 ASCII 集即完备。）
 */
const SQL_LEADING_WS = "char(9)||char(10)||char(11)||char(12)||char(13)||char(32)";

/**
 * 读侧 SQL 兜底：生成"排除非用户原话（合成轮 + compact 摘要存量污染）"的 WHERE 片段
 * （与 isReadExcludedUserText 同一套 READSIDE_EXCLUSION_PREFIXES 单一事实源）。
 * `expr` = 取正文的 SQL 表达式（如 COALESCE(json_extract(s.payload,'$.text'),'')）。
 * 返回 { clause, params }：clause 是 AND-of-NOT-LIKE（LTRIM 显式剥 ASCII 空白、对齐 JS trimStart），
 * params 是对应前缀模式，调用方按占位符出现顺序把 params 拼进自己的参数数组。前缀内无 LIKE 通配符
 * （% / _），无需 ESCAPE。
 */
export function syntheticTextExclusionSql(expr: string): { clause: string; params: string[] } {
  const clause = READSIDE_EXCLUSION_PREFIXES.map(
    () => `LTRIM(${expr}, ${SQL_LEADING_WS}) NOT LIKE ?`,
  ).join(" AND ");
  return { clause: `(${clause})`, params: READSIDE_EXCLUSION_PREFIXES.map((p) => `${p}%`) };
}
