// Stop 钩子：静默增量采集处境流水 +（开关开启时）每轮入队 + 懒启动 worker。永不阻塞、永不报错退出。
import { join } from "node:path";
import { openAnima } from "../src/index";
import { captureTranscript } from "../src/capture";
import { recordHookFailure, recordHookSuccess } from "../src/hookHealth";
import { refreshBadge } from "../src/badge";

// 递归保护：anima 拉起的 headless claude 里绝不执行 hook 逻辑（断环命门，必须在任何 spawn/DB 前）
if (process.env.ANIMA_HEADLESS === "1") process.exit(0);

// worker 上线闸门（默认关）：未显式 ANIMA_WORKER_ENABLED=1 → 维持纯采集旧行为，绝不入队/spawn。
// 翻开此闸＝worker 真上线（动共享 hook 行为 + 递归同源区），须先过烟雾测试 + codex 审 + 用户点头。
const WORKER_ENABLED = process.env.ANIMA_WORKER_ENABLED === "1";

try {
  const input = JSON.parse(await Bun.stdin.text()) as { transcript_path?: string; session_id?: string };
  const { db, config, degraded } = openAnima();
  // R10 降级态（库比代码新、只读开库）：openAnima 已把"待升级"警示牌写进徽章。此时绝不能再走写路径——
  // ① 只读库上的 capture/入队/记账都会失败被裸 catch 吞成静默（gap4）；② 更糟的是 refreshBadge 会拿心情
  // 标签**盖掉刚写的"待升级"警示牌**（gap1 回归：修复自己把可见信号又抹了）。故整段跳过，只留可见信号。
  if (degraded) process.exit(0);
  try {
    if (input.transcript_path) captureTranscript(db, input.transcript_path);
    refreshBadge(db, config.badgePath); // 实时刷徽章：死亡螺旋当场亮灯，不等收工

    if (WORKER_ENABLED && input.transcript_path) {
      // 每轮入队（毫秒级本地）+ 懒启动 worker（死才拉、spawn 的是 bun worker 不是 claude、delete ANIMA_HEADLESS）。
      // **动态 import**：开关关时（绝大多数现状）根本不加载 worker/spawn 模块，off-switch 真隔离依赖面（codex F8）。
      const { enqueueReviewForStop } = await import("../src/worker");
      const { lazyStartWorker } = await import("../src/workerSpawn");
      enqueueReviewForStop(db, input.transcript_path, input.session_id ?? null);
      lazyStartWorker({
        dataDir: config.dataDir,
        scriptPath: join(import.meta.dir, "..", "scripts", "worker.ts"),
        now: new Date(),
      });
    }

    recordHookSuccess(db, "Stop");
  } catch (e) {
    recordHookFailure(db, "Stop", {
      error: String(e).slice(0, 300),
      threshold: config.hookAlertThreshold,
    });
  }
} catch {
  // 连库都开不了：没地方记账，安静退出（绝不打断用户工作）
}
process.exit(0);
