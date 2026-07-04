// 一键立即全愈:把所有 live 兜底壳整段重嚼成真自评(K 路并发)。事故后清积压用,不必等夜跑 ≤预算慢慢愈。
// 与夜间 stageHeal(增量·自动·有界)互补;本脚本=手动·全量·无上限。先 VACUUM INTO 自动备份再动。
// 用法: bun scripts/heal-now.ts [db路径] [并发K=3]
import { dirname } from "node:path";
import { openDb } from "../src/db";
import { healAllNow } from "../src/digest";
import { claudeCli } from "../src/llm";
import { digestPaths, isRunLockActive } from "../src/runLock";

const dbPath = process.argv[2] ?? `${process.env.HOME}/.claude/anima/anima.db`;
const K = Number(process.argv[3]) || 3;

// 防与夜跑并发(AUDIT A区#3 配套):夜跑 stageHeal 活着时别同时全愈。数据层已有幂等护栏兜底(撞同一壳
// 不会双写),但并发只是白烧 LLM token + 抢写锁。只读探锁、不取锁(故不碰夜跑那把锁的 30 分钟冷却),活着就让出。
// 探锁走内核 flock(isRunLockActive):对 PID 复用免疫,不会把复用了死 pid 的无关进程误当"夜跑在跑"(R5)。
{
  const paths = digestPaths(dirname(dbPath), new Date());
  if (isRunLockActive(paths)) {
    console.log(
      `⚠️ 夜跑 digest 正在跑——全愈与它并发只会白烧 token + 抢写锁,已退出。等它跑完再试(数据层有幂等护栏兜底,不会双写)。`,
    );
    process.exit(1);
  }
}

const db = openDb(dbPath);

// 安全:先备份(VACUUM INTO 出干净单文件,~1s)
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const bak = `${dbPath}.bak-pre-healnow-${stamp}`;
try {
  db.run(`VACUUM INTO '${bak}'`);
  console.log(`✅ 备份: ${bak}`);
} catch (e) {
  console.log(`⚠️ 备份失败(已中止,先解决备份再跑): ${(e as Error).message}`);
  process.exit(1);
}

const llm = claudeCli("haiku", 300_000);
console.log(`一键全愈 -> ${dbPath} (K=${K})`);
const t0 = Date.now();
const r = await healAllNow(db, { llm, concurrency: K, onProgress: (m) => console.log(`  ${m}`) });
console.log(
  `\n✅ 完成 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 共 ${r.total} 壳 → 愈 ${r.healed} / 失败 ${r.failed}(留壳下次再愈) / 空壳作废 ${r.inert} / 无transcript ${r.noTranscript}(留作诚实缺口)`,
);
db.close();
