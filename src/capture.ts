// 事件采集：transcript 扫描 → 处境流水（纯客观），uuid 游标增量
// 设计注记：采集单一来源是 transcript 扫描（Stop/SessionEnd 时跑），
// 不在 PostToolUse 实时记——单一路径 + 游标事务推进，天然无重复、崩溃安全。
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";
import { stripEcho } from "./echo";
import { classifyUserTurn } from "./authorship";
import { appendSituation, type SituationInput } from "./situation";
import { normalizeProject } from "./project";
import {
  entriesAfter,
  flattenResultContent,
  isCompactSummaryEntry,
  readTranscriptEntries,
  type TranscriptEntry,
} from "./transcript";

const TEST_CMD_RE =
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bvitest\b|\bjest\b/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * extractEvents 能产出的全部 kind = transcript「真实活动」种类（都带真实时间戳）。
 * 这是唯一源头：消化端（digest.ts 的 daySessions / findUndigestedNights）判定
 * 「会话/夜归属」只认这些 kind，绝不认消化产物 marker（self_review_failed 等，其时间来自
 * 消化时刻——会把老会话错拽进当夜）。
 * ⚠️ 给 extractEvents 新增一种 kind 时，必须同步加到这里，否则那种活动的会话会被漏算；
 * tests/phase1 有守卫测试，漏加会红灯。
 * （唯一例外：USER_MESSAGE_SUSPECT_KIND 隔离行**故意不进**——嫌疑行大概率是合成轮，不该拽会话/夜归属，
 * 与改隔离前"直接销毁不落库"的归属行为完全对齐；见下方注释。）
 */
export const TRANSCRIPT_ACTIVITY_KINDS = [
  "user_message",
  "file_edit",
  "file_read",
  "command_run",
  "test_run",
  "tool_error",
] as const;

/**
 * D2（隔离不销毁，AUDIT-2026-07-03 后续，用户拍板）：启发式嫌疑用户轮的隔离 kind。
 * 设计依据——**启发式不配销毁权，铁证可以**：
 * - 铁证（promptSource==='system'，权威元数据）＝确定合成 → 照旧不落库，销毁没争议。
 * - 启发式（promptSource 缺失 + isWriteFallbackSyntheticText 文本长相命中；实测 33% 真人轮缺
 *   promptSource=热路径）只是**嫌疑**——误判即 append-only 永久丢真人原话。故不再跳过，改落本 kind：
 *   正文 payload 原样全存（{text, uuid} 与 user_message 完全同构）、dedup_key 照旧 msg:<uuid>。
 * - 隔离为何天然密封：situation_log 无 invalid_at 列，而所有读路（recall.searchRawReceipts/
 *   listReceiptsChrono/renderMemoryDetail/CHRONO_RECEIPT_KINDS）与素材（selfReview EVENT_ACTIVITY_KINDS）
 *   全按 kind 白名单取行 → 嫌疑行对全部读侧/素材/注入不可见，零新读侧逻辑。
 * - 翻案＝一条 `UPDATE situation_log SET kind='user_message' WHERE id=?` 原位复活（payload/dedup_key
 *   分毫不动，重采仍被幂等弹回）。注：这是数据层复活；读侧 R1 存量文本形态兜底（authorship 读侧前缀）
 *   是护存量污染的独立层，口径另案不动。
 * - 不进 TRANSCRIPT_ACTIVITY_KINDS（见上）——嫌疑行不参与会话/夜归属判定。
 */
export const USER_MESSAGE_SUSPECT_KIND = "user_message_suspect" as const;

// ── work-memory 采集辅助（§3A/§5.6，hook 零 LLM，纯正则毫秒级）──────────────
// 截断常量：scrub 之后再截（独立 Claude 顺序铁律），绝不存大 blob（F-2）。
const CMD_OUTPUT_HEAD = 150;
const CMD_OUTPUT_TAIL = 150;
const EDIT_SUMMARY_HEAD = 100;
const EDIT_SUMMARY_TAIL = 100;

