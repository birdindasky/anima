// anima worker —— 实时层，会话期懒启动、处理 work_queue 里的增量自评，空闲自退。
// 设计：DESIGN-WORKER.md §5（方案 C：懒启动 + SQLite 队列 + 空闲自退、机器级单例、递归隔离）
//      + DESIGN-WORKER-RESUME.md §4.3（水位线增量自评取活两段式）/ §v5（per-turn 触发）。
// 递归命门：worker 调 LLM **一律走注入的 claudeCli**（已带 --setting-sources "" + ANIMA_HEADLESS=1 隔离）；
//          本文件**绝不**自写 spawn claude（N8/N9）。本块只做「处理单条」纯逻辑，进程生命周期在后续增量。
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { writeSchemaErrorBadge } from "./badge";
import { systemClock, type Clock } from "./clock";
import { TRANSCRIPT_ACTIVITY_KINDS, captureTranscript } from "./capture";
import { openDb } from "./db";
import { claudeCli, killActiveLlmChild, type LlmClient } from "./llm";
import {
  acquireRunLock,
  appendRunLog,
  releaseRunLock,
  taskRunPaths,
  writeRunStatus,
} from "./runLock";
import {
  buildIncrementalMaterial,
  generateSelfReview,
  storeSelfReviewResult,
} from "./selfReview";
import { readTranscriptEntries, atOrAfter, dayBoundUuid } from "./transcript";
import { localDate, SQL_LOCAL_OCCURRED_DATE } from "./tz";
import { advanceWatermarkOnly, readWatermark } from "./watermark";
// ⚠️ 铁规（实时向量化）：只 import **type**——EmbedFn 运行期擦除、不拉 vectorize→embed→transformers。
// hook 每次 Stop 都 import 本模块（enqueueReviewForStop 在此），若静态值导入 vectorize/embed 会把
// 几百 MB transformers 拉进 hook 热路径＝2026-06-12「hook 干重活」复发。真 backfillVectors 在
// advanced>0 分支里**动态** import；真 embed 由 scripts/worker.ts 入口注入（见 DESIGN-REALTIME-VECTORIZE）。
import type { EmbedFn } from "./vectorize";
import {
  countPendingReviews,
  enqueueReview,
  listPendingSessions,
  markReviewDone,
  reclaimStaleProcessing,
  recordReviewFailure,
  requeueReview,
  takeSessionReview,
  type WorkItem,
} from "./workQueue";

const ACTIVITY_KINDS_SQL = TRANSCRIPT_ACTIVITY_KINDS.map((k) => `'${k}'`).join(", ");

/**
 * 会话「重心夜」：situation_log 里该会话真实活动最多的那一夜（并列取较晚）。增量自评的 occurredAt 钉它
 * （§4.3-1 IMPORTANT-2），避免跨午夜 resume 把自评劈成两夜、被 closure/人格/日记按夜选材漏掉。
 * 无活动记录 → null（调用方退回 clock.now）。
 */
export function sessionCenterNight(db: Database, sessionId: string): string | null {
  const r = db
    .query(
      `SELECT ${SQL_LOCAL_OCCURRED_DATE} AS d, count(*) AS c FROM situation_log
        WHERE session_id = ? AND kind IN (${ACTIVITY_KINDS_SQL})
        GROUP BY ${SQL_LOCAL_OCCURRED_DATE}
        ORDER BY c DESC, d DESC LIMIT 1`,
    )
    .get(sessionId) as { d: string } | null;
  return r?.d ?? null;
}

export type ReviewOutcome =
  | "reviewed" // 写了真自评 + 推水位线 + 队列 done
  | "sliced_more" // daysplit 跨天：复盘/推进了本日切片、推进了水位线（一天），余段 requeue 等下轮处理下一天（队列仍 pending、属实质前进）
  | "covered" // 已覆盖 / 空增量 / lostRace：水位线已到位、队列 done，无新写
  | "requeued_target" // 标 done CAS 落空（处理期间 target 被更新）→ 翻 pending 当轮重取
  | "target_not_visible" // target 不在本进程文件视图 → requeue（无 attempt），等下轮
  | "watermark_ahead" // 水位线超前本快照 → requeue（无 attempt），等下轮一致视图
  | "transcript_missing" // transcript 文件不在/空 → 队列 done（不可恢复，不阻塞；夜跑经 experiences 兜底）
  | "aborted" // worker 停止中：requeue（无 attempt），交给下个 worker（codex F6）
  | "failed"; // 生成失败 → 计 attempt（留 pending 重试 / 到顶 failed），**不写自评、不推水位线**

