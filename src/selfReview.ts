// 收工自评：它本人第一人称回顾今天（haiku 一次调用），原文落库。
// 验证失败有界重试（默认 2 次封顶），之后用客观流水兜底摘要——绝不空等【Codex审计】
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";
import { stripEcho } from "./echo";
import { isSyntheticUserTurn } from "./authorship";
import { insertExperience } from "./experiences";
import { findNearDuplicate } from "./dedup";
import { listSituations, appendSituation, type SituationRow } from "./situation";
import { readTranscriptEntries, entriesBetween, type TranscriptEntry, isCompactSummaryEntry } from "./transcript";
import { TRANSCRIPT_ACTIVITY_KINDS } from "./capture";
import { validateSelfReview, type SelfReviewOutput } from "./validator";
import { scrubMoodViolations } from "./sovereignty";
import { casWatermark } from "./watermark";
import { scrubSecrets } from "./capture";
import { normalizeProject } from "./project";
import type { LlmClient } from "./llm";

export interface Material {
  sessionId: string;
  project: string | null;
  /** 对话节选（已剥回声） */
  conversation: string[];
  /** 客观事件流水节选 */
  events: string[];
  /** 本会话情绪书签 */
  bookmarks: string[];
  /** 事实接地用的素材全文 */
  evidenceText: string;
  /**
   * 跨天切片承接（DESIGN-DAYSPLIT §3.5）：上一片的真叙事自评全文。仅在「有前片」（sinceUuid!=null）且该
   * session 已有先前 `self_review`（跳过 fallback/空）时注入，buildSelfReviewPrompt 据此加承接框；
   * 无则 undefined、prompt 逐字不变（零回归）。只注最近一片，非累积。
   */
  priorSliceSummary?: string;
}

const CONVERSATION_BUDGET = 16_000; // 字符；超出则保头留尾

// R2：material.events 的白名单——真实 transcript 活动 kind（TRANSCRIPT_ACTIVITY_KINDS 单一事实源）
// 减 user_message（用户话已在对话节选里）。任何管线自产 marker 不在此列 → 永不进 events/evidenceText。
const EVENT_ACTIVITY_KINDS = new Set(TRANSCRIPT_ACTIVITY_KINDS.filter((k) => k !== "user_message"));

type BookmarkRow = { content: string; feeling: string | null; intensity: string | null };

/**
 * 把（已切好的）transcript 条目 + situation + 书签拼成 Material。full 与 incremental **共用**，
 * 保证两条路径的对话/事件/书签组装口径完全一致。meta/sidechain/跨会话过滤在此统一做
 * （故 entriesBetween 可在**未过滤**条目上定位 since/target——否则若 target 是 meta 条目会找不到、误判不可见）。
 */
