// 首会话欢迎注入(引导设置流程的核心刀):全新安装(库里零经历)时,开会话注入一段
// 给 Claude 的欢迎简报,让它主动告诉用户 anima 已上线、今晚消化、明早见效。
// 治的病:装完 24 小时内产品完全隐形("装了个寂寞"流失点,2026-07-06 用户点名)。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { prepareSessionStart } from "../src/sessionStart";
import { ANIMA_CONTEXT_CLOSE, ANIMA_CONTEXT_OPEN } from "../src/echo";
import { stripEcho } from "../src/echo";

const NOW = "2026-07-06T18:00:00.000Z";

const tmpDirs: string[] = [];
function tmpHome(): { dbPath: string; personalityPath: string } {
  const d = mkdtempSync(join(tmpdir(), "anima-welcome-"));
  tmpDirs.push(d);
  const personalityPath = join(d, "personality.md");
  writeFileSync(personalityPath, "# 人格\n占位");
  return { dbPath: join(d, "anima.db"), personalityPath };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function prep(db: any, personalityPath: string) {
  return prepareSessionStart(db, {
    sessionId: "sess-w1",
    project: null,
    personalityPath,
    clock: frozenClock(NOW),
  });
}

describe("首会话欢迎注入", () => {
  test("全新库(零经历)→ 注入欢迎简报,含关键事实+让Claude转告用户的指令", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const out = prep(db, personalityPath);
    // 非空 + 包裹在 anima-context 标记里(防回声:采集时会被剥掉)
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).toContain(ANIMA_CONTEXT_OPEN);
    expect(out.text).toContain(ANIMA_CONTEXT_CLOSE);
    // 关键事实:首个会话/今晚消化/明早生效/mood/日记路径
    expect(out.text).toContain("first session");
    expect(out.text).toContain("2:00");
    expect(out.text).toContain("tomorrow");
    expect(out.text).toContain("/mood");
    expect(out.text).toContain(".claude/anima/diary");
    // 是给 Claude 的转告指令,不是干巴巴的日志
    expect(out.text.toLowerCase()).toContain("let the user know");
  });

  test("库里有任意一条经历(哪怕已作废)→ 不再出欢迎,走正常晨间注入", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const row = insertExperience(db, {
      kind: "event",
      content: "第一条记忆",
      sourceSession: "sess-old",
      occurredAt: "2026-07-05T10:00:00.000Z",
    });
    // 有效经历在库 → 无欢迎
    expect(prep(db, personalityPath).text).not.toContain("first session");
    // 把它作废(库里只剩一条已作废经历)→ 依旧不算首装,无欢迎(考官提醒#1:标题的承诺要真测到)
    expect(invalidateExperience(db, row.id)).toBe(true);
    expect(prep(db, personalityPath).text).not.toContain("first session");
  });

  test("欢迎简报会被防回声剥离(不会被采集成记忆)", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const out = prep(db, personalityPath);
    expect(stripEcho(out.text).trim()).toBe("");
  });

  test("空库上重复开会话 → 每次都给欢迎(直到首夜消化产出记忆),幂等无副作用", () => {
    const { dbPath, personalityPath } = tmpHome();
    const db = openDb(dbPath);
    const a = prep(db, personalityPath);
    const b = prep(db, personalityPath);
    expect(a.text).toBe(b.text);
    expect(b.text).toContain("first session");
  });
});
