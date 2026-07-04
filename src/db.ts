// SQLite 数据层：WAL + busy_timeout（并发会话只追加不互改）、FTS5 trigram 索引（中文召回）
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 8;

// R10：迁移引擎的两类"响亮失败"——绝不静默吞、绝不静默盖版本。用具名 error 让上层（openAnima）能
// instanceof 精确分流成"可见降级态"，而不是被 hook 裸 catch{} 吞成全站黑。
/** schema_version 值不是合法整数（库损坏/被手改/同步冲突写进非数字）。旧代码 parseInt→NaN→跳过全部
 *  DDL→照样盖版本→空库自称 v8 永久变黑；改成拿到坏值当场 loud throw、绝不继续。 */
export class SchemaVersionCorruptError extends Error {
  constructor(public readonly rawValue: string) {
    super(`anima.db schema_version 非法整数: ${JSON.stringify(rawValue)} —— 库损坏/被手改/同步冲突，拒绝迁移`);
    this.name = "SchemaVersionCorruptError";
  }
}
/** 库比当前代码新（老代码开新库＝降级）。原来硬 throw 被 hook 裸 catch{} 静默吞成零信号，
 *  改由 openAnima 接住 → 亮徽章 + 只读开库（可见降级态）。 */
export class SchemaTooNewError extends Error {
  constructor(
    public readonly foundVersion: number,
    public readonly supportedVersion: number,
  ) {
    super(`anima.db schema v${foundVersion} 比当前代码支持的 v${supportedVersion} 新——请升级 anima 插件`);
    this.name = "SchemaTooNewError";
  }
}

// 全部 IF NOT EXISTS / OR IGNORE：幂等且容忍多进程同时建库
const DDL_V1 = `
-- 经历表（主体）：发生了什么 + 情绪烙印作为属性（感受原文、强度自述——原始小票，永不改写）
-- bi-temporal 四时间戳：created/expired = 记录层，valid/invalid = 事实层；矛盾失效不删除
CREATE TABLE IF NOT EXISTS experiences (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  project        TEXT,
  content        TEXT NOT NULL,
  feeling        TEXT,
  intensity      TEXT,
  keywords       TEXT,
  source_session TEXT,
  occurred_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  valid_at       TEXT,
  expired_at     TEXT,
  invalid_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_exp_live
  ON experiences (project, occurred_at)
  WHERE expired_at IS NULL AND invalid_at IS NULL;

-- trigram 分词器：CJK 子串可索引（Codex 审计：FTS5 默认分词器对中文近乎失明）
CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  content, feeling, keywords,
  content='experiences', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS experiences_ai AFTER INSERT ON experiences BEGIN
  INSERT INTO experiences_fts(rowid, content, feeling, keywords)
  VALUES (new.id, new.content, COALESCE(new.feeling, ''), COALESCE(new.keywords, ''));
END;
CREATE TRIGGER IF NOT EXISTS experiences_ad AFTER DELETE ON experiences BEGIN
  INSERT INTO experiences_fts(experiences_fts, rowid, content, feeling, keywords)
  VALUES ('delete', old.id, old.content, COALESCE(old.feeling, ''), COALESCE(old.keywords, ''));
END;
CREATE TRIGGER IF NOT EXISTS experiences_au AFTER UPDATE ON experiences BEGIN
  INSERT INTO experiences_fts(experiences_fts, rowid, content, feeling, keywords)
  VALUES ('delete', old.id, old.content, COALESCE(old.feeling, ''), COALESCE(old.keywords, ''));
  INSERT INTO experiences_fts(rowid, content, feeling, keywords)
  VALUES (new.id, new.content, COALESCE(new.feeling, ''), COALESCE(new.keywords, ''));
END;

-- 处境流水（独立）：纯客观计数，append-only；自增 id 兼作单调序列号（时钟回拨兜底）
CREATE TABLE IF NOT EXISTS situation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  project     TEXT,
  kind        TEXT NOT NULL,
  payload     TEXT,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sit_session ON situation_log (session_id, id);

-- hook 失败连败计数器（失败可见化：连挂报警）
CREATE TABLE IF NOT EXISTS hook_health (
  hook_name            TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  alerted              INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_failure_at      TEXT,
  updated_at           TEXT
);
`;