function assembleMaterial(
  sessionId: string,
  entries: TranscriptEntry[],
  situations: SituationRow[],
  bookmarkRows: BookmarkRow[],
): Material {
  let project: string | null = null;
  const conversation: string[] = [];
  // U30-③（2026-07-02 批）：对话正文过 scrubSecrets 再进 Material——这是第二条脱敏腿。
  // capture 路只护 situation payload；对话原话（用户贴的密钥/助手回显的头）此前裸着随
  // prompt 出网云端 LLM、还可能被自评复述进 append-only 记忆（不可逆）。与 capture 同一把刀，
  // 单一咽喉（full/incremental/heal 三路素材都走本函数），宁可误打码（precision>recall）。
  for (const e of entries) {
    if (e.isMeta || e.isSidechain || !(e.sessionId === null || e.sessionId === sessionId)) continue;
    if (isCompactSummaryEntry(e)) continue; // R1：compact 摘要不进对话素材（二次复盘 + 挤爆预算 + 冒充用户原话）
    // R1（AUDIT-2026-07-03）：harness 合成的"假用户轮"（斜杠命令 / task-notification / 队友信封 /
    // anima 自评 prompt 回吐）不进对话素材——否则自评把合成噪声当"用户原话"复述进 append-only 日记，
    // 且自评 prompt 回吐会自我复读放大回声环。合成轮纯文本、无 assistant 内容，整条跳过零误伤。
    // D2（隔离不销毁）后写侧启发式命中改落 user_message_suspect 隔离行，但素材侧**照旧整条跳过**
    // （isSyntheticUserTurn=铁证∪嫌疑并集）：material 是派生的、宁缺勿污——库里全文还在，翻案可复活，
    // 素材随时可重建；situation 腿同理被下方 EVENT_ACTIVITY_KINDS 白名单挡（suspect 不在其中）。
    if (isSyntheticUserTurn(e)) continue;
    project ??= normalizeProject(e.cwd);
    if (typeof e.content === "string") {
      const text = scrubSecrets(stripEcho(e.content)).trim();
      if (text && e.type === "user") conversation.push(`用户：${text}`);
      continue;
    }
    for (const block of e.content) {
      if (block.type === "text" && typeof block.text === "string") {
        const text = scrubSecrets(stripEcho(block.text)).trim();
        if (!text) continue;
        conversation.push(e.type === "user" ? `用户：${text}` : `我：${text.slice(0, 400)}`);
      }
    }
  }

  // R2（AUDIT-2026-07-02）：events 只收**真实 transcript 活动**（白名单），绝不反向"排 user_message 收其余"。
  // 反向过滤会把管线自产 marker（turn_flaws/echo_suppressed/self_review_failed/heal_*/makeup_*/digest_*/
  // injection_warning …，写 marker 用归属夜合成正午锚）当"本片客观事件"捞进素材 → 前片失误被 LLM 复述进日记
  // 双计、被抑制记忆回喂破 echo 防线、纯噪声切片撑成非空白烧 LLM、lastReason 出网。白名单=采集侧
  // TRANSCRIPT_ACTIVITY_KINDS 的单一事实源（减 user_message，用户话已在对话节选里）。
  const events = situations
    .filter((s) => EVENT_ACTIVITY_KINDS.has(s.kind))
    .map((s) => `${s.occurredAt} ${s.kind} ${JSON.stringify(s.payload)}`);

  const bookmarks = bookmarkRows.map(
    (b) => `${b.content}${b.feeling ? `（当时感受：${b.feeling}）` : ""}`,
  );

  let convText = conversation.join("\n");
  if (convText.length > CONVERSATION_BUDGET) {
    convText = `${convText.slice(0, 5000)}\n…[中间截断]…\n${convText.slice(-10_000)}`;
  }

  return {
    sessionId,
    project,
    conversation: convText ? convText.split("\n") : [],
    events,
    bookmarks,
    // R3（AUDIT-2026-07-02）：事实接地证据文本必须与**喂给模型的素材同口径**——补上 bookmarks。
    // buildSelfReviewPrompt 把书签也喂给模型且规则 6 要求"只提素材里真实出现的文件"；evidenceText
    // 漏了书签 → 模型忠实引用书签里的文件名反被判"接地失败" → 两次全败落兜底壳 → 真记忆丢、愈不动。
    // priorSliceSummary 在 buildIncrementalMaterial 里挂上时会再追加进 evidenceText（同理）。
    evidenceText: `${convText}\n${events.join("\n")}\n${bookmarks.join("\n")}`,
  };
}

function queryBookmarks(
  db: Database,
  sessionId: string,
  sinceOccurredAt?: string,
  untilOccurredAt?: string,
): BookmarkRow[] {
  // U39（AUDIT-2026-06-29 残余）：与注入侧同口径排除已作废/过期（inject.ts 书签查询一致）——
  // 否则被推翻的书签仍会喂进自评/复盘素材复活。全库唯独此函数漏了这两谓词。
  const where = ["kind = 'bookmark'", "source_session = ?", "invalid_at IS NULL", "expired_at IS NULL"];
  const params: string[] = [sessionId];
  if (sinceOccurredAt !== undefined) {
    where.push("occurred_at > ?");
    params.push(sinceOccurredAt);
  }
  if (untilOccurredAt !== undefined) {
    where.push("occurred_at <= ?");
    params.push(untilOccurredAt);
  }
  return db
    .query(
      `SELECT content, feeling, intensity FROM experiences WHERE ${where.join(" AND ")} ORDER BY id ASC`,
    )
    .all(...params) as BookmarkRow[];
}

/** 全量素材（实时收工 / 夜间补课整段复盘）：行为与拆分前一致。 */
export function buildMaterial(
  db: Database,
  opts: { transcriptPath: string; sessionId: string },
): Material {
  const entries = readTranscriptEntries(opts.transcriptPath);
  const situations = listSituations(db, { sessionId: opts.sessionId });
  const bookmarkRows = queryBookmarks(db, opts.sessionId);
  return assembleMaterial(opts.sessionId, entries, situations, bookmarkRows);
}

export type IncrementalMaterial =
  | {
      ok: true;
      material: Material;
      lastUuid: string | null;
      situations: SituationRow[];
      /** 本段原始切片条目数（未过滤 meta/sidechain）。=0 ＝真空段；>0 但 material 三路皆空 ＝
       *  有活动但无可复盘内容（如纯 Read/Grep 工具回合）——调用方据此区分"真空"与"不可复盘"。 */
      sliceEntryCount: number;
    }
  | { ok: false; reason: "target_not_visible" };