/**
 * 处理单条取活的 WorkItem（§4.3 两段式：LLM 在事务外、落库水位线 CAS 在同步事务内）。
 * 各分支的队列收尾都在此完成，返回 outcome 供日志。**绝不**「没写成自评却推水位线/标 done」。
 */
export async function processReviewItem(
  db: Database,
  item: WorkItem,
  opts: { llm: LlmClient; clock?: Clock; maxAttempts?: number; shouldAbort?: () => boolean },
): Promise<ReviewOutcome> {
  const clock = opts.clock ?? systemClock;
  const sid = item.sessionId;

  if (!item.transcriptPath) {
    markReviewDone(db, sid, item.targetUuid); // 无 path，无从处理；不阻塞队列
    return "transcript_missing";
  }
  // **单读一次**：水位线定位 / 采集 / 增量切片共用同一份快照，消除多次读 live transcript 的视图漂移。
  const entries = readTranscriptEntries(item.transcriptPath);
  if (entries.length === 0) {
    markReviewDone(db, sid, item.targetUuid);
    return "transcript_missing";
  }

  const wmOld = readWatermark(db, sid);
  // 单调守卫（与 makeup 同口径）：wmOld 不在本快照（并发覆盖已推过 / 文件被重写）→ 绝不回退，requeue 等一致视图。
  if (wmOld !== null && entries.findIndex((e) => e.uuid === wmOld) === -1) {
    requeueReview(db, sid);
    return "watermark_ahead";
  }
  if (atOrAfter(entries, wmOld, item.targetUuid) === true) {
    // 水位线已到/越过 target（含 makeup/reclaim/上轮/别的 worker 已覆盖）→ 无活，直接收尾。
    // 用 atOrAfter 而非 `===`（codex ④）：target **严格早于**水位线（stale item——wm 被 makeup 走 dayBound /
    // reclaim 重跑推过）时，旧的相等判定 false → 落到下面空切片 advanceWatermarkOnly(wm→target) CAS 成功 →
    // **水位线回退**、下轮重复复盘。atOrAfter===true 把「已到达或越过」都收进 covered，绝不回退；
    // unsafe（target 不在快照）不在此收，继续走 buildIncrementalMaterial 的 target_not_visible requeue。
    markReviewDone(db, sid, item.targetUuid);
    return "covered";
  }

  // ANIMA_DAYSPLIT（DESIGN-DAYSPLIT §3.4）：worker 实时层也按真实东八日切片，与 makeup daysplit 段对齐。
  // 本片上界＝ min(item.target, 首条未审 entry 所在东八日的日界)；occurredAt 钉**那天**（非挂钟 today——
  // 00:30 处理昨晚会话时 today 会切错，codex N1）；目标跨过该日界 → 只复盘本日片、余段 requeue 下轮处理下一天。
  // off（center 路）逐字不变：sliceTarget=item.target、crossedDay=false、occurredAt 仍取重心夜。
  const daysplit = process.env.ANIMA_DAYSPLIT === "1";
  let sliceTarget = item.targetUuid;
  let crossedDay = false;
  let daysplitOccurredAt: string | undefined;
  if (daysplit) {
    const startIdx = wmOld === null ? 0 : entries.findIndex((e) => e.uuid === wmOld) + 1;
    let firstSliceDay: string | null = null;
    for (let i = startIdx; i < entries.length; i++) {
      const ts = entries[i]?.timestamp;
      if (ts) {
        firstSliceDay = localDate(ts);
        break;
      }
    }
    if (firstSliceDay !== null) {
      daysplitOccurredAt = `${firstSliceDay}T04:00:00.000Z`;
      const dayBound = dayBoundUuid(entries, firstSliceDay);
      if (dayBound !== null) {
        const dbIdx = entries.findIndex((e) => e.uuid === dayBound);
        const tgtIdx = entries.findIndex((e) => e.uuid === item.targetUuid);
        // 跨天＝日界严格早于本条目标（目标在更后一天）。目标不在本快照(tgtIdx<0)时：仅当日界后本快照仍有内容
        // (dbIdx<末条 → firstSliceDay 在本快照内已收口)才安全切日界、余段下轮；否则保守不切（当天尚未收口，
        // 走原 target_not_visible / 整段路），绝不把未收口的当天截半。
        const crosses = tgtIdx >= 0 ? dbIdx < tgtIdx : dbIdx >= 0 && dbIdx < entries.length - 1;
        if (crosses) {
          sliceTarget = dayBound;
          crossedDay = true;
        }
      }
    }
  }

  // 采集该增量段的客观事件进 situation_log（同一快照），供 buildIncrementalMaterial 的 events/兜底壳用。
  captureTranscript(db, item.transcriptPath, { clock, entries });

  const inc = buildIncrementalMaterial(db, {
    transcriptPath: item.transcriptPath,
    sessionId: sid,
    sinceUuid: wmOld,
    targetUuid: sliceTarget,
    entries,
  });
  if (!inc.ok) {
    // target 不可见（live transcript 还没把 target 那条落到本进程文件视图）→ 留待下轮，绝不烧 LLM/推水位线。
    requeueReview(db, sid);
    return "target_not_visible";
  }
  const newUuid = inc.lastUuid ?? sliceTarget;
  let occurredAt: string | undefined;
  if (daysplit && daysplitOccurredAt) {
    occurredAt = daysplitOccurredAt;
  } else {
    const centerNight = sessionCenterNight(db, sid);
    occurredAt = centerNight ? `${centerNight}T04:00:00.000Z` : undefined;
  }

  // 抢输验覆盖（§3.4，daysplit 两条收尾路共用）：落库 CAS 落空＝别人已推过水位线。重读水位线，仅真覆盖到
  // item.target 才标 done；否则余段（如跨天的下一天片）未消化 → requeue，绝不提前标 done 丢段。center 路不走此处
  // （保持旧行为：lostRace 直接 covered），仅 daysplit 段对齐需要逐日核覆盖。
  const finalizeRaceLost = (): ReviewOutcome => {
    const wmNow = readWatermark(db, sid);
    if (atOrAfter(entries, wmNow, item.targetUuid) === true) {
      markReviewDone(db, sid, item.targetUuid);
      return "covered";
    }
    requeueReview(db, sid);
    return "sliced_more";
  };

  // 空增量（三路素材全空）→ 推水位线、队列 done，不烧 LLM（与 makeup §3.3 同口径）。
  if (
    inc.material.conversation.length === 0 &&
    inc.material.events.length === 0 &&
    inc.material.bookmarks.length === 0
  ) {
    const advanced = advanceWatermarkOnly(db, sid, wmOld, newUuid, entries, clock);
    if (daysplit && !advanced) return finalizeRaceLost(); // 抢输验覆盖（含空增量 advanceWatermarkOnly 路，§3.4）
    if (daysplit && crossedDay) {
      requeueReview(db, sid); // 跨天空片：已推进到日界，余段下轮处理下一天，绝不标 done
      return "sliced_more";
    }
    markReviewDone(db, sid, item.targetUuid);
    return "covered";
  }

  // 第一段：LLM + validate（**事务外**）。失败 → 熔断计 attempt，绝不写自评/壳/推水位线（worker 重试，makeup 兜底）。
  const generated = await generateSelfReview({
    material: inc.material,
    llm: opts.llm,
    maxAttempts: opts.maxAttempts,
    shouldAbort: opts.shouldAbort,
  });
  if (!generated.ok) {
    if (opts.shouldAbort?.()) {
      requeueReview(db, sid); // 停止中失败：不计 attempt，原样留 pending 交给下个 worker（codex F6）
      return "aborted";
    }
    recordReviewFailure(db, sid, opts.maxAttempts ?? 2);
    return "failed";
  }

  // 第二段：水位线 CAS + 写库（同步事务）。CAS 落空＝同段被 makeup/别人抢先覆盖 → 视同已覆盖，收尾即可。
  const stored = storeSelfReviewResult(db, generated, {
    material: inc.material,
    clock,
    occurredAt,
    advanceWatermark: { oldUuid: wmOld, newUuid, entries },
    fallbackSituations: inc.situations,
  });
  if (stored.lostRace) {
    if (daysplit) return finalizeRaceLost(); // 抢输验覆盖：仅真覆盖到 item.target 才 done，否则 requeue 余段
    markReviewDone(db, sid, item.targetUuid);
    return "covered";
  }
  if (daysplit && crossedDay) {
    requeueReview(db, sid); // 跨天：本日片已写入，余段下轮处理下一天，绝不标 done/不计 attempt
    return "sliced_more";
  }
  const done = markReviewDone(db, sid, item.targetUuid);
  return done.requeued ? "requeued_target" : "reviewed";
}

