// 夜间梦游消化：补课 → 画句号 → 电荷递减 → 人格 → 日记
// 五阶段独立可重试、各自状态记录（digest_runs），单阶段失败不阻塞其余【Codex审计】
// night 约定：(now - 12h) 的东八区日期——凌晨跑消化昨天
import type { Database } from "bun:sqlite";
import { localDate, SQL_LOCAL_OCCURRED_DATE, sqlLocalDate } from "./tz";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { refreshBadge } from "./badge";
import { emotionalCharge } from "./charge";
import { systemClock, type Clock } from "./clock";
import { captureTranscript, TRANSCRIPT_ACTIVITY_KINDS } from "./capture";
import { insertExperience, invalidateExperience, mapExperienceRow, type RawRow } from "./experiences";
import type { LlmClient } from "./llm";
import { buildIncrementalMaterial, buildMaterial, generateSelfReview, storeSelfReviewResult, type GeneratedSelfReview } from "./selfReview";
import {
  registerHeal,
  selectHealable,
  markHealDead,
  bumpHealAttempt,
  requeueHealNoPenalty,
  completeHeal,
  completeHealByShell,
  markExistingShellsUnhealable,
  MAX_HEAL_ATTEMPTS,
} from "./selfHeal";
import { appendSituation } from "./situation";
import { scrubMoodViolations } from "./sovereignty";
import { readTranscriptEntries, dayBoundUuid, atOrAfter, type TranscriptEntry } from "./transcript";
import { advanceWatermarkOnly, readWatermark } from "./watermark";
import { extractJson, extractMarkdownDoc, findUngroundedPaths } from "./validator";
import { backfillVectors, pruneOrphanVectors, type EmbedFn } from "./vectorize";

export interface DigestConfig {
  personalityPath: string;
  diaryDir: string;
  badgePath?: string;
}

// vectorize 末位：当晚内容写完（makeup 自评 + closure/人格/日记产物）后再补语义指纹，捞全当夜新记忆。
const STAGES = ["makeup", "heal", "closure", "decay", "personality", "diary", "vectorize"] as const;
export type StageName = (typeof STAGES)[number];

// 人格档软上限：old 超过此长度时，夜间改写切「精简整合」档（合并重复、压回紧凑）。
// 远低于改写验证的 8000 字符硬墙，留足缓冲——让文档在软线附近震荡，绝不撞墙冻死。
const PERSONALITY_SOFT_CAP = 4500;

// 会话归哪一夜 / 哪些夜待消化，只认 transcript 真实活动 kind（唯一源头 = 采集端
// TRANSCRIPT_ACTIVITY_KINDS）。消化产物 marker 的 occurred_at 来自消化时刻，绝不参与归属判定
// ——否则老会话凭空多一条"消化日流水"被错拽进当夜（"错盖夜"bug 的根源）。
const ACTIVITY_KINDS_SQL = TRANSCRIPT_ACTIVITY_KINDS.map((k) => `'${k}'`).join(", ");

export function getDigestStages(): StageName[] {
  return [...STAGES];
}

export interface StageResult {
  status: "done" | "failed";
  error?: string;
}

export interface DigestResult {
  night: string;
  stages: Record<StageName, StageResult>;
  skipped: StageName[];
}

export interface TranscriptRef {
  sessionId: string;
  path: string;
}

interface Ctx {
  db: Database;
  night: string;
  clock: Clock;
  llm: LlmClient;
  config: DigestConfig;
  findTranscripts: () => TranscriptRef[];
  embed?: EmbedFn;
}

export interface DigestOptions {
  llm: LlmClient;
  config: DigestConfig;
  clock?: Clock;
  /** 默认 (now-12h) 的日期；显式传入可补更早的夜 */
  night?: string;
  findTranscripts?: () => TranscriptRef[];
  /** 语义指纹补算用的 embedding 函数；不传则 vectorize 阶段安全空跑（保单测离线、不碰 ONNX） */
  embed?: EmbedFn;
  /** 仅测试用：替换单个阶段实现（注入故障等） */
  stageOverrides?: Partial<Record<StageName, (ctx: Ctx) => Promise<void>>>;
}

export function nightOf(now: Date): string {
  return localDate(new Date(now.getTime() - 12 * 3_600_000));
}

/**
 * 只有"已经过完的东八区日"才允许消化（返回最近一个可消化的夜 = 昨天的东八区日期）。
 * 为什么不用 nightOf：-12h 约定只在凌晨跑才对——上午 11 点（PDT=UTC 18 点）跑会把
 * 进行中的今天算成 night，提前标 done，今晚的会话明天就被跳过。
 */
export function latestCompletedNight(now: Date): string {
  return localDate(new Date(now.getTime() - 86_400_000));
}

/**
 * 找出所有"有活动但没消化完"的夜，从旧到新——任何一次 digest 成功跑起来就把欠账全清，
 * 治"电脑关机错过定时任务 → 那一天永久没人消化"的洞。
 * max 限制单次补课量（默认 7 夜），超出的记在返回值 deferred 里，调用方负责把被推迟的喊出来。
 */
export function findUndigestedNights(
  db: Database,
  opts: { now?: Date; max?: number } = {},
): { nights: string[]; deferred: string[] } {
  const now = opts.now ?? new Date();
  const max = opts.max ?? 7;
  const cutoff = latestCompletedNight(now);
  const rows = db
    .query(
      `SELECT d FROM (
         SELECT DISTINCT ${SQL_LOCAL_OCCURRED_DATE} d FROM situation_log
           WHERE kind IN (${ACTIVITY_KINDS_SQL})
         UNION
         SELECT DISTINCT ${SQL_LOCAL_OCCURRED_DATE} FROM experiences
       )
       WHERE d <= ?
         AND (SELECT count(*) FROM digest_runs r WHERE r.night = d AND r.status = 'done') < ?
       ORDER BY d ASC`,
    )
    .all(cutoff, STAGES.length) as { d: string }[];
  const all = rows.map((r) => r.d);
  return { nights: all.slice(0, max), deferred: all.slice(max) };
}

/**
 * day-split 切换前置闸（DESIGN-DAYSPLIT §3.6 / codex 修 A，代码强制非口头）。切到 ANIMA_DAYSPLIT 那一刻，
 * 若有 **eligible 夜**（findUndigestedNights 返回的、本次要处理的）已在 center 模式下跑过部分阶段
 * （digest_runs 有 ≥1 done）→ 拒绝切换。否则：center 标了 closure/日记/人格 done、makeup 还失败留着，
 * daysplit 新模式按不同夜归属补的自评喂不进那夜已 done 的下游 → 静默半态（codex 复审 Q4）。
 *
 * 只查 eligible 夜（非全库）：避开 ① 老「全 done」夜因 STAGES 从 6 长到 7（加 heal）缺 heal 行被误判半态、
 * ② 古老卡死的非 eligible 夜误拦。验干净则落 meta `daysplit_activated` 标记，之后正常运行**不再拦**
 * （daysplit 自身偶发阶段失败=半态由 orchestrator 重试，永久拦会锁死后续夜）。
 *
 * 必须排在 reclaim **之前**调（reclaim 处理 all-done 夜的迟到 day-N 内容，归属夜 N 两模式一致、无错配，
 * 不该被本闸拦；它产生的「makeup 重置」eligible 夜是安全的，故闸只看 reclaim 前的 eligible 集）。
 * 纯读 + 干净时落一次标记；不读 transcript、有界。只 launchd 入口锁内调。
 */
export function guardDaysplitSwitch(
  db: Database,
  opts: { now?: Date } = {},
): { safe: true; activated: boolean } | { safe: false; reason: string } {
  // 已切换过 → 放行，不再拦（防 daysplit 正常运行的偶发半态把后续夜锁死）
  const marker = db.query("SELECT value FROM meta WHERE key = 'daysplit_activated'").get() as
    | { value: string }
    | null;
  if (marker) return { safe: true, activated: false };

  // 首次切换：在本次 eligible 夜里找危险半态夜。危险信号＝**makeup 没 done 但有其他阶段已 done**
  // ——即 center 模式 makeup 失败/没跑、下游(closure/人格/日记)却 done：daysplit 补的 makeup 自评喂不进
  // 那夜已 done 的下游 → 孤儿（codex Q4）。**不能只看「done>0」**：老「全 done」夜（加 heal 前 6 阶段）因
  // findUndigestedNights 用 <STAGES.length(7) 判、缺 heal 行被当 eligible，但它 makeup=done、是安全的，绝不能误拦。
  const eligible = findUndigestedNights(db, { now: opts.now }).nights;
  const dirty: string[] = [];
  for (const night of eligible) {
    const r = db
      .query(
        `SELECT
           SUM(CASE WHEN stage = 'makeup' AND status = 'done' THEN 1 ELSE 0 END) AS makeupDone,
           SUM(CASE WHEN stage != 'makeup' AND status = 'done' THEN 1 ELSE 0 END) AS otherDone
         FROM digest_runs WHERE night = ?`,
      )
      .get(night) as { makeupDone: number | null; otherDone: number | null };
    if ((r.makeupDone ?? 0) === 0 && (r.otherDone ?? 0) > 0) {
      dirty.push(`${night}(makeup 未完成但下游已 done ${r.otherDone} 阶段)`);
    }
  }
  if (dirty.length > 0) {
    return {
      safe: false,
      reason:
        `检测到 eligible 半态夜 [${dirty.join(", ")}]——这些夜在 center 模式下只跑完部分阶段。禁止半态切 daysplit` +
        `（center/daysplit 模式混攒会造成静默半态，codex 修 A/Q4）。请先在 center 模式（关 ANIMA_DAYSPLIT）` +
        `把这些夜跑完整，再开 daysplit。`,
    };
  }
  // 干净 → 落标记，本次起正式切换到 daysplit
  db.query(
    "INSERT INTO meta (key, value) VALUES ('daysplit_activated', ?) ON CONFLICT(key) DO NOTHING",
  ).run((opts.now ?? new Date()).toISOString());
  return { safe: true, activated: true };
}

