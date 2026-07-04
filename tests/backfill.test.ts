// 补课账本测试：findUndigestedNights / latestCompletedNight
// 核心保障：①欠几夜列几夜（旧→新）②进行中的今天绝不入列（防提前盖章）③max 上限与推迟名单
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { insertExperience } from "../src/experiences";
import { appendSituation } from "../src/situation";
import { findUndigestedNights, getDigestStages, latestCompletedNight, nightOf } from "../src/digest";

const tmpDirs: string[] = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "anima-backfill-"));
  tmpDirs.push(dir);
  return openDb(join(dir, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedDay(db: ReturnType<typeof openDb>, date: string) {
  insertExperience(
    db,
    { kind: "preference", content: `${date} 的一条经历`, occurredAt: `${date}T10:00:00.000Z` },
    frozenClock(`${date}T10:00:01.000Z`),
  );
}

function markNightDone(db: ReturnType<typeof openDb>, night: string) {
  for (const stage of getDigestStages()) {
    db.query(
      "INSERT INTO digest_runs (night, stage, status, error, finished_at) VALUES (?, ?, 'done', NULL, ?)",
    ).run(night, stage, `${night}T23:59:59.000Z`);
  }
}

describe("latestCompletedNight", () => {
  test("东八区同一天内时刻不同，结果都是昨天", () => {
    expect(latestCompletedNight(new Date("2026-06-11T17:00:00.000Z"))).toBe("2026-06-11"); // 东八区 06-12 01:00
    expect(latestCompletedNight(new Date("2026-06-12T14:00:00.000Z"))).toBe("2026-06-11"); // 东八区 06-12 22:00
  });

  test("下午跑时与 nightOf 分歧（这正是要修的 bug）：nightOf 会给出进行中的今天", () => {
    const afternoon = new Date("2026-06-12T06:00:00.000Z"); // 东八区 06-12 14:00
    expect(nightOf(afternoon)).toBe("2026-06-12"); // 老约定：危险，今天还没过完
    expect(latestCompletedNight(afternoon)).toBe("2026-06-11"); // 新约定：只碰过完的日子
  });
});

describe("findUndigestedNights", () => {
  test("欠几夜列几夜，旧→新排序", () => {
    const db = freshDb();
    for (const d of ["2026-06-10", "2026-06-08", "2026-06-09"]) seedDay(db, d);
    const { nights, deferred } = findUndigestedNights(db, {
      now: new Date("2026-06-11T18:00:00.000Z"),
    });
    expect(nights).toEqual(["2026-06-08", "2026-06-09", "2026-06-10"]);
    expect(deferred).toEqual([]);
  });

  test("已消化完的夜不再列", () => {
    const db = freshDb();
    for (const d of ["2026-06-08", "2026-06-09", "2026-06-10"]) seedDay(db, d);
    markNightDone(db, "2026-06-09");
    const { nights } = findUndigestedNights(db, { now: new Date("2026-06-11T18:00:00.000Z") });
    expect(nights).toEqual(["2026-06-08", "2026-06-10"]);
  });

  test("进行中的今天绝不入列（下午登录触发 RunAtLoad 也不会提前盖章）", () => {
    const db = freshDb();
    seedDay(db, "2026-06-11");
    seedDay(db, "2026-06-12"); // 今天，进行中
    const { nights } = findUndigestedNights(db, { now: new Date("2026-06-12T10:00:00.000Z") }); // 东八区 06-12 18:00
    expect(nights).toEqual(["2026-06-11"]);
  });

  test("超过 max 的推迟到 deferred，旧的优先补", () => {
    const db = freshDb();
    for (let i = 1; i <= 5; i++) seedDay(db, `2026-06-0${i}`);
    const { nights, deferred } = findUndigestedNights(db, {
      now: new Date("2026-06-10T12:00:00.000Z"),
      max: 3,
    });
    expect(nights).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    expect(deferred).toEqual(["2026-06-04", "2026-06-05"]);
  });

  test("无活动无欠账：空列表（digest 据此毫秒退出）", () => {
    const db = freshDb();
    const { nights, deferred } = findUndigestedNights(db, {
      now: new Date("2026-06-12T18:00:00.000Z"),
    });
    expect(nights).toEqual([]);
    expect(deferred).toEqual([]);
  });

  test("消化产物 marker 不造'幽灵夜'：只有 self_review_failed 的夜不入列，真实活动的夜照常入列", () => {
    const db = freshDb();
    // 幽灵夜 06-08：只有一条消化产物 marker（无真实活动、无 experiences）
    appendSituation(
      db,
      { sessionId: "ghost", kind: "self_review_failed", payload: { attempts: 2 } },
      frozenClock("2026-06-08T12:00:00.000Z"),
    );
    // 真实夜 06-09：一条 transcript 真实活动
    appendSituation(
      db,
      { sessionId: "real", kind: "user_message", payload: { text: "干点正事" } },
      frozenClock("2026-06-09T12:00:00.000Z"),
    );
    const { nights } = findUndigestedNights(db, { now: new Date("2026-06-11T03:00:00.000Z") });
    expect(nights).toContain("2026-06-09");
    expect(nights).not.toContain("2026-06-08");
  });
});
