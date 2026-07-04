// 独立验收考官 — AUDIT-2026-07-01 刀B（U39 queryBookmarks 漏作废/过期过滤 · U40 增量素材 null-ts 下界无界泄旧）
// 铁律：绝不改 src/；绝不碰生产库；一律 mkdtemp 临时目录建库。本文件由考官独立设计，未复用被验方自带用例。
//
// 每个断言都对「修复前的坏码」有区分力：
//   · U39 坏码 = queryBookmarks 的 WHERE 缺 invalid_at IS NULL / expired_at IS NULL → 作废/过期书签复活。
//   · U40 坏码 = sinceTs 直接取锚点条目 timestamp（null 则 undefined）→ 无界下界把整场旧料混进增量。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { buildIncrementalMaterial, buildMaterial } from "../src/selfReview";

const SX = "sess-graderB";
const OTHER = "sess-other";

// 时间轴（东八外的 UTC ISO，字典序=时序）
const T0 = "2026-06-10T09:00:00.000Z"; // 陈年：早于整段 transcript
const T1 = "2026-06-10T10:00:00.000Z"; // u1
const T1b = "2026-06-10T10:00:30.000Z"; // u1~u2
const T2 = "2026-06-10T10:01:00.000Z"; // u2
const T2plus = "2026-06-10T10:01:00.001Z"; // 紧贴 T2 之后（> since 边界）
const T2b = "2026-06-10T10:01:30.000Z"; // u2~u3
const T3 = "2026-06-10T10:02:00.000Z"; // u3
const T3b = "2026-06-10T10:02:30.000Z"; // u3~u4（尾部流水）
const T4 = "2026-06-10T10:03:00.000Z"; // u4
const T4plus = "2026-06-10T10:03:00.001Z"; // 紧贴 T4 之后（<= until 边界外）
const T5 = "2026-06-10T11:00:00.000Z"; // 未来：晚于整段 transcript

const CLK = frozenClock("2026-06-11T00:00:00.000Z");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Line = {
  type: "user" | "assistant";
  uuid: string;
  ts?: string | null; // 省略/undefined → 该条无 timestamp
  text: string;
};

function mkEnv(lines: Line[]): { db: ReturnType<typeof openDb>; path: string } {
  const d = mkdtempSync(join(tmpdir(), "anima-graderB-"));
  tmpDirs.push(d);
  const db = openDb(join(d, "anima.db"));
  const path = join(d, "transcript.jsonl");
  const rows = lines.map((l) => {
    const base: Record<string, unknown> = {
      type: l.type,
      uuid: l.uuid,
      sessionId: SX,
      cwd: "/proj",
      message:
        l.type === "user"
          ? { role: "user", content: l.text }
          : { role: "assistant", content: [{ type: "text", text: l.text }] },
    };
    if (l.ts !== undefined && l.ts !== null) base.timestamp = l.ts; // 省略字段 = null ts
    return JSON.stringify(base);
  });
  writeFileSync(path, rows.join("\n") + "\n");
  return { db, path };
}

/** 4 条全带 ts 的标准 transcript：u1..u4 */
const FULL_TS: Line[] = [
  { type: "user", uuid: "u1", ts: T1, text: "问题A" },
  { type: "assistant", uuid: "u2", ts: T2, text: "回答A" },
  { type: "user", uuid: "u3", ts: T3, text: "问题B" },
  { type: "assistant", uuid: "u4", ts: T4, text: "回答B" },
];

function bm(
  db: ReturnType<typeof openDb>,
  content: string,
  occurredAt: string,
  session = SX,
): number {
  return insertExperience(db, { kind: "bookmark", content, sourceSession: session, occurredAt }, CLK).id;
}
function sit(db: ReturnType<typeof openDb>, tag: string, occurredAt: string): void {
  appendSituation(db, { sessionId: SX, project: "/proj", kind: "file_edit", payload: { tag } }, {
    now: () => new Date(occurredAt),
  });
}
/** 只盖 expired_at（不动 invalid_at）：独立压 expired_at IS NULL 这一谓词 */
function expireOnly(db: ReturnType<typeof openDb>, id: number): void {
  db.query("UPDATE experiences SET expired_at = ? WHERE id = ?").run(T5, id);
}
/** 只盖 invalid_at（不动 expired_at）：独立压 invalid_at IS NULL 这一谓词 */
function invalidOnly(db: ReturnType<typeof openDb>, id: number): void {
  db.query("UPDATE experiences SET invalid_at = ? WHERE id = ?").run(T5, id);
}