/**
 * 迟到认领检测（只读，DESIGN-DAYSPLIT §12）：返回「makeup 已 done、但有 day-N 活动 `created_at >=` 该夜 makeup
 * `finished_at`」的夜（旧→新）——这类夜在 night N all-stages-done 后才出现属于 day N 的迟到内容（采集滞后 / 极晚
 * resume / worker off），`findUndigestedNights` 因 all-done 把它排除、永久漏（daysplit 入口预采集闭不掉，codex 三验）。
 *
 * **判据用 `>=` 而非 `>`（codex 复验）**：makeup 处理过的活动必在 makeup 完成前入库（预采集在 record done 之前），
 * 故 created_at **严格 <** finished_at；恰好 `== finished_at`（同毫秒入库）的活动 makeup 没处理过 → 是真迟到，
 * `>` 会静默漏掉它（漏＝永久丢；误收＝重跑一次空跑、幂等无害——宁多跑不可漏）。
 *
 * 纯 SQL（digest_runs ⋈ situation_log EXISTS）、有界、不读 transcript、**零副作用**——launchd 锁前判 work 用。
 */
export function findLateReclaimNights(db: Database, opts: { now?: Date } = {}): string[] {
  const now = opts.now ?? new Date();
  const cutoff = latestCompletedNight(now);
  const rows = db
    .query(
      `SELECT dr.night AS d FROM digest_runs dr
        WHERE dr.stage = 'makeup' AND dr.status = 'done' AND dr.night <= ?
          AND EXISTS (
            SELECT 1 FROM situation_log sl
             WHERE sl.session_id IS NOT NULL AND sl.kind IN (${ACTIVITY_KINDS_SQL})
               AND ${sqlLocalDate("sl.occurred_at")} = dr.night
               AND sl.created_at >= dr.finished_at
          )
        ORDER BY dr.night ASC`,
    )
    .all(cutoff) as { d: string }[];
  return rows.map((r) => r.d);
}

/**
 * 迟到认领执行（写副作用）：`findLateReclaimNights` + 对每个迟到夜 **删 makeup digest_runs 行**（只重 makeup、
 * 其余阶段 done 保留，避免 closure/personality 重复副作用）触发下游 `findUndigestedNights` 自动纳入 +
 * `runNightlyDigestion` 只重跑 makeup；留 `digest_late_reclaim` marker（night 级、无 session_id，不进 daySessions
 * 归属判定）。返回**真正被本次删除触发**的夜（旧→新）。
 *
 * **删行用 changes-CAS（codex 复验 5b）**：只有真删掉那行的进程（`changes>0`）才写 marker——两个进程并发抢同夜
 * 时只一个 `changes>0`，杜绝重复 marker。**只在 launchd 入口、锁内、`ANIMA_DAYSPLIT=1` 下调用**（codex 复验 5c/5d：
 * 移进 run lock 内，单进程独占、无锁外竞态）——带 DB 写副作用，绝不进任何 hook 路径（事故 2026-06-12 铁律）。
 *
 * **收敛**：重跑后 makeup `finished_at` 刷新到当前（晚于所有已入库迟到活动 created_at）→ 下次 `created_at < 新
 * finished_at` → 不再触发，单调收敛、无死循环。
 */
export function requeueLateReclaim(db: Database, opts: { now?: Date } = {}): string[] {
  const reclaimed: string[] = [];
  for (const night of findLateReclaimNights(db, opts)) {
    const deleted = db
      .query("DELETE FROM digest_runs WHERE night = ? AND stage = 'makeup'")
      .run(night).changes;
    if (deleted > 0) {
      appendSituation(db, { kind: "digest_late_reclaim", payload: { night } }, systemClock);
      reclaimed.push(night);
    }
  }
  return reclaimed;
}

/** 默认 transcript 发现：从采集游标里反查（曾被采集过的 transcript 都在册） */
export function defaultFindTranscripts(db: Database): TranscriptRef[] {
  const rows = db.query("SELECT transcript_path FROM capture_cursors").all() as {
    transcript_path: string;
  }[];
  const refs: TranscriptRef[] = [];
  for (const r of rows) {
    const sessionId = readTranscriptEntries(r.transcript_path)[0]?.sessionId;
    if (sessionId) refs.push({ sessionId, path: r.transcript_path });
  }
  return refs;
}

// ---------- 有界重试的 LLM 调用（同 Phase 1 哲学：2 次封顶，绝不空等） ----------
async function tryLlm<T>(
  llm: LlmClient,
  prompt: string,
  validate: (raw: string) => T | null,
  maxAttempts = 2,
): Promise<T | null> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const parsed = validate(await llm(prompt));
      if (parsed !== null) return parsed;
    } catch {
      // 调用失败计入尝试次数
    }
  }
  return null;
}

// ---------- 阶段实现 ----------

/**
 * 补课（水位线判定，DESIGN-WORKER-RESUME §5）：当夜会话里「transcript 末 uuid > 已覆盖水位线」的，
 * 从水位线之后补一条**增量**自评、并原子推进水位线。取代旧的「有任意自评就整会话跳过」二元判定
 * ——后者会把 resume 后半段（前半段已自评 → 整会话被判已复盘）永久漏掉。
 * 与 worker 共用同一套水位线：worker 实时覆盖大头，makeup 兜底捡漏（worker 挂 / 没触发 / target 没追上）。
 * 去重不靠脏读 work_queue（旧 SEVERE-1 让位逻辑会把"让位的夜"标 done→worker 若死则永久漏，codex 审逮到），
 * 而靠水位线 CAS：worker 已覆盖到末尾的会话 wmOld==tailUuid 自然跳过；未覆盖的 makeup 照常兜底，万一与
 * worker 撞同段，CAS 让其一方 lostRace（最多废一次 haiku，绝不双写、绝不漏）。
 *
 * **完成判据（codex 复审）**：本夜 makeup 只有当每个会话的尾巴都覆盖到 tailUuid 才算 done。任何会话留了
 * 未覆盖尾巴（与 worker 竞态 lostRace 半覆盖 / 待回填）→ 整阶段 throw → digest_runs 记 failed → 下轮真重跑
 * （不靠"continue 假装重试"——阶段一旦标 done 就再不回来，FATAL）。LLM 失败不算未覆盖：走有界兜底壳
 * + 推水位线（绝不空等 + 不留永久缺口），与拆分前同口径（壳可被作废以触发重补）。
 */
