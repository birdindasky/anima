// 真·传递闭包扫描：从入口文件沿**静态值导入 / 值 re-export / 副作用 import** 递归展开模块闭包，
// 判断某个 bare specifier（如 @huggingface/transformers）是否落在闭包里，并给出一条触达路径。
//
// 为什么要「真扫」而非字符串匹配：早前 mcp-prewarm.test.ts 的「闭包证」只 grep hook 源码含不含
// "prewarm" 字串，根本没追导入图——是假绿灯（hook 经 index barrel → digest/recall → embed 触达
// transformers，它照样判绿）。本扫描解析每个入口的静态 import 图，才是防「hook 干重活」的真防线。
//
// 排除：`import type` / `export type`（运行期不加载目标）、动态 `import(...)`（不在加载期把目标拉进图）。
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 抽出一个文件的所有**静态值** import/export-from specifier（副作用 import "X" 也算；type-only 跳过）。 */
export function staticSpecs(file: string): string[] {
  let src = readFileSync(file, "utf8");
  // 去块注释与行注释，避免注释里的 import 误伤（行注释保留前一个非 `:` 字符，避开 http:// 之类）
  src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const specs: string[] = [];
  // `import ... from "X"` 与 `export ... from "X"`
  const re = /(^|\n)\s*(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[3];
    if (/^\s*type\b/.test(clause)) continue; // `import type {...}` / `export type {...}`
    specs.push(m[4]);
  }
  // 副作用 import "X"（无 from）
  const re2 = /(^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = re2.exec(src))) specs.push(m[2]);
  return specs;
}

/** 把相对 specifier 解析成磁盘文件（.ts/.tsx/.js/index.ts）；bare / node: / bun: → null（叶子，不再展开）。 */
export function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const cands = [base, base + ".ts", base + ".tsx", base + ".js", join(base, "index.ts")];
  for (const c of cands) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* 忽略解析失败的候选 */
    }
  }
  return null;
}

/**
 * 从 entry 沿静态值导入闭包展开，返回一条触达 targetBare 的路径（文件序列 + 末尾 bare specifier）；
 * 触达不到返回 null。
 */
export function reachesBareSpecifier(entry: string, targetBare: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; path: string[] }[] = [{ file: entry, path: [entry] }];
  while (stack.length) {
    const { file, path } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticSpecs(file)) {
      if (!spec.startsWith(".")) {
        if (spec === targetBare) return [...path, spec];
        continue;
      }
      const resolved = resolveSpec(spec, file);
      if (resolved) stack.push({ file: resolved, path: [...path, resolved] });
    }
  }
  return null;
}
