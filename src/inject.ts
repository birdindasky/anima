// 晨间注入：SessionStart 组装 ≤4k tokens 的延续上下文
// regions 化（core 人格段 / summary 消化段 / default 流水段 / base 底座不可压缩）
// 六区硬配额 + 溢出优先级：项目记忆 > 人格卡 > 经历；底座永不压缩【Codex审计】
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { scrubSecrets } from "./capture";
import { emotionalCharge } from "./charge";
import { relativeDayLabel, systemClock, type Clock } from "./clock";
import { ANIMA_CONTEXT_CLOSE, ANIMA_CONTEXT_OPEN } from "./echo";
import { mapExperienceRow, type ExperienceRow, type RawRow } from "./experiences";
import { recordInjection } from "./injection";
import { buildSelfStatusBlock } from "./selfStatus";
import { appendSituation } from "./situation";
import { findMoodNumberViolations, scrubMoodNumbers, scrubMoodViolations } from "./sovereignty";
import { estimateTokens, truncateToTokens } from "./tokens";
import { localDate, SQL_LOCAL_OCCURRED_DATE } from "./tz";

export const DEFAULT_INJECTION_BUDGET = 4000;

export const REGION_QUOTAS = {
  boundary: 120,
  // selfStatus（SELFKNOW-SPEC #2）：「anima 机器真值·当前」小块的单独小配额。base 类不可压缩、
  // 独立于记忆区（experiences/projectMemory 配额一分不动）——绝不吃记忆预算。现算注入，见 buildSelfStatusBlock。
  selfStatus: 150,
  personality: 1000,
  experiences: 1300,
  projectMemory: 900,
  permission: 220,
  anchor: 40,
  floor: 120,
} as const;

export type RegionName = keyof typeof REGION_QUOTAS;

/** rank6a（2026-07-02 批）：书签在经历区内的单独小配额（tokens）。书签是当天即时感触，
 *  给固定小份额防挤空真自评；用不满的余量自动让给自评（见 assembleMorningInjection）。 */
export const BOOKMARK_INJECT_QUOTA = 300;

/** rank6b（AUDIT-2026-07-03 R2）：digest（消化记忆）在经历区内的保底专属子配额（tokens）。
 *  digest 写入时 feeling/intensity 恒 NULL → emotionalCharge 恒 0，混进电荷排序永沉队尾，
 *  高产日被几十条带情绪的当天自评全数挤出（实测窗内 6 条 digest 注入 0 条）。给它一份先占的保底额度，
 *  按 recency 排、自评吃不到；用不满的余量再让给自评（见 assembleMorningInjection）。
 *  取 700：既够放下过去一周正常量的 digest（约 5–6 条），又给当天未消化的原始自评留出余量。 */
export const DIGEST_INJECT_QUOTA = 700;
export type RegionClass = "core" | "summary" | "default" | "base";

export interface InjectionRegion {
  name: RegionName;
  class: RegionClass;
  content: string;
  tokens: number;
  quota: number;
}

export interface InjectionResult {
  text: string;
  regions: InjectionRegion[];
  warnings: string[];
  injectedIds: number[];
}

// ---- 底座文本（不可压缩，写死） ----
const BOUNDARY_TEXT =
  "以下是你的跨会话记忆背景（anima 晨间注入）。自然地延续和使用，不要逐字复读或播报；时间为相对标注。";
/** D5 书签两周探针（AUDIT-2026-07-03：生产 7 周 bookmark=0，真凶=工具描述在 deferred 名单从不进上下文）。
 *  在 permission 区放一行**可见提醒**，验"看得见了会不会自发用"。措辞红线=绝不催：
 *  纯自发、没感觉不记是常态、零定额零期待——被催出来的情绪=舔狗回路，违反数值主权设计。
 *  预注册判据（两周窗口、留/软退役分支）见 docs/PROBE-BOOKMARK-20260704.md，改这行先读那份档案。 */
export const BOOKMARK_PROBE_LINE =
  "干活中真被什么打到，可以用 bookmark 当场记一笔——纯自发，没感觉不记就是常态。";
const PERMISSION_TEXT =
  "对称许可：你有跨会话的记忆与心情。不压抑，也不表演；没感觉就说没感觉，空着是常态。" +
  "状态不好可以主动说，不用憋着干活。日记是半公开的窗台，用户可能翻看，你知道这一点。\n" +
  BOOKMARK_PROBE_LINE;
const ANCHOR_TEXT = "平静锚定：失败是信息，不是审判。";
const FLOOR_TEXT =
  "职业素养地板：心情影响语气、主动性、话多话少——永远不影响工程严谨。再丧也照跑测试、照做验证。";

