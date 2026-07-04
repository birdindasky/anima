// anima worker 守护进程入口。启动方式：① hooks/stop.ts 懒启动；② workerctl run；③ 手动 bun scripts/worker.ts。
// 绝不由 SessionStart 拉起（事故 2026-06-12 的触发机关）。设计：DESIGN-WORKER.md §5 / DESIGN-WORKER-RESUME §v5。
//
// ⚠️ S-7 唯一允许的静态顶层 import：sharp 桩。worker 是 Bun.spawn 起的、cwd=用户项目、读不到 anima 的
// bunfig.toml(preload 桩)；而实时向量化要拉 @huggingface/transformers(静态 import sharp)。桩只注册 bun
// 插件、无 DB/LLM/递归依赖，import 即注册、提升到哨兵之前也无害——必须先于任何 transformers 加载。
// 命门：真命门是 hook 不能拉 transformers（src/worker.ts 保持 transformers-free），本桩只救 worker 进程。
import "../src/stub-sharp";

// ⚠️ 递归隔离铁律（S-7）：ANIMA_HEADLESS 哨兵必须在**动态 import 之前**纯文本查——ESM 静态 import 先于
// 任何运行时语句执行，若用静态 import 把 worker 模块（及其 DB/LLM 依赖）拉进来，哨兵就晚了。故除上面那句
// 无害的 sharp 桩外，其余全走 `await import()`。worker spawn 的 claude 由 claudeCli 带满隔离。
if (process.env.ANIMA_HEADLESS === "1") process.exit(0);

const { resolveConfig } = await import("../src/config");
const { runWorker, defaultWorkerLlm } = await import("../src/worker");
// 真 embed 在此入口接（注入给 runWorker），src/worker.ts 永不静态 import embed → hook 边界不破。
const { embedDocuments, disposeEmbedder } = await import("../src/embed");

const config = resolveConfig();
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

try {
  const result = await runWorker({
    dbPath: config.dbPath,
    dataDir: config.dataDir,
    badgePath: config.badgePath, // R10：schema 降级/损坏时亮可见徽章（尊重 config 覆盖）
    llm: defaultWorkerLlm(),
    embed: embedDocuments, // 实时向量化：消化完顺手给当天记忆补语义指纹
    pollMs: num(process.env.ANIMA_WORKER_POLL_MS, 2000),
    idleExitMs: num(process.env.ANIMA_WORKER_IDLE_MS, 5 * 60_000),
  });
  console.log(`anima worker: ${result.reason}（处理 ${result.processed} 条）`);
} finally {
  // bun teardown 坑：onnxruntime-node 原生资源不显式释放会在退出时抛 C++ 异常致崩。runWorker 正常返回
  // 或抛错都要 dispose（含 idle-exit / SIGTERM 优雅停的正常 return）。放入口、不放 src/worker.ts（否则毒 hook）。
  await disposeEmbedder();
}
process.exit(0);