// ───────────────────────────── U39 · 全量路（buildMaterial）─────────────────────────────
describe("U39 buildMaterial：作废/过期书签一律不进素材，活书签零回归", () => {
  test("作废(invalidateExperience) / 仅过期 / 仅作废 三种死书签都被挡；活书签仍在；跨会话书签不越墙", () => {
    const { db, path } = mkEnv(FULL_TS);
    bm(db, "LIVE_MAIN_活着的感触", T2b);
    const dead = bm(db, "DEAD_INVALIDATED_被推翻", T2b);
    invalidateExperience(db, dead, CLK); // 同时盖 invalid_at + expired_at
    const expOnly = bm(db, "DEAD_EXPIRED_ONLY_仅记录层过期", T2b);
    expireOnly(db, expOnly);
    const invOnly = bm(db, "DEAD_INVALID_ONLY_仅事实层作废", T2b);
    invalidOnly(db, invOnly);
    bm(db, "OTHER_SESSION_别的会话", T2b, OTHER); // source_session 不同

    const joined = buildMaterial(db, { transcriptPath: path, sessionId: SX }).bookmarks.join("\n");
    expect(joined).toContain("LIVE_MAIN_活着的感触"); // 活书签零回归
    expect(joined).not.toContain("DEAD_INVALIDATED_被推翻");
    expect(joined).not.toContain("DEAD_EXPIRED_ONLY_仅记录层过期"); // 压 expired_at IS NULL
    expect(joined).not.toContain("DEAD_INVALID_ONLY_仅事实层作废"); // 压 invalid_at IS NULL
    expect(joined).not.toContain("OTHER_SESSION_别的会话"); // source_session 墙未被改动破坏
  });

  test("全部书签都活着 → 一条不落全进（不误伤活料）", () => {
    const { db, path } = mkEnv(FULL_TS);
    bm(db, "LIVE_甲", T1b);
    bm(db, "LIVE_乙", T2b);
    bm(db, "LIVE_丙", T3b);
    const joined = buildMaterial(db, { transcriptPath: path, sessionId: SX }).bookmarks.join("\n");
    expect(joined).toContain("LIVE_甲");
    expect(joined).toContain("LIVE_乙");
    expect(joined).toContain("LIVE_丙");
  });
});

// ─────────────────────────── U39 · 增量路（buildIncrementalMaterial）───────────────────────────
describe("U39 buildIncrementalMaterial：窗内的死书签同样不复活", () => {
  test("增量窗内作废/仅过期书签被挡，窗内活书签仍在", () => {
    const { db, path } = mkEnv(FULL_TS);
    bm(db, "INC_LIVE_窗内活着", T3b); // 落在 (T2,T4] 窗内
    const dead = bm(db, "INC_DEAD_窗内作废", T3b);
    invalidateExperience(db, dead, CLK);
    const expOnly = bm(db, "INC_EXPIRED_窗内仅过期", T3b);
    expireOnly(db, expOnly);

    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.material.bookmarks.join("\n");
    expect(joined).toContain("INC_LIVE_窗内活着");
    expect(joined).not.toContain("INC_DEAD_窗内作废");
    expect(joined).not.toContain("INC_EXPIRED_窗内仅过期");
  });
});

