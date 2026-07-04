// 经历表读写与中文检索。原始小票原则：只追加、只失效，没有删除口，原文永不改写。
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";

export interface ExperienceInput {
  /** 'event' | 'bookmark' | 'self_review' | 'imported' ... 语义由捕获侧定义 */
  kind: string;
  project?: string | null;
  content: string;
  /** 情绪烙印：它当时的感受原文（空着是常态） */
  feeling?: string | null;
  /** 强度自述原文（不是数字——数值永不入库） */
  intensity?: string | null;
  /** 关键词/别名，补语义召回（Phase 1 由自评顺手产出） */
  keywords?: string[];
  sourceSession?: string | null;
  /** 事件发生时刻，缺省取时钟当前值 */
  occurredAt?: string;
  /** 事实层生效时刻（bi-temporal） */
  validAt?: string | null;
  /**
   * 缝合定序键（DESIGN-SELFHEAL §3.5）。普通写**一律不传**（NULL）；仅 stageHeal 写愈合 review 时传
   * = 被替换壳的 id，使愈合片继承壳的原始时间位。NULL 时 COALESCE(order_seq,id)=id，与现行排序字节等价。
   */
  orderSeq?: number | null;
}

export interface ExperienceRow {
  id: number;
  uuid: string;
  kind: string;
  project: string | null;
  content: string;
  feeling: string | null;
  intensity: string | null;
  keywords: string[];
  sourceSession: string | null;
  occurredAt: string;
  createdAt: string;
  validAt: string | null;
  expiredAt: string | null;
  invalidAt: string | null;
}

export interface RawRow {
  id: number;
  uuid: string;
  kind: string;
  project: string | null;
  content: string;
  feeling: string | null;
  intensity: string | null;
  keywords: string | null;
  source_session: string | null;
  occurred_at: string;
  created_at: string;
  valid_at: string | null;
  expired_at: string | null;
  invalid_at: string | null;
}

export function mapExperienceRow(r: RawRow): ExperienceRow {
  return mapRow(r);
}

function mapRow(r: RawRow): ExperienceRow {
  return {
    id: r.id,
    uuid: r.uuid,
    kind: r.kind,
    project: r.project,
    content: r.content,
    feeling: r.feeling,
    intensity: r.intensity,
    keywords: r.keywords ? (JSON.parse(r.keywords) as string[]) : [],
    sourceSession: r.source_session,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
    validAt: r.valid_at,
    expiredAt: r.expired_at,
    invalidAt: r.invalid_at,
  };
}

