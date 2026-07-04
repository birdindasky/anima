// INDEPENDENT BLIND GRADER — "hotpath-transformers".
// Written from scratch by the acceptance examiner. Goal: prove the hooks' STATIC transitive import
// closure genuinely cannot reach @huggingface/transformers, and that the closure scan is a REAL
// transitive scan (not a fake-green that always passes because it never traverses / never distinguishes
// static from dynamic import). I re-implement my own closure collector here so I don't inherit any bug
// from the code-under-test's helper.
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TARGET = "@huggingface/transformers";
const LIVE_HOOKS = ["hooks/stop.ts", "hooks/session-start.ts", "hooks/session-end.ts"];

// ── my own static-value import extractor (independent re-implementation) ──
function staticSpecs(file: string): string[] {
  let src = readFileSync(file, "utf8");
  src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const specs: string[] = [];
  const re = /(^|\n)\s*(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/^\s*type\b/.test(m[3])) continue; // import type / export type -> not loaded at runtime
    specs.push(m[4]);
  }
  const re2 = /(^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = re2.exec(src))) specs.push(m[2]);
  return specs;
}
function resolveRel(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, base + ".ts", base + ".tsx", base + ".js", join(base, "index.ts")]) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}
// collect: every relative file reachable + the set of bare specifiers hit anywhere in the closure
function closure(entry: string): { files: Set<string>; bares: Set<string> } {
  const files = new Set<string>();
  const bares = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of staticSpecs(f)) {
      if (!spec.startsWith(".")) {
        bares.add(spec);
        continue;
      }
      const r = resolveRel(spec, f);
      if (r) stack.push(r);
    }
  }
  return { files, bares };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hotpath-transformers: hooks static closure is transformers-free", () => {
  test("SANITY — the scanner really traverses deep (barrel resolves, reaches src/embed.ts)", () => {
    // If ../src/index failed to resolve, the closure would be trivial and any 'no-transformers'
    // assertion would be a fake green. Prove the closure actually descends into embed.ts.
    for (const h of LIVE_HOOKS) {
      const { files } = closure(join(ROOT, h));
      expect(files.has(join(ROOT, "src/index.ts"))).toBe(true); // barrel really resolved
      expect(files.has(join(ROOT, "src/embed.ts"))).toBe(true); // reached the module that owns transformers
      expect(files.size).toBeGreaterThan(20); // non-trivial graph, not an empty walk
    }
  });

  test("hooks' static closure does NOT contain @huggingface/transformers", () => {
    const violations: string[] = [];
    for (const h of LIVE_HOOKS) {
      const { bares } = closure(join(ROOT, h));
      if (bares.has(TARGET)) violations.push(h);
    }
    expect(violations).toEqual([]);
  });

  test("embed.ts owns transformers only via DYNAMIC import (never static 'from')", () => {
    const src = readFileSync(join(ROOT, "src/embed.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(/from\s*["']@huggingface\/transformers["']/.test(src)).toBe(false); // no static import
    expect(/import\(\s*["']@huggingface\/transformers["']\s*\)/.test(src)).toBe(true); // dynamic only
  });

  // POSITIVE CONTROL: prove the scan can actually catch a static path, and correctly ignores a dynamic
  // one. Without this, "no violations" could just mean the scanner is broken.
  test("POSITIVE CONTROL — static import IS detected; dynamic import IS NOT", () => {
    const dir = mkdtempSync(join(tmpdir(), "closure-ctl-"));
    dirs.push(dir);
    // entry -> mid -> leaf(static transformers)
    writeFileSync(join(dir, "entry.ts"), `import { a } from "./mid";\nexport const x = a;\n`);
    writeFileSync(join(dir, "mid.ts"), `export { a } from "./leaf";\n`);
    writeFileSync(join(dir, "leafStatic.ts"), `import { pipeline } from "@huggingface/transformers";\nexport const a = pipeline;\n`);
    writeFileSync(join(dir, "leafDyn.ts"), `export async function a(){ const m = await import("@huggingface/transformers"); return m; }\n`);

    // static variant: leaf imports transformers statically -> MUST be caught
    writeFileSync(join(dir, "midStatic.ts"), `export { a } from "./leafStatic";\n`);
    writeFileSync(join(dir, "entryStatic.ts"), `import { a } from "./midStatic";\nexport const x = a;\n`);
    expect(closure(join(dir, "entryStatic.ts")).bares.has(TARGET)).toBe(true);

    // dynamic variant: leaf imports transformers dynamically -> MUST NOT be caught
    writeFileSync(join(dir, "midDyn.ts"), `export { a } from "./leafDyn";\n`);
    writeFileSync(join(dir, "entryDyn.ts"), `import { a } from "./midDyn";\nexport const x = a;\n`);
    expect(closure(join(dir, "entryDyn.ts")).bares.has(TARGET)).toBe(false);

    // type-only import of transformers -> MUST NOT be caught (not loaded at runtime)
    writeFileSync(join(dir, "leafType.ts"), `import type { Pipeline } from "@huggingface/transformers";\nexport type A = Pipeline;\n`);
    writeFileSync(join(dir, "entryType.ts"), `export type { A } from "./leafType";\n`);
    expect(closure(join(dir, "entryType.ts")).bares.has(TARGET)).toBe(false);
  });

  // REGRESSION GUARD: if someone flips embed.ts to a static transformers import, the hook closure
  // MUST turn red. Simulate by scanning against a patched copy of embed.ts.
  test("REGRESSION — a static transformers import in embed.ts would flip the hook closure red", () => {
    const dir = mkdtempSync(join(tmpdir(), "closure-reg-"));
    dirs.push(dir);
    // Build a tiny graph: entry -> embedCopy(static transformers). Confirms detection wiring.
    const patched = readFileSync(join(ROOT, "src/embed.ts"), "utf8").replace(
      /const \{ env, pipeline \} = await import\(\s*["']@huggingface\/transformers["']\s*\);/,
      `import { env, pipeline } from "@huggingface/transformers"; //`,
    );
    // Fallback if the exact line drifted: just append a static import.
    const finalSrc = /import\s+\{[^}]*\}\s+from\s+["']@huggingface\/transformers["']/.test(patched)
      ? patched
      : patched + `\nimport { pipeline as _p } from "@huggingface/transformers";\n`;
    writeFileSync(join(dir, "embedCopy.ts"), finalSrc);
    writeFileSync(join(dir, "entry.ts"), `import "./embedCopy";\n`);
    expect(closure(join(dir, "entry.ts")).bares.has(TARGET)).toBe(true);
  });
});
