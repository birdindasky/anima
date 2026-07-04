// 自省探针注册表（自动上墙 Phase 1 / 影子模式）。
//
// 这是 Class A 事实的唯一来源：anima 关于「自己的代码 / schema / 配置」的事实——
// 机器能直接读到真值、不经任何 LLM、不含任何攻击者可控文本、不跑任何 shell。
// 「自愈到底实装了没」正是这一类（getDigestStages() 里有没有 'heal'）——当初烧我们的就是它。
//
// 防御钉 C1（封闭注册表，杜绝 AI 自出考题）：IntrospectKey 是一个**写死的联合类型**，
// 每个 key 映射到一个进程内、代码自有的 reader。没有 probe(任意字符串) 这种东西——
// 未知 key 一律返回 ok:false。AI 至多能「点名」一个已存在的 key，绝无法新增探针或注入命令。
//
// 防御钉 C4-R2（活读才算确认）：每个 reader 每次都**真的去读当前真源**，没有任何缓存值
// 可被「续命」。读到了 → ok:true（这一轮确实活读了一次）；读不到 → ok:false（绝不编造值）。

import type { Database } from "bun:sqlite";
import { getDigestStages } from "./digest";
import { SCHEMA_VERSION, isValidSchemaVersionRaw } from "./db";
import { MAX_HEAL_ATTEMPTS, HEAL_BUDGET_PER_NIGHT } from "./selfHeal";

/** 封闭名单：能自动上墙的 Class A key 全集。新增能力 = 改这里的代码，而非运行时由文本决定。 */
export type IntrospectKey =
  | "anima.schema_version"
  | "anima.digest_stages"
  | "anima.selfheal.wired"
  | "anima.selfheal.max_attempts"
  | "anima.selfheal.budget_per_night"
  | "anima.db.tables";

export const INTROSPECT_KEYS: readonly IntrospectKey[] = [
  "anima.schema_version",
  "anima.digest_stages",
  "anima.selfheal.wired",
  "anima.selfheal.max_attempts",
  "anima.selfheal.budget_per_night",
  "anima.db.tables",
] as const;

/** 哪些 key 需要读 anima.db（其余纯代码读，不碰库）。 */
const DB_BACKED: ReadonlySet<IntrospectKey> = new Set<IntrospectKey>([
  "anima.schema_version",
  "anima.db.tables",
]);

export type ProbeResult =
  | { key: IntrospectKey; ok: true; value: string; source: string }
  // corrupt:true = 真值**存在但损坏**（NULL/非法整数等，疑迁移中断/手改/同步冲突），要在展示层响亮透出「损坏」；
  // 不带 corrupt 的 !ok = 单纯「未知/探测失败」（缺句柄/行缺失/异常），展示层照旧 "unknown"。两者绝不混为一谈。
  | { key: IntrospectKey; ok: false; error: string; source: string; corrupt?: boolean };

/**
 * 读一个 key 的当前真值。db 仅 DB-backed key 需要（且应为 anima.db 的**只读**句柄）。
 * 任何异常都被收敛成 ok:false（PARK：绝不编造值、绝不让一次读失败污染已知事实）。
 */
export function probe(key: IntrospectKey, db?: Database): ProbeResult {
  if (DB_BACKED.has(key) && !db) {
    return { key, ok: false, error: "需要 anima.db 只读句柄但未提供", source: sourceOf(key) };
  }
  try {
    switch (key) {
      case "anima.schema_version": {
        // 真源 = anima.db 的 meta 表（迁移落定的当前版本），不是代码常量——这才是「库实际是第几版」。
        const row = db!
          .query("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string | null } | null;
        if (!row) return { key, ok: false, error: "meta.schema_version 不存在", source: sourceOf(key) };
        // R10 round-2（gap3）：NULL / 非整数（损坏/手改/同步冲突）→ 走可见损坏路径（ok:false），绝不
        // String(null)='null' 冒充普通 data 骗过 whoami/wall（复用 readSchemaVersion 同一判据 isValidSchemaVersionRaw）。
        if (!isValidSchemaVersionRaw(row.value)) {
          return {
            key,
            ok: false,
            corrupt: true, // 真值在但损坏 → 展示层要响亮透出「损坏」，不得压平成 unknown
            error: `meta.schema_version 损坏（非法整数）: ${row.value === null ? "<NULL>" : JSON.stringify(row.value)}`,
            source: sourceOf(key),
          };
        }
        return { key, ok: true, value: String(row.value), source: sourceOf(key) };
      }
      case "anima.db.tables": {
        const rows = db!
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[];
        return { key, ok: true, value: rows.map((r) => r.name).join(","), source: sourceOf(key) };
      }
      case "anima.digest_stages": {
        // 夜间消化真实跑的阶段顺序。含不含 'heal' = 自愈这条腿在不在线。
        return { key, ok: true, value: getDigestStages().join(","), source: sourceOf(key) };
      }
      case "anima.selfheal.wired": {
        // 把上面那条蒸成一个干净布尔：'heal' 在阶段表里 = 自愈已接线。就是烧过我们的那条事实。
        const wired = getDigestStages().includes("heal");
        return { key, ok: true, value: String(wired), source: sourceOf(key) };
      }
      case "anima.selfheal.max_attempts":
        return { key, ok: true, value: String(MAX_HEAL_ATTEMPTS), source: sourceOf(key) };
      case "anima.selfheal.budget_per_night":
        return { key, ok: true, value: String(HEAL_BUDGET_PER_NIGHT), source: sourceOf(key) };
      default: {
        // 编译期已穷尽；运行期兜底防「点了名单外的 key」（C1）。
        const _exhaustive: never = key;
        return {
          key: key as IntrospectKey,
          ok: false,
          error: `未知 key（不在封闭注册表内）: ${String(_exhaustive)}`,
          source: "unknown",
        };
      }
    }
  } catch (e) {
    return { key, ok: false, error: (e as Error).message, source: sourceOf(key) };
  }
}

/** 防御钉 C4-R1：每次都把名单里**每一个** key 全跑一遍，不存在「这个 key 这轮跳过」的节流。 */
export function probeAll(db?: Database): ProbeResult[] {
  return INTROSPECT_KEYS.map((k) => probe(k, db));
}

function sourceOf(key: IntrospectKey): string {
  switch (key) {
    case "anima.schema_version":
      return "anima.db:meta.schema_version";
    case "anima.db.tables":
      return "anima.db:sqlite_master";
    case "anima.digest_stages":
    case "anima.selfheal.wired":
      return "src/digest.ts:getDigestStages()";
    case "anima.selfheal.max_attempts":
      return "src/selfHeal.ts:MAX_HEAL_ATTEMPTS";
    case "anima.selfheal.budget_per_night":
      return "src/selfHeal.ts:HEAL_BUDGET_PER_NIGHT";
  }
}