// ───────────────── U39 · 活书签时间窗边界零回归：> since 严格、<= until 含 ─────────────────
describe("U39 增量书签时间窗：> since 严格排除、<= until 含（活书签语义不得变）", () => {
  test("恰在 since 的排除、紧邻其后的收；恰在 until 的收、紧邻其后的排除", () => {
    // sinceUuid=u2 → sinceTs=T2；target=u4 → untilTs=T4。窗 = (T2, T4]
    const { db, path } = mkEnv(FULL_TS);
    bm(db, "BM_AT_SINCE_恰在下界", T2); // == T2 → 严格 > 排除
    bm(db, "BM_AFTER_SINCE_下界后一瞬", T2plus); // > T2 → 收
    bm(db, "BM_AT_UNTIL_恰在上界", T4); // == T4 → <= 含
    bm(db, "BM_AFTER_UNTIL_上界后一瞬", T4plus); // > T4 → 排除

    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.material.bookmarks.join("\n");
    expect(joined).not.toContain("BM_AT_SINCE_恰在下界"); // > since 严格
    expect(joined).toContain("BM_AFTER_SINCE_下界后一瞬");
    expect(joined).toContain("BM_AT_UNTIL_恰在上界"); // <= until 含
    expect(joined).not.toContain("BM_AFTER_UNTIL_上界后一瞬");
  });
});

// ───────────────── U40 · 下界锚点无 ts → 回退最近更早带 ts 条目，绝不无界泄旧 ─────────────────
describe("U40 增量下界：锚点无 ts 回退更早邻条，陈年旧料不泄；上界维持开放不丢尾部", () => {
  // u2（锚点/水位线）与 u4（末条/target）都无 ts；u1=T1、u3=T3 有 ts
  const NULL_ANCHOR: Line[] = [
    { type: "user", uuid: "u1", ts: T1, text: "问题A" },
    { type: "assistant", uuid: "u2", text: "回答A" }, // 无 ts ← 锚点
    { type: "user", uuid: "u3", ts: T3, text: "问题B" },
    { type: "assistant", uuid: "u4", text: "回答B" }, // 无 ts ← 末条/target
  ];

  test("下界回退到 u1(T1)：T0 陈年 situation/书签被挡，窗内的留下（坏码无界 → T0 泄进）", () => {
    const { db, path } = mkEnv(NULL_ANCHOR);
    sit(db, "ANCIENT_SIT_陈年事件", T0); // < T1 → 回退界 > T1 后应被挡
    sit(db, "LATE_SIT_尾部事件", T3b); // 尾部流水，必须留
    bm(db, "ANCIENT_BM_陈年书签", T0); // 书签同样按窗，应被挡
    bm(db, "LATE_BM_尾部书签", T3b); // 应留

    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = r.material.events.join("\n");
    const marks = r.material.bookmarks.join("\n");
    expect(events).not.toContain("ANCIENT_SIT_陈年事件"); // U40 核心：不再无界泄旧
    expect(marks).not.toContain("ANCIENT_BM_陈年书签");
    expect(events).toContain("LATE_SIT_尾部事件");
    expect(marks).toContain("LATE_BM_尾部书签");
  });

  test("上界维持开放（末条无 ts → target 无 ts → 无界上界）：尾部流水绝不被丢给不存在的下一片", () => {
    const { db, path } = mkEnv(NULL_ANCHOR);
    sit(db, "LATE_SIT_尾部事件", T3b); // u3~u4 间的尾部：绝不能被挤掉
    sit(db, "FUTURE_SIT_未来事件", T5); // 上界开放 → 允许重叠进来（宁重叠不漏段）
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = r.material.events.join("\n");
    expect(events).toContain("LATE_SIT_尾部事件"); // 命门：尾部不丢
    expect(events).toContain("FUTURE_SIT_未来事件"); // 上界确实开放（未被误钳到 T3）
  });
});