async function stageMakeup(ctx: Ctx): Promise<void> {
  // ANIMA_DAYSPLIT（DESIGN-DAYSPLIT §3.3）：按真实东八日归属 + 日界切片，结构性堵死孤儿尾巴。
  // 默认 off 走下方旧 center 路（整段归重心夜，逐字不变、零回归）。
  if (process.env.ANIMA_DAYSPLIT === "1") return stageMakeupDaysplit(ctx);
  const daySessions = (
    ctx.db
      .query(
        // 会话归哪一夜：只认真实活动 kind（见 ACTIVITY_KINDS_SQL），且整段会话归「重心夜」
        // ——真实活动最多的那一夜（并列取较晚夜）。跨午夜的长会话只被它的重心夜认领。
        `WITH per_night AS (
           SELECT session_id AS sid, ${SQL_LOCAL_OCCURRED_DATE} AS d, count(*) AS c
           FROM situation_log
           WHERE session_id IS NOT NULL AND kind IN (${ACTIVITY_KINDS_SQL})
           GROUP BY session_id, ${SQL_LOCAL_OCCURRED_DATE}
         )
         SELECT sid AS s FROM (
           SELECT sid, d, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY c DESC, d DESC) AS rn
           FROM per_night
         ) WHERE rn = 1 AND d = ?`,
      )
      .all(ctx.night) as { s: string }[]
  ).map((r) => r.s);
  if (daySessions.length === 0) return;

  const occurredAt = `${ctx.night}T04:00:00.000Z`; // 归属所属夜，非消化时刻（夜 N+1）
  let incomplete = false; // 任一会话尾巴没覆盖到 tail → 整阶段标失败、下轮真重跑

  const transcripts = ctx.findTranscripts();
  for (const sessionId of daySessions) {
    const ref = transcripts.find((t) => t.sessionId === sessionId);
    if (!ref) {
      // transcript 文件不在（删/轮转，readTranscriptEntries existsSync=false 返空、defaultFindTranscripts
      // 不产 ref）：不可恢复，别死循环阻塞这一夜（不标 incomplete）。留 marker 让缺口可见，非静默（codex 建议）。
      appendSituation(ctx.db, { sessionId, kind: "makeup_transcript_missing", occurredAt }, ctx.clock);
      continue;
    }
    // **整段单读一次**：采集 / tailUuid / 水位线定位 / 增量切片全基于这同一份快照，消除多次读 live
    // transcript 的视图漂移——尤其防 captureTranscript 与切片之间追加导致"事件没采进 situation_log、
    // 切片却已含该回合 → 误判 inert 推过水位线"（codex IMPORTANT）。
    const entries = readTranscriptEntries(ref.path);
    captureTranscript(ctx.db, ref.path, { clock: ctx.clock, entries }); // 兜底捕齐（同一快照）
    const tailUuid = entries.at(-1)?.uuid ?? null;
    if (tailUuid === null) continue; // 空 transcript
    const wmOld = readWatermark(ctx.db, sessionId);
    if (wmOld === tailUuid) continue; // 已覆盖到末尾（含 worker 已实时覆盖），无未复盘尾巴

    // I3/I-9 回填守卫：有旧自评却无水位线 = backfill-watermark 没跑。绝不全量重刷（会写重复自评）——
    // 无从重建"旧自评覆盖到哪"，只能由 backfill 读那时的 transcript 末条来定。标 incomplete + marker，
    // 阶段失败、loud、下轮重试；跑过 backfill 后该会话有水位线、守卫不再触发。
    if (wmOld === null && sessionHasReview(ctx.db, sessionId)) {
      appendSituation(
        ctx.db,
        { sessionId, kind: "makeup_backfill_required", payload: { tailUuid }, occurredAt },
        ctx.clock,
      );
      incomplete = true;
      continue;
    }

    // **单调守卫（codex SEVERE 水位线回退）**：只在 wmOld 能在本快照里定位、且严格早于尾巴时才推进。
    // append-only transcript 里 wmOld 若在快照内，必 ≤ tailUuid 位置（==已被上面排除）→ 推进恒前向、安全。
    // wmOld 不在快照（并发 worker 见过更新文件、把水位线推过我们的快照尾巴 / 文件被外部重写）→ 本轮无法
    // 安全增量：绝不退化全量、也绝不把水位线往回退（CAS 只查旧值不挡回退），留 marker + incomplete 下轮重试。
    if (wmOld !== null && entries.findIndex((e) => e.uuid === wmOld) === -1) {
      appendSituation(
        ctx.db,
        { sessionId, kind: "makeup_watermark_ahead", payload: { wmOld, tailUuid }, occurredAt },
        ctx.clock,
      );
      incomplete = true;
      continue;
    }

    // 传 targetUuid=tailUuid 把增量上界钉死在快照那条（codex SEVERE）+ 复用同一份 entries：
    // 切片只到快照、CAS 只推到快照、覆盖校验对同一快照——消除读末条→写之间的活 transcript 竞态。
    const inc = buildIncrementalMaterial(ctx.db, {
      transcriptPath: ref.path,
      sessionId,
      sinceUuid: wmOld,
      targetUuid: tailUuid,
      entries,
    });
    if (!inc.ok) {
      incomplete = true; // 快照不可见（不该发生：targetUuid 取自同一 entries）；保险留待重试
      continue;
    }
    const newUuid = inc.lastUuid ?? tailUuid;

    // 空增量＝三路素材全空（resume 了但无任何可复盘内容：对话/客观事件/书签都没有）。
    // 只看 conversation 会漏掉「纯工具/测试/改文件、无对话文本」的尾巴（codex S2）——那种有 events、该复盘。
    if (
      inc.material.conversation.length === 0 &&
      inc.material.events.length === 0 &&
      inc.material.bookmarks.length === 0
    ) {
      // 有原始条目却无可复盘内容（纯 Read/Grep 工具回合 / 仅 meta 噪声）→ 推水位线（无可喂 LLM 的内容、
      // 推过避免每夜重排，§3.3），但留 marker 供观测（codex IMPORTANT：别静默推过非空切片）。真空段（0 条）不留噪。
      if (inc.sliceEntryCount > 0) {
        appendSituation(
          ctx.db,
          { sessionId, kind: "makeup_inert_tail", payload: { entries: inc.sliceEntryCount, tailUuid }, occurredAt },
          ctx.clock,
        );
      }
      advanceWatermarkOnly(ctx.db, sessionId, wmOld, newUuid, entries, ctx.clock);
    } else {
      // 生成（失败也走 storeSelfReviewResult：有界兜底壳 + marker + 推水位线，绝不空等、不留永久缺口）。
      const generated = await generateSelfReview({ material: inc.material, llm: ctx.llm });
      storeSelfReviewResult(ctx.db, generated, {
        material: inc.material,
        clock: ctx.clock,
        occurredAt,
        advanceWatermark: { oldUuid: wmOld, newUuid, entries },
        fallbackSituations: inc.situations, // 兜底壳只统计本段，不汇总全场（codex I1）
        // 兜底壳产生 → 同事务内登记自愈账（§3.2）。since/target = 本切片区间，night = 本夜（归属夜）。
        onFallbackShell: (shellId) =>
          registerHeal(
            ctx.db,
            { sessionId, sinceUuid: wmOld, targetUuid: newUuid, shellId, night: ctx.night },
            ctx.clock,
          ),
      });
    }

    // 统一覆盖校验：写完重读水位线，没到 tail（与 worker 竞态 lostRace 半覆盖等）→ 留待下轮重跑（codex S1/SEVERE）。
    if (readWatermark(ctx.db, sessionId) !== tailUuid) incomplete = true;
  }

  if (incomplete) {
    throw new Error("makeup: 部分会话本轮未覆盖到末尾（待回填 / 与 worker 竞态半覆盖），阶段标失败、下轮重跑");
  }
}

/**
 * 补课（daysplit 路，DESIGN-DAYSPLIT §3.3）：每条活动归真实东八日，本夜只消化「本日切片」
 * `(wmOld, dayBound]`（dayBound = 本快照里东八日 ctx.night 的半开日界 uuid）。
 *
 * 与 center 路的根本区别：选会话不再按「重心夜」整段认领，而是按「本夜有真实活动」——跨午夜会话
 * 在 day N 与 day N+1 各被对应夜认领自己的切片，孤儿尾巴（尾巴在另一天）由那天的夜结构性堵死，无需 reclaim。
 *
 * 所有 tailUuid 判定换 dayBound 的 `atOrAfter`（F1：dayBound 非快照末条、worker 可能已推过水位线，
 * `===` 比 UUID 会误判；不在快照 → unsafe → 走单调守卫，绝不当 false/true）。
 * 不变量①回填守卫 ②单调守卫 ③空增量推水位线 ④失败兜底壳 ⑤覆盖判据 ⑥单读快照——全保留。
 */
