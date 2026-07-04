// AUDIT-2026-07-01 rank5：书签写口过 stripEcho。书签是唯一绕过 echo 剥离的写口——模型若把自己被
// <anima-context> 注入的心情/记忆当感触 bookmark 回来，不剥就原样落库→经召回/次日注入再入上下文=情绪自激
// 回声。addBookmark 现在与 capture/selfReview 同口径先 stripEcho 再落。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db";
import { addBookmark } from "../src/bookmark";
import { ANIMA_CONTEXT_OPEN, ANIMA_CONTEXT_CLOSE } from "../src/echo";
import { frozenClock } from "../src/clock";

const clock = frozenClock("2026-06-18T09:00:00.000Z");
const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-bmecho-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("rank5 · 书签写口剥回声", () => {
  test("含 <anima-context> 注入块的书签 → 标记与注入内容被剥，真感触保留", () => {
    const db = tmpDb();
    const r = addBookmark(
      db,
      { content: `${ANIMA_CONTEXT_OPEN}\n## 最近的经历\n- [今天] 上次注入的心情\n${ANIMA_CONTEXT_CLOSE}\n我此刻真正的感触`, sessionId: "s" },
      clock,
    );
    expect(r.content).not.toContain("anima-context");
    expect(r.content).not.toContain("上次注入的心情"); // 注入块整段被剥
    expect(r.content).toContain("我此刻真正的感触"); // 真感触留下
  });

  test("含 <system-reminder> 的书签 → 剥掉", () => {
    const db = tmpDb();
    const r = addBookmark(db, { content: "<system-reminder>系统提示</system-reminder>真心话", sessionId: "s" }, clock);
    expect(r.content).not.toContain("system-reminder");
    expect(r.content).toContain("真心话");
  });

  test("普通书签（无注入标记）→ 内容原样保留", () => {
    const db = tmpDb();
    const r = addBookmark(db, { content: "今天修好了那个静默吞错的洞，挺爽", sessionId: "s" }, clock);
    expect(r.content).toBe("今天修好了那个静默吞错的洞，挺爽");
  });
});
