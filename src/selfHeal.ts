// 失败自评的有界自愈（DESIGN-SELFHEAL v5）。自评失败走兜底壳后额外登记一条「待愈账」（review_heal），
// 夜间 stageHeal 用还在的 transcript 重消化那段，成功就把壳就地升级成真自评——有次数上限 + 防风暴 +
// 水位线一步不动（守 SEVERE「水位线只前进」铁律）。本模块只放纯库操作；LLM/素材编排在 digest.ts::stageHeal。
import { Database } from "bun:sqlite";

import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { envInt } from "./env";
import { invalidateExperience } from "./experiences";
import { writeSelfReviewBody, type GeneratedSelfReview, type Material } from "./selfReview";

/** 单切片重试上界：连失败到顶 → dead，绝不每夜重烧 LLM（H3）。 */
export const MAX_HEAL_ATTEMPTS = 3;
/** 预算硬默认（selectHealable 双保险 clamp 的兜底值，与 envInt 默认同源）。 */
const HEAL_BUDGET_DEFAULT = 50;
/** 单夜愈合预算：防一夜把所有积压壳全烧一遍（H3 防风暴）。默认 50，可经 ANIMA_HEAL_BUDGET 调；
 *  大事故积压不靠夜跑慢慢清，走 healAllNow 一键全愈（digest.ts，无上限并发）。
 *  U33：env 解析走 envInt（min:1，坏值退默认）——旧 `Number(env)||50` 静默吃负数，而 SQLite
 *  `LIMIT -N`＝不限量，一个坏 env 就把防风暴预算整个架空。 */
export const HEAL_BUDGET_PER_NIGHT = envInt("ANIMA_HEAL_BUDGET", HEAL_BUDGET_DEFAULT, { min: 1 });

