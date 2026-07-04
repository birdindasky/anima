// anima 数据层入口
export { systemClock, frozenClock, type Clock, type FrozenClock } from "./clock";
export { resolveConfig, type AnimaConfig } from "./config";
export { initDataDir } from "./dataDir";
export { openDb, SCHEMA_VERSION } from "./db";
export {
  insertExperience,
  getExperience,
  invalidateExperience,
  searchExperiences,
  segmentQuery,
  type ExperienceInput,
  type ExperienceRow,
  type SearchOptions,
} from "./experiences";
export {
  appendSituation,
  listSituations,
  type SituationInput,
  type SituationRow,
  type SituationFilter,
} from "./situation";
export {
  recordHookFailure,
  recordHookSuccess,
  getHookHealth,
  getHookAlerts,
  type HookHealthRow,
} from "./hookHealth";
export { stripEcho, ANIMA_CONTEXT_OPEN, ANIMA_CONTEXT_CLOSE } from "./echo";
export { captureTranscript, extractEvents, getCursor, type CaptureOptions } from "./capture";
export { addBookmark, type BookmarkInput } from "./bookmark";
export { recordInjection, listInjectedExperienceIds } from "./injection";
export { diceSimilarity, findNearDuplicate, DEDUP_THRESHOLD, type DedupOptions } from "./dedup";
export {
  validateSelfReview,
  type SelfReviewOutput,
  type SelfReviewItem,
  type ValidationResult,
} from "./validator";
export {
  buildMaterial,
  buildSelfReviewPrompt,
  runSelfReview,
  type Material,
  type SelfReviewResult,
  type SelfReviewOptions,
} from "./selfReview";
export { claudeCli, type LlmClient } from "./llm";
export { estimateTokens, truncateToTokens } from "./tokens";
export { findMoodNumberViolations, scrubMoodNumbers } from "./sovereignty";
export { relativeDayLabel } from "./clock";
export {
  assembleMorningInjection,
  DEFAULT_INJECTION_BUDGET,
  REGION_QUOTAS,
  type InjectionRegion,
  type InjectionResult,
  type InjectOptions,
} from "./inject";
export {
  searchMemoryIndex,
  searchRawReceipts,
  renderExperienceDetail,
  renderMemoryDetail,
  type RecallOptions,
  type IndexLine,
  type RecallSource,
} from "./recall";
export { emotionalCharge, imprintStrength, nightsBetween, type ChargeSource } from "./charge";
export {
  runNightlyDigestion,
  nightOf,
  getDigestStages,
  getWiredStages,
  defaultFindTranscripts,
  type DigestConfig,
  type DigestResult,
  type DigestOptions,
  type StageName,
  type StageResult,
  type TranscriptRef,
} from "./digest";
export { prepareSessionStart, type PrepareSessionStartOptions, type SessionStartResult } from "./sessionStart";
export { writeBadge, sanitizeBadge, refreshBadge, writeSchemaErrorBadge, clearSchemaErrorBadge } from "./badge";
export {
  estimateMood,
  renderMoodPanel,
  valenceOf,
  type MoodEstimate,
  type MoodAttribution,
  type SpiralStatus,
} from "./mood";

import { resolveConfig, type AnimaConfig } from "./config";
import { initDataDir } from "./dataDir";
import { openDb, openDbReadonly, SchemaTooNewError, SchemaVersionCorruptError } from "./db";
import { writeSchemaErrorBadge, clearSchemaErrorBadge } from "./badge";
import type { Database } from "bun:sqlite";

/**
 * 一步到位：解析配置 → 补齐数据目录 → 打开数据库（后续 hook/MCP 的统一入口）。
 * R10 降级可见态：老代码撞上更新的库（SchemaTooNewError）时，绝不静默让 migrate 硬 throw 被 hook 裸
 * catch{} 吞成全站黑——先把"待升级"写进徽章（HUD 上一眼可见的口），再以**只读**开库让读路径（注入/召回）
 * 继续存活；返回 `degraded: true` 供调用方按需短路写路径。库版本号损坏（SchemaVersionCorruptError）时
 * 同样先亮徽章示警，但仍 loud rethrow——不拿一个状态不可信的库继续跑（fail-closed）。
 */
export function openAnima(overrides?: Partial<AnimaConfig>): {
  config: AnimaConfig;
  db: Database;
  degraded?: boolean;
} {
  const config = resolveConfig(overrides);
  initDataDir(config);
  try {
    const db = openDb(config.dbPath);
    // schema 健康（迁到当前版本、无降级/损坏）：清掉可能残留的警示牌哨兵——升级后徽章不再永久卡"待升级"，
    // 之后 refreshBadge 恢复正常刷心情（单一事实源哨兵的解除口，见 badge.ts）。
    clearSchemaErrorBadge(config.badgePath);
    return { config, db };
  } catch (e) {
    if (e instanceof SchemaTooNewError) {
      // 徽章先上墙——即便下游 hook 随即（在只读库上写失败后）安静退出，可见信号已经亮了。
      writeSchemaErrorBadge(config.badgePath, e);
      return { config, db: openDbReadonly(config.dbPath), degraded: true };
    }
    if (e instanceof SchemaVersionCorruptError) {
      writeSchemaErrorBadge(config.badgePath, e);
      throw e; // 状态不可信：亮完徽章仍响亮抛出，不静默继续
    }
    throw e;
  }
}
