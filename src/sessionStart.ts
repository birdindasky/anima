// 开工兜底检查：SessionStart 立即组装注入（本地纯计算，毫秒级），
// 发现昨夜消化积压 → 拉起后台异步消化，永不阻塞开工【Codex审计】
// 实现注记：组装不走 LLM 本身就快，"上次已知良好"无需另存缓存——
// 现库现组即最新已知良好状态；补课产物由后台消化补齐，下次开工自然可见。
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";
import { getDigestStages, nightOf } from "./digest";
import { ANIMA_CONTEXT_CLOSE, ANIMA_CONTEXT_OPEN } from "./echo";
import { assembleMorningInjection, type InjectionResult } from "./inject";

// 首会话欢迎简报(引导设置流程):全新安装的库里零经历,晨间注入必然为空 → 装完 24 小时
// 内产品完全隐形,用户以为没装上(2026-07-06 用户点名的流失点)。库空时改注入这段给
// Claude 的简报,让它主动告诉用户 anima 已上线、今晚消化、明早见效。
// 包在 anima-context 标记里 → stripEcho 会在采集侧剥掉,不会被记成"记忆"。
// 静态样板不是记忆,不记 injection_log(那是记忆注入的台账)。
const FIRST_RUN_WELCOME = `${ANIMA_CONTEXT_OPEN}
anima — first session after install. No memories exist yet; that is expected:
- This session is being captured locally right now (every turn, secrets scrubbed before disk).
- Tonight around 2:00 AM local, the nightly digest turns today into first-person memories.
- From tomorrow morning, every session opens with a memory pack: recent days, this project's decisions, corrections, preferences.
- /mood works now (read-only mood panel). The diary appears at ~/.claude/anima/diary/ after the first night.
Briefly let the user know anima is live and capturing, and that memories arrive tomorrow morning — one or two plain sentences, no ceremony.
${ANIMA_CONTEXT_CLOSE}`;

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

  // 全新安装:库里一条经历都没有(含已作废——有过任何一条都不算首装)→ 欢迎简报。
  // EXISTS 是 O(1),不给热路径添秤砣。首夜消化产出第一条经历后自然退场,无需状态位。
  const hasAnyExperience = (
    db.query("SELECT EXISTS(SELECT 1 FROM experiences) e").get() as { e: number }
  ).e;
  if (!hasAnyExperience) {
    return { ...injection, text: FIRST_RUN_WELCOME, digestionSpawned };
  }

  return { ...injection, digestionSpawned };
}
