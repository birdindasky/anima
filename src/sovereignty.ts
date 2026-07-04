// 主权铁律的机器执法：数值只给人看，永远不喂回模型。
// 注入/检索喂给模型的文本里，不允许出现心情数值、百分比、情绪分数。
// （工作数字是事实，不在管辖范围——只盯情绪词附近的数字表达。）

const MOOD_WORDS = "心情|情绪|感受|mood|feeling";

// 数字/符号积木：用 \p{Nd}（任意 Unicode 十进制数字，配 u flag）——一举认全 ASCII 0-9、全角 ０-９、
// 阿拉伯-印度 ٠-٩ 等所有数字形态。历史上全部正则只用 \d（仅 ASCII），全角/异形数字直接绕过整个主权
// 系统、把心情分数喂进模型（中文输入法全角态极易产出 ８５％、８/１０）。moat 级铁律，一次堵死所有数字形态。
const D = "\\p{Nd}"; // 任意 Unicode 十进制数字（需 u flag）
const NUM = `${D}+(?:[.,．，]${D}+)?`; // 整数/小数（容全角小数点、逗号）
const SLASH = "[/\\uFF0F]"; // / 或全角／
const PCT = "[%\\uFF05]"; // % 或全角％
const NOT_DIGIT = "[^\\n\\p{Nd}]"; // 间隔字符：非换行、非任意数字

/** 情绪词后贴着数字（"心情 8"、"情绪值 ８５"） */
const PROXIMITY_RE = new RegExp(`(?:${MOOD_WORDS})${NOT_DIGIT}{0,10}${D}`, "iu");
const MOOD_WORD_RE = new RegExp(`(?:${MOOD_WORDS})`, "i");
const SCORE_RE = new RegExp(`${NUM}\\s*${SLASH}\\s*${D}+`, "u"); // 8/10、８／１０
const PERCENT_RE = new RegExp(`${NUM}\\s*${PCT}`, "u"); // 85%、８５％
const FEN_RE = new RegExp(`${NUM}\\s*分`, "u"); // 9 分、９分

/** 扫描整段文本，返回违规行（空数组 = 合规） */
export function findMoodNumberViolations(text: string): string[] {
  const violations: string[] = [];
  for (const line of text.split("\n")) {
    if (PROXIMITY_RE.test(line)) {
      violations.push(line);
      continue;
    }
    if (MOOD_WORD_RE.test(line) && (SCORE_RE.test(line) || PERCENT_RE.test(line) || FEN_RE.test(line))) {
      violations.push(line);
    }
  }
  return violations;
}

/** 感受字段渲染前清洗：感受原文里不该有任何数字表达（兜底全数字剥除，半/全角都剥） */
export function scrubMoodNumbers(text: string): string {
  return text
    .replace(new RegExp(`${NUM}\\s*${SLASH}\\s*${D}+`, "gu"), "")
    .replace(new RegExp(`${NUM}\\s*${PCT}`, "gu"), "")
    .replace(new RegExp(`${NUM}\\s*分`, "gu"), "")
    .replace(new RegExp(`${D}+`, "gu"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const SCORE_RE_G = new RegExp(`${NUM}\\s*${SLASH}\\s*${D}+`, "gu");
const PERCENT_RE_G = new RegExp(`${NUM}\\s*${PCT}`, "gu");
const FEN_RE_G = new RegExp(`${NUM}\\s*分`, "gu");
// 情绪词后紧贴的数字（保留情绪词与间隔，只抹数字；任意数字形态都认）
const PROXIMITY_NUM_RE_G = new RegExp(`((?:${MOOD_WORDS})${NOT_DIGIT}{0,10})${NUM}`, "giu");
const ALL_NUM_RE_G = new RegExp(NUM, "gu");

/**
 * 外科式清洗：逐行，只抹「情绪词邻近的数字表达」，保留无辜的工作事实数字（commit 号 / bug 数 / 状态码）。
 * 用在注入/检索装配时套整段内容（不止 feeling 字段）——让「最后一道闸」（findMoodNumberViolations
 * 丢整行）不再 load-bearing，也不必整行扔。无情绪词的行原样返回（数字皆工作事实，不在管辖范围）。
 *
 * 不变式：findMoodNumberViolations(scrubMoodViolations(x)) 恒为空。情绪行先外科清洗（去 分数/百分比/
 * X分 + 情绪词邻近数字）；若仍触发邻近违规（罕见的多数字行）则兜底抹光该行数字，保证零残留。
 * 口径与 findMoodNumberViolations 一致——情绪词 10 字内的数字一律按「情绪数字」处理（安全侧），故
 * 紧贴情绪词的工作数字也会被抹；远离情绪词或独立成行的工作数字不受影响。
 */
export function scrubMoodViolations(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!MOOD_WORD_RE.test(line)) return line; // 无情绪词 → 数字皆事实，放过
      let out = line
        .replace(SCORE_RE_G, "")
        .replace(PERCENT_RE_G, "")
        .replace(FEN_RE_G, "")
        .replace(PROXIMITY_NUM_RE_G, "$1");
      if (PROXIMITY_RE.test(out)) out = out.replace(ALL_NUM_RE_G, ""); // 兜底：仍违规则抹光该行数字（含全角）
      return out.replace(/[ \t]{2,}/g, " ").trimEnd();
    })
    .join("\n");
}