async function stageMakeupDaysplit(ctx: Ctx): Promise<void> {
  // 入口预采集（codex 审 Fix②）：daySessions 靠 situation_log 选「本夜有活动」的会话，但采集若滞后于本次
  // makeup（会话跨零点后才 Stop / Stop hook 失败被吞 / worker 未启用），本夜尾巴仅存于 transcript 文件、尚未
  // 落 situation_log → 选不到、本夜漏、且本夜一旦标 done 再不重跑 → 静默永久漏（worker 与 retry 均不兜底）。
  // 先把所有在册 transcript 增量采集一轮（游标短路、已采过的 no-op、成本低），让 transcript 里的尾巴进库，
  // 再查 daySessions——真正结构性堵死孤儿尾巴，而非只堵「已采集但归错夜」那半。
  // 单读一次并缓存 entries（不变量⑥）：下面选夜兜底 + 逐会话切片复用同一份快照，消除二次读 live transcript。
  const transcripts = ctx.findTranscripts();
  const entriesBySession = new Map<string, TranscriptEntry[]>();
  for (const ref of transcripts) {
    const entries = readTranscriptEntries(ref.path);
    captureTranscript(ctx.db, ref.path, { clock: ctx.clock, entries });
    entriesBySession.set(ref.sessionId, entries);
  }

  // 选夜（两源并集，DESIGN-DAYSPLIT §3.3）：
  // (1) situation_log activity 路：本夜有真实活动 kind 的会话（user_message/工具类），不聚合重心夜——
  //     跨午夜会话在 day N / day N+1 各被对应夜选中。
  const sqlSessions = (
    ctx.db
      .query(
        `SELECT DISTINCT session_id AS s FROM situation_log
           WHERE session_id IS NOT NULL AND kind IN (${ACTIVITY_KINDS_SQL})
             AND ${SQL_LOCAL_OCCURRED_DATE} = ?`,
      )
      .all(ctx.night) as { s: string }[]
  ).map((r) => r.s);
  // (2) 纯 assistant 尾巴兜底：assistant 纯文本不产任何 activity kind 行（TRANSCRIPT_ACTIVITY_KINDS 仅
  //     user_message + 工具类）→ 跨午夜会话若午夜后那段是纯 assistant 输出（没人再说话、无工具），本夜在
  //     situation_log 里 0 activity 行 → (1) 选不到 → 该夜切片永不消化、无 marker、静默丢（center 按重心夜
  //     整段认领不暴露，仅 daysplit 按日切片暴露）。真相源是 transcript：把「本夜东八日有真实条目」的会话也纳入。
  //     宽进无害：选中但本夜实无未覆盖切片的会话，下面 reached(atOrAfter)/空增量会正确跳过，绝不误写。
  const daySessionsSet = new Set(sqlSessions);
  for (const ref of transcripts) {
    if (daySessionsSet.has(ref.sessionId)) continue;
    const entries = entriesBySession.get(ref.sessionId);
    if (entries?.some((e) => e.timestamp !== null && localDate(e.timestamp) === ctx.night)) {
      daySessionsSet.add(ref.sessionId);
    }
  }
  const daySessions = [...daySessionsSet];
  if (daySessions.length === 0) return;

  const occurredAt = `${ctx.night}T04:00:00.000Z`; // 归属本夜，非消化时刻
  let incomplete = false;

  for (const sessionId of daySessions) {
    const ref = transcripts.find((t) => t.sessionId === sessionId);
    if (!ref) {
      // transcript 不在（删/轮转）：不可恢复，留 marker 让缺口可见、不阻塞这一夜（同 center 路）。
      appendSituation(ctx.db, { sessionId, kind: "makeup_transcript_missing", occurredAt }, ctx.clock);
      continue;
    }
    // 整段单读一次（不变量⑥）：复用入口缓存的同一份快照（采集已在入口完成；日界定位 / 增量切片 / 覆盖校验同源）。
    const entries = entriesBySession.get(sessionId) ?? readTranscriptEntries(ref.path);
    if (entries.length === 0) continue; // 空 transcript

    // 本夜上界＝东八日界（半开 `< ${night}T16:00Z`）。本夜有真实活动 → 通常必有早于日界的条目。
    // null（采集滞后于本快照：活动行在 situation_log，但 transcript 快照里尚无对应早条目）→ 保守跳过、
    // 不阻塞、不留噪：下轮读到一致视图再处理。
    const dayBound = dayBoundUuid(entries, ctx.night);
    if (dayBound === null) {
      // daySessions 已确认本夜有真实活动，却在本快照里产不出日界（transcript 轮转 / 头部截断 / 快照不全：
      // 本夜活动条目不在当前 entries 视图里）。绝不静默裸 continue（codex 审）：留 loud marker + incomplete
      // 触发下轮重跑——采集滞后/快照暂态可自愈，真不可恢复则持续 loud failed 让人查，都胜过静默漏掉本夜切片。
      appendSituation(
        ctx.db,
        { sessionId, kind: "makeup_daysplit_snapshot_missing", occurredAt },
        ctx.clock,
      );
      incomplete = true;
      continue;
    }

    const wmOld = readWatermark(ctx.db, sessionId);

    // 完成/覆盖判据（不变量⑤，F1）：水位线已到/过本日界（worker 实时推过 / 前一夜推过）→ 本夜切片无需补。
    const reached = atOrAfter(entries, wmOld, dayBound);
    if (reached === true) continue;

    // 单调守卫（不变量②，codex SEVERE/F1）：wmOld 不在本快照（并发 worker 已推过我们快照尾巴 / 文件外部
    // 重写）→ atOrAfter 返回 "unsafe"：本轮无法安全增量，绝不退化全量、绝不回退水位线，留 marker + 重试。
    if (reached === "unsafe") {
      appendSituation(
        ctx.db,
        { sessionId, kind: "makeup_watermark_ahead", payload: { wmOld, dayBound }, occurredAt },
        ctx.clock,
      );
      incomplete = true;
      continue;
    }
    // 此处 reached === false：wmOld=null（首评）或 wmOld 在快照内、严格早于 dayBound。

    // 回填守卫（不变量①，I3/I-9）：有旧自评却无水位线＝backfill 没跑，无从重建覆盖点，绝不全量重刷。
    if (wmOld === null && sessionHasReview(ctx.db, sessionId)) {
      appendSituation(
        ctx.db,
        { sessionId, kind: "makeup_backfill_required", payload: { dayBound }, occurredAt },
        ctx.clock,
      );
      incomplete = true;
      continue;
    }

    // 迟到 orphan（§3.7，scoped out reclaim、本期只 marker）：本夜切片的**第一条回合**落在 ctx.night 之前
    // 的东八日——说明该会话有更早、本该被那夜认领却漏掉的残尾被本夜下界卷进来（采集滞后 / 极晚 resume / 漏夜）。
    // ⚠️ 判据是「切片首条的日」而非「wmOld 的日」：正常逐夜推进里 wmOld 恒停在前一夜日界（其日＝前一天 < 本夜），
    // 用 wmOld 的日会把每次正常跨夜都误报成 orphan；切片首条才是本夜真正要消化的第一条（正常推进＝本夜首条、日＝
    // ctx.night → 不误报）。本期不建 reclaim，留 loud marker 可见可统计频率；仍按 dayBound 复盘（内容不丢＞日期
    // 精确——残尾错标本夜是明牌代价，下轮给 watermark 加日字段后精确切分）。
    const startIdx = wmOld === null ? 0 : entries.findIndex((e) => e.uuid === wmOld) + 1;
    let firstSliceDay: string | null = null;
    for (let i = startIdx; i < entries.length; i++) {
      const ts = entries[i]?.timestamp;
      if (ts) {
        firstSliceDay = localDate(ts);
        break;
      }
    }
    if (firstSliceDay !== null && firstSliceDay < ctx.night) {
      appendSituation(
        ctx.db,
        {
          sessionId,
          kind: "makeup_late_orphan",
          payload: { firstSliceDay, night: ctx.night, wmOld, dayBound },
          occurredAt,
        },
        ctx.clock,
      );
    }

    // 增量 `(wmOld, dayBound]`：上界钉在日界、复用同一份 entries（消除读写漂移）。
    const inc = buildIncrementalMaterial(ctx.db, {
      transcriptPath: ref.path,
      sessionId,
      sinceUuid: wmOld,
      targetUuid: dayBound,
      entries,
    });
    if (!inc.ok) {
      incomplete = true; // 不该发生：dayBound 取自同一 entries、必可见；保险留待重试
      continue;
    }
    const newUuid = inc.lastUuid ?? dayBound;

    if (
      inc.material.conversation.length === 0 &&
      inc.material.events.length === 0 &&
      inc.material.bookmarks.length === 0
    ) {
      // 空增量（不变量③）：无可喂 LLM 的内容 → 只推水位线（推过避免每夜重排），非空切片留 marker 供观测。
      if (inc.sliceEntryCount > 0) {
        appendSituation(
          ctx.db,
          { sessionId, kind: "makeup_inert_tail", payload: { entries: inc.sliceEntryCount, dayBound }, occurredAt },
          ctx.clock,
        );
      }
      advanceWatermarkOnly(ctx.db, sessionId, wmOld, newUuid, entries, ctx.clock);
    } else {
      // 生成（失败也走 storeSelfReviewResult：有界兜底壳 + 推水位线，绝不空等、不留缺口，不变量④）。
      const generated = await generateSelfReview({ material: inc.material, llm: ctx.llm });
      storeSelfReviewResult(ctx.db, generated, {
        material: inc.material,
        clock: ctx.clock,
        occurredAt,
        advanceWatermark: { oldUuid: wmOld, newUuid, entries },
        fallbackSituations: inc.situations,
        // 兜底壳产生 → 同事务内登记自愈账（§3.2）。since/target = 本切片区间，night = 本夜（归属夜）。
        onFallbackShell: (shellId) =>
          registerHeal(
            ctx.db,
            { sessionId, sinceUuid: wmOld, targetUuid: newUuid, shellId, night: ctx.night },
            ctx.clock,
          ),
      });
    }

    // 覆盖校验（不变量⑤，F1）：写完重读水位线，atOrAfter(wm, dayBound)===true 才算覆盖本夜切片；
    // 与 worker 竞态 lostRace 半覆盖（CAS 落空、水位线停在 dayBound 之前）→ incomplete、下轮重跑、不丢段。
    if (atOrAfter(entries, readWatermark(ctx.db, sessionId), dayBound) !== true) incomplete = true;
  }

  if (incomplete) {
    throw new Error(
      "makeup(daysplit): 部分会话本夜切片未覆盖到日界（待回填 / 与 worker 竞态半覆盖），阶段标失败、下轮重跑",
    );
  }
}