const DDL_V2 = `
-- transcript 采集游标：与流水写入同事务推进（保存成功才推进，崩溃不丢不重）
CREATE TABLE IF NOT EXISTS capture_cursors (
  transcript_path TEXT PRIMARY KEY,
  last_uuid       TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 已注入记忆追踪（衍生回显抑制的台账；Phase 2 注入时写入）
CREATE TABLE IF NOT EXISTS injection_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  experience_id INTEGER NOT NULL REFERENCES experiences(id),
  injected_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_injection_session ON injection_log (session_id);
`;

const DDL_V3 = `
-- 夜间消化各阶段状态：独立可重试，单阶段失败不阻塞其余【Codex审计】
CREATE TABLE IF NOT EXISTS digest_runs (
  night       TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (night, stage)
);
`;

const DDL_V4 = `
-- 语义指纹边表（v4）：每条经历一份向量指纹，供"按意思找"（hybrid 检索的向量侧）。
-- 用边表而非给 experiences 加列：经历是只追加永不改的原始小票，向量是可重算的派生物——
-- 分开存、删表即回滚。model_ver 记算它用的模型；换模型时按它检测过期并重算（旧向量不污染）。
CREATE TABLE IF NOT EXISTS vec_experiences (
  experience_id INTEGER PRIMARY KEY REFERENCES experiences(id),
  embedding     BLOB NOT NULL,
  model_ver     TEXT NOT NULL
);
`;

const DDL_V5 = `
-- worker 队列（v5）：SessionEnd 入队的待办板，worker 私有（experiences 才是唯一真相源）。
-- 触发模型见 docs/DESIGN-WORKER-RESUME.md §4.2/§4.3。(session_id,kind) 主键 = 一会话一行、
-- ON CONFLICT upsert 更新 target_uuid（resume 续上的新尾巴）。target_uuid = 本次要复盘到的
-- transcript 末 uuid；worker 标 done 用它做 CAS（target 变了说明 resume 又来、需再转一圈）。
CREATE TABLE IF NOT EXISTS work_queue (
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  transcript_path TEXT,
  status          TEXT NOT NULL,            -- 'pending'|'processing'|'done'|'failed'
  target_uuid     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  enqueued_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_wq_status ON work_queue (status);

-- 复盘水位线（v5）：每会话「已自评覆盖到 transcript 哪个 uuid」。是【操作游标】（同 capture_cursors
-- 性质，可更新），不是记忆——不受「经历只追加」铁律约束。兼任并发去重闸：落库事务里对它做
-- CAS（WHERE last_uuid=旧值），抢到才写增量自评，抢不到回滚（见 DESIGN-WORKER-RESUME §4.3-2）。
CREATE TABLE IF NOT EXISTS review_watermark (
  session_id TEXT PRIMARY KEY,
  last_uuid  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const DDL_V6 = `
-- 失败自评的有界自愈（v6，DESIGN-SELFHEAL §3.1）。自评失败 2 次走兜底壳后，额外登记一条「待愈账」，
-- 夜间 stageHeal 用还在的 transcript 重消化那段，成功就把壳就地升级成真自评。与 work_queue（worker 私有、
-- 无 since_uuid）解耦，避免污染 worker 语义。
CREATE TABLE IF NOT EXISTS review_heal (
  session_id      TEXT NOT NULL,
  since_uuid      TEXT,             -- 失败切片起点 = 当时 wmOld（null = 首评失败）
  target_uuid     TEXT NOT NULL,    -- 失败切片终点 = 当时 newUuid（壳覆盖到这）
  shell_id        INTEGER NOT NULL, -- 兜底壳 experiences.id，愈合成功时作废它 + 继承其 order_seq 原位
  night           TEXT NOT NULL,    -- 归属夜（occurredAt 用，绝不盖成消化时刻）
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | dead（重试耗尽/transcript没了/since滚没） | unhealable（存量壳无边界）
  next_attempt_at TEXT NOT NULL,    -- 冷却闸：默认 night+1 夜，防同夜立刻重烧
  created_at      TEXT NOT NULL,
  PRIMARY KEY (session_id, target_uuid)
);
CREATE INDEX IF NOT EXISTS idx_heal_pending ON review_heal (status, next_attempt_at);

