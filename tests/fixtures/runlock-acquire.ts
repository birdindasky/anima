// R5 并发取锁夹具（非 *.test.ts，不被 bun test 当测试收集）。
// 用法: bun runlock-acquire.ts <dataDir> <taskName> <holdMs>
// 取锁：立刻打印 {ok} JSON；若拿到锁则持有 holdMs 毫秒再放（让并发同伴都在持锁窗口内撞锁）。
import { acquireRunLock, releaseRunLock, taskRunPaths } from "../../src/runLock";

const [dataDir, taskName, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw) || 0;
const paths = taskRunPaths(dataDir, taskName, new Date());
const r = acquireRunLock(paths, { cooldownMinutes: 0 });
console.log(JSON.stringify(r));
if (r.ok) {
  await Bun.sleep(holdMs);
  releaseRunLock(paths);
}