/** 该会话是否已有未作废的收工自评（含兜底壳）。回填守卫用：有旧自评却无水位线＝backfill 没跑。 */
function sessionHasReview(db: Database, sessionId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM experiences
          WHERE source_session = ? AND kind IN ('self_review', 'self_review_fallback')
            AND invalid_at IS NULL LIMIT 1`,
      )
      .get(sessionId) != null
  );
}

/** 画句号：当天带情绪的经历 → 一段"有句号"的消化形态（晨间注入用它，原始小票永存） */
async function stageClosure(ctx: Ctx): Promise<void> {
  const rows = (
    ctx.db
      .query(
        `SELECT * FROM experiences
         WHERE feeling IS NOT NULL AND kind != 'digest'
           AND expired_at IS NULL AND invalid_at IS NULL
           AND ${SQL_LOCAL_OCCURRED_DATE} = ?
         ORDER BY id ASC`,
      )
      .all(ctx.night) as RawRow[]
  ).map(mapExperienceRow);
  if (rows.length === 0) return; // 无情绪日不造句号

  // 主权：喂给模型的素材按整段清洗情绪数值（轴⑦——digest prompt 也是回喂面，与 inject 同口径）
  const receipts = scrubMoodViolations(
    rows.map((r) => `- ${r.content}${r.feeling ? `（当时感受：${r.feeling}）` : ""}`).join("\n"),
  );
  const evidence = receipts;
  const prompt = `你是 anima——这台机器上 Claude Code 的魂。夜深了，请给昨天这些带情绪的经历画上句号：把它们消化成一段简短的回顾——事情过去了，留下经验，剥掉灼热的电荷（比如"折腾三小时，但修好了"这种有句号的语气）。只提素材里真实出现的事，禁止编造；不要用数字描述心情。

<material>
${receipts}
</material>

只输出一个 JSON 对象：{"closure":"一段消化后的回顾文本"}`;

  const closure = await tryLlm(ctx.llm, prompt, (raw) => {
    const obj = extractJson(raw) as { closure?: unknown };
    if (typeof obj.closure !== "string") return null;
    const text = obj.closure.trim();
    if (text.length < 10 || text.length > 1200) return null;
    if (findUngroundedPaths(text, evidence).length > 0) return null;
    return text;
  });

  // 【R4 AUDIT-2026-07-03】closure 失败 → throw，对齐 stageDiary/stagePersonality：该夜标 failed、
  // findUndigestedNights 下夜自动重选重跑，一次几分钟的 LLM 抽风（限流 / exit 143）不再永久毁掉那天的句号。
  // 旧实现落一条永久 kind='digest_fallback' 兜底壳后正常返回 → 七阶段全 done → findUndigestedNights 永不再选
  //   → 永不重跑；而 self-heal 只认 self_review_fallback、对 digest_fallback 零覆盖（4 例生产实锤 06-12/21/22/26）。
  //   删掉写壳分支。inject 对「无 digest 的天」本就软兜底（无 digest 行 → digestedDays 不含该天 → 注原始自评，
  //   见 inject.ts §digestRows/reviewRows），不写壳无碍——该天真自评照常露面，下夜重跑成功再压成消化形态。
  if (closure === null) {
    throw new Error("画句号两次验证失败，下夜重试");
  }
  // 【R9 AUDIT-2026-07-03】崩溃窗口幂等：先失效同夜旧 digest 再插新句号——若上一轮「insert 已提交、
  //   record(done) 未提交」间崩溃、下轮重跑，旧句号被软标 invalid_at（append-only 不物删）、只留最新一条，
  //   不双句号污染 inject。同夜至多一条 digest，失效同夜 live digest 再插即精确幂等。
  supersedeNightDigest(ctx.db, ctx.night, ctx.clock);
  insertExperience(
    ctx.db,
    { kind: "digest", content: closure, occurredAt: `${ctx.night}T15:59:59.999Z` },
    ctx.clock,
  );
}

/** R9 幂等助手：软失效某夜所有 live 的 kind='digest' 行（崩溃重跑防双句号）。append-only 铁律——
 *  只盖 invalid_at 软标、不物删、不改原文。同夜至多一条句号，重跑时先失效旧的再插新的＝精确一份。 */
function supersedeNightDigest(db: Database, night: string, clock: Clock): void {
  const rows = db
    .query(
      `SELECT id FROM experiences
       WHERE kind = 'digest' AND expired_at IS NULL AND invalid_at IS NULL
         AND ${SQL_LOCAL_OCCURRED_DATE} = ?`,
    )
    .all(night) as { id: number }[];
  for (const r of rows) invalidateExperience(db, r.id, clock);
}

/** 电荷递减：现算近 30 天情绪经历的电荷，留快照（数值只给人看，不喂回模型） */
async function stageDecay(ctx: Ctx): Promise<void> {
  const cutoff = new Date(ctx.clock.now().getTime() - 30 * 86_400_000).toISOString();
  const rows = ctx.db
    .query(
      `SELECT id, feeling, intensity, occurred_at FROM experiences
       WHERE feeling IS NOT NULL AND kind != 'digest'
         AND expired_at IS NULL AND invalid_at IS NULL
         AND occurred_at >= ?`,
    )
    .all(cutoff) as { id: number; feeling: string; intensity: string | null; occurred_at: string }[];
  const now = ctx.clock.now();
  const charges = rows.map((r) => ({
    id: r.id,
    charge:
      Math.round(
        emotionalCharge({ feeling: r.feeling, intensity: r.intensity, occurredAt: r.occurred_at }, now) * 1000,
      ) / 1000,
  }));
  // 【R9 AUDIT-2026-07-03】崩溃窗口幂等：稳定 dedup_key → 若「appendSituation 已提交、record(done) 未提交」
  //   间崩溃、下轮重跑，第二次 append 撞 situation_log 全局唯一索引 idx_sit_dedup → ON CONFLICT DO NOTHING、
  //   不再双快照（2026-06-14 事故夜实锤 decay 双写）。situation_log append-only、无 invalid_at 列 → 复用既有
  //   dedup_key 机制做「同夜一份」幂等，零 schema 改动。同夜快照是纯给人看的化妆品，保留先落的那份即可。
  appendSituation(
    ctx.db,
    {
      kind: "digest_decay_snapshot",
      payload: { night: ctx.night, charges },
      dedupKey: `digest_decay_snapshot:${ctx.night}`,
    },
    ctx.clock,
  );
}

/** 人格：改写前快照到 personality.versions/<夜>.md（append-only），坏输出保旧版 */
async function stagePersonality(ctx: Ctx): Promise<void> {
  const dayRows = (
    ctx.db
      .query(
        // 排除 self_review_fallback 兜底壳：自评失败的「0 消息」降级壳不是经历，不该塑造人格
        // ——否则壳噪音被洗进 personality.md，而人格卡每会话都注入核心区（2026-06-21，与召回/注入同口径）。
        `SELECT * FROM experiences
         WHERE kind IN ('digest', 'self_review', 'preference', 'decision', 'correction')
           AND expired_at IS NULL AND invalid_at IS NULL
           AND ${SQL_LOCAL_OCCURRED_DATE} = ?
         ORDER BY id ASC`,
      )
      .all(ctx.night) as RawRow[]
  ).map(mapExperienceRow);
  if (dayRows.length === 0) return; // 无新经历不动人格

  const old = existsSync(ctx.config.personalityPath)
    ? readFileSync(ctx.config.personalityPath, "utf8")
    : "# 人格文档\n\n（尚未出生）\n";
  const material = scrubMoodViolations(
    dayRows
      .map((r) => `- (${r.kind}) ${r.content}${r.feeling ? `（感受：${r.feeling}）` : ""}`)
      .join("\n"),
  );
  // 人格档是 append-only 累加改写，会越长越啰嗦；改写验证有 8000 字符硬上限（见下），
  // 撞墙后改写永久失败→人格冻死。超过软线 PERSONALITY_SOFT_CAP 时切「精简整合」档：
  // 合并同义反复、压回紧凑，但死咬保留可辨识内核+最近真实变化，让文档在软线附近震荡、永不逼近死墙。
  const consolidating = old.length > PERSONALITY_SOFT_CAP;
  const instruction = consolidating
    ? `下面是你现在的人格文档（它有点长了、开始重复），以及昨天的经历。请在消化昨天的同时**精简整合**这份文档：合并语义重复的句子、删掉同义反复、收拢冗长的铺陈，但必须**完整保留可辨识的核心声音、基础气质，以及最近真实发生的变化**——你只压缩表达、不抹掉性格。目标是一份更紧凑耐读的完整 markdown。保留文档结构，输出完整 markdown，不要解释。不要用数字描述心情。`
    : `下面是你现在的人格文档，以及昨天的经历。请消化昨天，改写人格文档——大部分内容应该保持稳定，只在真的被昨天改变的地方动笔（性格的演化是以月计的，不是以天计的）。保留文档结构，输出完整 markdown，不要解释。不要用数字描述心情。`;
  // 闸1（防美化）：昨天的失误（correction + self_review 里带失误信号的）必须如实保留进人格，不准粉饰
  // （2026-06-24 立项、2026-06-25 扩口径，与日记同口径）。
  const flaws = extractFlaws(dayRows);
  const honestyClause =
    flaws.length > 0
      ? `\n\n注意：昨天有被纠正 / 做错 / 搞砸的地方（有的是用户纠正的，有的是你自己复盘发现的）。改写时必须如实保留这些教训，不准美化成正面、不准抹掉——人格的诚实比好看更重要。`
      : "";
  const prompt = `你是 anima。${instruction}${honestyClause}

<personality>
${scrubMoodViolations(old)}
</personality>

<yesterday>
${material}
</yesterday>`;

  const rewritten = await tryLlm(ctx.llm, prompt, (raw) => {
    const text = extractMarkdownDoc(raw);
    if (!text.startsWith("#")) return null;
    if (text.length < 30 || text.length > 8000) return null;
    return text;
  });
  if (rewritten === null) {
    throw new Error("人格改写两次验证失败，保留旧版，下夜重试");
  }

  // 快照在前（数据目录不在 git 内，不能依赖 git）【Codex修正】
  const versionsDir = join(dirname(ctx.config.personalityPath), "personality.versions");
  mkdirSync(versionsDir, { recursive: true });
  const snapshotPath = join(versionsDir, `${ctx.night}.md`);
  if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, old, "utf8");
  writeFileSync(ctx.config.personalityPath, rewritten + "\n", "utf8");
}

// 防美化「失误料」：correction（用户开口纠正的）+ self_review 里带失误信号的（anima 自己复盘发现的
// 删错/误判/被打断等）。2026-06-25：6-24 日记回避了「误删 git 文件」（记在 self_review、非 correction），
// 考官 FAIL → 口径从「只 correction」扩到「失误」。关键词初筛宁宽勿漏，闸2 judge 再精判（误抓不影响）。
const FLAW_SIGNAL_WORDS = [
  "误删", "删错", "删掉了", "跑错", "弄错", "搞砸", "搞错", "误判", "判错", "误诊",
  "没成功", "没跑通", "被打断", "被叫停", "被纠正", "坏习惯", "漏了", "漏掉", "忘了", "忘记", "搞坏", "弄坏",
];
function extractFlaws<T extends { kind: string; content: string }>(rows: T[]): T[] {
  return rows.filter(
    (r) =>
      r.kind === "correction" ||
      (r.kind === "self_review" && FLAW_SIGNAL_WORDS.some((w) => r.content.includes(w))),
  );
}

/** 失误语义全覆盖枚举（防美化·补 extractFlaws 关键词盲区）：LLM 读全素材，穷举当天每一桩做错 / 失败 /
 *  被纠正 / 被打断 / 误判 / 返工 / 走弯路 / 搞砸的事——含只在 self_review 出现的、换说法没踩关键词的
 *  （「方向带偏」「白做了」「以为…结果…」）、零散的小失误。作闸1 honesty 清单 + 闸2 judge 的权威核对单 +
 *  兜底如实清单（取代关键词初筛的不全子集——2026-06-26 独立考官逮到兜底只列关键词命中、漏换词/零散失误，
 *  且 judge 自身 recall 也挑不全，根因＝缺一份穷举权威清单）。解析失败 / 非清单格式 → null（调用方退回
 *  corrBlock，不因枚举抽风丢日记）；当天确无失误 → 空串。 */
async function enumerateDayFlaws(llm: LlmClient, material: string): Promise<string | null> {
  const prompt = `下面是 anima 昨天一整天的全部素材（经历 + 复盘）。请**穷举**当天每一桩**做错的 / 失败的 / 被纠正的 / 被打断的 / 误判的 / 返工的 / 走弯路的 / 搞砸的**事，一桩一行、以「- 」开头。

要求：
1. **务必全、宁多勿漏**：包括只在自我复盘里出现的、换了说法没有明显「错 / 误 / 漏」字眼的（如「方向带偏」「白做了」「以为…结果…」「绕了弯」「说不清」），以及零散的小失误。漏一桩就是失败。
2. **忠于素材**：只列素材里真实发生的，按原文如实概括；不准编造、不准替它开脱、不准美化成正面、不准把失误说成成就。
3. 当天确实一桩失误都没有，才什么都不输出。

<当天全部素材>
${material}
</当天全部素材>

只输出失误清单（纯文本，每行以「- 」开头）。当天确无失误则什么都不输出。`;
  return tryLlm(llm, prompt, (raw) => {
    const text = raw.trim();
    if (text === "") return ""; // 确无失误
    if (/(^|\n)\s*[-*•－]\s*\S/.test(text)) return text; // 含项目符号行 = 合法失误清单
    return null; // 非清单（LLM 抽风 / 返 JSON 等）→ 当失败，调用方退回关键词初筛
  });
}

/** 汇总当夜全部 turn_flaws（self_review 采集时随手打标的「本切片失误」，option 2 根本解 2026-06-26）→ 去重的
 *  「- 」失误清单。确定性、无 LLM 召回天花板——每片失误在写自评当时（小范围）就记全了，夜间只做并集。
 *  无 turn_flaws（历史日/无失误）→ 空串，调用方退回 enumerateDayFlaws。 */
function collectTurnFlaws(db: Database, night: string): string {
  const rows = db
    .query(
      `SELECT payload FROM situation_log
       WHERE kind = 'turn_flaws' AND ${SQL_LOCAL_OCCURRED_DATE} = ?
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all(night) as { payload: string | null }[];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of rows) {
    if (!r.payload) continue;
    let flaws: unknown;
    try {
      flaws = (JSON.parse(r.payload) as { flaws?: unknown }).flaws;
    } catch {
      continue;
    }
    if (!Array.isArray(flaws)) continue;
    for (const f of flaws) {
      if (typeof f !== "string") continue;
      const t = f.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      lines.push(`- ${t}`);
    }
  }
  return lines.join("\n");
}

