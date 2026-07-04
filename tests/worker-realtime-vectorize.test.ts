// 实时向量化（DESIGN-REALTIME-VECTORIZE）：worker 消化完顺手给当天记忆补语义指纹。
// 守的命门：① hook 边界——src/worker.ts 必须 transformers-free（type-only + 动态 import），否则每次 Stop
// hook 都加载几百 MB transformers＝2026-06-12 复发；② 失败隔离——embed 抛错 worker 不崩、消化照常、水位线不动。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { enqueueReview } from "../src/workQueue";
import { insertExperience } from "../src/experiences";
import { runWorker } from "../src/worker";
import type { EmbedFn } from "../src/vectorize";

const NOW = frozenClock("2026-06-10T05:00:00.000Z");
const STARTED = new Date("2026-06-10T05:00:00.000Z");

const tmpDirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "anima-rtvec-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = { uuid: string; ts: string; role: "user" | "assistant"; text: string };
const TURNS: Turn[] = [
  { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "把权限回归测试修好。" },
  { uuid: "u2", ts: "2026-06-10T01:05:00.000Z", role: "assistant", text: "好，先看鉴权 mock。" },
  { uuid: "u3", ts: "2026-06-10T01:10:00.000Z", role: "user", text: "顺手配色先别改，等我确认。" },
];
function writeTranscript(dir: string, sid: string): string {
  const lines = TURNS.map((t) =>
    JSON.stringify({
      uuid: t.uuid, parentUuid: null, isSidechain: false, sessionId: sid,
      timestamp: t.ts, cwd: "/proj", type: t.role, isMeta: false,
      message: { role: t.role, content: t.text },
    }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
function goodLlm() {
  const calls = { n: 0 };
  const llm = async () => {
    calls.n++;
    return JSON.stringify({ review: "增量复盘：修权限测试、配色待确认。", feeling: "踏实", intensity: "中", keywords: ["权限"], items: [] });
  };
  return { llm, calls };
}
function seedQueue(dir: string, dbPath: string, sid = "s1") {
  const db = openDb(dbPath);
  const path = writeTranscript(dir, sid);
  enqueueReview(db, { sessionId: sid, transcriptPath: path, targetUuid: "u3" }, NOW);
  db.close();
}
function vecCount(dbPath: string): number {
  const db = openDb(dbPath);
  const c = (db.query("SELECT count(*) c FROM vec_experiences").get() as { c: number }).c;
  db.close();
  return c;
}
function reviewCount(dbPath: string, sid = "s1"): number {
  const db = openDb(dbPath);
  const c = (db.query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=?").get(sid) as { c: number }).c;
  db.close();
  return c;
}
// 任意维确定性桩向量（vec_experiences 是普通 BLOB 表、不强制维度）
const stubEmbed = (spy?: { n: number }): EmbedFn => async (texts) => {
  if (spy) spy.n += texts.length;
  return texts.map((t) => new Float32Array([t.length, 1, 1]));
};

describe("实时向量化", () => {
  // ① 命门：hook 边界——src/worker.ts 不得静态值导入 transformers 链（vectorize/embed）
  test("hook 边界：src/worker.ts 是 transformers-free（type-only + 动态 import）", () => {
    const src = readFileSync(join(import.meta.dir, "../src/worker.ts"), "utf8");
    // EmbedFn 必须是 type-only 导入
    expect(/import\s+type\s*\{[^}]*\bEmbedFn\b[^}]*\}\s*from\s*["']\.\/vectorize["']/.test(src)).toBe(true);
    // 绝不能有从 ./vectorize 或 ./embed 的**值**静态导入（type 除外）
    const badValueImport = /^\s*import\s+(?!type\b)[^;]*from\s+["']\.\/(vectorize|embed)["']/m;
    expect(badValueImport.test(src)).toBe(false);
    // backfillVectors 只能走动态 import（await import("./vectorize")）
    expect(/await\s+import\(\s*["']\.\/vectorize["']\s*\)/.test(src)).toBe(true);
  });

  // ② 注入 embed + 有实质前进 → 给新记忆补向量
  test("注入 embed + advanced>0 → 写进 vec_experiences", async () => {
    const dir = tmp();
    const dbPath = join(dir, "anima.db");
    seedQueue(dir, dbPath);
    const { llm } = goodLlm();
    const r = await runWorker({ dbPath, dataDir: dir, llm, clock: NOW, now: STARTED, idleExitMs: 0, pollMs: 0, embed: stubEmbed() });
    expect(r.reason).toBe("idle_exit");
    expect(reviewCount(dbPath)).toBe(1); // 消化照常
    expect(vecCount(dbPath)).toBeGreaterThan(0); // 当天记忆当场补了向量
  }, 15_000);

  // ③ 不注入 embed → 退化成原行为：消化照常、不算向量、不崩
  test("不注入 embed → 消化照常、零向量、不崩（向后兼容）", async () => {
    const dir = tmp();
    const dbPath = join(dir, "anima.db");
    seedQueue(dir, dbPath);
    const { llm } = goodLlm();
    const r = await runWorker({ dbPath, dataDir: dir, llm, clock: NOW, now: STARTED, idleExitMs: 0, pollMs: 0 });
    expect(r.reason).toBe("idle_exit");
    expect(reviewCount(dbPath)).toBe(1);
    expect(vecCount(dbPath)).toBe(0); // 没注入就不算
  }, 15_000);

  // ④ 失败隔离：embed 抛错 → worker 不崩、消化照常、向量为空（局部 catch 不冒泡）
  test("embed 抛错 → worker 不崩、消化照常、向量空、非致命", async () => {
    const dir = tmp();
    const dbPath = join(dir, "anima.db");
    seedQueue(dir, dbPath);
    const { llm } = goodLlm();
    const boom: EmbedFn = async () => { throw new Error("embed boom"); };
    const r = await runWorker({ dbPath, dataDir: dir, llm, clock: NOW, now: STARTED, idleExitMs: 0, pollMs: 0, embed: boom });
    expect(r.reason).toBe("idle_exit"); // 没被带崩
    expect(reviewCount(dbPath)).toBe(1); // 消化在 backfill 之前、已落库
    expect(vecCount(dbPath)).toBe(0); // 算向量失败、夜跑兜底
  }, 15_000);

  // ⑤ 无实质前进（空队列）→ 根本不调 embed（不白加载模型）。
  // 牙：预置一条**未向量化**的记忆——若 advanced>0 闸被摘成"每轮无条件 backfill"，backfill 会捞到这条、
  // 调 embed → spy.n>0 → 本测 fail（空库版分辨不出闸是否生效，独立考官反向改码证其无牙，故补料）。
  test("advanced=0（空队列）→ 不调 embed（即便库里有未向量化的料）", async () => {
    const dir = tmp();
    const dbPath = join(dir, "anima.db");
    const db = openDb(dbPath);
    insertExperience(db, { kind: "event", project: "anima", content: "一条未向量化的旧记忆，等着被补指纹" }, NOW);
    db.close();
    const { llm } = goodLlm();
    const spy = { n: 0 };
    const r = await runWorker({ dbPath, dataDir: dir, llm, clock: NOW, now: STARTED, idleExitMs: 0, pollMs: 0, embed: stubEmbed(spy) });
    expect(r.reason).toBe("idle_exit");
    expect(spy.n).toBe(0); // 队列空→advanced=0→闸跳过 backfill→embed 没被调（即便有未向量化的料在）
  }, 15_000);
});
