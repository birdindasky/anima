// token 估算（零依赖近似）：CJK 每字 ≈1 token，其余按 ~4 字符/token
const CJK_RE = /[⺀-⻿　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g;
const CJK_CHAR_RE = /[⺀-⻿　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const other = text.length - cjk;
  return cjk + Math.ceil(other / 4);
}

/** 按 token 预算截断文本（粗粒度：逐字符累计） */
export function truncateToTokens(text: string, maxTokens: number, marker = "…"): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const budget = maxTokens - estimateTokens(marker);
  let acc = 0;
  let out = "";
  for (const ch of text) {
    acc += CJK_CHAR_RE.test(ch) ? 1 : 0.25;
    if (acc > budget) break;
    out += ch;
  }
  return out + marker;
}