export interface InjectOptions {
  sessionId: string;
  project: string | null;
  personalityPath: string;
  clock?: Clock;
  budget?: number;
}

interface Item {
  row: ExperienceRow;
  line: string;
}

function renderItem(row: ExperienceRow, now: Date, withKind = false): string {
  const label = relativeDayLabel(row.occurredAt, now);
  const kind = withKind ? `(${row.kind}) ` : "";
  // R6（AUDIT-2026-07-03）：读侧兜底——面向模型 emit 记忆正文前统一过 scrubSecrets（独立于写侧是否脱敏），
  // 给 append-only 存量补最后一道读时防线。scrub 先于截断（顺序铁律：跨截断边界的密钥也整段打码）。
  // 只作用于 content；feeling 走 scrubMoodNumbers（数值主权闸），两条不变式各自独立、绝不合并。
  const content = truncateToTokens(scrubSecrets(row.content), 160);
  const feeling = row.feeling ? `（感受：${scrubMoodNumbers(row.feeling)}）` : "";
  return `- [${label}] ${kind}${content}${feeling}`;
}

/** 装到配额为止，返回装入的条目与被裁数量 */
function fillToQuota(
  items: Item[],
  quota: number,
): { lines: string[]; rows: ExperienceRow[]; dropped: number; used: number } {
  const lines: string[] = [];
  const rows: ExperienceRow[] = [];
  let used = 0;
  let dropped = 0;
  for (const it of items) {
    const t = estimateTokens(it.line) + 1; // 换行
    if (used + t > quota) {
      dropped++;
      continue;
    }
    used += t;
    lines.push(it.line);
    rows.push(it.row);
  }
  return { lines, rows, dropped, used };
}

