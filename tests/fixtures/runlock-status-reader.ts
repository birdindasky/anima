// R5 状态撕裂读夹具（非 *.test.ts）。
// 用法: bun runlock-status-reader.ts <dataDir> <taskName> <durationMs>
// 在 durationMs 内紧循环裸读 status.json 并 JSON.parse，统计"读到空/半截导致 parse 失败"的次数。
// 原子写（tmp+rename）下应恒为 0；旧的裸 writeFileSync（先 truncate 到 0 再写）会被并发读者撞出 >0。
import { readFileSync } from "node:fs";
import { taskRunPaths } from "../../src/runLock";

const [dataDir, taskName, durationRaw] = process.argv.slice(2);
const durationMs = Number(durationRaw) || 500;
const paths = taskRunPaths(dataDir, taskName, new Date());

let reads = 0;
let failures = 0;
const deadline = Date.now() + durationMs;
while (Date.now() < deadline) {
  let raw: string;
  try {
    raw = readFileSync(paths.statusPath, "utf8");
  } catch {
    continue; // 文件此刻不存在（rename 前一瞬），不算撕裂读
  }
  reads++;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.pid !== "number") failures++; // 解析出来但不完整
  } catch {
    failures++; // 读到空串/半截 JSON → 撕裂读
  }
}
console.log(JSON.stringify({ reads, failures }));