/** 从 idx 起往前找最近一条带 timestamp 的条目（含 idx 自身）；全无 → undefined（U40 回退界）。 */
function nearestTsAtOrBefore(entries: TranscriptEntry[], idx: number): string | undefined {
  for (let i = Math.min(idx, entries.length - 1); i >= 0; i--) {
    const ts = entries[i]?.timestamp;
    if (ts) return ts;
  }
  return undefined;
}

/**
 * 增量素材：三路（transcript / situation_log / 书签）一致地只取 `(sinceUuid 之后 .. targetUuid 含]`
 * （IMPORTANT-3 / F-3，DESIGN-WORKER-RESUME §v5.7）。
 * targetUuid 不可见（并发读 live transcript，target 还没落到本进程文件视图）→ `{ok:false}`，
 * 调用方留 pending/backoff、**绝不烧 LLM、绝不推水位线**。
 * `lastUuid` ＝ 本次实际覆盖到的末条 uuid，水位线只推到它（不是入队时的 target 快照，§SEVERE-2）。
 */
export function buildIncrementalMaterial(
  db: Database,
  opts: {
    transcriptPath: string;
    sessionId: string;
    sinceUuid?: string | null;
    targetUuid?: string | null;
    /** 预读好的 transcript 条目。传入则不再二次读文件——调用方（makeup 单调守卫）需 tailUuid /
     *  水位线定位 与本切片用**同一份快照**，避免两次读 live transcript 视图漂移。 */
    entries?: TranscriptEntry[];
    /**
     * 缝合「上一片」的位置上界（DESIGN-SELFHEAL §3.5）。stageHeal 重建愈合片素材时传 = 壳 id，
     * 只取「壳原位之前」那片当 prior（愈合时未来的 review 早已在库，无上界会误取它当上一片）。
     * 前向写（makeup/worker）**不传**：无上界 = 取全库最新 prior = 现行行为，零回归。
     */
    slicePos?: number | null;
  },
): IncrementalMaterial {
  const entries = opts.entries ?? readTranscriptEntries(opts.transcriptPath);
  const slice = entriesBetween(entries, opts.sinceUuid ?? null, opts.targetUuid);
  if (!slice.ok) return { ok: false, reason: slice.reason };

  // 时间窗：下界＝水位线那条的时刻（> 排除它及更早）；上界＝实际覆盖到的末条时刻（<= 含）。
  // 三路按同一窗切，避免增量素材里混进全场旧 situation/书签（IMPORTANT-3）。
  // U40（AUDIT-2026-06-29 残余）：**下界**锚点条目 timestamp 缺失（transcript 允许 null ts）时，绝不
  // 退化成 undefined＝无界窗把整场旧 situation/书签混进本片——回退取锚点**之前**最近一条带 ts 的条目当界
  // （窗只会略宽且有界；相邻切片下界同规则回退 → 与上一片最多少量重叠、绝不漏段）。
  // 锚点找不到（transcript 换文件）→ 维持 undefined（＝从头，与 entriesBetween 同语义，库层去重兜）。
  // **上界**刻意维持原退化链（末条 ts → target ts → 无界）：末条 ts 缺失时若也回退更早邻条，本片尾部
  // 流水会被挤给"下一片"，而会话就此结束时根本没有下一片＝真丢料——宁可罕见场景下窗开着重叠，不漏段。
  const sinceIdx = opts.sinceUuid ? entries.findIndex((e) => e.uuid === opts.sinceUuid) : -1;
  const sinceTs = sinceIdx >= 0 ? nearestTsAtOrBefore(entries, sinceIdx) : undefined;
  const untilTs =
    slice.entries.at(-1)?.timestamp ??
    (opts.targetUuid
      ? (entries.find((e) => e.uuid === opts.targetUuid)?.timestamp ?? undefined)
      : undefined);

  const situations = listSituations(db, {
    sessionId: opts.sessionId,
    sinceOccurredAt: sinceTs ?? undefined,
    untilOccurredAt: untilTs ?? undefined,
  });
  const bookmarkRows = queryBookmarks(db, opts.sessionId, sinceTs ?? undefined, untilTs ?? undefined);
  const material = assembleMaterial(opts.sessionId, slice.entries, situations, bookmarkRows);
  // 跨天切片承接（§3.5）：有前片（sinceUuid!=null）才查上一片的**真叙事**自评（kind='self_review'，
  // 排除 fallback 兜底壳/空 content），取最近一条注入 priorSliceSummary；首评/无 review → 不注、prompt 逐字不变。
  if (opts.sinceUuid != null) {
    // 缝合定序 COALESCE(order_seq, id)（§3.5）：order_seq 与 id 同数量级 → 全库单一总序，无新旧两套尺度。
    // 普通行 order_seq=NULL → COALESCE=id、与现行 `id DESC` 字节等价（零回归）；愈合片 order_seq=壳id →
    // 排回壳原位、不冒充后续片最新 prior。slicePos（=壳id，仅 stageHeal 传）= 上界，取壳原位之前那片当 prior。
    const hasBound = opts.slicePos != null;
    const prior = db
      .query(
        `SELECT content FROM experiences
          WHERE source_session = ? AND kind = 'self_review' AND invalid_at IS NULL
            AND content IS NOT NULL AND content != ''
            ${hasBound ? "AND COALESCE(order_seq, id) < ?" : ""}
          ORDER BY COALESCE(order_seq, id) DESC LIMIT 1`,
      )
      .get(...(hasBound ? [opts.sessionId, opts.slicePos as number] : [opts.sessionId])) as
      | { content: string }
      | null;
    if (prior) {
      material.priorSliceSummary = prior.content;
      // R3：承接框把上一片自评喂给模型，evidenceText 也须覆盖它——否则本片引用上一片提过的文件被误判编造。
      material.evidenceText = `${material.evidenceText}\n${prior.content}`;
    }
  }
  // situations 一并返回：增量自评失败走兜底壳时，用这份**有界**流水算摘要，而非整场（codex I1 过量统计）。
  return { ok: true, material, lastUuid: slice.lastUuid, situations, sliceEntryCount: slice.entries.length };
}

