// 梦游消化入口 —— 只允许两种启动方式：
//   ① launchd 调度（com.anima.digest：每天 11:00 + 登录时补跑）
//   ② 用户手动：bun scripts/digest.ts [--force]
// 绝不允许从 Claude hook 路径启动（事故 2026-06-12：SessionStart nohup 拉起 → 递归 claude -p → 满负载）。
// 防线：ANIMA_HEADLESS 递归保护 + 全局锁 + 冷却窗口 + pid/status/log 落盘 + SIGTERM 可安全停止。
// 补课：每次启动把所有"有活动但没消化完的夜"从旧到新清账（单次最多 7 夜），关机错过也不会永久漏。
import { openAnima } from "../src/index";
import {
  runNightlyDigestion,
  findUndigestedNights,
  requeueLateReclaim,
  findLateReclaimNights,
  guardDaysplitSwitch,
  type StageResult,
  type StageName,
} from "../src/digest";
import { claudeCli, killActiveLlmChild } from "../src/llm";
import { embedDocuments, disposeEmbedder } from "../src/embed";
import { recordHookFailure, recordHookSuccess } from "../src/hookHealth";
import {
  acquireRunLock,
  appendRunLog,
  digestPaths,
  releaseRunLock,
  writeRunStatus,
} from "../src/runLock";

// 递归保护：anima 自己拉起的 headless claude 里若再触发本脚本，立即退出
if (process.env.ANIMA_HEADLESS === "1") {
  console.error("anima digest: 递归保护触发（ANIMA_HEADLESS=1），拒绝启动");
  process.exit(0);
}

const force = process.argv.includes("--force");
const now = new Date();
const { db, config } = openAnima();
const paths = digestPaths(config.dataDir, now);

const daysplitOn = process.env.ANIMA_DAYSPLIT === "1";

// 没欠账就不取锁不留痕，毫秒退出（RunAtLoad 每次登录都会进来）：锁前**只读**探一眼有没有 work——普通欠账
// OR 迟到 reclaim 夜，都没有才退出。reclaim 的写副作用（删 makeup 行 + marker）移进锁内（codex 复验 5c/5d）：
// 单进程独占，消除「launchd 定时跑撞手动 bun scripts/digest.ts」的锁外竞态与重复 marker。
if (
  findUndigestedNights(db, { now }).nights.length === 0 &&
  (!daysplitOn || findLateReclaimNights(db, { now }).length === 0)
) {
  console.log("anima digest: 无欠账，退出");
  process.exit(0);
}

const cooldownMin = Number(process.env.ANIMA_DIGEST_COOLDOWN_MIN ?? "30");
const gate = acquireRunLock(paths, { cooldownMinutes: cooldownMin, force, now });
if (!gate.ok) {
  appendRunLog(paths, `启动被闸门拦下：${gate.reason}`);
  console.log(`anima digest: ${gate.reason}`);
  process.exit(0);
}

// day-split 切换前置闸（DESIGN-DAYSPLIT §3.6 / codex 修 A）：首次开 ANIMA_DAYSPLIT 时，若有 eligible 夜
// 在 center 模式下只跑了一半（≥1 done）→ 拒绝切换 + loud（防 center/daysplit 模式混攒静默半态）。必须排在
// 下面 reclaim 之前（reclaim 的 makeup 重置 eligible 夜是安全的、不该被本闸拦）。验干净落 daysplit_activated 标记。
if (daysplitOn) {
  const guard = guardDaysplitSwitch(db, { now });
  if (!guard.safe) {
    appendRunLog(paths, `ANIMA_DAYSPLIT 切换前置闸拒绝：${guard.reason}`);
    console.error(`anima digest: ANIMA_DAYSPLIT 切换被拒——${guard.reason}`);
    releaseRunLock(paths);
    process.exit(1); // 非 0 退出 = loud，launchd 日志可见
  }
  if (guard.activated) {
    appendRunLog(paths, "ANIMA_DAYSPLIT 首次切换：前置闸验过（无半态 eligible 夜），已落 daysplit_activated 标记");
  }
}

// 锁内：迟到认领 reclaim（DESIGN-DAYSPLIT §12）——把「all-done 夜又出现迟到 day-N 内容」的夜重置 makeup
// 触发重跑。必须在下面 findUndigestedNights 之前（否则迟到夜被判无账）。只 launchd 入口、绝不进 hook（事故
// 2026-06-12 铁律：hook 只读记账）。锁内单进程独占 → 无并发删行/重复 marker。
if (daysplitOn) {
  const reclaimed = requeueLateReclaim(db, { now });
  if (reclaimed.length > 0) {
    appendRunLog(paths, `迟到认领 reclaim：重置 makeup 重跑的夜=[${reclaimed.join(",")}]`);
  }
}

