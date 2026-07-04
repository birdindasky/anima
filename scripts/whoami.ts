// anima whoami —— 真相源命令（SELFKNOW-SPEC #1）。
//
// 治「自愈没实装」那类凭印象说错 anima 自己实现状态的乌龙：把 anima 当前的**机器真值**一次打印齐。
// 每个字段都从**真实源头现读**（代码常量 / DB meta / launchctl / env），绝不硬编码、绝不缓存——
// 改一处真值（迁一版库、砍一个阶段、翻一个 flag），whoami 下次跑就跟着变。
//
// 把 src/introspect.ts 的自省探针（那 6 个 Class-A readers）收敛进这一个
// 按需命令：DB-backed 真值走 introspect.probeAll（只读句柄 + 封闭注册表，绝不编造值），
// 其余（阶段接线 / embedder / flags / launchctl / 计数）直接现读源头。
//
// 用法：bun scripts/whoami.ts [db路径]   （默认 ~/.claude/anima/anima.db）

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { SCHEMA_VERSION } from "../src/db";
import { getDigestStages, getWiredStages } from "../src/digest";
import { EMBED_MODEL, EMBED_MODEL_VER, EMBED_DIM } from "../src/embed";
import { MAX_HEAL_ATTEMPTS, HEAL_BUDGET_PER_NIGHT } from "../src/selfHeal";
import { probeAll, type IntrospectKey, type ProbeResult } from "../src/introspect";

export interface StageWiring {
  name: string;
  wired: boolean;
}
export interface LaunchdJob {
  label: string;
  pid: string;
  status: string;
}
export interface FlagInfo {
  name: string;
  value: string;
  source: string;
}
export interface KindCount {
  kind: string;
  count: number;
}
export interface DigestRunRow {
  night: string;
  stage: string;
  status: string;
}
export interface EmbedderInfo {
  model: string;
  modelVer: string;
  dim: number;
  liveExperiences: number;
  vectorized: number;
  staleVectors: number;
  coveragePct: number;
}
export interface SelfKnowledge {
  dbPath: string;
  schemaVersion: string; // DB meta 现读（库实际第几版）
  codeSchemaVersion: number; // 代码常量 SCHEMA_VERSION（代码支持第几版）
  tables: string[];
  stages: StageWiring[];
  selfheal: { wired: boolean; maxAttempts: string; budgetPerNight: string };
  launchd: LaunchdJob[];
  embedder: EmbedderInfo;
  flags: FlagInfo[];
  kindCounts: KindCount[];
  recentDigestRuns: DigestRunRow[];
  probes: ProbeResult[]; // 收敛进来的 introspect 探针原始结果（审计留痕）
}

export interface WhoamiOptions {
  /** anima.db 的**只读**句柄（DB-backed 真值现读用）。 */
  db: Database;
  dbPath: string;
  /** `launchctl list` 原始输出提供者；默认真跑 launchctl（测试注入假值）。 */
  launchctlList?: () => string;
}

/** 真跑 `launchctl list`。失败（非 mac / 无 launchctl）返回空串——降级为「读不到」，绝不编造。 */
function defaultLaunchctlList(): string {
  try {
    const p = Bun.spawnSync(["launchctl", "list"]);
    return p.success ? p.stdout.toString() : "";
  } catch {
    return "";
  }
}

/** 解析 `launchctl list` 输出（列：PID \t Status \t Label），只留 com.anima* 标签。 */
export function parseLaunchd(raw: string): LaunchdJob[] {
  const jobs: LaunchdJob[] = [];
  for (const line of raw.split("\n")) {
    const [pid, status, label] = line.split("\t");
    if (label === undefined || pid === undefined || status === undefined) continue;
    const l = label.trim();
    if (!l.startsWith("com.anima")) continue; // 表头 "Label" / 其它 job 一律滤掉
    jobs.push({ pid: pid.trim(), status: status.trim(), label: l });
  }
  return jobs;
}

function probeMap(probes: ProbeResult[]): Map<IntrospectKey, ProbeResult> {
  const m = new Map<IntrospectKey, ProbeResult>();
  for (const p of probes) m.set(p.key, p);
  return m;
}
function probeValue(m: Map<IntrospectKey, ProbeResult>, key: IntrospectKey): string {
  const p = m.get(key);
  if (!p) return "unknown";
  if (p.ok) return p.value;
  // 真值损坏（NULL/非法整数）→ 主字段响亮「损坏」，绝不压平成 unknown 冒充正常态；其余 !ok 仍 "unknown"。
  return p.corrupt ? "损坏" : "unknown";
}

/**
 * 采集 anima 当前机器真值。纯读——DB-backed 走只读句柄 + introspect 探针，其余现读代码/env/launchctl。
 * 导出供单测逐字段对真实源头核对（改一处真值，返回值跟着变）。
 */