/** night 字符串 (YYYY-MM-DD) 的次日，用作冷却闸 next_attempt_at（≥1 夜，H3）。 */
export function nextNight(night: string): string {
  const d = new Date(`${night}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface HealRow {
  session_id: string;
  since_uuid: string | null;
  target_uuid: string;
  shell_id: number;
  night: string;
  attempts: number;
  status: string;
  next_attempt_at: string;
  created_at: string;
}

/**
 * 写路登记（§3.2）：兜底壳写完后额外登记一条 pending 账。**只 makeup 路会到这**（worker 失败不写壳、
 * 直接 recordReviewFailure，见 worker.ts），故无需额外旗。同切片只一条账（PK session+target，幂等 upsert）。
 * **对现有流程零副作用**：水位线照推、壳照写、返回值不变——自愈即便整个没跑，系统退化成今天的样子。
 */
export function registerHeal(
  db: Database,
  rec: { sessionId: string; sinceUuid: string | null; targetUuid: string; shellId: number; night: string },
  clock: Clock = systemClock,
): void {
  db.query(
    `INSERT INTO review_heal
       (session_id, since_uuid, target_uuid, shell_id, night, attempts, status, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?)
     ON CONFLICT (session_id, target_uuid) DO NOTHING`,
  ).run(
    rec.sessionId,
    rec.sinceUuid,
    rec.targetUuid,
    rec.shellId,
    rec.night,
    nextNight(rec.night), // 冷却到下夜才愈，避免同夜双烧
    clock.now().toISOString(),
  );
}

/**
 * 选本夜可愈账（§3.3-1）：pending + 未到重试上限 + 冷却已过（next_attempt_at <= 本夜）。
 * 按 created_at 取前 HEAL_BUDGET_PER_NIGHT 条（防风暴）。冷却闸用「正在消化的夜」比较，与时钟无关。
 */
export function selectHealable(db: Database, currentNight: string, budget = HEAL_BUDGET_PER_NIGHT): HealRow[] {
  // U33 双保险：非法预算（<1 / NaN / Infinity）兜回硬默认，绝不透传成 `LIMIT -N`＝无界（防风暴命门）。
  const lim = Number.isFinite(budget) && budget >= 1 ? Math.floor(budget) : HEAL_BUDGET_DEFAULT;
  return db
    .query(
      `SELECT * FROM review_heal
        WHERE status = 'pending' AND attempts < ? AND next_attempt_at <= ?
        ORDER BY created_at LIMIT ?`,
    )
    .all(MAX_HEAL_ATTEMPTS, currentNight, lim) as HealRow[];
}

/** 不可愈：transcript 没了 / since 滚没 / 空增量壳。标 dead，不再重试（H7 诚实缺口，配 marker 由调用方留）。 */
export function markHealDead(db: Database, sessionId: string, targetUuid: string, clock: Clock = systemClock): void {
  db.query(`UPDATE review_heal SET status = 'dead' WHERE session_id = ? AND target_uuid = ?`).run(
    sessionId,
    targetUuid,
  );
}

/** 本次重试失败：attempts++ + 冷却到下夜；到顶由调用方判定后标 dead。 */
export function bumpHealAttempt(
  db: Database,
  sessionId: string,
  targetUuid: string,
  currentNight: string,
): void {
  db.query(
    `UPDATE review_heal SET attempts = attempts + 1, next_attempt_at = ?
      WHERE session_id = ? AND target_uuid = ?`,
  ).run(nextNight(currentNight), sessionId, targetUuid);
}

/** target 不在快照（采集滞后/末段未落）：**不计 attempts**、只把冷却推到下夜重试（同 worker 无惩罚退回）。 */
export function requeueHealNoPenalty(
  db: Database,
  sessionId: string,
  targetUuid: string,
  currentNight: string,
): void {
  db.query(`UPDATE review_heal SET next_attempt_at = ? WHERE session_id = ? AND target_uuid = ?`).run(
    nextNight(currentNight),
    sessionId,
    targetUuid,
  );
}

/**
 * 愈合成功的原子替换（H2 原子幂等）：单事务内 ① 作废壳 ② 写真自评+items（继承壳原位 order_seq=shell_id）
 * ③ 删本账行。**水位线一步不动**（H1：早已在 target，本操作是「就地升级旧记录」非「覆盖新段」）。
 * 崩在事务中 → 整体回滚、账留 pending、下夜重试。generated 必须 ok（调用方只在生成成功时调）。
 */
export function completeHeal(
  db: Database,
  rec: { sessionId: string; targetUuid: string; shellId: number; night: string; generated: GeneratedSelfReview; material: Material },
  clock: Clock = systemClock,
): void {
  const tx = db.transaction(() => {
    // 幂等闸（AUDIT A区#3）：invalidate 是 CAS——抢到翻转壳才写真自评。没抢到（壳已被夜跑/重跑全愈作废）
    // 绝不再写第二条：否则同段两条一样的 live 自评、order_seq 还相同 → 召回双命中/日记双计/人格双读。
    // 没抢到也要清掉本账行收尾（本次愈合任务已无意义，对应自评别处已落）。
    if (!invalidateExperience(db, rec.shellId, clock)) {
      db.query(`DELETE FROM review_heal WHERE session_id = ? AND target_uuid = ?`).run(rec.sessionId, rec.targetUuid);
      return;
    }
    writeSelfReviewBody(
      db,
      rec.generated,
      rec.material,
      clock,
      `${rec.night}T04:00:00.000Z`, // occurredAt = 归属夜（H5：绝不盖成消化时刻）
      undefined,
      rec.shellId, // orderSeq = 壳 id：愈合片排回壳原位（§3.5）
    );
    db.query(`DELETE FROM review_heal WHERE session_id = ? AND target_uuid = ?`).run(rec.sessionId, rec.targetUuid);
  });
  tx();
}

/**
 * 一键全愈用的原子替换（healAllNow 调）：按**壳 id** 顶替（不依赖 review_heal 账，故存量/无边界壳也能愈）。
 * 单事务内 ① 作废壳 ② 写真自评+items（继承壳原位 order_seq=shellId，occurredAt=传入归属夜）③ 删该壳任何 review_heal 账。
 * 与 completeHeal 的差别：那个走切片/账(增量自愈)，这个走整段重嚼(全愈)、按 shell_id 收尾。generated 必 ok。
 */
export function completeHealByShell(
  db: Database,
  rec: { sessionId: string; shellId: number; night: string; generated: GeneratedSelfReview; material: Material },
  clock: Clock = systemClock,
): void {
  const tx = db.transaction(() => {
    // 幂等闸（AUDIT A区#3）：同 completeHeal——抢到翻转壳才写，没抢到（重跑全愈/撞夜跑）只清账不重复写。
    if (!invalidateExperience(db, rec.shellId, clock)) {
      db.query(`DELETE FROM review_heal WHERE shell_id = ?`).run(rec.shellId);
      return;
    }
    writeSelfReviewBody(db, rec.generated, rec.material, clock, `${rec.night}T04:00:00.000Z`, undefined, rec.shellId);
    db.query(`DELETE FROM review_heal WHERE shell_id = ?`).run(rec.shellId);
  });
  tx();
}

/**
 * 存量壳一次性标 unhealable（§3.4，F1）：schema 没存切片边界，既往壳的 since/target 无从可靠反推 →
 * 一律标 unhealable、不建可重试账、不跑 LLM、不猜边界。用壳 uuid 作合成 target（仅满足 PK 唯一），
 * 幂等（ON CONFLICT DO NOTHING）。只扫还没有账的 live 壳（新失败已由 registerHeal 建 pending 账）。
 */
export function markExistingShellsUnhealable(db: Database, clock: Clock = systemClock): number {
  const shells = db
    .query(
      `SELECT id, uuid, occurred_at FROM experiences
        WHERE kind = 'self_review_fallback' AND invalid_at IS NULL AND expired_at IS NULL
          AND source_session IS NOT NULL
          AND id NOT IN (SELECT shell_id FROM review_heal)`,
    )
    .all() as { id: number; uuid: string; occurred_at: string }[];
  const now = clock.now().toISOString();
  let marked = 0;
  for (const s of shells) {
    const night = s.occurred_at.slice(0, 10);
    const sid = (db.query(`SELECT source_session ss FROM experiences WHERE id = ?`).get(s.id) as { ss: string }).ss;
    db.query(
      `INSERT INTO review_heal
         (session_id, since_uuid, target_uuid, shell_id, night, attempts, status, next_attempt_at, created_at)
       VALUES (?, NULL, ?, ?, ?, 0, 'unhealable', ?, ?)
       ON CONFLICT (session_id, target_uuid) DO NOTHING`,
    ).run(sid, s.uuid, s.id, night, night, now);
    marked++;
  }
  return marked;
}
