// workerctl —— worker 一键停止 / 状态查看。
// ⚠️ N15：绝不用宽 `pkill -f "claude -p ..."`——digest 与 worker 的 claude 子进程命令签名逐字相同，宽杀会互杀。
// 这里只按 worker 自己的 pid 精停：SIGTERM → worker handler 自己杀掉它的 claude 子进程 + 写终态 + 放锁；
// 10s 不退再 SIGKILL 兜底 + 清场。digest 的进程一根毫毛都不碰。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolveConfig } from "../src/config";
import { isPidAlive, isRunLockActive, readRunStatus, taskRunPaths, writeRunStatus } from "../src/runLock";

const cmd = process.argv[2];
const config = resolveConfig();
const paths = taskRunPaths(config.dataDir, "worker", new Date());

function readPid(): number | null {
  if (!existsSync(paths.pidPath)) return null;
  const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

if (cmd === "status") {
  const pid = readPid();
  // alive 权威判据走内核 flock（对 PID 复用免疫），不再拿 pid 文件里的整数猜死活。
  console.log(
    JSON.stringify({ pid, alive: isRunLockActive(paths), status: readRunStatus(paths) }, null, 2),
  );
  process.exit(0);
}

if (cmd === "stop") {
  // 先用内核 flock 权威判断有没有在跑：没在跑就清 pid 残留退出。绝不靠 isPidAlive(pid) ——那个对
  // PID 复用失明，会把复用了死 worker pid 的无关进程当活 worker，一 SIGTERM 误杀掉它（R5）。
  if (!isRunLockActive(paths)) {
    rmSync(paths.pidPath, { force: true }); // 锁文件常驻不删（避免 flock+unlink 竞态），只清 pid 提示
    console.log("anima workerctl: 没有在跑的 worker（已清理残留 pid）");
    process.exit(0);
  }
  const pid = readPid();
  if (pid == null) {
    // 锁被持有但 pid 文件缺失（取锁与写 pid 之间的极窄窗）：无从定向 SIGTERM，交由下次再停。
    console.log("anima workerctl: worker 在跑但读不到 pid，请稍后重试");
    process.exit(1);
  }
  process.kill(pid, "SIGTERM"); // worker handler：killActiveLlmChild + 写 stopped + releaseRunLock
  const deadline = Date.now() + 10_000;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(200);
  if (isPidAlive(pid)) {
    process.kill(pid, "SIGKILL"); // 兜底硬杀
    await Bun.sleep(200);
  }
  const prevStarted = readRunStatus(paths)?.startedAt ?? new Date().toISOString();
  rmSync(paths.pidPath, { force: true }); // 锁文件常驻不删；worker finally 已 close fd 放锁，这里只清 pid 提示
  writeRunStatus(paths, { pid, status: "stopped", startedAt: prevStarted, finishedAt: new Date().toISOString() });
  console.log(`anima workerctl: 已停止 worker (pid ${pid})`);
  process.exit(0);
}

console.log("用法: bun scripts/workerctl.ts [status|stop]");
process.exit(cmd ? 1 : 0);