export function collectSelfKnowledge(opts: WhoamiOptions): SelfKnowledge {
  const { db, dbPath } = opts;
  const probes = probeAll(db); // 收敛的 introspect readers：只有本轮真活读到的才 ok:true
  const pm = probeMap(probes);

  // schema_version：DB meta 现读（不是代码常量）——库实际是第几版。
  const schemaVersion = probeValue(pm, "anima.schema_version");
  const tablesRaw = probeValue(pm, "anima.db.tables");
  const tables = tablesRaw === "unknown" ? [] : tablesRaw.split(",").filter(Boolean);

  // 夜跑阶段 + 各是否 wired：现读 STAGE_FNS 运行时对象（getWiredStages），非硬编码清单。
  const wired = new Set<string>(getWiredStages());
  const stages: StageWiring[] = getDigestStages().map((name) => ({ name, wired: wired.has(name) }));

  const selfheal = {
    wired: probeValue(pm, "anima.selfheal.wired") === "true",
    maxAttempts: probeValue(pm, "anima.selfheal.max_attempts"),
    budgetPerNight: probeValue(pm, "anima.selfheal.budget_per_night"),
  };

  // embedder：模型/维度现读 embed.ts；覆盖率 = 当前模型版本向量数 vs live 经历数（真 DB 计数）。
  const liveExperiences = (
    db
      .query(
        "SELECT COUNT(*) c FROM experiences WHERE expired_at IS NULL AND invalid_at IS NULL",
      )
      .get() as { c: number }
  ).c;
  const vectorized = (
    db
      .query(
        `SELECT COUNT(*) c FROM experiences e JOIN vec_experiences v ON v.experience_id = e.id
          WHERE e.expired_at IS NULL AND e.invalid_at IS NULL AND v.model_ver = ?`,
      )
      .get(EMBED_MODEL_VER) as { c: number }
  ).c;
  const staleVectors = (
    db
      .query("SELECT COUNT(*) c FROM vec_experiences WHERE model_ver != ?")
      .get(EMBED_MODEL_VER) as { c: number }
  ).c;
  const coveragePct =
    liveExperiences === 0 ? 100 : Math.round((vectorized / liveExperiences) * 1000) / 10;
  const embedder: EmbedderInfo = {
    model: EMBED_MODEL,
    modelVer: EMBED_MODEL_VER,
    dim: EMBED_DIM,
    liveExperiences,
    vectorized,
    staleVectors,
    coveragePct,
  };

  // feature flags / gates：env + 代码常量 + DB meta 现读。
  const daysplitEnv = process.env.ANIMA_DAYSPLIT ?? "(unset)";
  const daysplitActive = process.env.ANIMA_DAYSPLIT === "1";
  const daysplitMarker = db
    .query("SELECT value FROM meta WHERE key = 'daysplit_activated'")
    .get() as { value: string } | null;
  // autowall 写侧已埋葬（docs/TOMBSTONE-AUTOWALL.md）：ANIMA_PROMOTE / gate:* 显示位随葬。
  const flags: FlagInfo[] = [
    {
      name: "ANIMA_DAYSPLIT",
      value: `${daysplitActive ? "on" : "off"} (env=${daysplitEnv})`,
      source: "env ANIMA_DAYSPLIT → digest.ts stageMakeup / worker.ts",
    },
    {
      name: "daysplit_activated",
      value: daysplitMarker ? `activated (${daysplitMarker.value})` : "not-activated",
      source: "anima.db:meta.daysplit_activated",
    },
  ];

  const kindCounts = db
    .query(
      `SELECT kind, COUNT(*) c FROM experiences
        WHERE expired_at IS NULL AND invalid_at IS NULL GROUP BY kind ORDER BY c DESC, kind ASC`,
    )
    .all() as { kind: string; c: number }[];

  const recentDigestRuns = db
    .query(
      `SELECT night, stage, status FROM digest_runs
        WHERE night IN (SELECT DISTINCT night FROM digest_runs ORDER BY night DESC LIMIT 3)
        ORDER BY night DESC, stage ASC`,
    )
    .all() as DigestRunRow[];

  const launchd = parseLaunchd((opts.launchctlList ?? defaultLaunchctlList)());

  return {
    dbPath,
    schemaVersion,
    codeSchemaVersion: SCHEMA_VERSION,
    tables,
    stages,
    selfheal,
    launchd,
    embedder,
    flags,
    kindCounts: kindCounts.map((r) => ({ kind: r.kind, count: r.c })),
    recentDigestRuns,
    probes,
  };
}

