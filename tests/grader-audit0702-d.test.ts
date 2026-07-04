// 独立验收考官（刀D / AUDIT-2026-07-01 U33+U37）。盲考：唯一输入＝审计需求，不参考开发自带测试。
// 绝不改 src/、绝不碰生产库；一律临时目录建库。
//
// U33 自愈预算护栏：envInt 坏值退默认（单一事实源 src/env.ts）+ selectHealable 对非法预算不透传成
//     SQLite `LIMIT -N`＝无界（H3 防风暴命门）；合法预算零回归。
// U37 向量孤儿清理：pruneOrphanVectors 幂等、只删 dead 宿主行；live（含 live 但旧 model_ver）绝不误删；
//     夜跑 stageVectorize 在**无 embedder**时清理仍执行。
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { envInt } from "../src/env";
import { HEAL_BUDGET_PER_NIGHT, registerHeal, selectHealable } from "../src/selfHeal";
import { pruneOrphanVectors } from "../src/vectorize";
import { runNightlyDigestion } from "../src/digest";
import { insertExperience, invalidateExperience } from "../src/experiences";
import { EMBED_MODEL_VER, vecToBlob } from "../src/embed";
import { frozenClock } from "../src/clock";

let seq = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-grd0702d-${process.pid}-${seq++}.db`));
const clk = frozenClock("2026-06-10T12:00:00.000Z");

// ── 测试用小工具 ──────────────────────────────────────────────────────────
const vecCount = (db: ReturnType<typeof freshDb>) =>
  (db.query("SELECT count(*) c FROM vec_experiences").get() as { c: number }).c;
const hasVec = (db: ReturnType<typeof freshDb>, expId: number) =>
  (db.query("SELECT count(*) c FROM vec_experiences WHERE experience_id = ?").get(expId) as { c: number }).c === 1;

function seedVec(db: ReturnType<typeof freshDb>, expId: number, modelVer = "test-model-v1"): void {
  db.query("INSERT INTO vec_experiences (experience_id, embedding, model_ver) VALUES (?, ?, ?)").run(
    expId,
    vecToBlob(new Float32Array([0.1, 0.2, 0.3])),
    modelVer,
  );
}
function liveExp(db: ReturnType<typeof freshDb>, content = "仍然成立") {
  return insertExperience(db, { kind: "self_review", content, sourceSession: "s1" }, clk);
}
// 只盖 invalid_at（事实层作废，记录层不动）——隔离 prune SQL 的 `invalid_at IS NOT NULL` 分支。
function markInvalidOnly(db: ReturnType<typeof freshDb>, id: number) {
  db.query("UPDATE experiences SET invalid_at = ? WHERE id = ?").run(clk.now().toISOString(), id);
}
// 只盖 expired_at（记录层过期，事实层不动）——隔离 prune SQL 的 `expired_at IS NOT NULL` 分支。
function markExpiredOnly(db: ReturnType<typeof freshDb>, id: number) {
  db.query("UPDATE experiences SET expired_at = ? WHERE id = ?").run(clk.now().toISOString(), id);
}

// ════════════════════════════════════════════════════════════════════════
// U33-A：envInt 边界矩阵（护栏的第一道——坏值/越界一律退默认）
// ════════════════════════════════════════════════════════════════════════
describe("U33-A envInt 坏值/边界退默认", () => {
  const KEY = "ANIMA_GRADER_KNOB_D";
  afterEach(() => {
    delete process.env[KEY];
  });
  const call = (raw: string | undefined, opts?: { min?: number; max?: number }) => {
    if (raw === undefined) delete process.env[KEY];
    else process.env[KEY] = raw;
    return envInt(KEY, 50, opts);
  };

  test("小数向下取整（在范围内）：'12.9'→12、'3.999'→3", () => {
    expect(call("12.9")).toBe(12);
    expect(call("3.999")).toBe(3);
  });
  test("科学计数法解析：'1e3'→1000", () => {
    expect(call("1e3")).toBe(1000);
  });
  test("空串 / 纯空格 / 未设置 → 默认（Number('')=0<min=1）", () => {
    expect(call("")).toBe(50);
    expect(call("   ")).toBe(50);
    expect(call(undefined)).toBe(50);
  });
  test("前后空格的合法整数仍解析：' 12 '→12", () => {
    expect(call(" 12 ")).toBe(12);
  });
  test("Infinity / -Infinity / 数值溢出(1e400→Infinity) → 默认（!isFinite）", () => {
    expect(call("Infinity")).toBe(50);
    expect(call("-Infinity")).toBe(50);
    expect(call("1e400")).toBe(50);
  });
  test("负数 → 默认（命门：旧 `Number(env)||50` 会返回 -1，SQLite LIMIT -1＝无界）", () => {
    expect(call("-1")).toBe(50);
    expect(call("-100")).toBe(50);
    expect(call("-0.5")).toBe(50);
  });
  test("0 / NaN / 非数字文本 → 默认", () => {
    expect(call("0")).toBe(50);
    expect(call("NaN")).toBe(50);
    expect(call("abc")).toBe(50);
    expect(call("12abc")).toBe(50); // Number('12abc')=NaN（整串解析，非 parseInt 前缀）
  });
  test("min 边界：min=2 时 '1'→默认、'2'→2", () => {
    expect(call("1", { min: 2 })).toBe(50);
    expect(call("2", { min: 2 })).toBe(2);
  });
  test("max 边界：{min:1,max:30} 时 '30'→30、'31'→默认", () => {
    expect(call("30", { min: 1, max: 30 })).toBe(30);
    expect(call("31", { min: 1, max: 30 })).toBe(50);
  });
  test("合法大值（min-only 钮）照收：'1000'（min:1）→1000", () => {
    expect(call("1000", { min: 1 })).toBe(1000);
  });
});

// ════════════════════════════════════════════════════════════════════════
// U33-B：单一事实源下游抽查（原「wallShadow re-export 同一引用」检查随 autowall 埋葬——
// 见 docs/TOMBSTONE-AUTOWALL.md；envInt 唯一事实源 src/env.ts 本体矩阵在 U33-A）
// ════════════════════════════════════════════════════════════════════════
describe("U33-B envInt 单一事实源", () => {
  test("HEAL_BUDGET_PER_NIGHT 已走护栏：恒为 ≥1 的有限整数（绝无负/NaN/Infinity）", () => {
    expect(Number.isInteger(HEAL_BUDGET_PER_NIGHT)).toBe(true);
    expect(HEAL_BUDGET_PER_NIGHT).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(HEAL_BUDGET_PER_NIGHT)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// U33-C：selectHealable LIMIT 透传矩阵——非法预算绝不成无界，合法预算零回归
// ════════════════════════════════════════════════════════════════════════
describe("U33-C selectHealable 预算 clamp", () => {
  // 播 N 条 pending + 冷却已过 + 未到重试上限的可愈账。
  function seed(db: ReturnType<typeof freshDb>, count: number) {
    for (let i = 0; i < count; i++) {
      registerHeal(
        db,
        { sessionId: `s${i}`, sinceUuid: null, targetUuid: `t${i}`, shellId: i + 1, night: "2026-06-09" },
        clk,
      );
    }
  }
  const N = 60; // > 默认 50，才能区分"无界透传（取 60）"与"兜回默认（取 50）"
  const pick = (budget: number) => {
    const db = freshDb();
    seed(db, N);
    return selectHealable(db, "2026-06-10", budget).length;
  };

  test("负预算不再是无界 LIMIT：-1 / -100 → 恰好默认 50（旧码 LIMIT -1＝全取 60）", () => {
    expect(pick(-1)).toBe(50);
    expect(pick(-100)).toBe(50);
  });
  test("0 / 0.5（floor 后<1） → 兜回默认 50，绝不是 LIMIT 0＝取零", () => {
    expect(pick(0)).toBe(50);
    expect(pick(0.5)).toBe(50);
  });
  test("NaN / Infinity / -Infinity → 兜回默认 50（Infinity 非<1，靠 !isFinite 拦）", () => {
    expect(pick(Number.NaN)).toBe(50);
    expect(pick(Number.POSITIVE_INFINITY)).toBe(50);
    expect(pick(Number.NEGATIVE_INFINITY)).toBe(50);
  });
  test("合法预算零回归：5→5、25.7→25(floor)、60→60、1000→60(受可愈行数封顶)", () => {
    expect(pick(5)).toBe(5);
    expect(pick(25.7)).toBe(25);
    expect(pick(60)).toBe(60);
    expect(pick(1000)).toBe(60);
  });
  test("缺省参数走 HEAL_BUDGET_PER_NIGHT（默认 50）：60 条账取 50", () => {
    const db = freshDb();
    seed(db, N);
    expect(selectHealable(db, "2026-06-10").length).toBe(HEAL_BUDGET_PER_NIGHT);
  });
  test("小样本不误伤：预算兜回 50 时，3 条账仍全取（不矫枉过正取 0）", () => {
    const db = freshDb();
    seed(db, 3);
    expect(selectHealable(db, "2026-06-10", -1).length).toBe(3);
    expect(selectHealable(db, "2026-06-10", Number.NaN).length).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════
// U37-A：pruneOrphanVectors 删/留矩阵——只删 dead 宿主，live 绝不误删
// ════════════════════════════════════════════════════════════════════════
describe("U37-A prune 只删 dead 宿主", () => {
  test("invalid_at 宿主删、live 宿主留", () => {
    const db = freshDb();
    const dead = liveExp(db, "已被推翻");
    const live = liveExp(db);
    seedVec(db, dead.id);
    seedVec(db, live.id);
    markInvalidOnly(db, dead.id);
    expect(pruneOrphanVectors(db)).toBe(1);
    expect(hasVec(db, dead.id)).toBe(false);
    expect(hasVec(db, live.id)).toBe(true);
  });

  test("expired_at-only 宿主也删（dead 的另一形态：记录层过期）", () => {
    const db = freshDb();
    const exp = liveExp(db, "已衰减过期");
    seedVec(db, exp.id);
    markExpiredOnly(db, exp.id);
    expect(pruneOrphanVectors(db)).toBe(1);
    expect(vecCount(db)).toBe(0);
  });

  test("两戳都在（invalidateExperience 同时盖 invalid_at+expired_at）→ 删", () => {
    const db = freshDb();
    const exp = liveExp(db, "矛盾失效");
    seedVec(db, exp.id);
    expect(invalidateExperience(db, exp.id, clk)).toBe(true);
    expect(pruneOrphanVectors(db)).toBe(1);
    expect(vecCount(db)).toBe(0);
  });

  test("命门：live 但 model_ver 旧版的行绝不误删（那是等重算的）", () => {
    const db = freshDb();
    const live = liveExp(db, "等重算的旧指纹");
    seedVec(db, live.id, "ancient-model-v0"); // 旧版模型指纹，仍挂在 live 宿主上
    expect(pruneOrphanVectors(db)).toBe(0); // 宿主 live → 一行都不许删
    expect(hasVec(db, live.id)).toBe(true);
  });

  test("dead 宿主 + 当前 model_ver 的行照删（model_ver 与删除判定无关）", () => {
    const db = freshDb();
    const dead = liveExp(db, "dead 但指纹是最新的");
    seedVec(db, dead.id, EMBED_MODEL_VER);
    markInvalidOnly(db, dead.id);
    expect(pruneOrphanVectors(db)).toBe(1);
    expect(vecCount(db)).toBe(0);
  });

  test("混合批：3 dead + 3 live（含旧 model_ver）→ 只删 3，live 全留、计数准", () => {
    const db = freshDb();
    const deads = [liveExp(db, "d1"), liveExp(db, "d2"), liveExp(db, "d3")];
    const lives = [liveExp(db, "l1"), liveExp(db, "l2"), liveExp(db, "l3")];
    for (const d of deads) seedVec(db, d.id, EMBED_MODEL_VER);
    seedVec(db, lives[0].id, "ancient-model-v0"); // live 旧版
    seedVec(db, lives[1].id, EMBED_MODEL_VER); // live 当前版
    seedVec(db, lives[2].id, "test-model-v1"); // live 又一版
    markInvalidOnly(db, deads[0].id);
    markExpiredOnly(db, deads[1].id);
    invalidateExperience(db, deads[2].id, clk);
    expect(vecCount(db)).toBe(6);
    expect(pruneOrphanVectors(db)).toBe(3);
    expect(vecCount(db)).toBe(3);
    for (const l of lives) expect(hasVec(db, l.id)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// U37-B：幂等 + 空跑
// ════════════════════════════════════════════════════════════════════════
describe("U37-B prune 幂等/空跑", () => {
  test("重复跑幂等：首轮删 N、次轮删 0，live 行两轮不变", () => {
    const db = freshDb();
    const dead = liveExp(db, "dead");
    const live = liveExp(db);
    seedVec(db, dead.id);
    seedVec(db, live.id);
    markInvalidOnly(db, dead.id);
    expect(pruneOrphanVectors(db)).toBe(1);
    expect(pruneOrphanVectors(db)).toBe(0); // 幂等：第二遍无可删
    expect(pruneOrphanVectors(db)).toBe(0);
    expect(hasVec(db, live.id)).toBe(true);
  });

  test("全 live 库：prune 返回 0、一行不动", () => {
    const db = freshDb();
    const a = liveExp(db, "a");
    const b = liveExp(db, "b");
    seedVec(db, a.id, "ancient-model-v0");
    seedVec(db, b.id, EMBED_MODEL_VER);
    expect(pruneOrphanVectors(db)).toBe(0);
    expect(vecCount(db)).toBe(2);
  });

  test("空 vec 表：prune 返回 0、不炸", () => {
    const db = freshDb();
    liveExp(db, "无向量的经历");
    expect(pruneOrphanVectors(db)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// U37-C：夜跑 stageVectorize 在【无 embedder】时清理仍执行（端到端驱动真阶段）
//   runNightlyDigestion 逐阶段 try/catch，stageOverrides 把非 vectorize 阶段全 stub 成空跑，
//   只让真 stageVectorize 跑；embed:undefined → backfill 早退，唯有 pruneOrphanVectors 生效。
// ════════════════════════════════════════════════════════════════════════
describe("U37-C stageVectorize 无 embedder 仍清孤儿", () => {
  const noop = async () => {};
  const overrides = {
    makeup: noop,
    heal: noop,
    closure: noop,
    decay: noop,
    personality: noop,
    diary: noop,
  } as any;

  test("embed 缺席时：孤儿被清、live 留、vectorize 阶段 done", async () => {
    const db = freshDb();
    const dead = liveExp(db, "夜跑前就 dead 的孤儿");
    const live = liveExp(db, "夜跑要保留的 live");
    seedVec(db, dead.id, EMBED_MODEL_VER);
    seedVec(db, live.id, "ancient-model-v0"); // live 旧版：backfill 本会重算，但无 embedder 不动它，prune 也绝不删
    markInvalidOnly(db, dead.id);

    const uid = `${process.pid}-${seq++}`;
    const result = await runNightlyDigestion(db, {
      llm: {} as any, // 全部 LLM 阶段已被 noop 覆盖，绝不会被调用
      config: { personalityPath: join(tmpdir(), `p-${uid}.md`), diaryDir: join(tmpdir(), `d-${uid}`) },
      clock: clk,
      night: "2026-06-10",
      findTranscripts: () => [],
      embed: undefined, // ← 命门：无 embedder
      stageOverrides: overrides,
    });

    expect(result.stages.vectorize.status).toBe("done"); // 清理阶段没因缺 embedder 跳过/报错
    expect(hasVec(db, dead.id)).toBe(false); // 孤儿被 prune 清掉
    expect(hasVec(db, live.id)).toBe(true); // live（旧 model_ver）原样保留
    expect(vecCount(db)).toBe(1);
  });
});