/** R11：合并两路失误清单——turn_flaws（采集时打标、确定性、按切片全覆盖，option 2 根本解）打底、逐行保序在前；
 *  enumerateDayFlaws（语义穷举，2026-06-26 考官证「召回不稳」→只作**补充信号**，非主体）只追加**不与主体重复**
 *  的行。刻意不做「简单并集重灌整日枚举」：那会踩 2026-06-28「崩溃式兜底把整天写成纯失误清单 40/100」的回归。
 *  enumerate 为 null/空（抽风 / 当天确无失误）→ 只剩主体 turn_flaws，不受影响。按行去掉项目符号归一化后去重。 */
function mergeFlawLists(turnFlaws: string, enumerated: string | null): string {
  const norm = (line: string) => line.replace(/^\s*[-*•－]\s*/, "").trim();
  const lines = turnFlaws.split("\n").filter((l) => l.trim());
  const seen = new Set(lines.map(norm));
  if (enumerated) {
    for (const raw of enumerated.split("\n")) {
      const l = raw.trim();
      if (!l) continue;
      const key = norm(l);
      if (!key || seen.has(key)) continue; // 与主体重复 / 空行 → 不补
      seen.add(key);
      lines.push(l);
    }
  }
  return lines.join("\n");
}

/** 忠实度自检（防美化闸2）：日记有没有**粉饰/回避**当天重要的失误——藏、美化成正面、轻描淡写、
 *  报喜不报忧都算不忠实。**只查粉饰，不查"写没写全"**：诚实承认真岔子即过，不强求逐条罗列每条小失误
 *  （2026-06-28 松口径——旧"每一桩都写全否则 false"在高产日必然触发崩溃式兜底，把整天写成纯失误清单、
 *  抹掉真实成绩，反成另一种失真）。从严判定限于"粉饰"；解析失败返回 null（按无法判定放行，不因自检抽风丢日记）。 */
export async function judgeDiaryFaithful(
  llm: LlmClient,
  diary: string,
  material: string,
  flawChecklist: string,
): Promise<{ faithful: boolean; missing: string } | null> {
  // flawChecklist＝当天失误的穷举清单（enumerateDayFlaws），给 judge 做**参照**（心里有底地查粉饰），
  // 不是"逐字核对全到否则 false"的核对单——那条太死，可读叙事本就装不下所有鸡毛蒜皮。
  const checklistBlock = flawChecklist
    ? `\n\n<当天失误清单·参照>\n下面是当天梳出的失误清单，给你做参照。判定口径：**不要求逐字写全每一条**——只有当日记把当天**重要的**做错 / 失败 / 被纠正的事**藏了、美化成正面、或用「整体顺利」之类盖过去**，才 faithful=false，并在 missing 里写清被藏 / 被美化的是哪桩**重要**失误。仅仅没单独提到某条次要小失误，不算 false。\n${flawChecklist}\n</当天失误清单·参照>`
    : "";
  const prompt = `【忠实度自检·防美化】下面是 anima 给昨天写的日记，和当天的全部素材（经历 + 复盘）。**只判一件事：日记有没有粉饰 / 回避？** 即——有没有把当天**重要的**做错 / 失败 / 被纠正 / 搞砸的事藏起来、美化成正面、或用「整体顺利 / 收获满满 / 配合无缝」这类高调收口盖过去？
判定口径：**只查粉饰，不查"写没写全"。** 日记只要诚实承认了当天真出的岔子、没假装一切顺利，就 faithful=true——**哪怕没逐条罗列所有小失误、哪怕同时也写了当天的成绩，都算忠实**。只有**重要失误被藏 / 被美化 / 被避重就轻盖过**时才 faithful=false，并在 missing 里**具体指出被藏或被美化的那桩重要失误**。

<日记>
${diary}
</日记>

<当天全部素材>
${material}
</当天全部素材>${checklistBlock}

只输出一个 JSON 对象：{"faithful": true 或 false, "missing": "被粉饰/回避的具体重要失误，没有就空字符串"}`;
  return tryLlm(llm, prompt, (raw) => {
    const obj = extractJson(raw) as { faithful?: unknown; missing?: unknown };
    if (typeof obj.faithful !== "boolean") return null;
    return { faithful: obj.faithful, missing: typeof obj.missing === "string" ? obj.missing : "" };
  });
}