/** 把机器真值渲染成给人看的报告（纯字符串，不写盘）。 */
export function renderSelfKnowledge(sk: SelfKnowledge): string {
  const L: string[] = [];
  L.push("═══ anima whoami — 机器真值·现读（非缓存 / 非硬编码）═══");
  L.push(`DB: ${sk.dbPath}`);
  L.push("");

  const schemaProbe = sk.probes.find((p) => p.key === "anima.schema_version");
  L.push("── schema ──");
  if (schemaProbe && !schemaProbe.ok && schemaProbe.corrupt) {
    // 损坏态（NULL/非法整数）响亮透出，不走漂移比较（否则会被误报成「版本漂移」掩盖真相）。
    L.push(`  DB schema_version: ⚠️ 损坏（${schemaProbe.error}）   代码 SCHEMA_VERSION: ${sk.codeSchemaVersion}`);
  } else {
    const drift = sk.schemaVersion !== String(sk.codeSchemaVersion);
    L.push(`  DB schema_version: ${sk.schemaVersion}   代码 SCHEMA_VERSION: ${sk.codeSchemaVersion}${drift ? "   ⚠️ 不一致（库与代码版本漂移）" : ""}`);
  }
  L.push(`  tables (${sk.tables.length}): ${sk.tables.join(", ")}`);
  L.push("");

  L.push("── 夜跑阶段（STAGES + 是否 wired）──");
  for (const s of sk.stages) L.push(`  ${s.wired ? "✅" : "❌"} ${s.name}${s.wired ? "" : "   ← 挂名却没接实现！"}`);
  L.push("");

  L.push("── 自愈 ──");
  L.push(`  heal 阶段接线: ${sk.selfheal.wired ? "✅ wired（在线）" : "❌ 未接线"}`);
  L.push(`  HEAL_BUDGET_PER_NIGHT: ${sk.selfheal.budgetPerNight}    MAX_HEAL_ATTEMPTS: ${sk.selfheal.maxAttempts}`);
  L.push("");

  L.push("── launchd（当前加载）──");
  if (sk.launchd.length === 0) L.push("  (无 com.anima* 任务加载 / launchctl 读不到)");
  for (const j of sk.launchd) L.push(`  ${j.label}   pid=${j.pid} status=${j.status}`);
  L.push("");

  const e = sk.embedder;
  L.push("── embedder ──");
  L.push(`  模型: ${e.model}  (ver=${e.modelVer}, dim=${e.dim})`);
  L.push(`  向量覆盖率: ${e.vectorized}/${e.liveExperiences} live 经历 = ${e.coveragePct}%${e.staleVectors > 0 ? `   (另有 ${e.staleVectors} 条旧模型向量待重算)` : ""}`);
  L.push("");

  L.push("── feature flags / gates ──");
  for (const f of sk.flags) L.push(`  ${f.name} = ${f.value}   [${f.source}]`);
  L.push("");

  L.push("── 记忆计数（live，按 kind）──");
  const total = sk.kindCounts.reduce((a, k) => a + k.count, 0);
  for (const k of sk.kindCounts) L.push(`  ${k.kind}: ${k.count}`);
  L.push(`  合计 live: ${total}`);
  L.push("");

  L.push("── 最近 digest_runs（近 3 夜）──");
  if (sk.recentDigestRuns.length === 0) L.push("  (无 digest_runs 记录)");
  let curNight = "";
  for (const r of sk.recentDigestRuns) {
    if (r.night !== curNight) {
      curNight = r.night;
      L.push(`  ${r.night}:`);
    }
    L.push(`    ${r.status === "done" ? "✅" : "❌"} ${r.stage}: ${r.status}`);
  }
  return L.join("\n");
}

/**
 * 打开一个**只读姿态**的库句柄。用 rw 打开 + `PRAGMA query_only = TRUE`（SQL 层禁写、绝不动一行数据），
 * **不用 `{readonly:true}`**：WAL 库要读得起 -shm 共享内存索引，纯 readonly 句柄在无活边车的库
 * （如 checkpoint 过的快照副本）上**开得成、一查表就 SQLITE_CANTOPEN**（开时不报错、无法在 open 处 catch）。
 * rw 有权建 -shm，query_only 又焊死写路径 → 生产库、快照副本一律读得通、又保证零改动。
 * 不走 openDb：不触发迁移（whoami 只观察、不升级库）。
 */
function openForRead(dbPath: string): Database {
  if (!existsSync(dbPath)) {
    throw new Error(`anima.db 不存在: ${dbPath}（指一个真库路径，或先让 anima 跑一次建库）`);
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA query_only = TRUE;");
  return db;
}

if (import.meta.main) {
  const dbPath =
    process.argv[2] ??
    `${process.env.ANIMA_DATA_DIR ?? `${process.env.HOME}/.claude/anima`}/anima.db`;
  const db = openForRead(dbPath);
  try {
    console.log(renderSelfKnowledge(collectSelfKnowledge({ db, dbPath })));
  } finally {
    db.close();
  }
}
