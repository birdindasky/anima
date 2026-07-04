// 情绪书签：它当场记一笔，立刻落库（关终端不丢）。纯自发，绝不催，空着是常态。
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "./clock";
import { insertExperience, mapExperienceRow, type ExperienceRow } from "./experiences";
import { stripEcho } from "./echo";

/** 限长（2026-07-02 批）：书签是即时感触不是文章，超长原样落库＝挤注入配额+素材噪音。截断带标记。 */
export const BOOKMARK_MAX_CHARS = 2000;

export interface BookmarkInput {
  content: string;
  feeling?: string | null;
  intensity?: string | null;
  keywords?: string[];
  project?: string | null;
  sessionId?: string | null;
}

export function addBookmark(
  db: Database,
  input: BookmarkInput,
  clock: Clock = systemClock,
): ExperienceRow {
  // stripEcho（AUDIT-2026-07-01 rank5）：书签是唯一绕过 echo 剥离的写口。模型若把自己被 <anima-context>
  // 注入的心情/记忆原话当感触 bookmark 回来，不剥就原样落库 → 经召回/次日注入再进上下文 = 情绪自激回声
  // （echo.ts 整个模块正是为杀这条复读环而生）。与 capture/selfReview 同口径先剥再落。
  let content = stripEcho(input.content);
  if (content.length > BOOKMARK_MAX_CHARS) {
    content = content.slice(0, BOOKMARK_MAX_CHARS) + "…（书签超长截断）";
  }
  // rank11（2026-07-02 批）：写口查重——同会话同内容的 live 书签已在，就返回既有行（幂等），
  // 不再落第二条：重复感触＝复读噪音 + 挤注入配额。只看 live（作废的不挡新写）、只圈本会话
  // （跨会话同句是各自真实的感触，不误杀）。比较用剥离+截断后的最终落库形态。
  const dup = db
    .query(
      `SELECT * FROM experiences
        WHERE kind = 'bookmark' AND source_session IS ? AND content = ?
          AND invalid_at IS NULL AND expired_at IS NULL
        ORDER BY id ASC LIMIT 1`,
    )
    .get(input.sessionId ?? null, content);
  if (dup) return mapExperienceRow(dup as Parameters<typeof mapExperienceRow>[0]);
  // insertExperience 自带提交即持久（WAL）——这就是"即时落库"的全部秘密
  return insertExperience(
    db,
    {
      kind: "bookmark",
      content,
      feeling: input.feeling ?? null,
      intensity: input.intensity ?? null,
      keywords: input.keywords,
      project: input.project ?? null,
      sourceSession: input.sessionId ?? null,
    },
    clock,
  );
}