export interface DrainResult {
  processed: number;
  /** 本轮有**实质前进**的会话数（reviewed/sliced_more/covered/transcript_missing/failed-到顶）。
   *  sliced_more=daysplit 跨天推进了水位线一天、余段 requeue（队列未净缩但水位线真前进，应立即续清下一天）。
   *  纯卡住 requeue（target 不可见 / 水位线超前 / target 变了 / 被 abort）不算前进。主循环据它决定立即再清还是退避，
   *  防卡住的 requeue 行被 `processed>0` 拖成 tight-loop（codex F4）。 */
  advanced: number;
  outcomes: Partial<Record<ReviewOutcome, number>>;
}

/** 哪些 outcome 算"实质前进"。reviewed/covered/missing/failed 队列净缩；sliced_more 队列未缩但水位线推进了一天
 *  （跨天逐日推进，必单调收敛、有限天数终止）→ 也算前进，主循环立即续清下一天。纯卡住 requeue（会原样回 pending）不算。 */
const ADVANCED_OUTCOMES: ReviewOutcome[] = ["reviewed", "sliced_more", "covered", "transcript_missing", "failed"];

/**
 * 清一轮队：取**本轮起始**的 pending 会话快照，每会话取活并处理**一次**。requeue（target 不可见 /
 * 水位线超前 / target 变了 / abort）的行不在本轮重取——留到下次唤醒，**防 CAS/requeue 忙转烧 LLM**（§v5.6-4）。
 * 这是 worker 主循环的一拍；进程级生命周期（取锁/信号/空闲自退）在 runWorker 包裹。
 */
