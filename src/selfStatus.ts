// 开会话自动注入「anima 机器真值·当前」小块（SELFKNOW-SPEC #2 ★核心）。
//
// 治「自愈没实装」那类凭印象说错 anima 自身实现状态的乌龙：把最易记错的机器真值
// （schema 版本 / 夜跑阶段 / 自愈是否接线 / 关键 flags / live 记忆量）压成一段 < 小配额 token
// 的块，随 <anima-context> 每次 SessionStart **现算**注入——真相常驻眼前、不靠纪律。
//
// 铁律（与 whoami #1 同一批 readers、同一套安全约束）：
//  - **永远现算、不缓存、不过期**：每次都真去读 introspect 探针 + DB 计数 + env + 代码常量。
//    改一处真值（迁库 / 砍阶段 / 翻 flag / 加删记忆）→ 下次 SessionStart 注入跟着变。
//  - **零往返、绝不碰向量模型**：只 probeAll（只读句柄读代码/DB meta）+ 一条 COUNT + env 读，几毫秒。
//    绝不 getPipe()/embed()——不加载权重、不做推理（这批 reader 本就无任何模型触点）。
//  - **单独小配额、放 base 不可压缩区**：长度由 inject.ts REGION_QUOTAS.selfStatus 硬限，绝不吃记忆预算。
//
// 复用 whoami #1 那批 introspect readers（probeAll，封闭注册表、活读才算数），不新造真值通道。
import type { Database } from "bun:sqlite";
import { probeAll, type IntrospectKey, type ProbeResult } from "./introspect";
import { truncateToTokens } from "./tokens";

function pick(probes: ProbeResult[], key: IntrospectKey): string {
  const p = probes.find((x) => x.key === key);
  if (!p) return "unknown";
  if (p.ok) return p.value;
  // 区分两种 !ok：真值损坏 → 响亮「损坏」（绝不静默降级成正常态）；单纯未知/探测失败 → "unknown"。
  return p.corrupt ? "损坏" : "unknown";
}

/** 某 key 的真值是否「存在但损坏」（NULL/非法整数等），供展示层挑更响亮的写法。 */
function isCorrupt(probes: ProbeResult[], key: IntrospectKey): boolean {
  const p = probes.find((x) => x.key === key);
  return !!p && !p.ok && !!p.corrupt;
}

/**
 * 现读一段「anima 机器真值·当前」小块（纯字符串，不写盘、不缓存、不碰模型）。
 * @param maxTokens 硬上限（= REGION_QUOTAS.selfStatus）。最后一道保险截断，正常内容远在配额内、几乎不触发。
 */
export function buildSelfStatusBlock(db: Database, maxTokens: number): string {
  const probes = probeAll(db); // 与 whoami 同一批 readers：每 key 每次活读一次，无任何缓存续命
  const schema = pick(probes, "anima.schema_version"); // DB meta 现读（库实际第几版）
  const stages = pick(probes, "anima.digest_stages"); // 逗号分隔；含不含 heal 一眼可见
  const healWired = pick(probes, "anima.selfheal.wired") === "true";
  const healBudget = pick(probes, "anima.selfheal.budget_per_night");

  // feature flags：env 现读（与 whoami 同源）。PROMOTE 显示位已随 autowall 埋葬（TOMBSTONE-AUTOWALL）。
  const daysplit = process.env.ANIMA_DAYSPLIT === "1" ? "on" : "off";

  // live 记忆量：单条 COUNT，几毫秒；增删一条记忆下次注入即变——现算非缓存的活证。
  const liveCount = (
    db
      .query("SELECT COUNT(*) c FROM experiences WHERE expired_at IS NULL AND invalid_at IS NULL")
      .get() as { c: number }
  ).c;

  // schema_version 损坏（NULL/非法整数）→ 明说「损坏」而非 `schema v损坏`/`schema vunknown` 的静默降级。
  const schemaField = isCorrupt(probes, "anima.schema_version")
    ? "schema 损坏（schema_version 非法，疑迁移中断/手改/同步冲突）"
    : `schema v${schema}`;

  const block = [
    "anima 机器真值·当前（现读非缓存，说自身实现状态以此为准，勿凭印象）：",
    `${schemaField}｜夜跑阶段 ${stages}`,
    `自愈 heal ${healWired ? "已接线" : "未接线"}（每夜预算 ${healBudget}）｜DAYSPLIT ${daysplit}｜live 记忆 ${liveCount} 条`,
    // D3a（AUDIT-2026-07-03 收尾）：末行指引——此块只是开会话快照，覆盖不了全部真值面；
    // 要对外断言块里没有的实现状态项，指路 whoami（bun scripts/whoami.ts）现查，治「凭印象说错自身状态」复发。
    "本块是开会话快照；断言块里没有的 anima 实现状态项，先跑 anima whoami 拿现值，别凭印象。",
  ].join("\n");

  // 最后一道保险：绝不越出单独小配额（正常内容远在配额内，此截断几乎不触发）。
  return truncateToTokens(block, maxTokens);
}
