// 步骤3 缝合（DESIGN-DAYSPLIT §3.5）：跨天切片承接。复盘 day-N 切片、wmOld!=null（有前片）且有先前**真叙事**
// 自评（kind='self_review'，跳 fallback/空）→ 取最近一条注入 Material.priorSliceSummary；buildSelfReviewPrompt
// 有 prior 才加「跨天承接」框（别从半句开始/不重复上片/未完标未完待续），无 prior **逐字不变**（零回归）。
// 红灯先行：实现前 Material 无 priorSliceSummary 字段、prompt 无承接框。
//   S1 无 prior（首评 sinceUuid=null）→ priorSliceSummary undefined、prompt 不含承接框、与旧逐字一致
//   S2 有 prior（sinceUuid!=null + 有 self_review）→ 注入最近一条 review、prompt 含承接框 + 上片内容
//   S3 只有 fallback（self_review_fallback）→ 跳过、不注入
//   S4 多条 self_review → 只注**最近一条**（非累积）

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import {
  buildIncrementalMaterial,
  buildSelfReviewPrompt,
  type Material,
} from "../src/selfReview";

const tmpDirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "anima-stitch-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string };
function writeTranscript(dir: string, sid: string, turns: Turn[]): string {
  const lines = turns.map((t) =>
    JSON.stringify({
      uuid: t.uuid,
      parentUuid: null,
      isSidechain: false,
      sessionId: sid,
      timestamp: t.ts,
      cwd: "/proj",
      type: t.role,
      isMeta: false,
      message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
const TURNS: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "先修权限测试。" },
  { uuid: "u2", ts: "2026-06-11T01:00:00.000Z", role: "user", text: "第二天接着改配色。" },
  { uuid: "u3", ts: "2026-06-11T02:00:00.000Z", role: "assistant", text: "好，配色我先问你。" },
];

// 缝合框的稳定标识（实现里这段框文案含此标识，测试据此判定有没有加框）
const STITCH_MARK = "上一片";

const baseMaterial: Material = {
  sessionId: "s1",
  project: "/proj",
  conversation: ["用户：测试对话。"],
  events: [],
  bookmarks: [],
  evidenceText: "测试对话。",
};

describe("步骤3 缝合 buildSelfReviewPrompt", () => {
  test("S1 无 prior → 不含承接框，与旧 prompt 逐字一致（零回归）", () => {
    const prompt = buildSelfReviewPrompt(baseMaterial);
    expect(prompt).not.toContain(STITCH_MARK);
    // 旧结构锚点仍在
    expect(prompt).toContain("收工时间");
    expect(prompt).toContain("## 对话节选");
  });

  test("S2 有 prior → 含承接框 + 上一片内容", () => {
    const prompt = buildSelfReviewPrompt({
      ...baseMaterial,
      priorSliceSummary: "上半段：把鉴权 mock 修好了，配色待用户确认。",
    });
    expect(prompt).toContain(STITCH_MARK); // 加了承接框
    expect(prompt).toContain("把鉴权 mock 修好了"); // 上片自评内容进了 prompt
    expect(prompt).toContain("收工时间"); // 主体仍在
  });
});

describe("步骤3 缝合 buildIncrementalMaterial 注入 priorSliceSummary", () => {
  test("S2 sinceUuid!=null + 有 self_review → 注入最近一条 review", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const sid = "s1";
    const path = writeTranscript(dir, sid, TURNS);
    insertExperience(
      db,
      { kind: "self_review", content: "上一片：修了权限测试。", sourceSession: sid },
      frozenClock("2026-06-10T04:00:00.000Z"),
    );
    const inc = buildIncrementalMaterial(db, {
      transcriptPath: path,
      sessionId: sid,
      sinceUuid: "u1", // 有前片
      targetUuid: "u3",
    });
    expect(inc.ok).toBe(true);
    if (inc.ok) expect(inc.material.priorSliceSummary).toBe("上一片：修了权限测试。");
  });

  test("S1 首评 sinceUuid=null → 不注入 priorSliceSummary（逐字不变）", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const sid = "s1";
    const path = writeTranscript(dir, sid, TURNS);
    insertExperience(
      db,
      { kind: "self_review", content: "不该被注入（首评无前片）。", sourceSession: sid },
      frozenClock("2026-06-10T04:00:00.000Z"),
    );
    const inc = buildIncrementalMaterial(db, {
      transcriptPath: path,
      sessionId: sid,
      sinceUuid: null, // 首评
      targetUuid: "u3",
    });
    expect(inc.ok).toBe(true);
    if (inc.ok) expect(inc.material.priorSliceSummary).toBeUndefined();
  });

  test("S3 只有 fallback（self_review_fallback）→ 跳过、不注入", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const sid = "s1";
    const path = writeTranscript(dir, sid, TURNS);
    insertExperience(
      db,
      { kind: "self_review_fallback", content: "客观流水兜底壳，不是真叙事。", sourceSession: sid },
      frozenClock("2026-06-10T04:00:00.000Z"),
    );
    const inc = buildIncrementalMaterial(db, {
      transcriptPath: path,
      sessionId: sid,
      sinceUuid: "u1",
      targetUuid: "u3",
    });
    expect(inc.ok).toBe(true);
    if (inc.ok) expect(inc.material.priorSliceSummary).toBeUndefined();
  });

  test("S4 多条 self_review → 只注最近一条（非累积）", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const sid = "s1";
    const path = writeTranscript(dir, sid, TURNS);
    insertExperience(
      db,
      { kind: "self_review", content: "更早的一片。", sourceSession: sid },
      frozenClock("2026-06-09T04:00:00.000Z"),
    );
    insertExperience(
      db,
      { kind: "self_review", content: "最近的一片（应被注入）。", sourceSession: sid },
      frozenClock("2026-06-10T04:00:00.000Z"),
    );
    const inc = buildIncrementalMaterial(db, {
      transcriptPath: path,
      sessionId: sid,
      sinceUuid: "u1",
      targetUuid: "u3",
    });
    expect(inc.ok).toBe(true);
    if (inc.ok) expect(inc.material.priorSliceSummary).toBe("最近的一片（应被注入）。");
  });
});