// 取锁后正式查账（reclaim 已把迟到夜的 makeup 标回未完成 → 这里纳入）
const { nights, deferred } = findUndigestedNights(db, { now });
if (nights.length === 0) {
  // 锁前判过有 work、锁内却空（极罕见：并发进程抢先处理完 reclaim 夜）→ 放锁退出、不留痕
  releaseRunLock(paths);
  console.log("anima digest: 无欠账，退出");
  process.exit(0);
}

writeRunStatus(paths, {
  pid: process.pid,
  night: nights.join(","),
  status: "running",
  startedAt: now.toISOString(),
});
appendRunLog(
  paths,
  `digest 启动 pid=${process.pid} 待消化夜=[${nights.join(",")}] force=${force}` +
    (deferred.length > 0 ? ` 本次推迟=[${deferred.join(",")}]（下次启动接着补）` : ""),
);

let finished = false;
const stopGracefully = (signal: string) => {
  if (finished) return;
  finished = true;
  appendRunLog(paths, `收到 ${signal}，停止当前 LLM 子进程并退出`);
  killActiveLlmChild();
  writeRunStatus(paths, {
    pid: process.pid,
    night: nights.join(","),
    status: "stopped",
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    detail: `被 ${signal} 安全停止；digest_runs 按阶段幂等，下次启动自动续跑`,
  });
  releaseRunLock(paths);
  // 信号路径也要释放 ONNX——否则 SIGTERM 撞在 vectorize 中途会触发 bun/onnxruntime 退出清理崩溃。
  // 同步处理器里 fire-and-forget：dispose 内部已 try/catch、且快，.finally 兜底退出。
  disposeEmbedder().catch(() => {}).finally(() => process.exit(0));
};
process.on("SIGTERM", () => stopGracefully("SIGTERM"));
process.on("SIGINT", () => stopGracefully("SIGINT"));

const allStages: Record<string, Record<StageName, StageResult>> = {};
let anyFailed = false;
try {
  for (const night of nights) {
    const result = await runNightlyDigestion(db, {
      night,
      // 自评止血：夜间 makeup 给 haiku 过度推理的尾巴留足时间跑完（300s），
      // 而非 120s 撞墙落 fallback 空壳（专杀长会话）。夜间 batch 没人等，安全。
      // ANIMA_LLM_TIMEOUT_MS 可在 launchd plist 覆盖，不改码即可调。
      llm: claudeCli("haiku", 300_000),
      embed: embedDocuments, // Phase 2：夜跑给当晚新记忆补语义指纹（vectorize 末阶段）
      config: {
        personalityPath: config.personalityPath,
        diaryDir: config.diaryDir,
        badgePath: config.badgePath,
      },
    });
    allStages[night] = result.stages;
    const failed = Object.values(result.stages).some((s) => s.status === "failed");
    anyFailed ||= failed;
    appendRunLog(paths, `夜 ${night}：${failed ? "有阶段失败" : "完成"} ${JSON.stringify(result.stages)}`);
  }
  console.log(JSON.stringify({ nights: allStages, deferred }));
  if (anyFailed) {
    recordHookFailure(db, "NightlyDigest", {
      error: JSON.stringify(allStages).slice(0, 300),
      threshold: config.hookAlertThreshold,
    });
  } else {
    recordHookSuccess(db, "NightlyDigest");
  }
  finished = true;
  writeRunStatus(paths, {
    pid: process.pid,
    night: nights.join(","),
    status: anyFailed ? "failed" : "done",
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    detail: { stages: allStages, deferred },
  });
} catch (e) {
  recordHookFailure(db, "NightlyDigest", { error: String(e).slice(0, 300) });
  appendRunLog(paths, `digest 异常：${String(e).slice(0, 300)}`);
  finished = true;
  writeRunStatus(paths, {
    pid: process.pid,
    night: nights.join(","),
    status: "failed",
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    detail: String(e).slice(0, 300),
  });
} finally {
  releaseRunLock(paths);
}
await disposeEmbedder(); // 释放 ONNX 会话（内部已 try/catch）；下面 exit(0) 兜底避 bun 退出清理崩溃
process.exit(0);
