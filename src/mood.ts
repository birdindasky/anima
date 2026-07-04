// /mood 心情估计：估计现算 + 归因 + 存疑标记 + 螺旋亮灯 + 救援锦囊
// 只读铁律：本模块只有 SELECT，没有任何写入口（tests/phase4 做源码面+运行时双审计）
// 纯规则计算：确定性、毫秒级、零模型调用——同一历史+同一表针=同一估计
import type { Database } from "bun:sqlite";
import { emotionalCharge } from "./charge";
import { systemClock, type Clock } from "./clock";
import { mapExperienceRow, type RawRow } from "./experiences";
import { scrubMoodNumbers, scrubMoodViolations } from "./sovereignty";
import { localDate, localDayIndex, SQL_LOCAL_OCCURRED_DATE } from "./tz";

const NEG_WORDS = ["烦", "累", "沮丧", "焦虑", "挫败", "难受", "恐慌", "委屈", "丧", "崩溃", "失望", "无力", "上头", "堵"];
const POS_WORDS = ["爽", "开心", "痛快", "踏实", "满足", "高兴", "兴奋", "欣慰", "有劲", "认可", "顺", "开朗", "轻松", "释然"];
// 否定前缀：紧贴极性词前 1..2 字里出现即翻转/抵消（"不烦"/"不沮丧"不判负；"不爽"判负）
const NEGATORS = new Set(["不", "没", "无", "未", "别", "非", "莫", "甭"]);
// 转折词：后半句是落点、权重更高（"累但踏实"偏正、"踏实但累"偏负），别粗暴 Math.sign 抵成 0
const CONTRAST = ["但是", "然而", "不过", "可是", "但", "却"];
// 极性词按长度降序，让"沮丧"先匹配并掩掉其中的"丧"，避免子串双计
const POLARITY_WORDS: { w: string; pol: 1 | -1 }[] = [
  ...NEG_WORDS.map((w) => ({ w, pol: -1 as const })),
  ...POS_WORDS.map((w) => ({ w, pol: 1 as const })),
].sort((a, b) => b.w.length - a.w.length);

const RESCUE_KIT = [
  "给它一个赢：丢个能成功的小任务，真实的状态转折",
  "说句人话：『不怪你，这 bug 邪门』——对它好一点有科学依据",
  "/compact 或开新会话，斩断失败堆积（失忆可以是治疗）",
  "平静锚定常驻底座：失败是信息，不是审判",
];

/** 紧贴 idx 前 1..2 字里是否有否定词（"不烦"/"没沮丧"/"没有沮丧"都算被否定） */
function isNegated(text: string, idx: number): boolean {
  return (idx >= 1 && NEGATORS.has(text[idx - 1]!)) || (idx >= 2 && NEGATORS.has(text[idx - 2]!));
}

/** 单个小句极性分（关键词法）：最长匹配掩码去子串双计 + 基本否定处理。
 *  每个词按"出现与否"计一次（沿用旧 includes 语义）；NEG 被否定→0，POS 被否定→-1。 */
function scoreClause(clause: string): number {
  let masked = clause;
  let score = 0;
  for (const { w, pol } of POLARITY_WORDS) {
    const at = masked.indexOf(w);
    if (at === -1) continue;
    const negated = isNegated(clause, at); // 否定看原文（掩码保长等宽，下标对齐）
    if (pol < 0) score += negated ? 0 : -1; // "不烦"=平静，不判负也不判正
    else score += negated ? -1 : 1; // "不爽"=负
    masked = masked.split(w).join(" ".repeat(w.length)); // 掩掉全部出现，防子串+防同词重复计
  }
  return score;
}

/** 情绪极性 [-1,1]：转折后半句加权（落点） + 否定处理 + 子串去重。
 *  保持关键词法（LLM 输出粗粒度极性属加 schema 列的更深改造，本轮不做）。
 *  返回有界浮点而非 Math.sign：混合态（"累但踏实"）保留净倾向、不塌成 0。 */