-- experiences 加 order_seq（v5 缝合定序，§3.5）：普通写一律 NULL（COALESCE(NULL,id)=id，与现行 id DESC
-- 字节等价、零回归）；仅愈合 review 写 = 被替换壳的 id，使愈合片排回壳的原始时间位、不冒充后续片的最新 prior。
ALTER TABLE experiences ADD COLUMN order_seq INTEGER;
`;

const DDL_V7 = `
-- situation_log 采集幂等（v7，AUDIT-2026-07-01 rank1）：加事件指纹 dedup_key + (session_id, dedup_key)
-- 局部唯一索引。采集侧给每条 transcript 事件挂稳定指纹（用户消息=msg:<uuid> / 工具=tool:<tool_use_id>:<kind>）；
-- resume 换新路径 / rewind 删游标 → 整段重采时，同一事件被局部唯一索引挡下（INSERT OR IGNORE 弹回），不再重复落库；
-- 采集前还会按指纹先剔已采过的，避免重复事件抬高 work-cap 现存计数、挤掉真 Read。
-- 局部索引（WHERE dedup_key IS NOT NULL）：老行 + 非采集 marker（digest/selfReview 等不传指纹）dedup_key 为
-- NULL、不进索引，行为不变；历史重复行保持不洗（与 A区#4 决定一致）。
ALTER TABLE situation_log ADD COLUMN dedup_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sit_dedup ON situation_log (session_id, dedup_key) WHERE dedup_key IS NOT NULL;
`;

const DDL_V8 = `
-- 采集幂等索引改单列（v8，AUDIT-2026-07-01 rank1 二审收口）：transcript uuid / tool_use_id 全局唯一，dedup_key
-- 单列即足够去重。原 (session_id, dedup_key) 在 session=NULL 时 SQLite 认 NULL 各不相同 → 写层漏去重（codex +
-- 独立考官同点；真 transcript 恒带 sessionId 故无实触发）。改单列 dedup_key，空 session 也强制去重，与
-- experiences.uuid 单列 UNIQUE 同构。局部条件不变（marker/老行 dedup_key=NULL 仍不进索引，NULL 历史重复维持"不洗"）。
-- 【护栏】建单列唯一索引前先清"非空 dedup_key 的重复"（保留最早 id）：v7 空-session 窗口理论上可留同指纹多行，
-- 不清则 CREATE UNIQUE 失败——更糟：bun:sqlite 对"多语句 exec 里最后一条失败 + 尾随内容"会**静默吞错**、半截
-- 迁移仍 COMMIT 且版本推进（独立考官逐层坐实）→ 索引没建成、去重永久失效且零报错。故先 DELETE 消重、让 CREATE
-- 恒成功、不给静默吞留触发点。只清设了指纹的重复（bug 产物），绝不碰 NULL 历史老重复。生产实测 0 条、此步 no-op。
DELETE FROM situation_log
 WHERE dedup_key IS NOT NULL
   AND id NOT IN (SELECT MIN(id) FROM situation_log WHERE dedup_key IS NOT NULL GROUP BY dedup_key);
