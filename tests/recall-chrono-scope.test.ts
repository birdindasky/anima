// DESIGN-WORK-TIMELINE §2：chrono 双层选择。镜像 relevance 路兜底——
// 日记层（蒸馏 experiences）优先；窗内无日记则退录像层（小票 listReceiptsChrono）。
// scope='actions' 强制走录像层（要"按顺序的动作/命令"）。
// 红灯先行：实现前 chronoFork 只走录像层、不查 experiences、无 scope。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { insertExperience } from "../src/experiences";
import { frozenClock } from "../src/clock";
import { searchMemoryIndex } from "../src/recall";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-scope-${process.pid}-${n++}.db`));
const SINCE = "2026-06-12T16:00:00.000Z";
const UNTIL = "2026-06-13T16:00:00.000Z";
const clock = frozenClock("2026-06-13T03:00:00.000Z");
const at = "2026-06-13T03:00:00.000Z";

describe("chrono 双层选择（日记优先、退录像、scope=actions 强制录像）", () => {
  test("窗内有日记 → 默认返日记层（experience）", () => {
    const db = freshDb();
    insertExperience(db, { sessionId: "s", project: "/p", kind: "work_action", content: "换 YAML 配置", feeling: null, keywords: [], occurredAt: at });
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git push" }, occurredAt: at });
    const out = searchMemoryIndex(db, "", { order: "chrono", sinceTs: SINCE, untilTs: UNTIL, project: "/p", clock });
    expect(out.length).toBe(1);
    expect(out[0]!.source).toBe("experience");
    expect(out[0]!.line).toContain("换 YAML 配置");
  });

  test("窗内无日记 → 退录像层（situation，兜底）", () => {
    const db = freshDb();
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git push" }, occurredAt: at });
    const out = searchMemoryIndex(db, "", { order: "chrono", sinceTs: SINCE, untilTs: UNTIL, project: "/p", clock });
    expect(out.length).toBe(1);
    expect(out[0]!.source).toBe("situation");
    expect(out[0]!.line).toContain("git push");
  });

  test("scope='actions' → 即便有日记也强制走录像层", () => {
    const db = freshDb();
    insertExperience(db, { sessionId: "s", project: "/p", kind: "work_action", content: "换 YAML 配置", feeling: null, keywords: [], occurredAt: at });
    appendSituation(db, { kind: "command_run", project: "/p", payload: { command: "git push" }, occurredAt: at });
    const out = searchMemoryIndex(db, "", { order: "chrono", scope: "actions", sinceTs: SINCE, untilTs: UNTIL, project: "/p", clock });
    expect(out.length).toBe(1);
    expect(out[0]!.source).toBe("situation");
    expect(out[0]!.line).toContain("git push");
  });
});
