// worker 懒启动点。
// ⚠️⚠️ 进程创建红线（§5.4-3/N9）：本文件 + src/llm.ts 是全仓库**仅有的两个**允许进程创建原语的地方。
// 这里 spawn 的是 `bun scripts/worker.ts`（**不是 claude**）：worker 自带 ANIMA_HEADLESS 哨兵（脚本入口纯文本查）
// + 机器级单例锁，且它调 LLM 只走 claudeCli（带满隔离）——故链路「hook→bun worker→claudeCli→claude(带哨兵)→
// hook 秒退」环不闭合，不重蹈 2026-06-12 事故（那是 hook nohup 拉起会再触发 hook 的 claude）。
// **铁律 S4**：spawn 前必须 `delete env.ANIMA_HEADLESS`——worker 是顶层进程，带这标记会被自己的入口哨兵秒退；
// 且拉起方（hook）自己可能正运行在 headless 环境里，故必须显式 delete，不能靠"不设"。
import { openSync } from "node:fs";
import { isRunLockActive, readRunStatus, taskRunPaths } from "./runLock";

export type WorkerSpawn = (scriptPath: string, opts: { logPath: string; env: NodeJS.ProcessEnv }) => void;

/** 真实 spawn：detached + unref，fire-and-forget；stdout/stderr 指向 worker 日志文件。 */
const realSpawn: WorkerSpawn = (scriptPath, opts) => {
  const log = openSync(opts.logPath, "a");
  const proc = Bun.spawn(["bun", scriptPath], {
    detached: true,
    stdin: "ignore",
    stdout: log,
    stderr: log,
    env: opts.env,
  });
  proc.unref();
};

/**
 * 懒启动 worker（§5.1/5.2）：worker.pid 活 → 不重复 spawn（已有 worker 会清队）；死/无 → spawn 一个。
 * 双保险：即便此处误判去 spawn，新 worker 取锁失败会立即自退（第二个 worker 活不过取锁那一刻）。
 * 返回动作供观测/测试。spawn 注入可替换，便于单测决策逻辑而不真起进程。
 */
export function lazyStartWorker(
  opts: { dataDir: string; scriptPath: string; now: Date },
  spawn: WorkerSpawn = realSpawn,
): "started" | "alive" {
  const paths = taskRunPaths(opts.dataDir, "worker", opts.now);
  // 「worker 是否在跑」权威判据 = 锁是否被活进程 flock 持有（内核追踪、进程一死自动放）。不再靠 pid 整数比对，
  // 故对 PID 复用免疫——避免「崩溃 worker 的死 pid 被复用→isPidAlive 恒 true→worker 再也拉不起、实时层静默死」（R5 支线）。
  if (isRunLockActive(paths)) {
    // 正收尾（shutting_down）的 worker 视同"将退"：照常 spawn 一个，收窄"它刚退、新活没人接"的竞态窗
    // （codex F5）。新 worker 撞旧 worker 的锁会自退（双保险），旧 worker 退出后这条入队仍在 pending，
    // 等下次唤醒/夜跑兜底——残留窗口极小、不丢数据（§5.6 M2）。
    if (readRunStatus(paths)?.status !== "shutting_down") return "alive";
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANIMA_HEADLESS; // S4：worker 是顶层进程，绝不带哨兵标记
  spawn(opts.scriptPath, { logPath: paths.logPath, env });
  return "started";
}