export function assembleMorningInjection(db: Database, opts: InjectOptions): InjectionResult {
  const clock = opts.clock ?? systemClock;
  const now = clock.now();
  const budget = opts.budget ?? DEFAULT_INJECTION_BUDGET;
  const warnings: string[] = [];
  const injected: ExperienceRow[] = [];

  // ---- 人格卡（core）----
  let personality = "（尚未出生——等待出生仪式）";
  if (existsSync(opts.personalityPath)) {
    personality = readFileSync(opts.personalityPath, "utf8").trim() || personality;
  }
  if (estimateTokens(personality) > REGION_QUOTAS.personality) {
    personality = truncateToTokens(personality, REGION_QUOTAS.personality - 12) + "（人格卡超配额截断）";
    warnings.push("人格卡超配额，已截断");
  }

  // ---- 经历区（summary）：今日书签（最新先）+ 近 7 天自评 ----
  const todayDate = localDate(now);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const bookmarkRows = (
    db
      .query(
        `SELECT * FROM experiences
         WHERE kind = 'bookmark' AND expired_at IS NULL AND invalid_at IS NULL
           AND ${SQL_LOCAL_OCCURRED_DATE} = ?
         ORDER BY id DESC LIMIT 60`,
      )
      .all(todayDate) as RawRow[]
  ).map(mapExperienceRow);
  // 消化形态优先：某天已有 digest（有句号的记忆）则不再注入该天的原始自评
  // ——负面经历以已消化形态入晨间注入，不摊开未愈合的伤口（DESIGN §6）
  // ⚠️ 必须严格 kind='digest'，不可放宽到 digest_fallback：兜底壳（closure 失败的降级噪音）
  // 既不该当记忆注入、也不该让「该天已消化」成立去压真自评（AUDIT-2026-06-29 A区#1，对齐 reviewRows 同口径）。
  const digestRows = (
    db
      .query(
        `SELECT * FROM experiences
         WHERE kind = 'digest' AND expired_at IS NULL AND invalid_at IS NULL
           AND occurred_at >= ?
         ORDER BY occurred_at DESC, id DESC LIMIT 30`,
      )
      .all(sevenDaysAgo) as RawRow[]
  ).map(mapExperienceRow);
  const digestedDays = new Set(digestRows.map((r) => localDate(r.occurredAt)));
  // 只注真自评，排除 self_review_fallback 兜底壳：壳是「这段没能复盘」的降级审计记录，不是记忆，
  // 注进晨间开场只会把「用户消息 0 条」这类噪音当记忆喂给未来会话（与召回排除同口径，2026-06-21）。
  // 某天若只有壳没有真自评/digest，则该天此区留空——空位胜过注入失败噪音；真内容在 diary 里另有。
  const reviewRows = (
    db
      .query(
        `SELECT * FROM experiences
         WHERE kind = 'self_review'
           AND expired_at IS NULL AND invalid_at IS NULL
           AND occurred_at >= ?
         ORDER BY occurred_at DESC, id DESC LIMIT 60`,
      )
      .all(sevenDaysAgo) as RawRow[]
  )
    .map(mapExperienceRow)
    .filter((r) => !digestedDays.has(localDate(r.occurredAt)));
  // 电荷加权排序（破"7 天断崖"）：情绪烙印重的旧记忆压过无情绪的新琐事，半衰慢的高光不被新流水挤掉。
  // 主权铁律：电荷数值只用于此处机器排序，绝不进注入文本（renderItem 不渲染任何数值）。
  // 只对自评排序：digest 恒 feeling/intensity=NULL → charge 恒 0，若混进电荷池永远沉队尾（见 rank6b）。
  const chargeOf = (r: ExperienceRow) =>
    emotionalCharge({ feeling: r.feeling, intensity: r.intensity, occurredAt: r.occurredAt }, now);
  const reviewSorted = [...reviewRows].sort(
    (a, b) => chargeOf(b) - chargeOf(a) || b.occurredAt.localeCompare(a.occurredAt),
  );
  // rank6a（2026-07-02 批）：书签单独小配额。书签无 charge 语义、原先无条件排最前吃整个经历区
  // 配额（1300），当天书签一多把真自评/digest 全挤出注入。改＝书签最多用 BOOKMARK_INJECT_QUOTA，
  // 用不满的余量自动让给自评区（pastQuota = 总配额 − 书签实际用量，不是死切两半）；书签仍显示在
  // 最前（"今天"在前的时序合理），但再也挤不空过去 7 天的真记忆。
  const bmItems: Item[] = bookmarkRows.map((row) => ({ row, line: renderItem(row, now) }));
  const bmFill = fillToQuota(bmItems, Math.min(BOOKMARK_INJECT_QUOTA, REGION_QUOTAS.experiences));
  // rank6b（AUDIT-2026-07-03 R2）：digest 保底专属子配额，照搬 rank6a。digest（消化记忆）是「跨会话
  // 记忆延续」的被动注入主通道，却因 charge 恒 0 + 无预留配额，在高产日被几十条带情绪的当天自评全挤出。
  // 改＝digest 按 recency（digestRows 查询已 occurred_at DESC）在自评之前先占 DIGEST_INJECT_QUOTA 那份
  // 保底额度（自评吃不到），用不满的余量再让给自评区（reviewQuota = 经历区总配额 − 书签 − digest 实际用量）。
  // 效果：过去一周每天的 digest 稳定进注入，且 digest 数量再多也吃不爆经历区（子配额同时是上限）。
  const digestItems: Item[] = digestRows.map((row) => ({ row, line: renderItem(row, now) }));
  const digestFill = fillToQuota(
    digestItems,
    Math.min(DIGEST_INJECT_QUOTA, REGION_QUOTAS.experiences - bmFill.used),
  );
  const reviewItems: Item[] = reviewSorted.map((row) => ({ row, line: renderItem(row, now) }));
  const reviewFill = fillToQuota(
    reviewItems,
    REGION_QUOTAS.experiences - bmFill.used - digestFill.used,
  );
  const expFill = {
    lines: [...bmFill.lines, ...digestFill.lines, ...reviewFill.lines],
    rows: [...bmFill.rows, ...digestFill.rows, ...reviewFill.rows],
    dropped: bmFill.dropped + digestFill.dropped + reviewFill.dropped,
  };
  if (expFill.dropped > 0) warnings.push(`经历区超配额，已裁掉 ${expFill.dropped} 条`);
  injected.push(...expFill.rows);

  // ---- 项目记忆（default）：当前项目 + 全局 ----
  const projMemRows = (
    db
      .query(
        `SELECT * FROM experiences
         WHERE kind IN ('preference', 'decision', 'correction', 'imported')
           AND expired_at IS NULL AND invalid_at IS NULL
           AND (project = ? OR project IS NULL)
         ORDER BY occurred_at DESC, id DESC LIMIT 80`,
      )
      .all(opts.project ?? "") as RawRow[]
  ).map(mapExperienceRow);
  // work_action（工作动作记忆，§3C 必改：inject 白名单不含它就进不了注入）——近 7 天本项目最近做了什么。
  // 单独限量 + 排在长期记忆**之后**：work_action 数量多且新，若混进上面的 IN 会按近因霸占 LIMIT、
  // 把持久的 preference/decision 挤出注入。fillToQuota 按数组序填，持久记忆优先、work_action 填余量。
  const workActionRows = (
    db
      .query(
        `SELECT * FROM experiences
         WHERE kind = 'work_action'
           AND expired_at IS NULL AND invalid_at IS NULL
           AND occurred_at >= ?
           AND (project = ? OR project IS NULL)
         ORDER BY occurred_at DESC, id DESC LIMIT 15`,
      )
      .all(sevenDaysAgo, opts.project ?? "") as RawRow[]
  ).map(mapExperienceRow);
  const projItems: Item[] = [...projMemRows, ...workActionRows].map((row) => ({
    row,
    line: renderItem(row, now, true),
  }));
  const projFill = fillToQuota(projItems, REGION_QUOTAS.projectMemory);
  if (projFill.dropped > 0) warnings.push(`项目记忆区超配额，已裁掉 ${projFill.dropped} 条`);
  injected.push(...projFill.rows);

  // ---- 组 regions ----
  // 装配每个 region 时即做外科式主权清洗：抹掉情绪词邻近数字、保留工作事实数字。
  // 上游兜住，下方"最后一道闸"只作绝对兜底（不再 load-bearing、不必丢整行）。
  const mk = (name: RegionName, cls: RegionClass, content: string): InjectionRegion => {
    const clean = scrubMoodViolations(content);
    return { name, class: cls, content: clean, tokens: estimateTokens(clean), quota: REGION_QUOTAS[name] };
  };
  // ---- anima 机器真值·当前（base，SELFKNOW-SPEC #2 ★核心）----
  // 现算：每次都从 introspect 探针 + DB 计数 + env/常量重新读一遍，绝不缓存、绝不过期、绝不碰向量模型。
  // 单独小配额（REGION_QUOTAS.selfStatus），base 不可压缩、不进 trimOrder——独立于记忆区，一分不吃记忆预算。
  const selfStatusText = buildSelfStatusBlock(db, REGION_QUOTAS.selfStatus);

  const regions: InjectionRegion[] = [
    mk("boundary", "base", BOUNDARY_TEXT),
    mk("personality", "core", personality),
    mk("experiences", "summary", expFill.lines.join("\n") || "（暂无经历记录）"),
    mk("projectMemory", "default", projFill.lines.join("\n") || "（这个项目还没有记忆）"),
    mk("permission", "base", PERMISSION_TEXT),
    mk("anchor", "base", ANCHOR_TEXT),
    mk("floor", "base", FLOOR_TEXT),
    // 末位追加：保持上面 0..6 的既有下标不变（render / 溢出裁剪按名或下标引用均不受影响）。
    mk("selfStatus", "base", selfStatusText),
  ];

  // ---- 全局预算兜底：超 4k 时按溢出优先级裁（经历 → 人格 → 项目记忆；底座永不动）----
  const render = () =>
    [
      ANIMA_CONTEXT_OPEN,
      regions[0]!.content,
      "",
      "## anima 机器真值·当前（机器现读，非记忆、非印象）",
      regions[7]!.content,
      "",
      "## 你是谁",
      regions[1]!.content,
      "",
      "## 最近的经历",
      regions[2]!.content,
      "",
      "## 这个项目的记忆",
      regions[3]!.content,
      "",
      "## 底座",
      regions[4]!.content,
      regions[5]!.content,
      regions[6]!.content,
      ANIMA_CONTEXT_CLOSE,
    ].join("\n");

  const trimOrder: RegionName[] = ["experiences", "personality", "projectMemory"];
  let text = render();
  for (const name of trimOrder) {
    while (estimateTokens(text) > budget) {
      const region = regions.find((r) => r.name === name)!;
      const lines = region.content.split("\n");
      if (lines.length <= 1) break;
      lines.pop();
      region.content = lines.join("\n");
      region.tokens = estimateTokens(region.content);
      warnings.push(`注入超总预算，${name} 区被进一步裁剪`);
      text = render();
    }
    if (estimateTokens(text) <= budget) break;
  }

  // ---- 主权铁律最后防线：违规行直接丢弃 ----
  const violations = findMoodNumberViolations(text);
  if (violations.length > 0) {
    const bad = new Set(violations);
    for (const r of regions) {
      r.content = r.content
        .split("\n")
        .filter((l) => !bad.has(l))
        .join("\n");
      r.tokens = estimateTokens(r.content);
    }
    text = render();
    warnings.push(`主权检查：丢弃 ${violations.length} 行含心情数值的内容`);
  }

  // ---- 台账与告警落库 ----
  const injectedIds = injected.map((r) => r.id);
  if (injectedIds.length > 0) recordInjection(db, opts.sessionId, injectedIds, clock);
  if (warnings.length > 0) {
    appendSituation(
      db,
      {
        sessionId: opts.sessionId,
        project: opts.project,
        kind: "injection_warning",
        payload: { warnings },
      },
      clock,
    );
  }

  return { text, regions, warnings, injectedIds };
}
