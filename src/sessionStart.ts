// 开工兜底检查：SessionStart 立即组装注入（本地纯计算，毫秒级），
// 发现昨夜消化积压 → 拉起后台异步消化，永不阻塞开工【Codex审计】
// 实现注记：组装不走 LLM 本身就快，"上次已知良好"无需另存缓存——
// 现库现组即最新已知良好状态；补课产物由后台消化补齐，下次开工自然可见。
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";
import { getDigestStages, nightOf } from "./digest";
import { assembleMorningInjection, type InjectionResult } from "./inject";

export interface PrepareSessionStartOptions {
  sessionId: string;
  project: string | null;
  personalityPath: string;
  clock?: Clock;
  budget?: number;
  /**
   * 发现积压时调用。仅供测试注入观察用——生产 hook 一律不传（事故 2026-06-12：
   * hook 传入 nohup 后台消化导致递归 claude -p 满负载）。消化只由 launchd / 手动触发。
   */
  spawnDigestion?: () => void;
}

export interface SessionStartResult extends InjectionResult {
  digestionSpawned: boolean;
}

export function prepareSessionStart(
  db: Database,
  opts: PrepareSessionStartOptions,
): SessionStartResult {
  const clock = opts.clock ?? systemClock;
  const night = nightOf(clock.now());
  const done = (
    db
      .query("SELECT count(*) c FROM digest_runs WHERE night = ? AND status = 'done'")
      .get(night) as { c: number }
  ).c;
  const backlog = done < getDigestStages().length;

  let digestionSpawned = false;
  if (backlog && opts.spawnDigestion) {
    opts.spawnDigestion();
    digestionSpawned = true;
  }

  const injection = assembleMorningInjection(db, {
    sessionId: opts.sessionId,
    project: opts.project,
    personalityPath: opts.personalityPath,
    clock,
    budget: opts.budget,
  });

  return { ...injection, digestionSpawned };
}
