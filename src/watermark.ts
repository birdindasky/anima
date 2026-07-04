// 复盘水位线（review_watermark）的读 / CAS / 独立推进。
// 水位线是【操作游标】（同 capture_cursors 性质，可更新），不是记忆——不受「经历只追加」铁律约束。
// 兼任并发去重闸：CAS（首评 INSERT…ON CONFLICT DO NOTHING、增量 UPDATE…WHERE last_uuid=旧值）
// 抢到才写增量自评，抢不到一行不落。见 DESIGN-WORKER-RESUME §3.1 / §4.3-2。
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";

/** 序见证：transcript 条目快照（只用 uuid），供 CAS 原语校验推进方向。 */
export type WatermarkOrder = ReadonlyArray<{ uuid: string }>;

/** 读会话当前水位线 last_uuid；无记录（从未复盘）→ null。纯读。 */
export function readWatermark(db: Database, sessionId: string): string | null {
  const r = db.query("SELECT last_uuid FROM review_watermark WHERE session_id = ?").get(sessionId) as
    | { last_uuid: string }
    | null;
  return r?.last_uuid ?? null;
}

/**
 * U28（AUDIT-2026-07-01 盘点）防回退守卫：oldUuid 与 newUuid 都能在序见证里定位、且 new 严格早于
 * old → 拒绝（把已消化段重标未消化＝重复记忆的源头）。任一不可见（换 transcript / rewind 的合法
 * resume）→ 放行给 DB 层 CAS——序无从谈起时不误杀，调用方 atOrAfter 护栏 + 库层去重兜。
 * `order` **必传**：传序列＝校验；传 null＝显式弃权（写者自证无 transcript 语境，可 grep 审计）；
 * 漏传（undefined，bun 不做类型检查）→ throw，fail-loud 绝不静默跳守卫——本守卫的存在意义就是
 * 堵"新调用方漏写护栏"，若漏传能悄悄通过，守卫本身就成了下一个漏写点。
 */
function refuseRollback(oldUuid: string | null, newUuid: string, order: WatermarkOrder | null | undefined): boolean {
  if (order === undefined) {
    throw new Error("casWatermark/advanceWatermarkOnly 缺序见证参数：传 transcript entries 或显式 null 弃权");
  }
  if (oldUuid === null || order === null) return false;
  const oi = order.findIndex((e) => e.uuid === oldUuid);
  if (oi < 0) return false;
  const ni = order.findIndex((e) => e.uuid === newUuid);
  return ni >= 0 && ni < oi;
}

/**
 * 水位线 CAS（去重闸核心）：抢到「把 oldUuid→newUuid 这一推进」返回 true，抢不到返回 false。
 * **单条写语句、纯同步、不开事务**——可被嵌进调用方更大的事务（storeSelfReviewResult 的写库事务）：
 *  - 首评（oldUuid=null）：`INSERT … ON CONFLICT(session_id) DO NOTHING`，已有行（别的写者先到）→ changes=0 → false。
 *  - 增量（oldUuid≠null）：`UPDATE … WHERE last_uuid=oldUuid`，别人已推过 → changes=0 → false。
 *  - 回退推进（order 见证下 new 早于 old）→ false，一行不写（U28）。
 */
export function casWatermark(
  db: Database,
  sessionId: string,
  oldUuid: string | null,
  newUuid: string,
  now: string,
  order: WatermarkOrder | null,
): boolean {
  if (refuseRollback(oldUuid, newUuid, order)) return false;
  if (oldUuid === null) {
    return (
      db
        .query(
          `INSERT INTO review_watermark (session_id, last_uuid, updated_at)
           VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
        )
        .run(sessionId, newUuid, now).changes > 0
    );
  }
  return (
    db
      .query(
        `UPDATE review_watermark SET last_uuid = ?, updated_at = ?
         WHERE session_id = ? AND last_uuid = ?`,
      )
      .run(newUuid, now, sessionId, oldUuid).changes > 0
  );
}

/**
 * 只推水位线、不写自评（§3.3 空增量：resume 了但无实质新回合 → 推过空尾巴避免每夜重排）。
 * 单条 CAS 语句自带原子性，返回是否抢到（抢不到＝别的写者已推过，无害）。序见证同 casWatermark（U28）。
 */
export function advanceWatermarkOnly(
  db: Database,
  sessionId: string,
  oldUuid: string | null,
  newUuid: string,
  order: WatermarkOrder | null,
  clock: Clock = systemClock,
): boolean {
  return casWatermark(db, sessionId, oldUuid, newUuid, clock.now().toISOString(), order);
}