export function insertExperience(
  db: Database,
  input: ExperienceInput,
  clock: Clock = systemClock,
): ExperienceRow {
  const now = clock.now().toISOString();
  const uuid = crypto.randomUUID();
  db.query(
    `INSERT INTO experiences
       (uuid, kind, project, content, feeling, intensity, keywords, source_session,
        occurred_at, created_at, valid_at, order_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid,
    input.kind,
    input.project ?? null,
    input.content,
    input.feeling ?? null,
    input.intensity ?? null,
    input.keywords && input.keywords.length ? JSON.stringify(input.keywords) : null,
    input.sourceSession ?? null,
    input.occurredAt ?? now,
    now,
    input.validAt ?? null,
    input.orderSeq ?? null,
  );
  const row = db.query("SELECT * FROM experiences WHERE uuid = ?").get(uuid) as RawRow;
  return mapRow(row);
}

export function getExperience(db: Database, id: number): ExperienceRow | null {
  const row = db.query("SELECT * FROM experiences WHERE id = ?").get(id) as RawRow | null;
  return row ? mapRow(row) : null;
}

/**
 * 矛盾失效：盖失效戳（事实层 invalid_at + 记录层 expired_at），不删除、不改原文。
 * `WHERE invalid_at IS NULL` 让它成为 compare-and-swap——返回**是否真的由本调用翻转**（false = 本就已失效）。
 * 愈合拿它当幂等闸：抢到翻转（true）才写真自评，没抢到（false）说明别处已愈、绝不重复写（AUDIT A区#3）。
 * 注：用 `.changes > 0` 判而非取精确计数——experiences 有 FTS 触发器，`.changes` 会被触发器内写入膨胀
 * （与 watermark.ts CAS 同口径）。
 */
export function invalidateExperience(
  db: Database,
  id: number,
  clock: Clock = systemClock,
): boolean {
  const now = clock.now().toISOString();
  return (
    db
      .query(
        `UPDATE experiences SET invalid_at = ?, expired_at = ?
         WHERE id = ? AND invalid_at IS NULL`,
      )
      .run(now, now, id).changes > 0
  );
}

// ---------- 检索 ----------
// 中文按字符 bigram 切单元（"权限测试" → 权限/限测/测试），英文按词；
// 命中标准：覆盖率 > 50%。trigram FTS 在安全时做候选收窄（≥3 字符单元），
// 最终判定一律走 LIKE 覆盖率——正确性不依赖 FTS。

const HAN_RE = /\p{Script=Han}/u;

// —— 查询侧停用词剥离（AUDIT-2026-07-01 盘点 U27）——
// 整句自然语言查询（"为什么那个迁移会静默失败"）的填充词会以 bigram 形态混进单元表抬高分母，
// >50% 覆盖率门槛直接把真命中判漏召。只动【查询】切分，内容/存储侧一个字不碰：
//  ① 多字停用词当分隔符把连写段切开（切段而非删字——绝不产生跨停用词的假 bigram）；
//  ② 纯语法单字（的/了/会/能…）只在 ≥3 字连写段里当分隔符：两字独立词（会话/了解）是用户给的
//     精确词、整词保留零回归；长段切出的单字残段照常成单元，LIKE 是子串匹配，"了解"切剩"解"
//     仍命中 %解%，召回不丢；
//  ③ 英文停用词整 token 剥；
//  ④ 全剥空 → 回退未剥离切分（纯停用词查询保持旧行为，绝不"搜什么都返回空"）。
// 词表刻意保守：只收疑问/指代/句式填充，不收可能出现在记忆正文里的实义词（昨天/之前/感觉…）。
const ZH_STOP_WORDS = [
  "可不可以", "是不是", "有没有", "能不能", "会不会", "要不要", "为什么", "怎么样",
  "什么", "怎么", "怎样", "如何", "哪个", "哪些", "哪里", "哪儿",
  "这个", "这些", "这样", "这么", "那个", "那些", "那样", "那么",
  "可以", "一下", "一个", "时候", "然后", "但是", "因为", "所以",
  "就是", "还是", "或者", "以及", "并且", "而且", "其实", "真的",
  "到底", "究竟", "帮我", "给我", "我想", "我要", "问题", "情况",
  "咱们", "我们", "你们", "他们", "她们", "它们",
] as const;
// 单字虚词分两档（独立考官 grader-a 逮到的精度回归：会/能/要 是"语法-构词两栖字"，
// 无条件当分隔符会把 性能测试→[性,测试]、主要问题→[主] 打散成超高频单字，过度召回反超真命中）：
//  tier1 纯语气/结构助词——几乎不构词，两侧非串边即切；
//  tier2 两栖字——常见于实词（性能/会话/主要/被动/把手…），**两侧都 ≥2 字才切**（只切"整词 停用字 整词"
//  的真语法位，如"迁移会静默失败"的会；"性能"里的 能 左侧只有单字"性"，不切、整段保留＝旧行为）。
const ZH_STOP_PARTICLES = "的了吗呢啊呀吧嘛么";
const ZH_STOP_AMBIG = "很挺太就都也还又再被把请让您咱会能要";
// 长词在前：JS 交替取首个命中，防"为什么"被"什么"截半（此正则只管多字停用词；单字走 splitHanSegment 条件切）
const ZH_STOP_WORDS_RE = new RegExp(ZH_STOP_WORDS.join("|"), "gu");

/** 按停用词/虚词把 Han 连写段切成若干实词段（U27 剥离核心，规则见上两注释）。 */
function splitHanSegment(seg: string): string[] {
  const out: string[] = [];
  for (const part of seg.split(ZH_STOP_WORDS_RE)) {
    if (!part) continue;
    let cur = "";
    for (let i = 0; i < part.length; i++) {
      const ch = part[i]!;
      const rest = part.length - i - 1;
      const cut =
        (ZH_STOP_PARTICLES.includes(ch) && cur.length >= 1 && rest >= 1) ||
        (ZH_STOP_AMBIG.includes(ch) && cur.length >= 2 && rest >= 2);
      if (cut) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
  }
  // 残段若只是一个孤立虚词字（如尾随"了"），不当检索单元
  return out.filter((s) => !(s.length === 1 && (ZH_STOP_PARTICLES.includes(s) || ZH_STOP_AMBIG.includes(s))));
}
const EN_STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "how", "why", "what", "when", "where", "which", "who", "whose", "whom",
  "this", "that", "these", "those", "it", "its", "of", "to", "in", "on", "at", "by", "for",
  "with", "about", "from", "as", "and", "or", "so", "such", "just", "also", "too", "very",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "have", "has", "had", "having", "i", "you", "he", "she", "we", "they",
  "me", "him", "her", "us", "them", "my", "your", "his", "their", "our",
  "if", "then", "than", "there", "here",
]);

function pushHanUnits(out: string[], t: string): void {
  if (t.length <= 2) out.push(t);
  else for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
}

export function segmentQuery(query: string): string[] {
  const tokens = query.toLowerCase().match(/\p{Script=Han}+|[a-z0-9_./-]+/gu) ?? [];
  const units: string[] = [];
  const raw: string[] = []; // 未剥离切分（④ 回退用）
  for (const t of tokens) {
    if (HAN_RE.test(t)) {
      pushHanUnits(raw, t);
      if (t.length <= 2) {
        // ② 两字独立词整词保留（除非它本身就是停用词，如独立打出的"什么"）
        const isStopChar = t.length === 1 && (ZH_STOP_PARTICLES.includes(t) || ZH_STOP_AMBIG.includes(t));
        if (!(ZH_STOP_WORDS as readonly string[]).includes(t) && !isStopChar) {
          units.push(t);
        }
      } else {
        for (const seg of splitHanSegment(t)) pushHanUnits(units, seg);
      }
    } else {
      raw.push(t);
      if (!EN_STOP_WORDS.has(t)) units.push(t);
    }
  }
  const out = [...new Set(units)];
  return out.length > 0 ? out : [...new Set(raw)];
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface SearchOptions {
  project?: string;
  /** 与 project 连用：true 时把全局记忆（project IS NULL）一并纳入 */
  includeGlobal?: boolean;
  /** true 时不过滤已失效记忆（默认硬过滤 expired/invalid IS NULL） */
  includeHistory?: boolean;
  limit?: number;
}

/**
 * 两类兜底壳 kind 的**单一事实源**：`self_review_fallback`（这段没能复盘）与 `digest_fallback`（这天没能
 * 画句号）都是降级**审计**记录、不是记忆。所有「面向模型」的读路径——召回索引 / recall_detail 全文 / 日记
 * 素材——都从此派生排除谓词，新增任何壳 kind 只改这一处，杜绝「加了壳 kind 却漏堵某条读路」的漂移
 * （AUDIT-2026-06-29 的病根正是读写口径不对齐）。
 */
export const FALLBACK_SHELL_KINDS = ["self_review_fallback", "digest_fallback"] as const;

/**
 * 召回硬排除兜底壳：任何检索路召回它们都是噪音、还会误导未来会话（write-eval 把 live fallback 壳列为
 * landmine）。无条件排除——includeHistory 给的是「看已失效的真记忆」，不是「看失败壳」。digest 重补走直查
 * （不经此路），故不受影响。字面（searchExperiences）与语义（vectorSearch）两路共用此谓词，防止两边漂移。
 */
export const RECALL_EXCLUDE_KIND_SQL = `e.kind NOT IN (${FALLBACK_SHELL_KINDS.map((k) => `'${k}'`).join(", ")})`;

/**
 * recall_detail 专用：按 id 取一条「可暴露给模型」的经历全文。必须与召回索引同口径过滤，否则 recall_detail
 * 就是绕过所有墙的后门（AUDIT-2026-06-29 A区#2：旧路 getExperience 只 `WHERE id=?`，按编号能拉别项目 /
 * 已作废 / 兜底壳的全文，唯一守卫是一行软文字「已失效」，模型可无视）：
 *   ① 排除已失效/过期——作废=该事实被推翻，绝不该再喂回模型；
 *   ② 排除兜底壳（FALLBACK_SHELL_KINDS，审计噪音非记忆）；
 *   ③ 给了 project 就按项目墙隔离（别项目不越墙，project IS NULL 全局可见）——与流水 #s 详情同约定。
 * 不给 project（undefined）维持向后兼容：不加项目墙，但 ①② 恒过滤。getExperience 保持裸取不动——自愈 /
 * 落库校验等内部路径要按 id 取任意行（含已作废），那不是面向模型的暴露面。
 */
export function getExperienceForRecall(
  db: Database,
  id: number,
  project?: string,
): ExperienceRow | null {
  const placeholders = FALLBACK_SHELL_KINDS.map(() => "?").join(", ");
  const where = ["id = ?", "invalid_at IS NULL", "expired_at IS NULL", `kind NOT IN (${placeholders})`];
  const params: (string | number)[] = [id, ...FALLBACK_SHELL_KINDS];
  if (project !== undefined) {
    where.push("(project = ? OR project IS NULL)");
    params.push(project);
  }
  const row = db.query(`SELECT * FROM experiences WHERE ${where.join(" AND ")}`).get(...params) as RawRow | null;
  return row ? mapRow(row) : null;
}

export function searchExperiences(
  db: Database,
  query: string,
  opts: SearchOptions = {},
): ExperienceRow[] {
  const units = segmentQuery(query);
  if (units.length === 0) return [];
  const required = Math.floor(units.length / 2) + 1; // 覆盖率 > 50%

  const hay = "(e.content || ' ' || COALESCE(e.feeling, '') || ' ' || COALESCE(e.keywords, ''))";
  const scoreExpr = units
    .map(() => `(CASE WHEN ${hay} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
    .join(" + ");
  const params: (string | number)[] = units.map((u) => `%${escapeLike(u)}%`);

  const where: string[] = [RECALL_EXCLUDE_KIND_SQL];
  if (!opts.includeHistory) {
    where.push("e.expired_at IS NULL AND e.invalid_at IS NULL");
  }
  if (opts.project !== undefined) {
    where.push(opts.includeGlobal ? "(e.project = ? OR e.project IS NULL)" : "e.project = ?");
    params.push(opts.project);
  }

  // FTS 候选收窄：仅当"短单元数 < 需命中数"时安全——
  // 此时任何过线的行必然命中至少一个长单元，OR-MATCH 不会漏召回
  const longUnits = units.filter((u) => u.length >= 3);
  const shortCount = units.length - longUnits.length;
  if (longUnits.length > 0 && shortCount < required) {
    const match = longUnits.map((u) => `"${u.replaceAll('"', '""')}"`).join(" OR ");
    where.push("e.id IN (SELECT rowid FROM experiences_fts WHERE experiences_fts MATCH ?)");
    params.push(match);
  }

  const sql = `
    SELECT * FROM (
      SELECT e.*, (${scoreExpr}) AS match_score
      FROM experiences e
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    )
    WHERE match_score >= ?
    -- 排序公式【Codex审计】：相关性是门槛（覆盖率过滤在先）；
    -- 情绪烙印只在相关集合内做同分加权，不得越过相关性
    ORDER BY match_score DESC,
             (CASE WHEN feeling IS NOT NULL AND feeling != '' THEN 1 ELSE 0 END) DESC,
             occurred_at DESC, id DESC
    LIMIT ?`;
  params.push(required, opts.limit ?? 20);

  const rows = db.query(sql).all(...params) as (RawRow & { match_score: number })[];
  return rows.map(mapRow);
}

export interface ChronoSearchOptions extends SearchOptions {
  /** 时间窗下界（含），UTC ISO */
  sinceTs: string;
  /** 时间窗上界（不含），UTC ISO */
  untilTs: string;
}

/**
 * 日记层（蒸馏 experiences）按时间查（DESIGN-WORK-TIMELINE §2/§3A）。
 * 时间窗 [sinceTs, untilTs) 左闭右开；ORDER BY occurred_at DESC, COALESCE(order_seq, id) DESC——
 * order_seq 已随 SELFHEAL 落地（普通行 NULL→COALESCE=id 字节等价；愈合片=壳id 排回原位，设计 §4 F2）。
 * 排除两类兜底壳（self_review_fallback / digest_fallback，走 RECALL_EXCLUDE_KIND_SQL）；默认排除失效；query 可空（空=窗内全取；非空=OR 软筛、**不套覆盖率门槛**，按时间排不按相关性）。
 */
export function searchExperiencesChrono(
  db: Database,
  query: string,
  opts: ChronoSearchOptions,
): ExperienceRow[] {
  const where: string[] = [RECALL_EXCLUDE_KIND_SQL, "e.occurred_at >= ?", "e.occurred_at < ?"];
  const params: (string | number)[] = [opts.sinceTs, opts.untilTs];
  if (!opts.includeHistory) {
    where.push("e.expired_at IS NULL AND e.invalid_at IS NULL");
  }
  if (opts.project !== undefined) {
    where.push(opts.includeGlobal ? "(e.project = ? OR e.project IS NULL)" : "e.project = ?");
    params.push(opts.project);
  }
  const units = segmentQuery(query);
  if (units.length > 0) {
    const hay = "(e.content || ' ' || COALESCE(e.feeling, '') || ' ' || COALESCE(e.keywords, ''))";
    const ors = units.map(() => `${hay} LIKE ? ESCAPE '\\'`).join(" OR ");
    where.push(`(${ors})`);
    for (const u of units) params.push(`%${escapeLike(u)}%`);
  }
  params.push(opts.limit ?? 20);
  const sql = `
    SELECT * FROM experiences e
    WHERE ${where.join(" AND ")}
    ORDER BY e.occurred_at DESC, COALESCE(e.order_seq, e.id) DESC
    LIMIT ?`;
  const rows = db.query(sql).all(...params) as RawRow[];
  return rows.map(mapRow);
}
