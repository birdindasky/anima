// 给经历补算/更新语义指纹。可断点续跑、幂等。embed 函数注入（测试用桩，生产用真模型）。
// 铁律：模型调用在 SQLite 事务之外（两段式：先算向量、再快速事务落库），不把重活圈进库锁。
import type { Database } from "bun:sqlite";
import { EMBED_MODEL_VER, vecToBlob } from "./embed";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface BackfillOpts {
  /** 用哪个模型版本标记（默认当前锁定模型）。换模型时旧版本的向量会被重算。 */
  modelVer?: string;
  /** 每批喂多少条给模型 */
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

interface PendingRow {
  id: number;
  content: string;
}

/**
 * U37（AUDIT-2026-07-01 盘点）：清向量孤儿——宿主经历已作废/过期的 vec_experiences 行。
 * experiences 零物理删除（append-only 铁律）→ 孤儿只有「dead 宿主」一种形态；读侧本就三重闸
 * （live JOIN + model_ver 过滤 + 维度校验），孤儿不是召回污染、只是磁盘与全表扫的无界增长。
 * 纯 SQL 同步、幂等；夜跑 stageVectorize 顺手清（backfill 之前，省得扫描面白白变大）。
 */
export function pruneOrphanVectors(db: Database): number {
  return db
    .query(
      `DELETE FROM vec_experiences WHERE experience_id IN (
         SELECT id FROM experiences WHERE expired_at IS NOT NULL OR invalid_at IS NOT NULL)`,
    )
    .run().changes;
}

/**
 * 给「live 且尚无当前模型指纹」的经历补算向量，返回新算条数。
 * - 续跑：已有当前版本向量的跳过；中途被杀，重跑只补剩下的。
 * - 幂等：同一条最多一行（experience_id 主键 + ON CONFLICT 覆盖）。
 */
export async function backfillVectors(db: Database, embed: EmbedFn, opts: BackfillOpts = {}): Promise<number> {
  const modelVer = opts.modelVer ?? EMBED_MODEL_VER;
  const batchSize = opts.batchSize ?? 32;

  const pending = db
    .query(
      `SELECT e.id AS id, e.content AS content
         FROM experiences e
         LEFT JOIN vec_experiences v ON v.experience_id = e.id
        WHERE e.expired_at IS NULL AND e.invalid_at IS NULL
          AND (v.experience_id IS NULL OR v.model_ver != ?)
        ORDER BY e.id ASC`,
    )
    .all(modelVer) as PendingRow[];

  const total = pending.length;
  if (total === 0) {
    opts.onProgress?.(0, 0);
    return 0;
  }

  const upsert = db.query(
    `INSERT INTO vec_experiences (experience_id, embedding, model_ver) VALUES (?, ?, ?)
     ON CONFLICT(experience_id) DO UPDATE SET embedding = excluded.embedding, model_ver = excluded.model_ver`,
  );
  const writeBatch = db.transaction((rows: PendingRow[], vecs: Float32Array[]) => {
    for (let j = 0; j < rows.length; j++) upsert.run(rows[j].id, vecToBlob(vecs[j]), modelVer);
  });

  let done = 0;
  for (let i = 0; i < total; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vecs = await embed(batch.map((r) => r.content)); // 模型调用：事务外
    writeBatch(batch, vecs); // 落库：快速事务
    done += batch.length;
    opts.onProgress?.(done, total);
  }
  return done;
}
