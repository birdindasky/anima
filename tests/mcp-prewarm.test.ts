// SELFKNOW #3：MCP 服务器 boot 预热 embedder。
// 守两条命门：① fire-and-forget——不同步抛、不阻塞调用方、失败静默降级；② 只活在持久 server 进程，
// 绝不把模型加载塞进 hook 热路径（静态闭包证：prewarm 模块只动态 import embed；server 以 void 触发不 await；
// 三个 live hook 谁都不引用预热/MCP server 路径）。重演 2026-06-12「hook 干重活」事故的防线。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prewarmEmbedder } from "../src/mcp/prewarm";
import { reachesBareSpecifier } from "./helpers/importClosure";

const SRC = join(import.meta.dir, "..");

describe("prewarmEmbedder 行为（fire-and-forget）", () => {
  test("触发一次 embed（warmup）", async () => {
    let calls = 0;
    let arg = "";
    await prewarmEmbedder((t) => {
      calls++;
      arg = t;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(arg.length).toBeGreaterThan(0); // 传了非空 warmup 文本
  });

  test("非阻塞：embed 还悬着时就已返回一个悬挂 Promise（不 await 完成）", async () => {
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = () => {
        settled = true;
        res();
      };
    });
    const p = prewarmEmbedder(() => gate);
    expect(p).toBeInstanceOf(Promise);
    expect(settled).toBe(false); // 调用已返回，embed 仍悬着 → 没阻塞

    let done = false;
    p.then(() => {
      done = true;
    });
    await Promise.resolve(); // 放微任务跑一圈
    expect(done).toBe(false); // 预热真悬着，佐证调用方拿回控制权

    release();
    await p;
    expect(settled).toBe(true);
  });

  test("静默降级：embed 异步 reject → 返回的 Promise 照样 resolve，不冒泡", async () => {
    await expect(
      prewarmEmbedder(() => Promise.reject(new Error("boom"))),
    ).resolves.toBeUndefined();
  });

  test("静默降级：embed 同步抛 → 不同步抛给调用方、返回 resolve", async () => {
    await expect(
      prewarmEmbedder(() => {
        throw new Error("sync boom");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("命门：静态闭包证（模型加载不进 hook 热路径）", () => {
  test("prewarm 模块 transformers-free：embed 只走动态 import，无静态值导入", () => {
    const src = readFileSync(join(SRC, "src/mcp/prewarm.ts"), "utf8");
    // 绝不静态**值**导入 ../embed 或 transformers（type 除外）
    const badValueImport =
      /^\s*import\s+(?!type\b)[^;]*from\s+["'](\.\.\/embed|@huggingface\/transformers)["']/m;
    expect(badValueImport.test(src)).toBe(false);
    // embed 必须走动态 import("../embed")
    expect(/import\(\s*["']\.\.\/embed["']\s*\)/.test(src)).toBe(true);
  });

  test("server.ts 以 void 触发预热、绝不 await，且在 stdin 循环之前", () => {
    const src = readFileSync(join(SRC, "src/mcp/server.ts"), "utf8");
    expect(
      /import\s*\{[^}]*\bprewarmEmbedder\b[^}]*\}\s*from\s*["']\.\/prewarm["']/.test(src),
    ).toBe(true);
    // fire-and-forget：void 触发、不得 await
    expect(/\bvoid\s+prewarmEmbedder\s*\(/.test(src)).toBe(true);
    expect(/\bawait\s+prewarmEmbedder\s*\(/.test(src)).toBe(false);
    // 预热在 stdin 消息循环（for await ... of console）之前触发
    const idxWarm = src.indexOf("prewarmEmbedder(");
    const idxLoop = src.indexOf("for await");
    expect(idxWarm).toBeGreaterThan(-1);
    expect(idxLoop).toBeGreaterThan(idxWarm);
  });

  // 真·传递闭包证（替换旧的假绿灯：旧版只 grep hook 源码含不含 "prewarm" 字串，根本没追导入图——
  // hook 经 index barrel → digest/recall → vectorize/hybridSearch → embed 触达 transformers 它照样判绿）。
  // 现在从每个 live hook 入口沿**静态值导入**递归展开闭包，断言到不了 @huggingface/transformers。
  const LIVE_HOOKS = ["stop.ts", "session-start.ts", "session-end.ts"];
  const TRANSFORMERS = "@huggingface/transformers";

  test("三个 live hook 的静态导入闭包内触达不到 @huggingface/transformers（模型库图不进 hook 热路径）", () => {
    const violations: string[] = [];
    for (const hook of LIVE_HOOKS) {
      const path = reachesBareSpecifier(join(SRC, "hooks", hook), TRANSFORMERS);
      if (path) violations.push(path.map((p) => p.replace(SRC + "/", "")).join(" → "));
    }
    if (violations.length) console.error("HOOK→TRANSFORMERS 静态链路:\n" + violations.join("\n"));
    expect(violations).toEqual([]);
  });

  test("三个 live hook 谁都不引用预热/MCP server 路径（预热只在持久 server 进程）", () => {
    for (const hook of LIVE_HOOKS) {
      const src = readFileSync(join(SRC, "hooks", hook), "utf8");
      expect(/prewarm/.test(src)).toBe(false);
      expect(/mcp\/server/.test(src)).toBe(false);
    }
  });
});
