// MCP 服务器 boot 预热 embedder：只在**持久 MCP 服务器进程**里跑，让首次召回是温的（稳态 ~10ms
// 而非冷载 ~0.33s）。命门：绝不把模型加载塞进任何 hook 热路径——重演 2026-06-12「hook 干重活」事故。
// 本模块对 ../embed（→ transformers）只走**动态 import**，静态导入面是 transformers-free：即便被误引，
// 光加载本模块也不会把几百 MB 模型拉进模块图；真正加载只发生在 prewarmEmbedder() 被调用（仅 server.ts）。
export type PrewarmEmbed = (text: string) => Promise<unknown>;

// 动态 import embed：把 transformers 挡在静态图外，只在真触发预热那一刻才加载。
async function defaultEmbed(text: string): Promise<unknown> {
  const { embedQuery } = await import("../embed");
  return embedQuery(text);
}

/**
 * 后台预热：触发一次 embedQuery，让 embedder pipeline 加载 + 跑一次前向，把首召回从冷载降到温。
 * 契约（fire-and-forget）：
 *  - **绝不同步抛、绝不阻塞调用方**：立刻返回一个已归一化的 Promise（生产端不 await，测试端可 await）。
 *  - **失败静默降级**：预热失败（依赖缺/模型不可用/同步抛/异步 reject）一律吞掉——首次真召回自会懒加载。
 * 默认动态 import ../embed；测试可注入桩 embed 避免真加载模型。
 */
export function prewarmEmbedder(embed: PrewarmEmbed = defaultEmbed): Promise<void> {
  let started: Promise<unknown>;
  try {
    // 立即触发（同步启动加载），同步抛也在此兜住
    started = Promise.resolve(embed("warmup"));
  } catch {
    return Promise.resolve();
  }
  // 异步 reject 静默吞：预热挂了无所谓，召回路径本就有懒加载兜底
  return started.then(
    () => undefined,
    () => undefined,
  );
}
