// digestctl —— digest 一键停止 / 状态查看。R5（AUDIT-2026-07-03）：迁到 src/runLock.ts 的内核 flock
// 常驻锁模型，与 workerctl 同款语义。旧版 digestctl.sh 的两处硬伤全在这里根治：
//   ① 停进程时 `rm digest.lock` —— 踩爆「*.lock 锁文件常驻不删」不变量：删文件会开 flock+unlink 竞态
//      （P1 持旧 inode flock 尚未写 pid → unlink 锁文件 → P2 在同名新 inode 上 flock 成功 → 双持锁）。
//      本控制台**绝不 rm .lock**，只清 .pid 观测文件。
//   ② 用 `kill -0 pid` 猜死活 —— 对 PID 复用失明（复用了死 digest pid 的无关进程被误当活 digest → 误杀）。
//      「在不在跑」一律问内核 isRunLockActive（走 flock，对 PID 复用免疫）。
// ⚠️ N15：绝不用宽 `pkill -f "claude -p ..."` —— digest 与 worker 的 claude 子进程命令签名逐字相同，宽杀
//   会互杀。digest 收 SIGTERM 会自行 killActiveLlmChild + 写终态 + 放锁（scripts/digest.ts stopGracefully），
//   故这里只需 SIGTERM → 10s → SIGKILL 兜底，绝不做任何孤儿清扫。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolveConfig } from "../src/config";
import { digestPaths, isPidAlive, isRunLockActive, readRunStatus, writeRunStatus } from "../src/runLock";

const cmd = process.argv[2];
const config = resolveConfig();
const paths = digestPaths(config.dataDir, new Date());

function readPid(): number | null {
  if (!existsSync(paths.pidPath)) return null;
  const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

if (cmd === "status") {
  // alive 权威判据走内核 flock（对 PID 复用免疫，也不把"常驻锁文件存在"误当在跑）。
  console.log(
    JSON.stringify({ pid: readPid(), alive: isRunLockActive(paths), status: readRunStatus(paths) }, null, 2),
  );
  process.exit(0);
}

if (cmd === "stop") {
  // 先用内核 flock 权威判断有没有在跑：没在跑就清 pid 残留退出。绝不靠 kill -0(pid)——那对 PID 复用失明，
  // 会把复用了死 digest pid 的无关进程当活 digest，一 SIGTERM 误杀掉它（R5）。
  if (!isRunLockActive(paths)) {
    rmSync(paths.pidPath, { force: true }); // 锁文件常驻不删（避免 flock+unlink 竞态），只清 pid 提示
    console.log("anima digestctl: 没有在跑的 digest（已清理残留 pid）");
    process.exit(0);
  }
  const pid = readPid();
  if (pid == null) {
    // 锁被持有但 pid 文件缺失（取锁与写 pid 之间的极窄窗）：无从定向 SIGTERM，交由下次再停。
    console.log("anima digestctl: digest 在跑但读不到 pid，请稍后重试");
    process.exit(1);
  }
  process.kill(pid, "SIGTERM"); // digest stopGracefully：killActiveLlmChild + 写 stopped + releaseRunLock
  const deadline = Date.now() + 10_000;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(200);
  if (isPidAlive(pid)) {
    process.kill(pid, "SIGKILL"); // 兜底硬杀（进程一死内核随即自动放 flock）
    await Bun.sleep(200);
  }
  const prevStarted = readRunStatus(paths)?.startedAt ?? new Date().toISOString();
  rmSync(paths.pidPath, { force: true }); // 锁文件常驻不删；digest finally 已 close fd 放锁，这里只清 pid
  writeRunStatus(paths, { pid, status: "stopped", startedAt: prevStarted, finishedAt: new Date().toISOString() });
  console.log(`anima digestctl: 已停止 digest (pid ${pid})`);
  process.exit(0);
}

console.log("用法: bun scripts/digestctl.ts [status|stop]");
process.exit(cmd ? 1 : 0);
