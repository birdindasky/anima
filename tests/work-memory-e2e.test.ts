// work-memory 端到端冒烟：真 transcript → 采集 → 蒸馏 work_action → 召回 + 注入命中
// （first pass 自验；独立盲考官另跑对抗版）
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { captureTranscript } from "../src/capture";
import { listSituations } from "../src/situation";
import { buildMaterial, generateSelfReview, storeSelfReviewResult } from "../src/selfReview";
import { searchExperiences } from "../src/experiences";
import { assembleMorningInjection } from "../src/inject";

const SID = "e2e-sess";
const PROJ = "/Users/tester/Projects/demo";
const tmpDirs: string[] = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), "anima-e2e-"));
  tmpDirs.push(dir);
  const h = join(dir, "anima-home");
  mkdirSync(h, { recursive: true });
  return h;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTranscript(path: string) {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const lines = [
    line({ type: "user", uuid: "u1", sessionId: SID, cwd: PROJ, timestamp: "2026-06-21T10:00:00.000Z", message: { role: "user", content: "帮我把解析换成 YAML" } }),
    line({
      type: "assistant", uuid: "a1", sessionId: SID, cwd: PROJ, timestamp: "2026-06-21T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "r1", name: "Read", input: { file_path: `${PROJ}/x.ts` } },
          { type: "tool_use", id: "g1", name: "Bash", input: { command: "git commit -m parse" } },
          { type: "tool_use", id: "e1", name: "Edit", input: { file_path: `${PROJ}/y.ts`, old_string: "TOML", new_string: "YAML" } },
        ],
      },
    }),
    line({
      type: "user", uuid: "u2", sessionId: SID, cwd: PROJ, timestamp: "2026-06-21T10:02:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "r1", content: "文件内容若干", is_error: false },
          { type: "tool_result", tool_use_id: "g1", content: "[main abc1] parse", is_error: false },
          // R3（AUDIT-2026-07-03）：Edit 成败要等 tool_result——成功的编辑须配对（否则不落 file_edit）
          { type: "tool_result", tool_use_id: "e1", content: `The file ${PROJ}/y.ts has been updated.`, is_error: false },
        ],
      },
    }),
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

describe("work-memory 端到端", () => {
  test("采集→蒸馏 work_action→召回+注入 全链命中，且 feeling=NULL", async () => {
    const h = home();
    const db = openDb(join(h, "anima.db"));
    const clock = frozenClock("2026-06-21T10:05:00.000Z");
    const tpath = join(h, "transcript.jsonl");
    writeTranscript(tpath);

    // 1) 采集
    captureTranscript(db, tpath, { clock });
    const kinds = new Set(listSituations(db, { sessionId: SID }).map((s) => s.kind));
    expect(kinds.has("file_read")).toBe(true);
    expect(kinds.has("command_run")).toBe(true);
    expect(kinds.has("file_edit")).toBe(true);

    // 2) 蒸馏：素材含工作事件 → LLM（stub）蒸出 work_action（引用真实文件 y.ts，过事实接地）
    const material = buildMaterial(db, { transcriptPath: tpath, sessionId: SID });
    expect(material.evidenceText).toContain("y.ts"); // 工作事件真流进素材
    expect(material.evidenceText).toContain("command_run");

    const llm = async (_p: string): Promise<string> =>
      JSON.stringify({
        review: "今天把解析从 TOML 换成 YAML",
        feeling: "松了口气",
        intensity: "",
        keywords: ["y.ts"],
        items: [{ type: "work_action", content: "把 y.ts 的 TOML 换成 YAML，git commit 提交", keywords: ["y.ts", "git", "YAML"] }],
      });
    const generated = await generateSelfReview({ material, llm, clock });
    expect(generated.ok).toBe(true);
    storeSelfReviewResult(db, generated, { material });

    const wa = db.query("SELECT content, feeling FROM experiences WHERE kind='work_action'").all() as { content: string; feeling: string | null }[];
    expect(wa.length).toBe(1);
    expect(wa[0].feeling).toBeNull(); // 守心情主权

    // 3) 召回命中
    expect(searchExperiences(db, "y.ts").some((r) => r.kind === "work_action")).toBe(true);
    expect(searchExperiences(db, "YAML").some((r) => r.kind === "work_action")).toBe(true);

    // 4) 注入命中
    writeFileSync(join(h, "personality.md"), "# 人格卡\n\n我叫小满。\n", "utf8");
    const inj = assembleMorningInjection(db, {
      sessionId: "next-sess",
      project: PROJ,
      personalityPath: join(h, "personality.md"),
      clock: frozenClock("2026-06-21T23:00:00.000Z"),
    });
    expect(inj.text).toContain("y.ts"); // work_action 进了开局注入
  });
});