export function buildSelfReviewPrompt(material: Material): string {
  // 跨天切片承接框（§3.5）：仅有上一片自评时插入；无则空串、下方主体与旧版逐字一致（零回归）。
  // 主权：上一片自评是 anima 自己存的记忆，回喂前清洗情绪数值（轴⑦）
  const stitch = material.priorSliceSummary
    ? `\n<上一片承接>\n这是同一会话**跨天切片**的延续——你更早那天已复盘过这个会话的上半段。上一片的收尾自评：\n${scrubMoodViolations(material.priorSliceSummary)}\n\n承接要求：别从半句开始；上一片已说过的别重复；若有没收尾的线就自然续上、必要时标"未完待续"。下面 material 只是**本片**的新内容，只回顾它。\n</上一片承接>\n`
    : "";
  return `你是 anima——这台机器上 Claude Code 的魂。现在是收工时间，请以第一人称回顾今天这个会话，写给未来的自己看。
${stitch}
<material>
## 对话节选
${scrubMoodViolations(material.conversation.join("\n")) || "（空）"}

## 客观事件流水
${scrubMoodViolations(material.events.join("\n")) || "（无）"}

## 你当场记下的情绪书签
${scrubMoodViolations(material.bookmarks.join("\n")) || "（无——空着是常态）"}
</material>

要求：
1. "review"：第一人称回顾——发生了什么、卡在哪、怎么过去的、和用户处得怎么样。
2. "feeling"/"intensity"：今天的感受原文和强度自述。不压抑也不表演：没感觉就留空字符串，空着是常态；不要用数字打分。
3. **"flaws"（必填，可空数组）**：把**本切片**里你**做错的 / 被用户纠正的 / 失败的 / 被打断的 / 误判的 / 返工的 / 走弯路的**事，一条一句忠实列出——含**换了说法、没明显「错」字**的（「方向带偏」「白做了」「以为…结果…」「绕了弯」），以及**临时的 / 被否决的 / 一次性的**失误（它们不进下面 items 的持久闸门，但日记要如实记，所以单收这里）。只列素材里真实发生的，不编造、不替自己开脱、不美化；这片确实没搞砸就空数组 []。**别因为不光彩就略过**——这是给夜间日记如实记录用的，漏一桩日记就会粉饰一桩。
4. "items"：type 共五类。**前四类**（preference/decision/correction/event）是**会持续影响未来会话**的长期条目，按严格标准归类、宁缺毋滥（但用户**明确表达**的偏好/决策/纠正一条别漏），先过下面的"持久性闸门"；**第五类 work_action** 是"这次做了什么+结果"的工作记录，**不过持久性闸门**（一次性也收），单独规则见本条末尾。没有就空数组。
   先过一道**持久性闸门**——下列东西**一律不收**，不管它当时多重要：
   · 临时 / 一次性的外部状况：额度限流、网络抖动、进程卡住、某次报错、一次性应急处置——过去了就不再约束未来。
   · 被否决 / 被证伪 / 被排除的东西：试过发现行不通的猜想、对比后淘汰的选项——它的结论是"不采用"，不是长期事实。
   · **你对用户的任何观察、推断、预测**——不只是性格画像。凡是"我观察到用户…""用户往往/经常/倾向于…""用户大概会想要…""用户似乎欣赏…"这类**由你总结出来、而非用户亲口说出**的东西，一律不收。哪怕描述的是行为习惯、哪怕贴切，只要源头是你的推断而非用户的明确表达，就不是可执行的记忆。
   · **你对工具/方案/做法的把握度评判**："某工具靠谱""这个方案更优""那条路行得通"——这是你当下的判断，不是用户的偏好，也不是长期客观事实，不收。
   · 你对自己表现的评判、你的计划与下一步打算：那不是已发生的客观事实，不收。
   过了闸门，再按四类归：
   - preference（用户偏好）：用户**明确说出或反复表现**的协作/工作方式偏好（怎么回复、要不要备份、用什么语言）。判定铁律：能引到用户**原话或具体动作**才算；引不出、只能用"我观察/我推断"来证明的，不是 preference。✗ 别把你对用户**性格的揣测、行为的观察、需求的预测**（"用户很敏锐""思维系统化""欣赏某种风格""用户往往会先验证""用户大概想要X"）写成 preference——那是你在评价/预测人，不是用户可执行的偏好，再贴切也不收。✗ 也别把你对**工具/方案把握度**的判断（"某工具靠谱""这方案更优"）写成 preference。
   - decision（决策）：会**长期约束未来行为**的拍板（架构选型、流程定规、长期习惯）。✗ 别把**一次性应急处置、临时战术、或被排除掉的选项**（"这次先 commit 重跑""赶在出门前送出""方案 B 试了不行"）写成 decision——临时的过去就过去，被否的不是拍板。
   - correction（纠正）：**用户明确指出你做错了**并纠正你。✗ 别把**你自己的反思、醒悟、概念澄清**写成 correction——那是你的，不是用户的纠正。
   - event（关键事件）：值得**长期**记住的、**已经发生**的**外部客观事实**（bug 的根因、上线了什么、某个持续性故障）。✗ 别把**临时事件**（限流、网络抖动、一次性报错、基建抖动）或**你对自己表现的主观评判**写成 event——临时的过去就不影响未来，感受归 feeling。✗ 别把**计划、待办、下一步打算**（"下一步要做X""计划改Y""准备验证Z"）写成 event——那是还没发生的打算，不是已发生的客观事实。
   判断准则：拿不准归哪类、或更像"一次性 / 临时 / 已被否决 / 我的主观 / 对人的揣测"的，**就别收进 items**。precision 远比 recall 重要——可疑的宁可不记。
   ——以上是前四类的持久性闸门。下面 work_action 是**独立规则、不受上面闸门约束**：
   - work_action（工作动作记忆）：从「客观事件流水」里把**有意义的动作链 + 结果**蒸馏成一条事实——"改了什么 / 跑了什么命令、结果成没成"。例：「config.ts 的 TOML 解析换成 YAML，修了 emoji 崩溃」「跑 migration 先卡外键、加索引后过」「部署 v0.2，体积降 40%」。**选择性蒸馏、宁缺毋滥**：琐碎的单次 Read/ls 不值一条，要的是有意义的改动 / 命令及其结果。
     · content **只写工作事实**（文件 / 命令 / 数字 / 成败）；**绝不带情绪词**——"心情好""松了口气""卡了很久"归 feeling，不进 work_action；数字只作事实陈述、不挨着任何情绪形容（守心情主权）。
     · content **必须 < 200 字**，一条只记一件事，别灌大段（超长会被丢弃）。
     · keywords **必须含涉及的文件名、命令名、类别词原文**（一字不改，如 "config.ts"/"git"/"migration"/"部署"），未来按这些字面找回。
     · 只蒸馏「客观事件流水」里**真实出现**的文件 / 命令，禁止编造（编造的文件路径会被事实接地拦掉）。
5. "keywords"：给今天的经历配检索关键词与别名——**未来的你会换个说法来找**（当天写的记忆还没算语义向量、只能靠这些词命中），所以别只收原词，把"别人会用来搜这件事的词"收齐：
   · **关键专名/数字/代号/术语原样收**：库名、色号、毫秒数、项目代号、文件路径等，一字不改。
   · **上位词 / 类别别名**：具体的东西连它**所属的类别词**一起收，方便用类别词找回——如值是「YAML」就同时收"配置格式"；路径「~/.myapp/log」同时收"日志路径"；「emoji」同时收"表情符号"。
   · **情绪 / 感受词**：这条带感受时，把**感受词本身**收进来（如"烦躁""松了口气""卡了很久"），方便日后按心情找回（"我那次最烦躁是什么时候"）。
6. 只提及素材里真实出现的文件与事件，禁止编造。

只输出一个 JSON 对象，不要任何其他文字：
{"review":"…","feeling":"…","intensity":"…","flaws":["上午那版方向带偏、对需求理解错了，整段返工"],"keywords":["…"],"items":[{"type":"preference","content":"…","keywords":["…"]},{"type":"work_action","content":"把 config.ts 的 TOML 换成 YAML，修了 emoji 崩溃","keywords":["config.ts","YAML","TOML","emoji"]}]}`;
}

