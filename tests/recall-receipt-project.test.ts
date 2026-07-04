// 钉1：受体检 C9a 暴露——经历空时翻原始流水的二级兜底路不按 project 过滤，
// 别项目的用户原话越墙漏过来（哑雷）。修后：流水兜底与经历同语义按 project 过滤。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { appendSituation } from "../src/situation";
import { searchRawReceipts, searchMemoryIndex, searchMemoryIndexHybrid } from "../src/recall";
import { type QueryEmbedder } from "../src/hybridSearch";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-rcpt-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = frozenClock("2026-06-18T09:00:00.000Z");
const QN = "/Users/tester/proj/citrus";
const LT = "/Users/tester/proj/beacon";
// 向量桩：返回零向量 → 余弦 0、向量路恒空，逼 hybrid 落到流水兜底（隔离测流水侧）
const zeroQuery: QueryEmbedder = async () => new Float32Array(3);

function seedReceipts(db: ReturnType<typeof openDb>) {
  // 灯塔项目里聊了"告警阈值是多少"；青柠项目从没提过告警阈值。
  appendSituation(db, { sessionId: "lt1", project: LT, kind: "user_message", payload: { text: "灯塔的 CPU 告警阈值定多少合适" } }, clock);
  appendSituation(db, { sessionId: "qn1", project: QN, kind: "user_message", payload: { text: "青柠的日志默认写到哪个路径" } }, clock);
}

describe("钉1 · 流水兜底按 project 过滤", () => {
  test("searchRawReceipts：限定 project 时不返回别项目的流水", () => {
    const db = tmpDb();
    seedReceipts(db);
    // 青柠侧查"告警阈值"——灯塔那条不该越墙
    const qn = searchRawReceipts(db, "告警阈值是多少", { project: QN });
    expect(qn.map((r) => r.text).join("\n")).not.toContain("告警阈值");
    expect(qn.length).toBe(0);
    // 灯塔侧查得到自己的
    const lt = searchRawReceipts(db, "告警阈值是多少", { project: LT });
    expect(lt.map((r) => r.text).join("\n")).toContain("告警阈值");
  });

  test("searchRawReceipts：不传 project（搜全部）保持原行为不过滤", () => {
    const db = tmpDb();
    seedReceipts(db);
    const all = searchRawReceipts(db, "告警阈值是多少");
    expect(all.map((r) => r.text).join("\n")).toContain("告警阈值");
  });

  test("searchRawReceipts：includeGlobal 默认纳入 project IS NULL 的全局流水", () => {
    const db = tmpDb();
    // 文本含完整「告警阈值是多少」→ 过覆盖率闸，隔离出 project 这一维
    appendSituation(db, { sessionId: "g1", project: null, kind: "user_message", payload: { text: "全局备忘：告警阈值是多少来着" } }, clock);
    const qn = searchRawReceipts(db, "告警阈值是多少", { project: QN });
    expect(qn.map((r) => r.text).join("\n")).toContain("全局备忘");
    const strict = searchRawReceipts(db, "告警阈值是多少", { project: QN, includeGlobal: false });
    expect(strict.length).toBe(0);
  });

  test("searchMemoryIndex（字面入口）：经历空→流水兜底也按 project 过滤", () => {
    const db = tmpDb();
    seedReceipts(db);
    const qn = searchMemoryIndex(db, "告警阈值是多少", { project: QN });
    expect(qn.map((l) => l.line).join("\n")).not.toContain("告警阈值");
  });

  test("searchMemoryIndexHybrid（语义入口）：C9a 跨项目隔离——青柠查告警阈值，灯塔流水不越墙", async () => {
    const db = tmpDb();
    seedReceipts(db);
    const qn = await searchMemoryIndexHybrid(db, "告警阈值是多少", zeroQuery, { project: QN });
    expect(qn.map((l) => l.line).join("\n")).not.toContain("告警阈值");
    expect(qn.length).toBe(0);
    // 灯塔侧仍能从流水兜底拿到
    const lt = await searchMemoryIndexHybrid(db, "告警阈值是多少", zeroQuery, { project: LT });
    expect(lt.map((l) => l.line).join("\n")).toContain("告警阈值");
  });
});