DROP INDEX IF EXISTS idx_sit_dedup;
CREATE UNIQUE INDEX idx_sit_dedup ON situation_log (dedup_key) WHERE dedup_key IS NOT NULL;
`;

const MIGRATIONS: Record<number, string> = { 1: DDL_V1, 2: DDL_V2, 3: DDL_V3, 4: DDL_V4, 5: DDL_V5, 6: DDL_V6, 7: DDL_V7, 8: DDL_V8 };

const MAX_OPEN_RETRY = 60; // ×(50~640ms) ≈ 最多约 20s，远超任何冷启动建库争用

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  // 整个开库（构造 + pragma + 迁移）套 busy 重试：worker 上线后 hook/worker/夜跑会多进程并发开库。
  // 常态（库已建好）attempt 0 即成、零退避。仅冷启动（多进程同抢全新库的 WAL 切模式独占锁）才退避重开
  // ——头一个切成 WAL 后其余重试即变无锁读，随机抖动退避防 thundering-herd 锁步。
  for (let attempt = 0; ; attempt++) {
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { create: true });
      // ⚠️ busy_timeout 必须**第一句**设：journal_mode=WAL 的切换/确认本身要拿数据库锁，跑在
      //    busy_timeout 之前则并发下立刻 SQLITE_BUSY（多进程压测实测逮到）。
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db);
      return db;
    } catch (e) {
      db?.close();
      if (isBusy(e) && attempt < MAX_OPEN_RETRY) {
        backoffSleep(attempt);
        continue;
      }
      throw e;
    }
  }
}

/**
 * schema_version 原始值是否合法（"什么算损坏"的**单一事实源判据**）。readSchemaVersion 拿它决定
 * loud throw、introspect 拿它决定 ok:false——两处共用同一根尺子，绝不各写各的漂（R10 round-2 gap3）。
 * 合法 = 非空白字符串且 Number 后是整数（比 parseInt 严：`Number('8abc')`=NaN 被逮，parseInt 会宽容读成 8）。
 */
export function isValidSchemaVersionRaw(raw: unknown): raw is string {
  return typeof raw === "string" && raw.trim() !== "" && Number.isInteger(Number(raw));
}

/**
 * 读 schema_version；meta 表还没建（全新库）→ 0。纯读，不抢锁。
 * ⚠️ R10：值必须是**合法整数**。原来 `parseInt(row.value,10)` 太宽——损坏/手改/同步冲突写进非数字时
 *    parseInt→NaN，而 `NaN > v`/`NaN === v` 皆 false → 跳过全部 DDL → 却照样盖 schema_version 并 COMMIT
 *    → 空库自称 v8 永久变黑（实测坐实）。故：区分"表不存在/尚无版本行"（全新库=0，静默）与"表存在但值损坏"
 *    （非整数/空 → SchemaVersionCorruptError loud throw，绝不静默继续）。判据抽到 isValidSchemaVersionRaw
 *    单一事实源（与 introspect 共用）。
 */
function readSchemaVersion(db: Database): number {
  let row: { value: string | null } | null;
  try {
    row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string | null }
      | null;
  } catch {
    return 0; // meta 表不存在 = 全新库
  }
  if (!row) return 0; // meta 表在、但还没写版本行 = 等同全新库
  const raw = row.value;
  // NULL / 非字符串（同步冲突/手改写进 NULL，或未来 schema 放宽了列约束）/ 非整数 → 走响亮损坏路径。
  // 不先判类型就直接 `raw.trim()` 会抛裸 TypeError → 漏过 corrupt 分支、丢掉可见损坏徽章（R10 gap2）。
  if (!isValidSchemaVersionRaw(raw)) {
    throw new SchemaVersionCorruptError(raw === null ? "<NULL>" : String(raw));
  }
  return Number(raw);
}

/**
 * 只读打开一个**已存在**的库（R10 降级态专用）。不建库、不迁移、不抢写锁——老代码撞上更新的库时，
 * 让注入/召回等读路径继续存活，写路径自然失败但不再是零信号黑洞。busy_timeout 是连接级设置、不写盘，
 * 只读连接也能设。
 */
export function openDbReadonly(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function isBusy(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const msg = String((e as Error)?.message ?? "");
  return code === "SQLITE_BUSY" || /database is locked|database table is locked/i.test(msg);
}

/** 退避 + **真随机抖动**：base 50→640ms 线性涨顶，叠 [0,base) 随机，防多进程锁步同时重试（thundering-herd）。 */
function backoffSleep(attempt: number): void {
  const base = Math.min(50 + attempt * 20, 640);
  Bun.sleepSync(base + Math.floor(Math.random() * base));
}

/**
 * 迁移到 SCHEMA_VERSION。
 * - **已最新 → 纯读短路、绝不进写事务**：worker 上线后 hook（每轮 Stop·多会话）+ worker + 夜跑会
 *   多进程并发开同一个库，若每次 openDb 都为重写同一个 schema_version 抢一次 `BEGIN IMMEDIATE`
 *   写锁，并发下 busy_timeout 兜不住就 SQLITE_BUSY 崩。常态（库已建好）走这条零写锁路径。
 * - 真要建表/升级 → 写事务 + busy 重试兜「多进程同时首启」：拿到锁后**再读一次版本**（别的进程可能
 *   在等锁期间已迁完），已最新就空提交退出，幂等。
 */
function migrate(db: Database): void {
  const found = readSchemaVersion(db);
  if (found > SCHEMA_VERSION) {
    throw new SchemaTooNewError(found, SCHEMA_VERSION);
  }
  if (found === SCHEMA_VERSION) return; // 已最新：纯读判定，不抢写锁

  const MAX_RETRY = 60; // ×(50~640ms) ≈ 最多约 20s，远超任何单次冷启动迁移
  for (let attempt = 0; ; attempt++) {
    try {
      runMigrationTx(db);
      return;
    } catch (e) {
      if (isBusy(e) && attempt < MAX_RETRY) {
        // 别的进程在等锁期间可能已迁完——重读判定，别把「未来版本」也当成功吞掉（codex I2）。
        const v = readSchemaVersion(db);
        if (v > SCHEMA_VERSION) {
          throw new SchemaTooNewError(v, SCHEMA_VERSION);
        }
        if (v === SCHEMA_VERSION) return;
        backoffSleep(attempt);
        continue;
      }
      throw e;
    }
  }
}

/**
 * 把一段迁移 DDL 拆成单条语句，供逐条 exec（绕开 bun:sqlite exec 多语句静默吞错，见 runMigrationTx）。
 * 触发器体 `CREATE TRIGGER … BEGIN …; …; END;` 内的 `;` 不是语句边界——按 BEGIN/END 词计深度，只在深度 0
 * 的 `;` 断句。先去掉整行 `--` 注释（本库注释无 ASCII `;`/BEGIN/END，去掉更稳）。BEGIN/END 用全词匹配，
 * 本库仅触发器用到、无同名标识符（已 grep 核实）。
 * ⚠️ 非 quote-aware 词法器（两位独立考官同点）：假设 DDL 的**单引号字符串字面量内不含** `;`/`--`/`BEGIN`/`END`
 *   ——当前 DDL_V1..V8 已核实为零。将来加迁移若要在字符串字面量里放这些字符，必须改成真 SQL tokenizer，
 *   否则会误拆（如 `'a;b'` 被切两半、`'a -- x'` 后半被当注释吞）。加 DDL 前记得回来看这条。
 */
export function splitSqlStatements(ddl: string): string[] {
  const src = ddl.replace(/--[^\n]*/g, ""); // 去整行注释
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  const re = /\bBEGIN\b|\bEND\b|;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tok = m[0].toUpperCase();
    if (tok === "BEGIN") depth++;
    else if (tok === "END") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      // 深度 0 的 `;` = 语句边界
      const stmt = src.slice(last, m.index).trim();
      if (stmt) out.push(stmt);
      last = m.index + 1;
    }
  }
  const tail = src.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

function runMigrationTx(db: Database): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const found = readSchemaVersion(db); // 拿到写锁后重读：等锁期间别的进程可能已迁完
    if (found > SCHEMA_VERSION) {
      throw new SchemaTooNewError(found, SCHEMA_VERSION);
    }
    for (let v = found + 1; v <= SCHEMA_VERSION; v++) {
      const ddl = MIGRATIONS[v];
      if (!ddl) throw new Error(`缺少 v${v} 迁移脚本`);
      // 逐条 exec（AUDIT-2026-07-01）：bun:sqlite 的 db.exec(多语句串) 有静默吞错洞——某条语句运行期失败时
      // 不抛、还继续跑后面的语句（实测中间 CREATE UNIQUE 失败被吞、后一条 CREATE TABLE 照建、exec 不抛）→
      // 半截迁移被记成完成、schema_version 照推、坏状态零报错永不重试。拆成单条 exec：单语句出错必抛 → 冒泡
      // 回本事务 → 下方 COMMIT 不执行、版本不推 → 下轮重试。触发器体内的 `;` 由 splitSqlStatements 保护不断句。
      for (const stmt of splitSqlStatements(ddl)) db.exec(stmt);
    }
    // R10 结构断言（COMMIT 前，仅全新库 found===0）：逐条 exec 护栏已挡住框架静默吞错，但 DDL 万一因别的
    // 原因没落地（磁盘满、外部并发 DROP 等）也要在盖版本前当场炸掉 → ROLLBACK → 响亮可重试失败，而不是盖上
    // schema_version 骗后人成"静默永久损坏"。只在从零建库时核查——此时 DDL_V1 必已跑、地基三表必须成型；
    // 增量迁移（found>0，只跑该版增量 DDL）不假设早版本表由本轮产生，避免误伤合法的部分迁移。
    if (found === 0) {
      for (const t of ["experiences", "situation_log", "meta"]) {
        const ok = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
        if (!ok) throw new Error(`迁移后结构断言失败：核心表 ${t} 不存在——迁移未落地，回滚重试`);
      }
    }
    db.exec(
      `INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
       ON CONFLICT (key) DO UPDATE SET value = '${SCHEMA_VERSION}';`,
    );
    db.exec("COMMIT;");
  } catch (e) {
    db.exec("ROLLBACK;");
    throw e;
  }
}