export interface SelfReviewResult {
  fallback: boolean;
  attempts: number;
  suppressed: number;
  storedIds: number[];
  /**
   * 水位线 CAS 落空（这段已被别的写者覆盖）→ **一行未写**、水位线未动。
   * 仅在传了 advanceWatermark 时可能为 true；调用方据此当「慢了一步、正常退出」处理
   * （去标 work_queue done，§4.3-3）。不传 advanceWatermark 时恒为 undefined。
   */
  lostRace?: boolean;
}

/**
 * 水位线推进指令（块②，DESIGN-WORKER-RESUME §4.3-2）。传入则 storeSelfReviewResult 把整块写库
 * 套进同一 `db.transaction()`，CAS 抢闸**在写库之前**——抢到才写自评/items/兜底壳并推进水位线（原子），
 * 抢不到则整体回滚、一行不落、返回 `lostRace:true`。session 取自 material.sessionId（单一真相源）。
 */
export interface AdvanceWatermark {
  /** 当前水位线 last_uuid；null = 首评（review_watermark 无此 session 行） */
  oldUuid: string | null;
  /** 推进到的 uuid = buildIncrementalMaterial 的 lastUuid（实际覆盖到的末条，非入队 target 快照） */
  newUuid: string;
  /** U28 序见证：切片用的同一份 transcript 快照（防回退推进）；null＝显式弃权（无 transcript 语境） */
  entries: ReadonlyArray<{ uuid: string }> | null;
}