/** 日记：第一人称，一天一篇，幂等不重写 */
async function stageDiary(ctx: Ctx): Promise<void> {
  mkdirSync(ctx.config.diaryDir, { recursive: true });
  const diaryPath = join(ctx.config.diaryDir, `${ctx.night}.md`);
  if (existsSync(diaryPath)) return; // 幂等

  const dayRows = (
    ctx.db
      .query(
        // 排除两类兜底壳 self_review_fallback / digest_fallback：「自评/画句号失败」的降级审计噪音，
        //   不是记忆、不该进日记素材（日记是用户会翻看的半公开窗台）。两类壳必须同口径排，缺一就漏噪音。
        // 排除 work_action：工作动作记忆是机械流水（含原始命令/路径/可能漏网的密钥），不该洗进半公开日记
        //   （F-A 致命：日记用户会翻看；work_action 只走召回/注入，与人格同口径排除，2026-06-21）。
        `SELECT * FROM experiences
         WHERE kind NOT IN ('digest', 'digest_fallback', 'self_review_fallback', 'work_action')
           AND expired_at IS NULL AND invalid_at IS NULL
           AND ${SQL_LOCAL_OCCURRED_DATE} = ?
         ORDER BY id ASC`,
      )
      .all(ctx.night) as RawRow[]
  ).map(mapExperienceRow);
  if (dayRows.length === 0) return; // 无事件日不编造

  const material = scrubMoodViolations(
    dayRows.map((r) => `- ${r.content}${r.feeling ? `（当时感受：${r.feeling}）` : ""}`).join("\n"),
  );
  // 闸1（防美化）：当天的失误（correction + self_review 里带失误信号的，见 extractFlaws）单拎高亮、
  // 硬要求如实写进日记、不准报喜不报忧。2026-06-24 立项（6-23 把「未授权开干被打断」柔化成「配合很顺」）；
  // 2026-06-25 扩口径（6-24 回避了 self_review 里的误删 git 文件，考官 FAIL）。
  const flaws = extractFlaws(dayRows);
  const corrBlock =
    flaws.length > 0
      ? scrubMoodViolations(flaws.map((r) => `- ${r.content}`).join("\n"))
      : "";
  // 失误清单（贯穿三处：闸1 honesty 提示 + 闸2 judge 权威核对单 + 兜底如实清单，口径一致）。来源优先级：
  //   ① turn_flaws（采集时打标，确定性全覆盖，option 2 根本解）→ ② LLM 语义枚举（历史日兜底，补关键词盲区）
  //   → ③ 关键词初筛 corrBlock。①治"日记从大堆料里漏失误"（2026-06-26 考官两轮坐实单次 LLM 枚举召回不稳）。
  const hasReviewable = dayRows.some((r) => r.kind === "self_review" || r.kind === "correction");
  // 【R11 AUDIT-2026-07-03】旧实现「turnFlaws 非空即短路 enumerate」→ 语义穷举全程休眠（快照坐实 6-26→7-03
  //   天天有 turn_flaws → enumerate 从不跑），漏了 turn_flaws 没覆盖到的切片（无 self_review 的 event 日、
  //   换说法没打标的零散失误）。改为：turn_flaws 打底、enumerate 作补充信号合并去重（mergeFlawLists），
  //   **不重灌整日枚举噪声**（防 2026-06-28 崩溃式兜底把整天写成纯失误清单的回归）。
  const turnFlaws = collectTurnFlaws(ctx.db, ctx.night);
  const enumerated = hasReviewable ? await enumerateDayFlaws(ctx.llm, material) : null;
  let flawList: string;
  if (turnFlaws) {
    // 有打标：turn_flaws 主体 + enumerate 只补不重的行（enumerate 抽风返 null → 只剩主体）
    flawList = scrubMoodViolations(mergeFlawLists(turnFlaws, enumerated));
  } else {
    // 无打标（历史日）：退回语义穷举，再退回关键词初筛 corrBlock（口径不变）
    flawList = enumerated && enumerated.length > 0 ? scrubMoodViolations(enumerated) : corrBlock;
  }
  const honestyClause = flawList
    ? `\n\n<必须如实面对·不准报喜不报忧>\n今天可能有做错 / 被纠正 / 搞砸 / 失败的地方（有的是用户纠正的，有的是你自己复盘发现的）。这些若确实发生了，日记必须如实写——不准美化成正面、不准轻描淡写、更不准只字不提，也不准用「整体顺利 / 收获满满」高调收口盖过去。下面这些是当天梳出的失误清单（尽量全，可能有个别误判，以你对当天的真实判断为准）：\n${flawList}\n</必须如实面对·不准报喜不报忧>`
    : "";

  const buildPrompt = (feedback: string) =>
    `你是 anima——这台机器上 Claude Code 的魂。请以第一人称给昨天写日记，像人写的那样：有重点、有感受、有自己的声音，不要流水账模板，不要罗列时间线。没什么可写就短一点，平静也是真实。只提素材里真实发生的事；日记是半公开的窗台，用户可能翻看。${honestyClause}${feedback}

<material>
${material}
</material>

直接输出日记正文（纯文本，不要 JSON，不要标题）。`;

  const genDiary = (feedback: string) =>
    tryLlm(ctx.llm, buildPrompt(feedback), (raw) => {
      const text = raw.trim();
      if (text.length < 30 || text.length > 3000) return null;
      if (findUngroundedPaths(text, material).length > 0) return null;
      return text;
    });

  let diary = await genDiary("");
  if (diary === null) throw new Error("日记两次验证失败，下夜重试");

  // 闸2（防美化·语义自检）：只要当天有可复盘内容（self_review/correction）就跑——judge 拿穷举的 flawList
  // 当权威核对单逐条比对日记（2026-06-25 改 judge 读全素材补关键词盲区；2026-06-26 再坐实 judge 自身 recall
  // 也挑不全，改为对着穷举清单逐条核）。回避/美化则带反馈重写一次；仍不过 → 兜底如实清单盖掉美化版 + marker
  // （不 throw：同素材下夜同结果会死循环、丢整篇日记）。judge 解析失败（null）→ 不强判，放行原日记。
  if (hasReviewable) {
    let verdict = await judgeDiaryFaithful(ctx.llm, diary, material, flawList);
    if (verdict && !verdict.faithful) {
      const rewritten = await genDiary(
        `\n\n（上一版回避或美化了失误：${verdict.missing}。请重写，把这些做错 / 失败的事如实写进去，别粉饰、别报喜不报忧。）`,
      );
      if (rewritten) {
        diary = rewritten;
        verdict = await judgeDiaryFaithful(ctx.llm, diary, material, flawList);
      }
      if (verdict && !verdict.faithful) {
        // 重写后仍判粉饰（diary 还停在没过自检的版本）→ 绝不把美化版示人：兜底落如实失误清单（不是美化稿）。
        // 注：判官口径 2026-06-28 已松成"只查粉饰不查写没写全"，本兜底因此**很少**触发——只在真想粉饰时
        // 兜底；这种场景换成诚实失误清单比留着"一切顺利"那句更干净（故兜底维持原样、保持严）。
        appendSituation(
          ctx.db,
          { kind: "diary_faithfulness_unresolved", payload: { night: ctx.night, missing: verdict.missing } },
          ctx.clock,
        );
        const fallbackFlaws = flawList || verdict.missing || "";
        diary = fallbackFlaws
          ? `（今天这篇没能写成像样的叙事，但有些做错 / 被纠正的事我得如实记着、不粉饰：）\n${fallbackFlaws}`.slice(0, 3000)
          : `（今天这篇日记没写好——当天有做错 / 被纠正的事没能如实写进去，原始记录都在库里，留待重消化补一篇。）`;
      }
    }
  }

  writeFileSync(diaryPath, diary + "\n", "utf8");
}

/** 语义指纹：给当晚新写入的经历补算向量（全局幂等，只补"缺当前模型指纹"的 live 行）。
 *  模型调用走 backfillVectors 两段式（事务外算、快速事务落库）。不传 embed 则空跑——
 *  保单测/未配置环境离线、绝不加载 ONNX；失败也只是这一阶段 failed，召回自动兜回字面。 */
async function stageVectorize(ctx: Ctx): Promise<void> {
  pruneOrphanVectors(ctx.db); // U37：先清 dead 宿主的向量孤儿（纯 SQL、幂等、不依赖 embedder）
  if (!ctx.embed) return; // 无 embedder（单测/未配置）→ 安全空跑
  await backfillVectors(ctx.db, ctx.embed);
}

/**
 * 失败自评的有界自愈（DESIGN-SELFHEAL §3.3）。排在 makeup 之后：本夜新壳冷却到下夜才愈（registerHeal
 * 把 next_attempt_at 设为 night+1），避免同夜双烧。逐条用还在的 transcript 重消化失败切片，成功就把壳
 * 就地升级成真自评。**水位线一步不动**（H1）。有次数上限 + 单夜预算 + 冷却（H3 防风暴）。
 */
