// 混合检索：字面（searchExperiences，专名/色号/ULID 精确）+ 语义（向量余弦，换说法召回），
// 用 RRF 融合。字面侧永远保留——语义不挤掉它，两路互补。查询 embedding 注入（测试用桩、
// 生产用 embedQuery）。opts.semantic=false 一键退回纯字面（逃生阀）；模型缺失/出错也自动兜回字面。
import type { Database } from "bun:sqlite";
import {
  mapExperienceRow,
  RECALL_EXCLUDE_KIND_SQL,
  searchExperiences,
  type ExperienceRow,
  type RawRow,
  type SearchOptions,
} from "./experiences";
import { blobToVec, cosine, EMBED_MODEL_VER } from "./embed";

export type QueryEmbedder = (query: string) => Promise<Float32Array>;

/**
 * 向量路余弦地板：低于此值视为"语义正交、明显无关"，不进候选。**保守值，只剪明显垃圾。**
 *
 * ⚠️ 这不是"陷阱题空返回"的解（独立考官真模型 + 真梦游端到端证伪过一个更高的地板）：
 * bge-base-zh 真实余弦下，陷阱噪音与真命中**区间重叠、无法用单一标量地板分开**——
 *   · 陷阱「数据库」同域噪音顶 ≈0.51–0.56（仅共享项目名"青柠"这类大众词）；
 *   · 真命中 C5「最烦躁」≈0.42（比陷阱噪音还低）、C10「配置格式/YAML」≈0.53（纯靠语义）；
 *   · 跨语言真命中（中文查→英文经历）≈0.45 且零字面重叠，长得和陷阱噪音一样。
 * 想抬地板堵陷阱(0.55)必连坐杀掉 C5/跨语言真召回；想保真召回必放陷阱噪音。二者方向相反，
 * 中间无安全窗。干净的"该空就空"需检索栈升级（字面侧 IDF/BM25 降权大众词、或更强 embedder、
 * 或梦游侧把区分性关键词写进经历让字面路兜得住低覆盖真命中），非一个旋钮能解——已记 HANDOFF。
 *
 * 故此地板取**保守 0.30**：只挡住真正正交的项（跨项目残余、纯无关），对真召回零代价（实测真
 * 命中底 ≈0.42，远在其上），不为"看起来堵了陷阱"去赌一个误杀真命中的高地板。
 */
export const VECTOR_MIN_COSINE = 0.3;

export interface HybridOptions extends SearchOptions {
  /** 关掉则纯字面（一键逃生）。默认开。 */
  semantic?: boolean;
  /** 各路融合前取前多少候选 */
  candidateK?: number;
  /** RRF 常数，越大名次差异越平滑（标准 60） */
  rrfK?: number;
  /** 向量候选的余弦地板（默认 VECTOR_MIN_COSINE）。低于此值不进候选。 */
  minCosine?: number;
}

/** 向量侧：embed 查询 → 库内 live 向量余弦排序 → 前 candidateK 的经历行。 */
async function vectorSearch(
  db: Database,
  query: string,
  embed: QueryEmbedder,
  opts: HybridOptions,
): Promise<ExperienceRow[]> {
  // model_ver 过滤（AUDIT-2026-07-01 rank9，读侧防混版）：只取当前 embedder 的向量。换 embedder / backfill
  // 半途库里会混着老维/异模型向量，与当前查询向量算余弦是垃圾（异模型乱余弦错捞 / 维度不等 NaN 漏召）。
  // 写侧 vectorize 早按 model_ver 判重算=典型「写严读漏」，这里把读侧补齐。稳态单模型下等价 no-op。
  const where: string[] = [RECALL_EXCLUDE_KIND_SQL, "v.model_ver = ?"];
  const params: (string | number)[] = [EMBED_MODEL_VER];
  if (!opts.includeHistory) where.push("e.expired_at IS NULL AND e.invalid_at IS NULL");
  if (opts.project !== undefined) {
    where.push(opts.includeGlobal ? "(e.project = ? OR e.project IS NULL)" : "e.project = ?");
    params.push(opts.project);
  }
  const sql = `SELECT e.*, v.embedding AS _emb
    FROM vec_experiences v JOIN experiences e ON e.id = v.experience_id
    WHERE ${where.join(" AND ")}`;
  const rows = db.query(sql).all(...params) as (RawRow & { _emb: Uint8Array })[];
  if (rows.length === 0) return [];
  const qv = await embed(query);
  const floor = opts.minCosine ?? VECTOR_MIN_COSINE;
  // 逐行算余弦：单条坏 blob（字节数非 4 倍 → blobToVec 抛 RangeError）**只跳过它**，绝不让一行异常冒泡到
  // searchExperiencesHybrid 的 catch、把整段语义召回永久降级纯字面（AUDIT-2026-07-01 rank8）。
  const scored: { r: RawRow & { _emb: Uint8Array }; s: number }[] = [];
  for (const r of rows) {
    let s: number;
    try {
      s = cosine(qv, blobToVec(r._emb));
    } catch {
      continue; // 坏 blob 跳过（该行标记待重算由 backfill 兜；此处只保证召回不整体哑火）
    }
    if (s >= floor) scored.push({ r, s }); // 低于地板：泛泛沾边，别塞候选（防陷阱题捞噪音）
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.candidateK ?? 20)
    .map((x) => mapExperienceRow(x.r));
}

/** RRF：每路按名次给分 1/(k+rank+1)，累加。两路都靠前的自然胜出。 */
function rrf(lists: number[][], k: number): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return score;
}

export async function searchExperiencesHybrid(
  db: Database,
  query: string,
  embed: QueryEmbedder,
  opts: HybridOptions = {},
): Promise<ExperienceRow[]> {
  const limit = opts.limit ?? 20;
  const candidateK = opts.candidateK ?? 20;
  const lexical = searchExperiences(db, query, { ...opts, limit: candidateK });

  if (opts.semantic === false) return lexical.slice(0, limit);

  let vector: ExperienceRow[];
  try {
    vector = await vectorSearch(db, query, embed, { ...opts, candidateK });
  } catch {
    return lexical.slice(0, limit); // 语义出错（模型缺失等）→ 纯字面兜底
  }
  if (vector.length === 0) return lexical.slice(0, limit);

  const byId = new Map<number, ExperienceRow>();
  for (const r of [...lexical, ...vector]) byId.set(r.id, r);
  const fused = rrf([lexical.map((r) => r.id), vector.map((r) => r.id)], opts.rrfK ?? 60);
  // 排序：融合分（相关性）是主轴；同分才按 情绪烙印→近因→id 打破——镜像字面路 searchExperiences
  // 的同分加权，绝不让情绪/近因越过相关性（Codex 审计原则）。消掉此前靠 Map 插入序的任意排序（钝）。
  const moodFlag = (r: ExperienceRow) => (r.feeling && r.feeling.trim() ? 1 : 0);
  return [...fused.entries()]
    .sort((x, y) => {
      if (y[1] !== x[1]) return y[1] - x[1]; // 融合分高者在前（相关性主轴）
      const rx = byId.get(x[0])!, ry = byId.get(y[0])!;
      if (moodFlag(ry) !== moodFlag(rx)) return moodFlag(ry) - moodFlag(rx); // 带情绪烙印的在前
      if (rx.occurredAt !== ry.occurredAt) return rx.occurredAt > ry.occurredAt ? -1 : 1; // 近因在前
      return ry.id - rx.id; // 稳定末位序
    })
    .slice(0, limit)
    .map(([id]) => byId.get(id)!);
}