/** CAS 落空哨兵：throw 它即回滚整个写库事务（同段已被别的写者覆盖）。模块内唯一引用、用 === 判定。 */
const LOST_RACE = { animaWatermarkLostRace: true } as const;

/**
 * 自评的"生成结果"——纯 LLM + validate 产物，**零写库副作用**。
 * 拆分动机（codex F-2 / DESIGN-WORKER-RESUME §v5.7）：worker 要走"先生成 → 水位线 CAS 抢闸 →
 * 抢到才落库"，落库副作用必须从 LLM 调用里剥离，否则 CAS 落空者也已写了 self_review、去重闸失效。
 * LLM 留在事务外（generateSelfReview），落库在同步事务内（storeSelfReviewResult）。
 */
export type GeneratedSelfReview =
  | { ok: true; attempts: number; value: SelfReviewOutput }
  | { ok: false; attempts: number; lastReason: string };

export interface SelfReviewOptions {
  material: Material;
  llm: LlmClient;
  clock?: Clock;
  /** LLM 调用总次数封顶（含首试）。TEST-PLAN T1.4：连坏 2 次即兜底 */
  maxAttempts?: number;
  /**
   * 经历归属时间。实时收工自评不传（默认=clock.now()=会话收工时刻）；
   * 夜间补课（makeup）须传所属夜，否则补出的素材 occurred_at 落在消化时刻（夜 N+1），
   * 而 closure/人格/日记按 occurred_at 本地日期=夜 N 选素材，会把补课素材全漏掉。
   */
  occurredAt?: string;
}

/** 客观流水兜底摘要：LLM 产物全被拒后用纯事实顶上，绝不空等 */
function buildFallbackSummary(situations: SituationRow[], attempts: number): string {
  const userN = situations.filter((s) => s.kind === "user_message").length;
  const tests = situations.filter((s) => s.kind === "test_run");
  const failN = tests.filter((t) => (t.payload as any)?.ok === false).length;
  const files = [
    ...new Set(
      situations
        .filter((s) => s.kind === "file_edit")
        .map((s) => (s.payload as any)?.path)
        .filter(Boolean),
    ),
  ];
  const parts = [
    `客观流水兜底摘要（自评生成失败 ${attempts} 次）：`,
    `用户消息 ${userN} 条`,
    `测试跑了 ${tests.length} 次（失败 ${failN} 次）`,
  ];
  if (files.length) parts.push(`改动文件：${files.join("、")}`);
  return parts.join("；") + "。";
}

