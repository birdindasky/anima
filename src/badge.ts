// HUD 徽章：badge.txt 一行文本，≤50 字符、无 ANSI/控制字符（claude-hud sanitize 兼容）
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { systemClock, type Clock } from "./clock";
import { SchemaTooNewError, SchemaVersionCorruptError } from "./db";
import { estimateMood } from "./mood";

/**
 * R10 round-2：schema 警示牌"待处理"哨兵路径。writeSchemaErrorBadge 亮警示牌时立此哨兵，
 * refreshBadge 见哨兵就跳过——单一事实源：一处标记覆盖所有 refreshBadge 调用方（夜跑 digest.ts:1335 /
 * hook / 未来任何新调用方），彻底堵住"心情标签盖掉待升级/损坏警示牌"的回归（codex R10 NO-GO gap1）。
 * 哨兵由 openAnima 健康开库时清除（schema 恢复=解除警示，见 clearSchemaErrorBadge），故升级后徽章不会永久卡住。
 */
function schemaErrorSentinelPath(badgePath: string): string {
  return `${badgePath}.schema-error`;
}

const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*[A-Za-z]", "g");
const CONTROL_RE = new RegExp("[\\x00-\\x1f\\x7f]", "g");

export function sanitizeBadge(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

export function writeBadge(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sanitizeBadge(text), "utf8");
}

/** 徽章刷新：心情标签上墙，螺旋亮灯时 ⚠ 变色（写徽章的口在这里，不在 mood 模块） */
export function refreshBadge(db: Database, path: string, clock: Clock = systemClock): void {
  // R10 round-2（gap1 单一事实源）：schema 警示牌待处理时，绝不拿心情标签盖掉"待升级/损坏"警示牌。
  // 一处判定覆盖所有调用方（夜跑/hook/其它）——即便某调用方漏判 degraded，也过不了这道闸。
  if (path && existsSync(schemaErrorSentinelPath(path))) return;
  const est = estimateMood(db, { clock });
  writeBadge(path, `${est.spiral.active ? "⚠ " : ""}${est.label}`);
}

/**
 * R10：schema 降级/损坏的可见警示牌（openAnima 与 worker 后门共用单一文案源，别各写各的漂）。
 * 只认这两类具名 error；其余返回 false（调用方照原样处理）。写徽章尽力而为——写不了也别把示警本身
 * 级联成新的崩溃点（可见信号的兜底）。
 */
export function writeSchemaErrorBadge(path: string, e: unknown): boolean {
  let text: string | null = null;
  if (e instanceof SchemaTooNewError) {
    text = `⚠ anima 待升级 (db v${e.foundVersion}>v${e.supportedVersion})`;
  } else if (e instanceof SchemaVersionCorruptError) {
    text = "⚠ anima db 版本损坏，需修复";
  }
  if (text === null) return false;
  try {
    writeBadge(path, text);
    // 立"待处理"哨兵：refreshBadge 认得它就不覆盖本警示牌（单一事实源，见 schemaErrorSentinelPath）。
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(schemaErrorSentinelPath(path), text, "utf8");
    }
  } catch {
    /* 徽章/哨兵写不了就算了，别把示警本身变成崩溃点（可见信号的兜底） */
  }
  return true;
}

/**
 * 清除 schema 警示牌哨兵。openAnima 健康（非降级）开库时调用：schema 恢复到代码支持范围 = 警示解除，
 * 之后 refreshBadge 可正常刷心情。缺文件是常态（force:true 不抛）——这是单一事实源哨兵的解除口。
 */
export function clearSchemaErrorBadge(path: string): void {
  if (!path) return;
  try {
    rmSync(schemaErrorSentinelPath(path), { force: true });
  } catch {
    /* 清不掉不致命：最坏是徽章多显示一轮旧警示，下轮再清 */
  }
}
