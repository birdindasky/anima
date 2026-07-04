// 独立盲考官 · SELFKNOW #3「MCP boot 预热 embedder」验收
// 三条需求：① boot 后台非阻塞预热使首召回温；② 模型加载绝不进 hook 热路径（闭包证 hook 不 import transformers）；
// ③ 预热失败静默降级。
// 本文件自写对抗测试：既验预热行为，也做**真·传递闭包**证明（不是字符串匹配 hook 源码，
// 而是从 hook 入口沿静态值导入递归展开，看 @huggingface/transformers 是否落在闭包里）。
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prewarmEmbedder } from "../src/mcp/prewarm";

const ROOT = join(import.meta.dir, "..");

// ─────────────────────────── 需求①③：预热行为 ───────────────────────────
describe("需求①③ 预热 fire-and-forget", () => {
  test("非阻塞：embed 悬着时调用方已拿回控制权", async () => {
    let released = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = () => { released = true; r(); }));
    const p = prewarmEmbedder(() => gate);
    expect(p).toBeInstanceOf(Promise);
    expect(released).toBe(false); // 调用已返回，embed 仍悬 → 没阻塞
    release();
    await p;
  });

  test("同步抛 → 不同步抛给调用方、返回 resolve（静默降级）", async () => {
    await expect(prewarmEmbedder(() => { throw new Error("sync boom"); })).resolves.toBeUndefined();
  });

  test("异步 reject → 不冒泡、返回 resolve（静默降级）", async () => {
    await expect(prewarmEmbedder(() => Promise.reject(new Error("boom")))).resolves.toBeUndefined();
  });

  test("默认路径只走动态 import ../embed（源码级：本模块静态面 transformers-free）", () => {
    const src = readFileSync(join(ROOT, "src/mcp/prewarm.ts"), "utf8");
    const badStaticValue = /^\s*import\s+(?!type\b)[^;]*from\s+["'](\.\.\/embed|@huggingface\/transformers)["']/m;
    expect(badStaticValue.test(src)).toBe(false);
    expect(/import\(\s*["']\.\.\/embed["']\s*\)/.test(src)).toBe(true);
  });
});

// ─────────────── 需求②：真·传递闭包（闭包证 hook 不 import transformers） ───────────────
// 从入口文件沿**静态值导入 / 值 re-export / 副作用 import** 递归展开模块闭包。
// 排除：`import type` / `export type` / 动态 import(...)（这些不会在加载期把目标模块拉进图）。
type Edge = { spec: string; file: string };

function staticSpecs(file: string): string[] {
  let src = readFileSync(file, "utf8");
  // 去掉行注释与块注释，避免注释里的 import 误伤
  src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const specs: string[] = [];
  // 匹配 `import ... from "X"` 与 `export ... from "X"`（含副作用 `import "X"`）
  const re = /(^|\n)\s*(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[3];
    // 纯类型导入/导出：`import type {...}` / `export type {...}` → 运行期不加载目标
    if (/^\s*type\b/.test(clause)) continue;
    specs.push(m[4]);
  }
  // 副作用 import "X"（无 from）
  const re2 = /(^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = re2.exec(src))) specs.push(m[2]);
  return specs;
}

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null; // bare / node: / bun: → 叶子
  const base = resolve(dirname(fromFile), spec);
  const cands = [base, base + ".ts", base + ".tsx", base + ".js", join(base, "index.ts")];
  for (const c of cands) if (existsSync(c) && !c.endsWith("/")) {
    try { if (readFileSync(c) && !require("node:fs").statSync(c).isDirectory()) return c; } catch {}
  }
  return null;
}

// 返回：闭包内是否触达某个 bare specifier（如 @huggingface/transformers），并给出一条路径
function reaches(entry: string, targetBare: string): string[] | null {
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

const HOOKS = ["hooks/stop.ts", "hooks/session-start.ts", "hooks/session-end.ts"].map((h) => join(ROOT, h));
const TARGET = "@huggingface/transformers";

describe("需求② 真·传递闭包证：hook 不 import transformers", () => {
  test("三个 live hook 的静态值导入闭包内不得触达 @huggingface/transformers", () => {
    const violations: string[] = [];
    for (const hook of HOOKS) {
      const path = reaches(hook, TARGET);
      if (path) {
        const rel = path.map((p) => p.replace(ROOT + "/", ""));
        violations.push(`${rel[0]} → ${rel.join(" → ")}`);
      }
    }
    if (violations.length) {
      // 打印真实链路，方便定位
      console.error("HOOK→TRANSFORMERS 静态链路:\n" + violations.join("\n"));
    }
    expect(violations).toEqual([]);
  });
});