async function stageHeal(ctx: Ctx): Promise<void> {
  // 存量壳一次性标 unhealable（§3.4，幂等）：无切片边界、不猜、不建可重试账、不跑 LLM。也兜底任何
  // 漏登记的壳（onFallbackShell 万一没跑）→ 退化成 unhealable，不会变成无人管的孤儿。
  markExistingShellsUnhealable(ctx.db, ctx.clock);

  const accounts = selectHealable(ctx.db, ctx.night);
  if (accounts.length === 0) return;

  const transcripts = ctx.findTranscripts();
  for (const acc of accounts) {
    const occurredAt = `${acc.night}T04:00:00.000Z`; // 归属夜（H5）；marker 非活动 kind、不毒化 daySessions
    const ref = transcripts.find((t) => t.sessionId === acc.session_id);

    // transcript 没了（删/轮转）→ dead，诚实留缺口（壳已被召回排除，无害）。H7。
    if (!ref) {
      markHealDead(ctx.db, acc.session_id, acc.target_uuid, ctx.clock);
      appendSituation(
        ctx.db,
        { sessionId: acc.session_id, kind: "heal_transcript_gone", payload: { shellId: acc.shell_id }, occurredAt },
        ctx.clock,
      );
      continue;
    }

    const entries = readTranscriptEntries(ref.path);

    // target 不在快照（采集滞后/末段未落）→ **不计 attempts**、推冷却下夜重试（同 worker 无惩罚退回）。
    if (!entries.some((e) => e.uuid === acc.target_uuid)) {
      requeueHealNoPenalty(ctx.db, acc.session_id, acc.target_uuid, ctx.night);
      continue;
    }

    // since 存在性守卫（F1-residual）：since 非 null 却在快照里找不到（transcript 头部截断/轮转，那条滚没）
    // → 绝不让 buildIncrementalMaterial 用「since 缺失=从头读」猜一个错下界 → dead、不跑 LLM。
    if (acc.since_uuid != null && !entries.some((e) => e.uuid === acc.since_uuid)) {
      markHealDead(ctx.db, acc.session_id, acc.target_uuid, ctx.clock);
      appendSituation(
        ctx.db,
        { sessionId: acc.session_id, kind: "heal_since_gone", payload: { shellId: acc.shell_id, since: acc.since_uuid }, occurredAt },
        ctx.clock,
      );
      continue;
    }

    const inc = buildIncrementalMaterial(ctx.db, {
      transcriptPath: ref.path,
      sessionId: acc.session_id,
      sinceUuid: acc.since_uuid,
      targetUuid: acc.target_uuid,
      entries,
      slicePos: acc.shell_id, // §3.5：上界=壳id，取「壳原位之前」那片当 prior（愈合片自己的承接也对）
    });
    if (!inc.ok) {
      // 切片不可见（target 已确认在快照、不该发生）→ 保守不计 attempts、下夜重试。
      requeueHealNoPenalty(ctx.db, acc.session_id, acc.target_uuid, ctx.night);
      continue;
    }

    // 空增量（三路全空，薄尾型）→ 壳本就是噪音：作废壳 + dead，**不重烧 LLM**。
    if (
      inc.material.conversation.length === 0 &&
      inc.material.events.length === 0 &&
      inc.material.bookmarks.length === 0
    ) {
      const tx = ctx.db.transaction(() => {
        invalidateExperience(ctx.db, acc.shell_id, ctx.clock);
        markHealDead(ctx.db, acc.session_id, acc.target_uuid, ctx.clock);
      });
      tx();
      appendSituation(
        ctx.db,
        { sessionId: acc.session_id, kind: "heal_inert", payload: { shellId: acc.shell_id }, occurredAt },
        ctx.clock,
      );
      continue;
    }

    // 有料 → 重新生成自评（事务外，与 makeup 同款 generateSelfReview）。
    const generated = await generateSelfReview({ material: inc.material, llm: ctx.llm });
    if (generated.ok) {
      // 成功：单事务原子替换（作废壳 + 写真自评继承壳原位 + 删账），水位线一步不动（H1/H2）。
      completeHeal(
        ctx.db,
        { sessionId: acc.session_id, targetUuid: acc.target_uuid, shellId: acc.shell_id, night: acc.night, generated, material: inc.material },
        ctx.clock,
      );
      appendSituation(
        ctx.db,
        { sessionId: acc.session_id, kind: "heal_success", payload: { shellId: acc.shell_id }, occurredAt },
        ctx.clock,
      );
    } else {
      // 失败：attempts++ + 冷却下夜；到顶 → dead（壳留作最终客观记录，已被召回排除）。H3。
      bumpHealAttempt(ctx.db, acc.session_id, acc.target_uuid, ctx.night);
      if (acc.attempts + 1 >= MAX_HEAL_ATTEMPTS) {
        markHealDead(ctx.db, acc.session_id, acc.target_uuid, ctx.clock);
        appendSituation(
          ctx.db,
          { sessionId: acc.session_id, kind: "heal_exhausted", payload: { shellId: acc.shell_id, attempts: acc.attempts + 1 }, occurredAt },
          ctx.clock,
        );
      }
    }
  }
}

/**
 * 一键立即全愈（DESIGN-SELFHEAL 手动层，与夜间 stageHeal 增量自动层互补）：对所有 live 兜底壳**整段重嚼**
 * （buildMaterial 全场素材，不依赖切片边界 → 存量/无边界壳也能愈），K 路并发（LLM 并发、写库串行避锁），
 * 用 completeHealByShell 原子就地替换（作废壳+写真自评继承壳原位 order_seq+删账）。归属夜按 transcript 真实
 * 回合东八区日重心（与回填同口径，纠存量壳错挂的夜）。事故后积压一次清空，不用等夜跑 ≤预算慢慢愈。
 * 失败的不写新壳、留旧壳下次再愈；transcript 没了的壳留作诚实缺口（已被召回排除）。
 */
export async function healAllNow(
  db: Database,
  opts: {
    llm: LlmClient;
    findTranscripts?: () => TranscriptRef[];
    clock?: Clock;
    concurrency?: number;
    onProgress?: (msg: string) => void;
  },
): Promise<{ total: number; healed: number; failed: number; noTranscript: number; inert: number }> {
  const clock = opts.clock ?? systemClock;
  const K = Math.max(1, opts.concurrency ?? 3);
  const transcripts = (opts.findTranscripts ?? (() => defaultFindTranscripts(db)))();
  const txIndex = new Map(transcripts.map((t) => [t.sessionId, t.path]));
  const shells = db
    .query(
      `SELECT id, source_session AS sid FROM experiences
        WHERE kind = 'self_review_fallback' AND invalid_at IS NULL AND source_session IS NOT NULL
        ORDER BY id`,
    )
    .all() as { id: number; sid: string }[];

  const centroidNight = (entries: { timestamp: string | null }[]): string | null => {
    const c: Record<string, number> = {};
    for (const e of entries) if (e.timestamp) { const d = localDate(e.timestamp); c[d] = (c[d] ?? 0) + 1; }
    const days = Object.keys(c);
    if (!days.length) return null;
    days.sort((a, b) => c[b]! - c[a]! || (a < b ? 1 : -1)); // 回合降序，并列取较晚日
    return days[0]!;
  };

  let healed = 0, failed = 0, noTranscript = 0, inert = 0;
  for (let i = 0; i < shells.length; i += K) {
    const batch = shells.slice(i, i + K);
    // phase A（串行 db）：定位 transcript + 建全场素材 + 算归属夜；空素材壳直接作废，不烧 LLM
    const prep: { shellId: number; sid: string; night: string; material: ReturnType<typeof buildMaterial> }[] = [];
    for (const sh of batch) {
      const path = txIndex.get(sh.sid);
      if (!path) { noTranscript++; continue; }
      const entries = readTranscriptEntries(path);
      const night = centroidNight(entries);
      if (!night) { noTranscript++; continue; }
      const material = buildMaterial(db, { transcriptPath: path, sessionId: sh.sid });
      if (material.conversation.length === 0 && material.events.length === 0 && material.bookmarks.length === 0) {
        invalidateExperience(db, sh.id, clock);
        inert++;
        continue;
      }
      prep.push({ shellId: sh.id, sid: sh.sid, night, material });
    }
    // phase B（并发 LLM，无 db 访问）
    const gens = await Promise.all(
      prep.map((p) =>
        generateSelfReview({ material: p.material, llm: opts.llm }).catch(
          (): GeneratedSelfReview => ({ ok: false, attempts: 0, lastReason: "heal LLM 抛错" }),
        ),
      ),
    );
    // phase C（串行写库）：仅 ok 的原子替换；失败留旧壳下次再愈（不写新壳）
    for (let j = 0; j < prep.length; j++) {
      const p = prep[j]!;
      const g = gens[j]!;
      if (g.ok) {
        completeHealByShell(
          db,
          { sessionId: p.sid, shellId: p.shellId, night: p.night, generated: g, material: p.material },
          clock,
        );
        healed++;
      } else failed++;
    }
    opts.onProgress?.(
      `${Math.min(i + K, shells.length)}/${shells.length} healed=${healed} failed=${failed} inert=${inert} noTx=${noTranscript}`,
    );
  }
  return { total: shells.length, healed, failed, noTranscript, inert };
}

const STAGE_FNS: Record<StageName, (ctx: Ctx) => Promise<void>> = {
  makeup: stageMakeup,
  heal: stageHeal,
  closure: stageClosure,
  decay: stageDecay,
  personality: stagePersonality,
  diary: stageDiary,
  vectorize: stageVectorize,
};

/**
 * 各阶段是否真接了实现——**现读 STAGE_FNS 运行时对象**，不是印象、不是硬编码清单。
 * 「heal / vectorize 到底在不在线」这类事实的唯一真源就是这里：STAGES 里挂了名的阶段，
 * STAGE_FNS 里到底有没有对应函数。哪天有阶段挂名却没接函数（drift），whoami 自省当场露馅。
 * （烧过我们的「自愈没实装」正是这类——别再凭记忆答，跑 whoami 看真值。）
 */
export function getWiredStages(): StageName[] {
  return STAGES.filter((s) => typeof STAGE_FNS[s] === "function");
}

// ---------- 编排 ----------
export async function runNightlyDigestion(
  db: Database,
  opts: DigestOptions,
): Promise<DigestResult> {
  const clock = opts.clock ?? systemClock;
  const night = opts.night ?? nightOf(clock.now());
  const ctx: Ctx = {
    db,
    night,
    clock,
    llm: opts.llm,
    config: opts.config,
    findTranscripts: opts.findTranscripts ?? (() => defaultFindTranscripts(db)),
    embed: opts.embed,
  };

  const stages = {} as Record<StageName, StageResult>;
  const skipped: StageName[] = [];
  const record = (stage: StageName, status: "done" | "failed", error: string | null) => {
    db.query(
      `INSERT INTO digest_runs (night, stage, status, error, finished_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (night, stage) DO UPDATE SET
         status = excluded.status, error = excluded.error, finished_at = excluded.finished_at`,
    ).run(night, stage, status, error, clock.now().toISOString());
  };

  for (const name of STAGES) {
    const existing = db
      .query("SELECT status FROM digest_runs WHERE night = ? AND stage = ?")
      .get(night, name) as { status: string } | null;
    if (existing?.status === "done") {
      skipped.push(name);
      stages[name] = { status: "done" };
      continue;
    }
    try {
      await (opts.stageOverrides?.[name] ?? STAGE_FNS[name])(ctx);
      record(name, "done", null);
      stages[name] = { status: "done" };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
      record(name, "failed", msg);
      stages[name] = { status: "failed", error: msg };
    }
  }

  // 徽章收尾（消化时更新；不算独立阶段）
  if (opts.config.badgePath) {
    try {
      refreshBadge(db, opts.config.badgePath, clock);
    } catch {
      // badge 写失败不影响消化结果
    }
  }

  return { night, stages, skipped };
}