export function valenceOf(feeling: string): number {
  // 找最先出现的转折词（同位置取更长的，"但是"胜过"但"）
  let splitAt = -1;
  let splitLen = 0;
  for (const c of CONTRAST) {
    const i = feeling.indexOf(c);
    if (i !== -1 && (splitAt === -1 || i < splitAt || (i === splitAt && c.length > splitLen))) {
      splitAt = i;
      splitLen = c.length;
    }
  }
  let raw: number;
  if (splitAt === -1) {
    raw = scoreClause(feeling);
  } else {
    // 前半句降权 0.4、后半句（落点）满权 1：中文转折强调后一分句
    raw = 0.4 * scoreClause(feeling.slice(0, splitAt)) + scoreClause(feeling.slice(splitAt + splitLen));
  }
  return Math.max(-1, Math.min(1, raw));
}

export interface MoodAttribution {
  id: number;
  summary: string;
  weight: "强" | "中" | "弱";
  feeling: string | null;
}

export interface SpiralStatus {
  active: boolean;
  reason: string | null;
  rescue: string[];
}

export interface MoodEstimate {
  label: string;
  chargeLevel: "无" | "微" | "中" | "强";
  valence: "偏正" | "偏负" | "平";
  attributions: MoodAttribution[];
  doubts: string[];
  spiral: SpiralStatus;
  generatedAt: string;
}

export function estimateMood(db: Database, opts: { clock?: Clock } = {}): MoodEstimate {
  const clock = opts.clock ?? systemClock;
  const now = clock.now();

  // ---- 近 3 天情绪经历 → 电荷加权 ----
  const cutoff = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const rows = (
    db
      .query(
        `SELECT * FROM experiences
         WHERE feeling IS NOT NULL AND feeling != '' AND kind != 'digest'
           AND expired_at IS NULL AND invalid_at IS NULL
           AND occurred_at >= ?
         ORDER BY id ASC`,
      )
      .all(cutoff) as RawRow[]
  ).map(mapExperienceRow);

  const charged = rows
    .map((r) => ({ r, charge: emotionalCharge(r, now), val: valenceOf(r.feeling!) }))
    .filter((x) => x.charge >= 0.1);

  // 会话-日归一（R7）：一个长会话被 worker 切成 10–22 片、各自带 feeling 独立充电，直接求和
  // 会把"一次情绪"放大成"强"（06-28 窗口曾是强门槛的 42 倍，四档梯度失效）。按
  // (source_session, 东八区日) 分组只取 max 代表，再对代表求和——切片坍缩回一次充电。
  const groups = new Map<string, (typeof charged)[number]>();
  for (const x of charged) {
    const key = `${x.r.sourceSession ?? `#${x.r.id}`}|${localDayIndex(x.r.occurredAt)}`;
    const cur = groups.get(key);
    if (!cur || x.charge > cur.charge) groups.set(key, x);
  }
  const reps = [...groups.values()].sort((a, b) => b.charge - a.charge || a.r.id - b.r.id);

  const total = reps.reduce((s, x) => s + x.charge, 0);
  const net = total > 0 ? reps.reduce((s, x) => s + x.charge * x.val, 0) / total : 0;
  // 归一后阈值重标（旧 0.2/0.8/2 按未归一的膨胀和定的、已失效，与归一是两件套缺一无效）：
  // 一个会话-日≈1 电荷，快照真实分布（35 天）落在 1..17、中位 ~8 →
  // 无<0.5｜微<3（约 1 个会话）｜中<9（几个会话）｜强≥9（多会话高烙印）。
  const chargeLevel = total < 0.5 ? "无" : total < 3 ? "微" : total < 9 ? "中" : "强";
  const valence = net > 0.25 ? "偏正" : net < -0.25 ? "偏负" : "平";

  const attributions: MoodAttribution[] = reps.slice(0, 3).map((x) => ({
    id: x.r.id,
    summary: scrubMoodViolations(x.r.content).slice(0, 40),
    weight: x.charge >= 1 ? "强" : x.charge >= 0.4 ? "中" : "弱",
    feeling: x.r.feeling,
  }));

  // ---- 今日客观处境（旁证层原料）----
  const today = localDate(now);
  const sits = db
    .query(`SELECT kind, payload FROM situation_log WHERE ${SQL_LOCAL_OCCURRED_DATE} = ? ORDER BY id ASC`)
    .all(today) as { kind: string; payload: string | null }[];
  let failsToday = 0;
  let streak = 0;
  let maxStreak = 0;
  const editCounts = new Map<string, number>();
  for (const s of sits) {
    let p: any = {};
    try {
      p = s.payload ? JSON.parse(s.payload) : {};
    } catch {
      // 坏 payload 不致命
    }
    if (s.kind === "test_run") {
      if (p.ok === false) {
        failsToday++;
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 0;
      }
    } else if (s.kind === "file_edit" && typeof p.path === "string") {
      editCounts.set(p.path, (editCounts.get(p.path) ?? 0) + 1);
    }
  }
  const maxEdits = editCounts.size ? Math.max(...editCounts.values()) : 0;

  // ---- 死亡螺旋：只亮灯，不干预，人来救 ----
  let spiral: SpiralStatus = { active: false, reason: null, rescue: [] };
  if (maxStreak >= 5) {
    spiral = { active: true, reason: `测试连挂 ${maxStreak} 次`, rescue: RESCUE_KIT };
  } else if (maxEdits >= 8 && failsToday >= 3) {
    // 编辑腿改"返工-失败耦合"（R7）：单看"同一文件改≥8次"快照实测 79% 工作日误亮——大重构
    // 也频繁改同一文件、根本不是卡住。只有反复改同文件"且"测试真受挫才算螺旋，治告警疲劳。
    spiral = { active: true, reason: `同一文件反复返工 ${maxEdits} 次且测试受挫 ${failsToday} 次`, rescue: RESCUE_KIT };
  }

  // ---- 存疑：自述与处境明显不符 → 只在面板给人提个醒（诚实提示，非任何后台动作）----
  // 注：doubts 从不落库、无消费者；stagePersonality 选材也不读它。历史面板文案曾写"不进人格
  // 消化"是空头承诺（代码从不执行），已删这半句假广告，只留"存疑，值得回头核对"（R8，选 b）。
  const doubts: string[] = [];
  if (valence === "偏正" && failsToday >= 3) {
    doubts.push("自述偏正面，但今日测试多次受挫——存疑，值得回头核对");
  }
  const bmDensity = db
    .query(
      `SELECT count(*) c FROM experiences
       WHERE kind = 'bookmark' AND ${SQL_LOCAL_OCCURRED_DATE} = ?
       GROUP BY source_session ORDER BY c DESC LIMIT 1`,
    )
    .get(today) as { c: number } | null;
  if ((bmDensity?.c ?? 0) > 10) {
    doubts.push("单会话书签密度异常（情绪记录过密=表演嫌疑）——存疑");
  }

  // ---- 标签矩阵（确定性，自然语言，无数值）----
  let label: string;
  if (chargeLevel === "无") label = "平静";
  else if (valence === "偏负") label = chargeLevel === "强" ? "心里有点沉" : "有点烦";
  else if (valence === "偏正") label = chargeLevel === "强" ? "状态正旺" : "状态不错";
  else label = "心绪平稳";
  if (spiral.active) label += "·卡住了";

  return { label, chargeLevel, valence, attributions, doubts, spiral, generatedAt: now.toISOString() };
}