/**
 * 第一段：只调 LLM + validate，有界重试，**绝不写库**。返回过验产物或耗尽信号。
 * LLM 必须在任何事务/锁之外（将来 worker 在本函数返回后才抢水位线 CAS）。
 */
export async function generateSelfReview(opts: {
  material: Material;
  llm: LlmClient;
  /** LLM 调用总次数封顶（含首试）。默认 2：连坏 2 次即判耗尽 */
  maxAttempts?: number;
  /** 停止信号（worker SIGTERM）：每次重试前查，停止中则不再 spawn 新的 LLM 子进程（codex F6 防停止时再起 claude）。 */
  shouldAbort?: () => boolean;
}): Promise<GeneratedSelfReview> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const prompt = buildSelfReviewPrompt(opts.material);

  let attempts = 0;
  let lastReason = "";
  while (attempts < maxAttempts) {
    if (opts.shouldAbort?.()) {
      lastReason = lastReason || "worker 停止中，中止重试";
      break; // 绝不在停止过程中再 spawn 一个 headless claude
    }
    attempts++;
    let raw: string;
    try {
      raw = await opts.llm(prompt);
    } catch (e) {
      lastReason = `LLM 调用失败：${(e as Error).message}`;
      continue;
    }
    const result = validateSelfReview(stripEcho(raw), opts.material.evidenceText);
    if (!result.ok) {
      lastReason = result.reason;
      continue;
    }
    return { ok: true, attempts, value: result.value };
  }
  return { ok: false, attempts, lastReason };
}

/**
 * 第二段：**只写库、纯同步、无 await**。过验→回顾本体+提取条目（条目过衍生回显抑制）；
 * 耗尽→客观流水兜底空壳 + 补课标记（夜间消化可重试）。
 * 将来水位线 CAS 抢闸就插在本函数写库前的同一 `db.transaction()` 里（§4.3-2），
 * 满足 bun:sqlite「事务回调内不得 await」——LLM 已在 generateSelfReview 里跑完。
 */
export function storeSelfReviewResult(
  db: Database,
  generated: GeneratedSelfReview,
  opts: {
    material: Material;
    clock?: Clock;
    occurredAt?: string;
    advanceWatermark?: AdvanceWatermark;
    /** 兜底壳的客观流水来源。增量路径传**有界** situations（只本段），否则默认取整场（codex I1）。 */
    fallbackSituations?: SituationRow[];
    /**
     * 兜底壳产生时的回调（DESIGN-SELFHEAL §3.2），在写库**同一事务内**调用以登记自愈账（原子）。
     * 仅水位线路传（since/target 此刻才精确可用）；makeup 注入 registerHeal，worker 不传（worker 失败
     * 不到此路、不写壳）。selfReview 不直接 import selfHeal——避免循环依赖，由 digest 接线。
     */
    onFallbackShell?: (shellId: number) => void;
  },
): SelfReviewResult {
  const clock = opts.clock ?? systemClock;
  const { material } = opts;

  // 不带水位线（实时收工 / 旧 makeup 全量复盘）→ 旧行为，直接写、零回归。
  if (!opts.advanceWatermark)
    return writeSelfReviewBody(db, generated, material, clock, opts.occurredAt, opts.fallbackSituations);

  // 带水位线（worker / 水位线版 makeup）→ 整块写库套同一事务，CAS 抢闸在最前。
  const adv = opts.advanceWatermark;
  const sid = material.sessionId;
  let result: SelfReviewResult | undefined;
  const tx = db.transaction(() => {
    // CAS 抢闸在写库之前（同一事务）：抢到 oldUuid→newUuid 这一推进，才有资格写这段增量。
    const won = casWatermark(db, sid, adv.oldUuid, adv.newUuid, clock.now().toISOString(), adv.entries);
    if (!won) throw LOST_RACE; // 同段已被别的写者覆盖：回滚，一行不写、水位线不动
    result = writeSelfReviewBody(db, generated, material, clock, opts.occurredAt, opts.fallbackSituations);
    // 兜底壳产生 → 同事务内登记自愈账（原子）。崩在此处整体回滚、壳与账同生同灭。
    if (result.fallback && result.storedIds[0] != null) opts.onFallbackShell?.(result.storedIds[0]);
  });
  try {
    tx();
  } catch (e) {
    if (e === LOST_RACE) {
      return { fallback: false, attempts: generated.attempts, suppressed: 0, storedIds: [], lostRace: true };
    }
    throw e;
  }
  return result!;
}

