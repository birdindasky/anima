// Grader fixture (非 *.test.ts)：模拟一个"真在跑的 digest"。
// 用法: bun grader-digest-daemon.ts <dataDir> <taskName>
// 取真锁（内核 flock）+ 写 pid，打印 READY 到 stdout；收 SIGTERM 时释放锁并 exit 0（模拟优雅停机）。
import { acquireRunLock, releaseRunLock, taskRunPaths } from "../../src/runLock";

const [dataDir, taskName] = process.argv.slice(2);
const paths = taskRunPaths(dataDir, taskName, new Date());
const r = acquireRunLock(paths, { cooldownMinutes: 0 });
if (!r.ok) {
  console.log("ACQUIRE_FAILED");
  process.exit(2);
}
process.on("SIGTERM", () => {
  releaseRunLock(paths); // 优雅放锁（= digest stopGracefully 的 releaseRunLock）
  process.exit(0);
});
console.log("READY"); // 通知 grader：锁已到手，可以来 stop 了
// 挂着不退，等 digestctl SIGTERM
setInterval(() => {}, 1000);