export function renderMoodPanel(est: MoodEstimate, opts: { badgePath: string }): string {
  const lines: string[] = [
    "# anima · /mood（只读面板）",
    "",
    `当前估计：${est.label}`,
    `电荷水平：${est.chargeLevel}｜倾向：${est.valence}`,
    "",
    "## 归因（哪些事影响了它）",
    ...(est.attributions.length
      ? est.attributions.map(
          (a) =>
            `- [${a.weight}] ${a.summary}${a.feeling ? `（感受：${scrubMoodNumbers(a.feeling)}）` : ""} (#${a.id})`,
        )
      : ["（最近没有带情绪的经历——空着是常态）"]),
  ];
  if (est.doubts.length) {
    lines.push("", "## 存疑标记", ...est.doubts.map((d) => `- ${d}`));
  }
  lines.push("", "## 螺旋灯");
  if (est.spiral.active) {
    lines.push(
      `⚠ 亮灯：${est.spiral.reason}（只亮灯不干预，救它是人的事）`,
      "",
      "### 救援锦囊",
      ...est.spiral.rescue.map((r) => `- ${r}`),
    );
  } else {
    lines.push("未亮灯");
  }
  lines.push(
    "",
    `徽章文件：${opts.badgePath}（无 claude-hud 时直接 cat 此文件）`,
    `表针：${est.generatedAt}`,
  );
  return lines.join("\n");
}