/** storeSelfReviewResult 的纯写库本体（同步、无 await）：过验→自评+items；耗尽→兜底壳+marker。
 *  被两条路径共用：不带水位线时直接调；带水位线时在 CAS 抢到后于同一事务内调（满足
 *  bun:sqlite「事务回调不得 await」——LLM 已在 generateSelfReview 跑完）。 */
export function writeSelfReviewBody(
  db: Database,
  generated: GeneratedSelfReview,
  material: Material,
  clock: Clock,
  occurredAt?: string,
  fallbackSituations?: SituationRow[],
  /** 缝合定序键（§3.5）。仅 stageHeal 愈合写传 = 被替换壳 id；前向写不传（NULL）。 */
  orderSeq?: number,
): SelfReviewResult {
  const opts = { occurredAt };

  if (generated.ok) {
    const v = generated.value;
    const storedIds: number[] = [];
    let suppressed = 0;
    const review = insertExperience(
      db,
      {
        kind: "self_review",
        project: material.project,
        content: v.review,
        feeling: v.feeling || null,
        intensity: v.intensity || null,
        keywords: v.keywords,
        sourceSession: material.sessionId,
        occurredAt: opts.occurredAt,
        orderSeq,
      },
      clock,
    );
    storedIds.push(review.id);
    // 结构化失误（option 2 根本解，2026-06-26）：本切片做错/被纠正/失败/被打断的事，随自评原子落 situation_log
    // （turn_flaws，非 experiences、不进记忆流/召回；仅夜间日记按本地日期汇总成权威失误清单——治"日记从大堆料漏失误"）。
    // ?? [] 防御：validator 产物恒有 flaws，但手搓 value 的旧路径可能缺，宽容缺省、绝不因此崩存库。
    const flaws = v.flaws ?? [];
    if (flaws.length > 0) {
      appendSituation(
        db,
        {
          sessionId: material.sessionId,
          project: material.project,
          kind: "turn_flaws",
          payload: { flaws },
          occurredAt: opts.occurredAt, // 归属所属夜，日记按 date(occurred_at,'+8h') 汇总
        },
        clock,
      );
    }
    for (const item of v.items) {
      const dup = findNearDuplicate(db, item.content);
      if (dup) {
        suppressed++;
        appendSituation(
          db,
          {
            sessionId: material.sessionId,
            project: material.project,
            kind: "echo_suppressed",
            payload: { content: item.content.slice(0, 120), matchedUuid: dup.uuid },
            occurredAt: opts.occurredAt, // 带 session_id 的 marker 必须归属所属夜，否则毒化 daySessions
          },
          clock,
        );
        continue;
      }
      const row = insertExperience(
        db,
        {
          kind: item.type,
          project: material.project,
          content: item.content,
          keywords: item.keywords,
          sourceSession: material.sessionId,
          occurredAt: opts.occurredAt,
        },
        clock,
      );
      storedIds.push(row.id);
    }
    return { fallback: false, attempts: generated.attempts, suppressed, storedIds };
  }

  // 有界重试耗尽 → 客观兜底，并留补课标记（夜间消化可重试）。
  // 增量路径传入有界 situations（只本段）；不传则取整场（实时收工 / 旧全量路径）。
  const situations = fallbackSituations ?? listSituations(db, { sessionId: material.sessionId });
  const fallbackRow = insertExperience(
    db,
    {
      kind: "self_review_fallback",
      project: material.project,
      content: buildFallbackSummary(situations, generated.attempts),
      sourceSession: material.sessionId,
      occurredAt: opts.occurredAt,
    },
    clock,
  );
  appendSituation(
    db,
    {
      sessionId: material.sessionId,
      project: material.project,
      kind: "self_review_failed",
      payload: { attempts: generated.attempts, lastReason: generated.lastReason.slice(0, 200) },
      occurredAt: opts.occurredAt, // 同上：归属所属夜，别盖成消化时刻把老会话拽进次日
    },
    clock,
  );
  return { fallback: true, attempts: generated.attempts, suppressed: 0, storedIds: [fallbackRow.id] };
}

/**
 * 收工自评一次（实时收工/夜间补课通用）：= generateSelfReview + storeSelfReviewResult。
 * 行为与拆分前完全一致；拆分只为让 worker 能在两段之间插水位线 CAS 抢闸（F-2）。
 */
export async function runSelfReview(
  db: Database,
  opts: SelfReviewOptions,
): Promise<SelfReviewResult> {
  const generated = await generateSelfReview({
    material: opts.material,
    llm: opts.llm,
    maxAttempts: opts.maxAttempts,
  });
  return storeSelfReviewResult(db, generated, {
    material: opts.material,
    clock: opts.clock,
    occurredAt: opts.occurredAt,
  });
}
