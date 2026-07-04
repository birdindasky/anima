// 安全旋钮 env 解析的单一事实源（AUDIT B区·env 健壮性 → 2026-07-01 盘点 U33 提为全库共用）。
// 旧惯用法 `Number(env) || 默认` 会**静默吃负数**（`Number("-1")||50` = -1，因为 -1 truthy）——
// 对预算/闸值这类安全钮，负数往下游一传（如 SQLite `LIMIT -1`＝不限量）就把防线整个架空。
// 修：非数/越界一律退默认。安全类旋钮一律走它，保持「env 只准把闸调得更严」的方向性。
export function envInt(name: string, def: number, opts: { min?: number; max?: number } = {}): number {
  const raw = Math.floor(Number(process.env[name]));
  if (!Number.isFinite(raw)) return def;
  if (raw < (opts.min ?? 1) || raw > (opts.max ?? Number.POSITIVE_INFINITY)) return def; // 越界=可疑→退默认
  return raw;
}
