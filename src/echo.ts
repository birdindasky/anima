// 防回声剥离：采集/自评前剥掉 harness 注入与 anima 自己注入的内容，
// 防"记忆里存着上次注入的记忆"的复读循环与情绪自激振荡（来源：claude-supermemory 教训）

/** Phase 2 晨间注入必须用这对标记包裹，剥离才认得出自己 */
export const ANIMA_CONTEXT_OPEN = "<anima-context>";
export const ANIMA_CONTEXT_CLOSE = "</anima-context>";

const STRIP_PATTERNS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<anima-context>[\s\S]*?<\/anima-context>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
];

export function stripEcho(text: string): string {
  let out = text;
  for (const re of STRIP_PATTERNS) out = out.replace(re, "");
  return out;
}