export async function drainQueue(
  db: Database,
  opts: { llm: LlmClient; clock?: Clock; maxAttempts?: number; shouldAbort?: () => boolean },
): Promise<DrainResult> {
  const outcomes: Partial<Record<ReviewOutcome, number>> = {};
  let processed = 0;
  let advanced = 0;
  for (const sid of listPendingSessions(db)) {
    if (opts.shouldAbort?.()) break; // 收到停止信号：本轮不再取新会话
    const item = takeSessionReview(db, sid);
    if (!item) continue; // 已非 pending（被处理/done）
    const outcome = await processReviewItem(db, item, opts);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    processed++;
    if (ADVANCED_OUTCOMES.includes(outcome)) advanced++;
  }
  return { processed, advanced, outcomes };
}

const STALE_PROCESSING_MS = 10 * 60_000; // processing 超此久＝崩溃残留，启动自清回 pending（§5.6）

export interface RunWorkerOpts {
  dbPath: string;
  dataDir: string;
  /** 徽章路径（R10 可见降级）。默认 <dataDir>/badge.txt；scripts/worker.ts 传 config.badgePath 以尊重覆盖。 */
  badgePath?: string;
  llm: LlmClient;
  clock?: Clock;
  now?: Date;
  /** 空闲轮询间隔 ms（默认 2000）。测试传 0 = 不真睡。 */
  pollMs?: number;
  /** 队空持续 ≥ 此久则自退 ms（默认 5min）。测试传 0 = 清空即退。 */
  idleExitMs?: number;
  maxAttempts?: number;
  /**
   * 实时向量化（DESIGN-REALTIME-VECTORIZE）：注入则在每轮 drainQueue **实质前进后**给新写记忆补语义指纹，
   * 治"当天记忆白天语义瞎"。不注入＝退化成原行为（只夜跑算向量）。真 embedDocuments 只在 scripts/worker.ts
   * 入口接（带 sharp 桩 + dispose），本模块永不静态 import embed → hook 边界不破。
   */
  embed?: EmbedFn;
  /** **仅测试**：在 idle-exit 的"最后 pending 检查"之前触发，给测试注入新入队以确定性验救援分支（codex 测试缺口2）。 */
  onBeforeIdleCheck?: () => void;
}