// ───────────────── U40 · 回退取「最近」更早 ts，而非「最早」 ─────────────────
describe("U40 下界回退取最近更早带 ts 的条目（不是从头第一条）", () => {
  // u1=T1、u2=T2 都有 ts；u3=null 作锚点；u4=T4 作 target
  const TWO_EARLIER: Line[] = [
    { type: "user", uuid: "u1", ts: T1, text: "问题A" },
    { type: "assistant", uuid: "u2", ts: T2, text: "回答A" },
    { type: "user", uuid: "u3", text: "问题B" }, // 无 ts ← 锚点
    { type: "assistant", uuid: "u4", ts: T4, text: "回答B" }, // target
  ];

  test("锚点 u3 无 ts → 回退到最近的 u2(T2) 而非 u1(T1)：T1~T2 之间的料被排除", () => {
    const { db, path } = mkEnv(TWO_EARLIER);
    sit(db, "MIDGAP_SIT_介于T1T2", T1b); // 若误取最早 T1 → 会被 > T1 收进（错）；取最近 T2 → 排除（对）
    sit(db, "INWIN_SIT_窗内", T2b); // > T2 → 收
    sit(db, "ANCIENT_SIT_陈年", T0); // < T1 → 无论如何都排除（有界性兜底）

    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u3", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = r.material.events.join("\n");
    expect(events).not.toContain("MIDGAP_SIT_介于T1T2"); // 证明回退取的是「最近」T2
    expect(events).toContain("INWIN_SIT_窗内");
    expect(events).not.toContain("ANCIENT_SIT_陈年");
  });
});

// ───────────────── U40 · 两条「从头」旧语义必须保留 ─────────────────
describe("U40 从头旧语义保留：换文件 resume（锚点找不到）与锚点前全无 ts", () => {
  test("锚点 uuid 不在 transcript（换文件 resume）→ 下界维持 undefined＝从头（陈年料照进，靠库层去重兜）", () => {
    const { db, path } = mkEnv(FULL_TS);
    sit(db, "ANCIENT_SIT_陈年", T0);
    sit(db, "INWIN_SIT_窗内", T2b);
    // sinceUuid 是一个不存在的 uuid：findIndex=-1 → sinceIdx=-1 → sinceTs=undefined（从头）
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "ghost-not-in-file", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = r.material.events.join("\n");
    expect(events).toContain("ANCIENT_SIT_陈年"); // 从头：陈年料在窗内（<= T4），与 resume 旧语义一致
    expect(events).toContain("INWIN_SIT_窗内");
  });

  test("锚点找到但其前全无 ts（u1、u2 都无 ts）→ 无更早 ts 可退 → undefined＝从头（唯一可行退化）", () => {
    const noEarlyTs: Line[] = [
      { type: "user", uuid: "u1", text: "问题A" }, // 无 ts
      { type: "assistant", uuid: "u2", text: "回答A" }, // 无 ts ← 锚点
      { type: "user", uuid: "u3", ts: T3, text: "问题B" },
      { type: "assistant", uuid: "u4", ts: T4, text: "回答B" }, // target
    ];
    const { db, path } = mkEnv(noEarlyTs);
    sit(db, "ANCIENT_SIT_陈年", T0);
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 锚点及其之前无任何 ts → nearestTsAtOrBefore 返回 undefined → 从头（与 resume 同）。这是唯一可行退化，非泄漏 bug。
    expect(r.material.events.join("\n")).toContain("ANCIENT_SIT_陈年");
  });
});

// ───────────────── U40 · 时间戳齐全 → 逐字零回归 ─────────────────
describe("U40 时间戳齐全时行为逐字不变（零回归）", () => {
  test("since=u2 target=u4 全带 ts：窗 = (T2,T4]，陈年/更早的旧料不混、窗内料在", () => {
    const { db, path } = mkEnv(FULL_TS);
    sit(db, "EARLY_SIT_u1u2之间", T1b); // <= T2 → 排除（严格 > T2）
    sit(db, "INWIN_SIT_u2u3之间", T2b); // 窗内
    sit(db, "TAIL_SIT_u3u4之间", T3b); // 窗内
    bm(db, "EARLY_BM_更早", T1b); // 排除
    bm(db, "INWIN_BM_窗内", T3b); // 收
    const r = buildIncrementalMaterial(db, { transcriptPath: path, sessionId: SX, sinceUuid: "u2", targetUuid: "u4" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = r.material.events.join("\n");
    const marks = r.material.bookmarks.join("\n");
    expect(events).not.toContain("EARLY_SIT_u1u2之间");
    expect(events).toContain("INWIN_SIT_u2u3之间");
    expect(events).toContain("TAIL_SIT_u3u4之间");
    expect(marks).not.toContain("EARLY_BM_更早");
    expect(marks).toContain("INWIN_BM_窗内");
  });
});