/** 首尾保留、中段省略——绝不存全量 blob */
function headTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)} …(${s.length - head - tail}字省略)… ${s.slice(s.length - tail)}`;
}

// command_run 白名单 + 分类（§3A）：不在白名单的 Bash 一律不采。
// 数组顺序即淘汰优先级（deploy/install > git > build > net）；靠前者优先归类。
const COMMAND_CATEGORIES: { cat: string; re: RegExp }[] = [
  { cat: "deploy", re: /\b(?:deploy|kubectl|fly|vercel|docker)\b/ },
  { cat: "install", re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|add|install)\b|\b(?:pip3?|brew|apt|cargo)\s+(?:install|add)\b/ },
  { cat: "git", re: /\bgit\b/ },
  { cat: "build", re: /\b(?:make|cargo|go)\s+build\b|\b(?:bun|npm|pnpm|yarn)\s+run\s+build\b|\b(?:tsc|webpack|rollup)\b|\bvite\s+build\b/ },
  { cat: "net", re: /\b(?:curl|wget|gh)\b/ },
];
/** 返回类别；不在白名单 → null（不采） */
export function classifyCommand(command: string): string | null {
  for (const { cat, re } of COMMAND_CATEGORIES) if (re.test(command)) return cat;
  return null;
}

// 输出正文不存的命令类别（轴⑤ hybrid，用户拍 2026-06-22；build 经 codex 复核加入 2026-06-23）：
// deploy/net/install/build 的输出是不受控的自由文本（env/日志/inspect/API 响应/registry 凭证；
// 且 npm/bun run build 是任意脚本、可能打印 env），常含**无名字提示又低熵**的密钥（pin/裸密码），
// 正则结构兜不住 → 一律只留「命令+成败」、不存输出正文（记忆会被回喂云端模型，泄漏即外发）。
// 仅 git 的输出（diff/状态/log）密钥风险低、召回价值高 → 保留打码摘要。
const OUTPUT_REDACTED_CATEGORIES = new Set(["deploy", "net", "install", "build"]);

// 隐私 scrub（§5.6 M-A）：密钥进 append-only 库不可逆，宁可误打码（precision>recall）。
// 高熵串要求**同时含大写+小写+数字** → 天然排除 git SHA（纯小写 hex 无大写，codex n-3）与无数字路径。
// 必须在截断之前对全量跑。
export function scrubSecrets(text: string): string {
  return text
    // 已知前缀型 token / AWS / slack / JWT / Bearer / PEM
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|pat|glpat)[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED JWT]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, "[REDACTED KEY]")
    // 敏感 flag 后的值（--token / --client-secret / --refresh-token …）
    .replace(/(--?(?:token|password|passwd|secret|api[-_]?key|auth|access[-_]?key|client[-_]?secret|refresh[-_]?token)[=\s]+)(\S+)/gi, "$1[REDACTED]")
    // curl basic-auth flag：-u user:pass（盲考官 N-1b）
    .replace(/(-u\s+[^:\s]+:)(\S+)/g, "$1[REDACTED]")
    // 敏感名的 HTTP 头：-H 'Authorization: …' / 'X-Api-Key: …' / 'X-Auth-Token: …'（盲考官 N-1b）
    .replace(/(-H\s+["']?[\w-]*(?:authorization|token|secret|api[-_]?key|auth|cookie)[\w-]*:\s*)([^"'\\]+)/gi, "$1[REDACTED]")
    // URL query 参数名**含**敏感子串即打码（client_secret/refresh_token/auth_token/jsessionid…，盲考官 N-1/N-1b）
    .replace(/([?&][^=&\s]*(?:token|secret|key|auth|pass|pwd|sig|jwt|session|credential)[^=&\s]*=)([^&\s'"]+)/gi, "$1[REDACTED]")
    // URL basic-auth 密码：//user:pass@host（强制结尾 @，故 //host:port 不误伤）（盲考官 N-1）
    // 用户名 0+ 字符：兼容空用户型连接串 redis://:pass@host（轴⑤ S20）
    .replace(/(\/\/[^/\s:@]*:)([^@\s/]+)(@)/g, "$1[REDACTED]$3")
    // JSON body 里敏感 key 的字符串值（curl -d '{"token":"…"}'，盲考官 N-1b）
    .replace(/("[^"]*(?:token|secret|key|auth|pass|pwd|jwt|session|credential)[^"]*"\s*:\s*")([^"]+)(")/gi, "$1[REDACTED]$3")
    // mysql/psql -p 密码（纯数字端口不动）
    .replace(/(-p\s+)(?!\d+\b)(\S+)/g, "$1[REDACTED]")
    // 名字带敏感词的赋值（env-dump / KEY=val / password: val）——靠**变量名**判定，
    // 不靠熵值，故纯数字/全小写/低熵的输出型密钥也打、且不误伤路径与 SHA（轴⑤ S18/S19/O4）。
    .replace(
      /\b(\w*(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key|ssh[-_]?key|signing[-_]?key|authorization|credential|auth[-_]?token)\w*\s*[=:]\s*)(\S+)/gi,
      "$1[REDACTED]",
    )
    // R6（AUDIT-2026-07-03）：高价值专用模式——高熵兜底对"无大写/无数字"形态失明（全小写 hex 签名、
    // 全大写 token、AIza 型），这几条按**独一前缀/固定形态**补齐盲区，不放宽"裸 hex 一律放行"的精度契约。
    // Google API key（AIza + 35 位，前缀独一）：形态固定、零误伤。
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]")
    // Slack incoming webhook 完整 URL（路径即凭证，泄漏即可代发消息）。
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+/g, "[REDACTED]")
    // Webhook 签名：只在 sha1=/sha256= 明确签名上下文里打码其 hex 值——绝不动**裸** hex
    //（裸 40/64 hex 仍按 git SHA 放行，守"宁可漏打码非密钥"契约，见 grader-blind 契约7）。
    .replace(/\b(sha(?:1|256)=)[A-Fa-f0-9]{20,}/gi, "$1[REDACTED]")
    // 高熵兜底：≥20 位同时含大小写+数字 → 排除小写 hex SHA（无大写）与无数字路径（codex n-3）
    .replace(/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

/** 编辑变更紧凑摘要（不存全文，F-2）；返回值会先 scrub 再截断 */
function buildEditSummary(name: string, input: Record<string, unknown>): string {
  if (name === "Write") {
    const c = typeof input.content === "string" ? input.content : "";
    return `write ${c.length}b: ${(c.split("\n")[0] ?? "").trim()}`;
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return `multiedit ${edits.length} hunks`;
  }
  if (name === "NotebookEdit") return "notebook edit";
  const oldS = (typeof input.old_string === "string" ? input.old_string : "").replace(/\s+/g, " ").trim();
  const newS = (typeof input.new_string === "string" ? input.new_string : "").replace(/\s+/g, " ").trim();
  return `- ${oldS} | + ${newS}`;
}

interface PendingTool {
  name: string;
  command?: string;
  filePath?: string;
  /** R3（AUDIT-2026-07-03）：编辑变更摘要在 tool_use 时预建（scrub+截断已完成），暂存到此，
   *  等 tool_result 配对、按 ok 门控才落 file_edit（失败的 Edit 不再产"文件已改"幽灵）。 */
  editChange?: string;
}

/** 纯函数：从条目流提取客观事件（不碰库） */
export function extractEvents(entries: TranscriptEntry[]): SituationInput[] {
  const events: SituationInput[] = [];
  const pending = new Map<string, PendingTool>();

  for (const e of entries) {
    if (e.isMeta || e.isSidechain) continue; // 子代理不算它的经历；本地命令杂音跳过
    if (isCompactSummaryEntry(e)) continue; // R1：auto-compact 摘要是机器续接文本，非用户原话，绝不落库
    const base = {
      sessionId: e.sessionId,
      project: normalizeProject(e.cwd),
      occurredAt: e.timestamp ?? undefined,
    };

    if (e.type === "assistant" && Array.isArray(e.content)) {
      for (const block of e.content) {
        if (block.type !== "tool_use" || !block.id || !block.name) continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const pt: PendingTool = {
          name: block.name,
          command: input.command as string | undefined,
          filePath: typeof input.file_path === "string" ? input.file_path : undefined,
        };
        // R3（AUDIT-2026-07-03）：编辑此刻还没 tool_result、无从知道成没成——只**暂存**变更摘要
        // （scrub 先于截断，顺序铁律），落库挪到下方 tool_result 分支按 ok 门控，与 Bash/Read/test 一致。
        if (EDIT_TOOLS.has(block.name) && typeof input.file_path === "string") {
          pt.editChange = headTail(
            scrubSecrets(buildEditSummary(block.name, input)),
            EDIT_SUMMARY_HEAD,
            EDIT_SUMMARY_TAIL,
          );
        }
        pending.set(block.id, pt);
      }
      continue;
    }

    if (e.type !== "user") continue;

    // R1+D2（AUDIT-2026-07-03）：harness 合成的"假用户轮次"（斜杠命令展开 / task-notification /
    // local-command-stdout / 队友信封 / anima 自评 prompt 回吐）绝不当用户原话落 user_message——
    // 与 isCompactSummaryEntry 并列的第二道采集闸。写侧三分（权威见 authorship.classifyUserTurn）：
    // 铁证（promptSource='system'）→ 照旧不落库；启发式命中 → 只算嫌疑，落 USER_MESSAGE_SUSPECT_KIND
    // 隔离行（正文原样全存，隔离不销毁，设计依据见该常量注释）；其余=真人照常。只影响 user_message
    // 正文，同条目里的 tool_result 照常处理（合成轮本就纯文本、无 tool_result，故不误伤）。
    const verdict = classifyUserTurn(e);
    const userMsgKind = verdict === "synthetic_suspect" ? USER_MESSAGE_SUSPECT_KIND : "user_message";

    if (typeof e.content === "string") {
      const text = stripEcho(e.content).trim();
      if (text && verdict !== "synthetic_confirmed") events.push({ ...base, kind: userMsgKind, payload: { text, uuid: e.uuid }, dedupKey: `msg:${e.uuid}` });
      continue;
    }

    let userText = "";
    for (const block of e.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const tool = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        const output = stripEcho(flattenResultContent(block.content));
        const ok = block.is_error !== true;
        const cmdCat = tool?.command ? classifyCommand(tool.command) : null;
        if (tool?.command && TEST_CMD_RE.test(tool.command)) {
          const m = output.match(/(\d+)\s*fail/i);
          const passed = m ? parseInt(m[1]!, 10) === 0 : ok;
          // 命令也要 scrub（codex 复核：API_TOKEN=x npm test 会把 token 原样存进库）
          const scrubbedTestCmd = scrubSecrets(tool.command);
          events.push({
            ...base,
            kind: "test_run",
            dedupKey: `tool:${block.tool_use_id}:test_run`,
            payload: {
              command: scrubbedTestCmd !== tool.command ? "[命令含疑似密钥，未采]" : scrubbedTestCmd,
              ok: passed,
            },
          });
        } else if (tool?.name === "Bash" && tool.command && cmdCat) {
          // 一般命令（白名单内）：分类 + 成败 + 输出摘要（scrub 先于截断）。
          // 命令本身若疑似含密钥 → 整条不采，只留分类+成败（§5.6 ⑤兜底）。
          const scrubbedCmd = scrubSecrets(tool.command);
          const cmdHadSecret = scrubbedCmd !== tool.command;
          events.push({
            ...base,
            kind: "command_run",
            dedupKey: `tool:${block.tool_use_id}:command_run`,
            payload: {
              command: cmdHadSecret ? "[命令含疑似密钥，未采]" : scrubbedCmd,
              category: cmdCat,
              ok,
              // 危险类只留成败、不存输出正文（轴⑤ hybrid）；安全类留打码摘要
              output: OUTPUT_REDACTED_CATEGORIES.has(cmdCat)
                ? "[输出正文未采：此类命令输出可能含无名低熵密钥]"
                : headTail(scrubSecrets(output), CMD_OUTPUT_HEAD, CMD_OUTPUT_TAIL),
            },
          });
        } else if (tool?.name === "Read" && tool.filePath && ok) {
          // 成功的读：只存路径（不存文件内容，§3A）；读出错走下方 tool_error。
          events.push({ ...base, kind: "file_read", payload: { path: tool.filePath }, dedupKey: `tool:${block.tool_use_id}:file_read` });
        } else if (tool && EDIT_TOOLS.has(tool.name) && tool.filePath && tool.editChange !== undefined && ok) {
          // R3（AUDIT-2026-07-03）：成功的编辑才落 file_edit（change 摘要在 tool_use 时已 scrub+截断预建）。
          // 失败的 Edit（old_string 没匹配 / File has not been read yet）ok=false → 不进本支、落下方 tool_error，
          // 不再产"文件已改"幽灵事件。base 用 tool_result 条目（与 command_run/file_read 同口径的动作时刻）。
          events.push({
            ...base,
            kind: "file_edit",
            dedupKey: `tool:${block.tool_use_id}:file_edit`,
            payload: { path: tool.filePath, tool: tool.name, change: tool.editChange },
          });
        } else if (block.is_error === true) {
          events.push({
            ...base,
            kind: "tool_error",
            dedupKey: `tool:${block.tool_use_id}:tool_error`,
            payload: { tool: tool?.name ?? "unknown", snippet: scrubSecrets(output).slice(0, 200) },
          });
        }
      } else if (block.type === "text" && typeof block.text === "string") {
        userText += block.text;
      }
    }
    const text = stripEcho(userText).trim();
    if (text && verdict !== "synthetic_confirmed") events.push({ ...base, kind: userMsgKind, payload: { text, uuid: e.uuid }, dedupKey: `msg:${e.uuid}` });
  }
  return events;
}

// ── 按会话采集量上限 + 去重（§3A F-1，防 situation_log 爆量）──────────────
const SESSION_READ_CAP = 50;
const SESSION_CMD_CAP = 30;
const READ_DEDUP_MS = 10 * 60 * 1000; // 同文件 10 分钟内重复 Read 只采 1 次
// 触顶淘汰优先级（数字越小越该留）：deploy/install > git > build > net
const CMD_PRIORITY: Record<string, number> = { deploy: 0, install: 1, git: 2, build: 3, net: 4 };

function occMs(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

interface SessionCapState {
  reads: number;
  cmds: number;
  readPaths: Map<string, number>; // path -> 最近一次 occurred_at(ms)
}

/**
 * 过滤 work-memory 事件（file_read / command_run）：按会话 cap + 同文件去重。
 * 其余 kind 原样直通、保序。读 DB 拿会话既有计数/近期 read（纯读，在写事务之前调）。
 * append-only 库无法删旧 → cap 实现为「到顶即停采新的」（保最旧、丢溢出），并留溢出 marker。
 */
export function filterWorkMemoryEvents(db: Database, events: SituationInput[]): SituationInput[] {
  if (!events.some((e) => e.kind === "file_read" || e.kind === "command_run")) return events;

  const state = new Map<string, SessionCapState>();
  const get = (sid: string): SessionCapState => {
    let s = state.get(sid);
    if (!s) {
      const reads =
        (db.query("SELECT count(*) AS c FROM situation_log WHERE session_id=? AND kind='file_read'").get(sid) as { c: number } | null)?.c ?? 0;
      const cmds =
        (db.query("SELECT count(*) AS c FROM situation_log WHERE session_id=? AND kind='command_run'").get(sid) as { c: number } | null)?.c ?? 0;
      const readPaths = new Map<string, number>();
      const rows = db
        .query("SELECT payload, occurred_at FROM situation_log WHERE session_id=? AND kind='file_read' ORDER BY id DESC LIMIT 100")
        .all(sid) as { payload: string | null; occurred_at: string }[];
      for (const r of rows) {
        try {
          const p = r.payload ? (JSON.parse(r.payload) as { path?: string }).path : null;
          if (typeof p === "string") {
            const m = occMs(r.occurred_at);
            if (!readPaths.has(p) || m > readPaths.get(p)!) readPaths.set(p, m);
          }
        } catch {
          /* 坏 payload 跳过 */
        }
      }
      s = { reads, cmds, readPaths };
      state.set(sid, s);
    }
    return s;
  };

  // 预判每会话保留哪些 command_run（按类别优先级 + 剩余 allowance）
  const keptCmds = new Set<SituationInput>();
  const cmdsBySession = new Map<string, SituationInput[]>();
  for (const ev of events) {
    if (ev.kind !== "command_run") continue;
    const sid = ev.sessionId ?? "";
    const list = cmdsBySession.get(sid) ?? [];
    list.push(ev);
    cmdsBySession.set(sid, list);
  }
  for (const [sid, list] of cmdsBySession) {
    const allowance = Math.max(0, SESSION_CMD_CAP - get(sid).cmds);
    if (list.length <= allowance) {
      for (const c of list) keptCmds.add(c);
      continue;
    }
    const ranked = list
      .map((c, i) => ({ c, i, r: CMD_PRIORITY[((c.payload as { category?: string }) ?? {}).category ?? ""] ?? 9 }))
      .sort((a, b) => a.r - b.r || a.i - b.i); // 高优先级先留，同级保最旧
    for (const x of ranked.slice(0, allowance)) keptCmds.add(x.c);
  }

  const out: SituationInput[] = [];
  let droppedReads = 0;
  let droppedCmds = 0;
  for (const ev of events) {
    if (ev.kind === "file_read") {
      const s = get(ev.sessionId ?? "");
      const path = ((ev.payload as { path?: string }) ?? {}).path ?? "";
      const now = occMs(ev.occurredAt);
      const last = s.readPaths.get(path);
      if (last !== undefined && Math.abs(now - last) <= READ_DEDUP_MS) {
        droppedReads++;
        continue; // 同文件 10 分钟内去重
      }
      if (s.reads >= SESSION_READ_CAP) {
        droppedReads++;
        continue; // 到顶
      }
      s.reads++;
      s.readPaths.set(path, now);
      out.push(ev);
    } else if (ev.kind === "command_run") {
      if (!keptCmds.has(ev)) {
        droppedCmds++;
        continue;
      }
      out.push(ev);
    } else {
      out.push(ev);
    }
  }
  if (droppedReads || droppedCmds) {
    const anchor = events.find((e) => e.kind === "file_read" || e.kind === "command_run")!;
    out.push({
      sessionId: anchor.sessionId,
      project: anchor.project,
      occurredAt: anchor.occurredAt,
      kind: "work_capture_overflow", // 非活动 marker（不进 TRANSCRIPT_ACTIVITY_KINDS）；零消费者，纯诊断面包屑
      // 挂指纹（v8，codex Q2）：每会话一条稳定 key——重采/回溯时锚事件会变（首采锚=被采的头条、重采锚=被丢的
      // 尾条），故不能锚事件；用 sessionId 做稳定键，同会话触顶只落一条（谁也不读计数，一条"触顶过"足够）。
      dedupKey: `overflow:${anchor.sessionId ?? ""}`,
      payload: { droppedReads, droppedCmds, readCap: SESSION_READ_CAP, cmdCap: SESSION_CMD_CAP },
    });
  }
  return out;
}

export interface CaptureOptions {
  clock?: Clock;
  /** 仅测试用：在游标推进前注入故障，验证事务回滚 */
  beforeCommit?: () => void;
  /** 仅测试用：在「读游标」之后、「写事务」之前触发——测试在此注入并发对手抢先采集同段，验证 CAS 让出（A区#4）。 */
  afterRead?: () => void;
  /** 预读好的 transcript 条目。传入则不再读文件——调用方（makeup）要让采集与增量切片基于**同一份
   *  快照**，消除两次读 live transcript 之间追加导致"事件没采进 situation_log、切片却已含该回合"的窗口。 */
  entries?: TranscriptEntry[];
}

/**
 * 采集前剔除已采过的事件（v7 幂等，AUDIT-2026-07-01 rank1）：按 (session_id, dedup_key) 查库，命中即已采过。
 * 必须在 work-cap 计数（filterWorkMemoryEvents 按 situation_log 现存行数算名额）**之前**剔，否则 resume/rewind
 * 重采出的重复事件先占名额、把真 Read/命令挤出上限丢弃。无 dedupKey 的事件（非采集 marker）照过。
 * 这是名额层去重；写库层还有 (session_id, dedup_key) 唯一索引 + INSERT OR IGNORE 兜并发（本 filter 与 insert 之
 * 间被别的进程抢先写同指纹）。
 */
function filterAlreadyCaptured(db: Database, events: SituationInput[]): SituationInput[] {
  const check = db.query("SELECT 1 FROM situation_log WHERE dedup_key = ? LIMIT 1"); // v8：dedup_key 单列全局唯一，不需 session
  return events.filter((ev) => {
    if (!ev.dedupKey) return true;
    return !check.get(ev.dedupKey);
  });
}

export function getCursor(db: Database, transcriptPath: string): string | null {
  const row = db
    .query("SELECT last_uuid FROM capture_cursors WHERE transcript_path = ?")
    .get(transcriptPath) as { last_uuid: string } | null;
  return row?.last_uuid ?? null;
}

/** 增量采集：流水写入与游标推进同事务——保存成功才推进，崩溃不丢不重 */
export function captureTranscript(
  db: Database,
  transcriptPath: string,
  opts: CaptureOptions = {},
): { captured: number; cursor: string | null } {
  const clock = opts.clock ?? systemClock;
  const entries = opts.entries ?? readTranscriptEntries(transcriptPath);
  const dbCursor = getCursor(db, transcriptPath);
  // 单调守卫（仅作用于**显式传入的快照**）：dbCursor 非空却不在本快照里 = 快照比游标还旧/与之不一致，
  // 此时 entriesAfter 会退化成"整段重采"→ situation_log 无唯一约束 → 重复事件 + 游标回退（codex IMPORTANT）。
  // 直接 no-op，绝不回退。默认读路径（opts.entries 缺省）不受影响：自读的 append-only 文件必含 dbCursor。
  if (opts.entries && dbCursor !== null && !entries.some((e) => e.uuid === dbCursor)) {
    return { captured: 0, cursor: dbCursor };
  }
  const fresh = entriesAfter(entries, dbCursor);
  if (fresh.length === 0) return { captured: 0, cursor: dbCursor };

  // 采集 → 先剔已采过的（v7 幂等，治重采抬高 cap 现存计数）→ work-memory cap/去重过滤（纯读 DB，写事务前）
  const events = filterWorkMemoryEvents(db, filterAlreadyCaptured(db, extractEvents(fresh)));
  const lastUuid = fresh[fresh.length - 1]!.uuid;
  const now = clock.now().toISOString();
  opts.afterRead?.(); // 测试缝：在此注入并发对手抢采（生产恒 undefined）

  // 并发去重（AUDIT A区#4）：Stop hook（每回合）与 worker 会同采一份 transcript、各持不同锁。旧码游标读在
  // 事务外（line 385）→ 两路按同一旧游标算出同一段 fresh、都写 → situation_log 无唯一约束 → 同一动作两条、永久。
  // 修：① 事务用 BEGIN IMMEDIATE（下方 tx.immediate()）在起点即拿写锁——busy_timeout=5000 撞锁是等待非抛错；
  //     ② 事务内重读游标做 CAS——已被另一路推进（≠算 fresh 时的 dbCursor）就整体让出：那段对方已采，剩余留
  //        下轮采（cursor 已前移、不丢不重）。WAL 写串行 + IMMEDIATE 锁保证「读游标→比对→写」对其它写者原子。
  let result: { captured: number; cursor: string | null } = { captured: 0, cursor: dbCursor };
  const tx = db.transaction(() => {
    if (getCursor(db, transcriptPath) !== dbCursor) {
      result = { captured: 0, cursor: getCursor(db, transcriptPath) }; // 对手已推进 → 让出，绝不重复写
      return;
    }
    for (const ev of events) appendSituation(db, ev, clock);
    opts.beforeCommit?.();
    db.query(
      `INSERT INTO capture_cursors (transcript_path, last_uuid, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (transcript_path) DO UPDATE SET last_uuid = excluded.last_uuid, updated_at = excluded.updated_at`,
    ).run(transcriptPath, lastUuid, now);
    result = { captured: events.length, cursor: lastUuid };
  });
  tx.immediate();
  return result;
}
