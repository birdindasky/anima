// worker resume 触发的迁移冷启动回填（DESIGN-WORKER-RESUME §9）。
//
// 背景：v5 加了 review_watermark（每会话「已自评覆盖到 transcript 哪个 uuid」）。若不给存量
// 已自评会话回填水位线，worker/makeup 改走水位线后首夜会把每个老会话当「水位线空＝全未复盘」
// → 整段重刷一遍（O(全部历史会话)烧 haiku + 可能错乱夜归属）。本回填堵这个雷。
//
// 回填值 = 该会话 transcript 真末条 uuid（含上次采集后的增长，故读文件而非用采集游标）；
// 文件已删 → 退回 capture_cursors.last_uuid → 退回末条带 uuid 的 user_message → 三路皆空跳过+告警。
// 幂等 + 可断点续跑：已有水位线的会话不覆盖、跳过。
//
// 铁律对账：review_watermark 是【操作游标】（同 capture_cursors，可更新），非记忆，不受
// 「经历只追加」约束；本回填只写 review_watermark 这一张表，不碰 experiences / selfReview。
import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";
import { getCursor } from "./capture";
import { readTranscriptEntries, dayBoundUuid } from "./transcript";

export interface BackfillWatermarkResult {
  /** 待回填会话总数（有未作废 self_review / self_review_fallback 的） */
  total: number;
  filledFromTranscript: number;
  filledFromCursor: number;
  filledFromSituation: number;
  /** 已有水位线、跳过的（幂等/续跑） */
  skipped: number;
  /** transcript / 游标 / 流水 uuid 三路皆空，未回填的会话（交脚本打印，不写 marker） */
  warnedSessions: string[];
}

export interface BackfillWatermarkOptions {
  clock?: Clock;
  onProgress?: (done: number, total: number) => void;
}

export function backfillReviewWatermark(
  db: Database,
  opts: BackfillWatermarkOptions = {},
): BackfillWatermarkResult {
  const clock = opts.clock ?? systemClock;
  const now = clock.now().toISOString();

  // 回填对象：库里所有有未作废 self_review / self_review_fallback 的会话。
  // fallback 也算「已复盘」，否则迁移夜会对每个 fallback 会话白烧一次（§9）。
  const sessions = (
    db
      .query(
        `SELECT DISTINCT source_session AS sid FROM experiences
          WHERE kind IN ('self_review','self_review_fallback')
            AND invalid_at IS NULL AND source_session IS NOT NULL`,
      )
      .all() as { sid: string }[]
  ).map((r) => r.sid);

  // 从 capture_cursors 一次建两张 session→path 映射：
  //  authMap：读首条 sessionId 的权威映射（文件可读时用，处理「文件名≠session」的罕见情形）；
  //  baseMap：basename(path) 去 .jsonl，文件已删时的兜底（basename===session_id 是 CC 命名约定，已实测）。
  // 逻辑与 digest.defaultFindTranscripts 同源（此处内联以免 import digest → 拖入 selfReview/vectorize）。
  const authMap = new Map<string, string>();
  const baseMap = new Map<string, string>();
  for (const { transcript_path } of db
    .query("SELECT transcript_path FROM capture_cursors")
    .all() as { transcript_path: string }[]) {
    baseMap.set(basename(transcript_path).replace(/\.jsonl$/, ""), transcript_path);
    const sid = readTranscriptEntries(transcript_path)[0]?.sessionId;
    if (sid) authMap.set(sid, transcript_path);
  }
  const resolvePath = (sid: string): string | null => authMap.get(sid) ?? baseMap.get(sid) ?? null;

  const res: BackfillWatermarkResult = {
    total: sessions.length,
    filledFromTranscript: 0,
    filledFromCursor: 0,
    filledFromSituation: 0,
    skipped: 0,
    warnedSessions: [],
  };

  const hasWatermark = db.query("SELECT 1 FROM review_watermark WHERE session_id = ?");
  const insertWm = db.query(
    "INSERT INTO review_watermark (session_id, last_uuid, updated_at) VALUES (?, ?, ?)",
  );
  const lastUserMsg = db.query(
    `SELECT payload FROM situation_log
      WHERE session_id = ? AND kind = 'user_message' AND payload IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
  );
  // rank3（AUDIT-2026-07-01）：该会话最近一条自评所属的「夜」。occurred_at 是夜标记（如
  // 2026-06-30T04:00:00.000Z，前 10 位即东八夜日期），用它取日界 uuid 作保守水位线——绝不用文件末条。
  const lastReviewNight = db.query(
    `SELECT MAX(occurred_at) AS m FROM experiences
      WHERE source_session = ? AND kind IN ('self_review','self_review_fallback') AND invalid_at IS NULL`,
  );

  let done = 0;
  for (const sid of sessions) {
    done++;
    opts.onProgress?.(done, sessions.length);

    if (hasWatermark.get(sid)) {
      res.skipped++; // 幂等 + 可断点续跑：已有不覆盖
      continue;
    }

    const path = resolvePath(sid);
    let lastUuid: string | null = null;
    let via: "transcript" | "cursor" | "situation" | null = null;

    if (path) {
      const entries = readTranscriptEntries(path); // 文件已删 → []
      if (entries.length > 0) {
        // rank3 修（AUDIT-2026-07-01）：绝不用文件末条当水位线——会把「末次复盘后、回填前新增的轮次」当已
        // 复盘、被 digest 的 wmOld===tailUuid 永久跳过、静默丢记忆。老自评不记覆盖到哪个 uuid（信息已丢），
        // 取该会话最近自评所属夜的**日界 uuid** 作保守水位线：复盘覆盖到那夜为止、之后的轮次留给正常 digest。
        // 复盘夜后无新活动 → 日界==文件末条（与旧行为一致、不丢）；有新活动 → 日界<末条、新轮次不静默丢。
        const nightRow = lastReviewNight.get(sid) as { m: string | null } | null;
        const night = nightRow?.m ? nightRow.m.slice(0, 10) : null;
        const bound = night ? dayBoundUuid(entries, night) : null;
        if (bound) {
          lastUuid = bound;
          via = "transcript";
        } else {
          // 有条目却定位不到复盘夜界（transcript 被轮转 / 复盘夜内容已不在文件）→ 不猜、不退文件末条，交告警 loud。
          res.warnedSessions.push(sid);
          continue;
        }
      } else {
        const cur = getCursor(db, path); // 文件没了 → 退采集游标
        if (cur) {
          lastUuid = cur;
          via = "cursor";
        }
      }
    }

    if (!lastUuid) {
      // 再退：该会话最后一条带 uuid 的 user_message（situation_log 仅 user_message 的 payload 带 uuid）
      const row = lastUserMsg.get(sid) as { payload: string } | null;
      if (row) {
        try {
          const u = (JSON.parse(row.payload) as { uuid?: unknown })?.uuid;
          if (typeof u === "string" && u) {
            lastUuid = u;
            via = "situation";
          }
        } catch {
          /* 坏 payload 不致命，落到下面的告警 */
        }
      }
    }

    if (!lastUuid || !via) {
      // 三路皆空：跳过不回填，交脚本打印。刻意不写 situation_log marker——带 session_id 的 marker
      // 历史上正是「错盖夜」污染源（commit 1db18c4），这里宁可只在脚本输出里可见。
      res.warnedSessions.push(sid);
      continue;
    }

    insertWm.run(sid, lastUuid, now);
    if (via === "transcript") res.filledFromTranscript++;
    else if (via === "cursor") res.filledFromCursor++;
    else res.filledFromSituation++;
  }

  return res;
}
