// IMPORTANT-3（DESIGN-WORKER-RESUME §v5.7 / §3.3）：增量自评不能只切 transcript，
// situation_log 也得按时间窗切，否则增量素材里混进全场旧事件。
// 给 listSituations 加 sinceOccurredAt（> 排除水位线及更早）/ untilOccurredAt（<= 含 target）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { appendSituation, listSituations } from "../src/situation";

const tmpDirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-test-"));
  tmpDirs.push(d);
  return join(d, "anima.db");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T1 = "2026-06-10T10:00:00.000Z";
const T2 = "2026-06-10T11:00:00.000Z";
const T3 = "2026-06-10T12:00:00.000Z";

function seed(db: ReturnType<typeof openDb>) {
  const clock = frozenClock("2026-06-11T00:00:00.000Z");
  for (const [t, tag] of [
    [T1, "e1"],
    [T2, "e2"],
    [T3, "e3"],
  ] as const) {
    appendSituation(
      db,
      { sessionId: "s1", project: null, kind: "file_edit", payload: { tag }, occurredAt: t },
      clock,
    );
  }
}
const tags = (rows: { payload: unknown }[]) => rows.map((r) => (r.payload as { tag: string }).tag);

describe("listSituations 时间窗过滤", () => {
  test("sinceOccurredAt 排除该时刻及更早（> 严格大于）", () => {
    const db = openDb(tmpDb());
    seed(db);
    expect(tags(listSituations(db, { sinceOccurredAt: T1 }))).toEqual(["e2", "e3"]);
    expect(tags(listSituations(db, { sinceOccurredAt: T2 }))).toEqual(["e3"]);
  });

  test("untilOccurredAt 含该时刻（<= 小于等于）", () => {
    const db = openDb(tmpDb());
    seed(db);
    expect(tags(listSituations(db, { untilOccurredAt: T2 }))).toEqual(["e1", "e2"]);
  });

  test("since + until 组成半开区间 (T1, T2] → 只 e2", () => {
    const db = openDb(tmpDb());
    seed(db);
    expect(tags(listSituations(db, { sinceOccurredAt: T1, untilOccurredAt: T2 }))).toEqual(["e2"]);
  });

  test("时间窗与 sessionId 同时生效", () => {
    const db = openDb(tmpDb());
    seed(db);
    appendSituation(
      db,
      { sessionId: "other", project: null, kind: "file_edit", payload: { tag: "x" }, occurredAt: T3 },
      frozenClock("2026-06-11T00:00:00.000Z"),
    );
    expect(tags(listSituations(db, { sessionId: "s1", sinceOccurredAt: T1 }))).toEqual(["e2", "e3"]);
  });

  test("无时间窗参数 → 行为不变（全取）", () => {
    const db = openDb(tmpDb());
    seed(db);
    expect(tags(listSituations(db, { sessionId: "s1" }))).toEqual(["e1", "e2", "e3"]);
  });
});
