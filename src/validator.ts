// 输出验证器：自评/消化产物的格式校验 + 事实接地（提及的文件须在素材中存在）
// 来源：claude-mem poisoned 分类器教训 + Codex 审计

export interface SelfReviewItem {
  type: "preference" | "decision" | "correction" | "event" | "work_action";
  content: string;
  keywords?: string[];
}

export interface SelfReviewOutput {
  review: string;
  feeling: string;
  intensity: string;
  keywords: string[];
  items: SelfReviewItem[];
  /** 本切片做错/被纠正/失败/被打断/误判/返工的事（采集时打标，2026-06-26 option 2 根本解）。
   *  小切片范围内 LLM 必然记全，随自评落 turn_flaws、夜间日记直接汇总成权威失误清单——治"日记从大堆料里漏失误"。
   *  缺省/格式不符 → 空数组（不毁整份自评）。 */
  flaws: string[];
}

export type ValidationResult =
  | { ok: true; value: SelfReviewOutput }
  | { ok: false; reason: string };

const ITEM_TYPES = new Set(["preference", "decision", "correction", "event", "work_action"]);
// work_action 是纯事实工作记录，content 必须 < 此长度（codex M-2 防 LLM 灌大段）；超长丢这一条、不毁整份自评
const WORK_ACTION_MAX = 200;

// 路径样式：带斜杠且有扩展名的路径，或常见代码文件名。
// 速测教训（2026-06-11）：斜杠形式必须要求扩展名，否则 "1/15"、"ZooKeeper/KRaft"
// 这类比例/产品名写法会被误判成文件路径，把合法自评拒掉。
const PATH_RE =
  /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,7}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|md|json|yml|yaml|toml|sql|css|html|sh)\b/g;

/** 文本中提及但素材里不存在的路径（事实接地公共件，消化验证器复用） */
export function findUngroundedPaths(text: string, evidenceText: string): string[] {
  const out: string[] = [];
  for (const path of text.match(PATH_RE) ?? []) {
    if (!evidenceText.includes(path)) out.push(path);
  }
  return out;
}

export function extractJson(raw: string): unknown {
  const stripped = raw.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("找不到 JSON 对象");
  return JSON.parse(stripped.slice(start, end + 1));
}

/**
 * 从可能带噪声的 LLM markdown 回复里稳健地抠出文档正文。
 * haiku 偶尔把 markdown 裹进 ```markdown ... ``` 代码围栏，或在首个 # 标题前加一句开场白
 * （如"好的，这是改写后的人格文档："），导致 startsWith("#") 假性失败。这里先归一化：
 *   1. trim
 *   2. 整体被 ``` / ```markdown / ```md 围栏包住 → 取内层内容
 *   3. 存在顶层 Markdown 标题（行首 #）→ 从该标题行起切，丢掉前面的开场白
 *   4. 再 trim 返回；找不到标题就原样返回（让调用方的 startsWith("#") 去拒）
 */
export function extractMarkdownDoc(raw: string): string {
  let text = raw.trim();

  // 整体围栏：```\n...\n``` 或 ```markdown / ```md 开头
  const fence = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();

  // 丢掉首个顶层标题之前的开场白（行首 # 才算标题，避免切到散文里的 #）
  const headingIdx = text.search(/^#/m);
  if (headingIdx > 0) text = text.slice(headingIdx);

  return text.trim();
}

export function validateSelfReview(raw: string, evidenceText: string): ValidationResult {
  let parsed: any;
  try {
    parsed = extractJson(raw);
  } catch (e) {
    return { ok: false, reason: `格式损坏：${(e as Error).message}` };
  }

  if (typeof parsed.review !== "string" || parsed.review.trim().length === 0) {
    return { ok: false, reason: "review 缺失或为空" };
  }
  if (parsed.review.length > 4000) return { ok: false, reason: "review 超长（>4000 字符）" };
  if (typeof parsed.feeling !== "string" || typeof parsed.intensity !== "string") {
    return { ok: false, reason: "feeling/intensity 必须是字符串（空着是常态，但字段要在）" };
  }
  if (!Array.isArray(parsed.keywords) || !parsed.keywords.every((k: unknown) => typeof k === "string")) {
    return { ok: false, reason: "keywords 必须是字符串数组" };
  }
  if (!Array.isArray(parsed.items) || parsed.items.length > 20) {
    return { ok: false, reason: "items 必须是数组且 ≤20 条" };
  }
  for (const item of parsed.items) {
    if (!ITEM_TYPES.has(item?.type)) {
      return { ok: false, reason: `items.type 非法：${JSON.stringify(item?.type)}` };
    }
    if (typeof item.content !== "string" || !item.content.trim() || item.content.length > 500) {
      return { ok: false, reason: "items.content 缺失或超长" };
    }
    if (item.keywords !== undefined && !Array.isArray(item.keywords)) {
      return { ok: false, reason: "items.keywords 必须是数组" };
    }
  }

  // 事实接地：产物中提及的文件路径必须在素材里出现过——防 LLM 编造
  const claimed = [parsed.review, ...parsed.items.map((i: SelfReviewItem) => i.content)].join("\n");
  const ungrounded = findUngroundedPaths(claimed, evidenceText);
  if (ungrounded.length > 0) {
    return { ok: false, reason: `事实接地失败：素材中不存在 "${ungrounded[0]}"` };
  }

  return {
    ok: true,
    value: {
      review: parsed.review.trim(),
      feeling: parsed.feeling.trim(),
      intensity: parsed.intensity.trim(),
      keywords: parsed.keywords,
      items: parsed.items
        .map((i: any) => ({
          type: i.type,
          content: i.content.trim(),
          keywords: Array.isArray(i.keywords) ? i.keywords.filter((k: unknown) => typeof k === "string") : [],
        }))
        // work_action content 超 200 字 → 丢这一条（不毁整份自评，codex M-2）
        .filter((i: SelfReviewItem) => i.type !== "work_action" || i.content.length < WORK_ACTION_MAX),
      // flaws 宽松强制：非数组/缺省 → []；只留非空字符串、各截 300 字、最多 20 条（坏字段绝不毁整份自评）
      flaws: Array.isArray(parsed.flaws)
        ? parsed.flaws
            .filter((f: unknown) => typeof f === "string" && f.trim().length > 0)
            .map((f: string) => f.trim().slice(0, 300))
            .slice(0, 20)
        : [],
    },
  };
}