export type RunWorkerReason = "lock_failed" | "idle_exit" | "stopped";

/**
 * worker 守护主体（§5.1/5.2/5.6）。**入口铁序**：取锁成功前绝不 open DB / 改状态。
 * ⚠️ ANIMA_HEADLESS 哨兵不在这里——必须在 **scripts/worker.ts 脚本入口、动态 import 本模块之前**纯文本查
 * （§S-7：ESM 静态 import 先于任何运行时判断，故哨兵要在 import 之外）。本函数假定已非 headless。
 * 流程：取锁(cooldown 0) → openDB → 自清陈旧 processing → 主循环(清队→空闲≥idleExit 自退；退前持锁查 pending)
 * → SIGTERM/SIGINT 优雅停（杀 LLM 子进程 + 写终态 + 放锁）。正常退出铁序：先写终态、再放锁（§5.6 防尸体误判）。
 */
export async function runWorker(opts: RunWorkerOpts): Promise<{ reason: RunWorkerReason; processed: number }> {
  const clock = opts.clock ?? systemClock;
  const startedAt = (opts.now ?? clock.now()).toISOString();
  const paths = taskRunPaths(opts.dataDir, "worker", opts.now ?? clock.now());

  // 取锁：cooldownMinutes:0（worker 随叫随到，§5.2/S1）。失败立即退、零副作用（不 openDB、不写状态）。
  const gate = acquireRunLock(paths, { cooldownMinutes: 0, now: opts.now ?? clock.now() });
  if (!gate.ok) return { reason: "lock_failed", processed: 0 };

  let stopping = false;
  const onSignal = () => {
    stopping = true;
    killActiveLlmChild(); // §5.6：停掉在跑的 headless claude 子进程
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // openDb 在取锁之后：任何异常都必须先放锁 + 摘信号，否则 releaseRunLock/db.close 永不执行＝锁与句柄泄漏
  // （R10 gap5）。schema 降级/损坏是 worker 这条常跑后门唯一没人亮徽章的口——补可见徽章（R10 gap3）后再抛。
  // worker 是写重进程，只读降级库上无活可干，故这里响亮抛出（背景进程非 0 退出，徽章即用户可见信号），
  // 不像 openAnima 那样退化成只读继续跑。
  let db: Database;
  try {
    db = openDb(opts.dbPath);
  } catch (e) {
    writeSchemaErrorBadge(opts.badgePath ?? join(opts.dataDir, "badge.txt"), e);
    releaseRunLock(paths);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    throw e;
  }
  let processed = 0;
  let reason: RunWorkerReason = "idle_exit";
  try {
    writeRunStatus(paths, { pid: process.pid, status: "running", startedAt });
    reclaimStaleProcessing(db, { staleMs: STALE_PROCESSING_MS, clock });

    const pollMs = opts.pollMs ?? 2000;
    const idleExitMs = opts.idleExitMs ?? 5 * 60_000;
    const shouldAbort = () => stopping;
    let idleSinceMs: number | null = null;
    let seenPending = countPendingReviews(db); // 已知 pending 数基线，用于区分"真新入队"vs"卡住的 requeue 行"
    while (!stopping) {
      const r = await drainQueue(db, { llm: opts.llm, clock, maxAttempts: opts.maxAttempts, shouldAbort });
      processed += r.processed;
      if (r.advanced > 0) {
        idleSinceMs = null;
        seenPending = countPendingReviews(db);
        // 实时向量化：本轮新写了记忆 → 给"缺当前模型指纹"的 live 行补向量（DESIGN-REALTIME-VECTORIZE）。
        // **局部 try/catch、非致命**：失败只 log，记忆已落库、夜跑 stageVectorize 仍兜底；绝不让异常冒泡到
        // 外层 try（那里会 throw 带崩整个 worker）。动态 import 把 transformers 留在 worker 进程、不毒 hook。
        if (opts.embed) {
          try {
            const { backfillVectors } = await import("./vectorize");
            await backfillVectors(db, opts.embed);
          } catch (e) {
            appendRunLog(paths, `实时向量化失败（非致命，夜跑兜底）：${String(e).slice(0, 200)}`, clock.now());
          }
        }
        continue; // 有**实质前进**（净缩队列）→ 立即接着清
      }
      // 本轮零前进（队空 / 只 requeue 卡住）：计空闲，够久则退；否则退避 poll，绝不 tight-loop（codex F4）。
      const nowMs = clock.now().getTime();
      if (idleSinceMs === null) idleSinceMs = nowMs;
      if (nowMs - idleSinceMs >= idleExitMs) {
        // 准备自退：先标 shutting_down，再**持锁做最后一次 pending 检查**（codex F5 收窄退出竞态窗）。
        writeRunStatus(paths, { pid: process.pid, status: "shutting_down", startedAt });
        opts.onBeforeIdleCheck?.(); // 仅测试注入点（见 RunWorkerOpts）
        const finalPending = countPendingReviews(db);
        if (finalPending > seenPending) {
          // pending **涨了** = 真有新会话入队（非卡住的 requeue）→ 收回退出、继续清（codex F4：只认增量）。
          idleSinceMs = null;
          seenPending = finalPending;
          writeRunStatus(paths, { pid: process.pid, status: "running", startedAt });
          continue;
        }
        // 队空 / 只剩卡住的 requeue（数没涨）→ 自退；卡住的那条由夜跑 makeup 兜底（不丢数据）。
        // ⚠️ 已知 MINOR 盲点（codex 边界4）：同一退出窗里"一条 done + 一条新入队"使总数恰好不变 → 救援不触发、
        //    新行留 pending、等下个 Stop/夜跑 makeup 兜底（≤一轮延迟、不丢数据）。realtime 要求更严可改比对
        //    入队身份/单调序号；当前按"数增长"足够且简单。
        break;
      }
      seenPending = countPendingReviews(db);
      if (pollMs > 0 && !stopping) await Bun.sleep(pollMs);
      else break; // pollMs=0（单轮/测试）：零前进即退，绝不空转
    }
    reason = stopping ? "stopped" : "idle_exit";
  } catch (e) {
    appendRunLog(paths, `worker 异常退出：${String(e).slice(0, 300)}`, clock.now());
    throw e;
  } finally {
    // 正常退出铁序（§5.6）：先写终态、再放锁（否则留"pid 没了 + status=running"尸体被误判 crashed）。
    writeRunStatus(paths, {
      pid: process.pid,
      status: reason === "stopped" ? "stopped" : "idle_exit",
      startedAt,
      finishedAt: clock.now().toISOString(),
    });
    releaseRunLock(paths);
    db.close();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  return { reason, processed };
}

/** 默认 LLM：haiku，超时沿用 llm.ts 的可调机制（worker 实时层超时可比夜跑短）。 */
export function defaultWorkerLlm(): LlmClient {
  return claudeCli("haiku");
}

/**
 * 每轮 Stop 入队（§4.2/§v5.2 delta-1）：算 transcript 当前末条 uuid 作 target，upsert 进队。纯毫秒级本地操作，
 * 不阻塞开工、不烧 LLM、不 spawn（spawn 由 hook 侧的 workerSpawn 单独做）。空 transcript / 无 sessionId → 不入队。
 */
export function enqueueReviewForStop(
  db: Database,
  transcriptPath: string,
  sessionId?: string | null,
  clock: Clock = systemClock,
): void {
  const entries = readTranscriptEntries(transcriptPath);
  const tail = entries.at(-1)?.uuid ?? null;
  if (tail === null) return; // 空 transcript，无可复盘尾巴
  const sid = sessionId ?? entries[0]?.sessionId ?? null;
  if (!sid) return;
  enqueueReview(db, { sessionId: sid, transcriptPath, targetUuid: tail }, clock);
}
