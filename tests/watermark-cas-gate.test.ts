// 块② 水位线 CAS 去重闸（DESIGN-WORKER-RESUME §4.3-2，F-1 命门）。
// storeSelfReviewResult 带 advanceWatermark 时，整块写库套同一 db.transaction()，
// CAS 抢闸在最前：抢到才写自评+items+推水位线（原子）；抢不到（同段被别的写者推过）
// → 一行不写、水位线不动、返回 lostRace:true。本组坐实：
//   ① 抢到：自评落库 + 水位线推进；② 同段两写者：恰一个赢、一个 lostRace、库里恰一条增量自评；
//   ③ 首评 old=null 两写者：恰一行水位线、一条自评；④ 不同 session：互不干扰；
//   ⑤ 不传 advanceWatermark：零回归（旧行为，不碰水位线表）；⑥ 原子性：CAS 落空 → 自评/items 全回滚；
//   ⑦ 跨连接（两 Database 连同一文件 WAL）：去重仍成立。

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { openDb } from "../src/db";
import { storeSelfReviewResult, type GeneratedSelfReview, type Material } from "../src/selfReview";

const NOW = "2026-06-10T18:00:00.000Z";

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-cas-"));
  tmpDirs.push(d);
  return join(d, "anima.db");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mat(sessionId: string): Material {
  return {
    sessionId,
    project: "proj",
    conversation: ["用户：测一下并发去重"],
    events: [],
    bookmarks: [],
    evidenceText: "测一下并发去重",
  };
}
function gen(
  review = "今天在测水位线并发去重，盯着一段被两个写者抢，最后只一个落库。",
  items: { type: "preference" | "decision" | "correction" | "event"; content: string; keywords: string[] }[] = [],
): GeneratedSelfReview {
  return {
    ok: true,
    attempts: 1,
    value: { review, feeling: "", intensity: "", keywords: ["并发", "去重"], items },
  };
}
function watermark(db: Database, sid: string): { l: string } | null {
  return db.query("SELECT last_uuid l FROM review_watermark WHERE session_id=?").get(sid) as
    | { l: string }
    | null;
}
function reviewCount(db: Database, sid: string): number {
  return (
    db
      .query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=?")
      .get(sid) as { c: number }
  ).c;
}

describe("块② CAS 去重闸", () => {
  test("抢到：自评落库 + 水位线推进（首评 old=null）", () => {
    const db = openDb(tmpDbPath());
    const sid = "s1";
    const r = storeSelfReviewResult(db, gen(), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "u-100", entries: null },
    });
    expect(r.lostRace).toBeFalsy();
    expect(r.fallback).toBe(false);
    expect(reviewCount(db, sid)).toBe(1);
    expect(watermark(db, sid)?.l).toBe("u-100");
  });

  test("同段两写者：恰一个赢、第二个 lostRace 一行不写", () => {
    const db = openDb(tmpDbPath());
    const sid = "s2";
    storeSelfReviewResult(db, gen(), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "X", entries: null },
    });
    expect(reviewCount(db, sid)).toBe(1);
    // 两个写者都读到 old=X，抢着推到不同 target
    const a = storeSelfReviewResult(db, gen("A 的增量复盘文本够长够具体"), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: "X", newUuid: "T-A", entries: null },
    });
    const b = storeSelfReviewResult(db, gen("B 的增量复盘文本够长够具体"), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: "X", newUuid: "T-B", entries: null },
    });
    expect(a.lostRace).toBeFalsy();
    expect(b.lostRace).toBe(true);
    expect(reviewCount(db, sid)).toBe(2); // 首评 + A；B 没写
    expect(watermark(db, sid)?.l).toBe("T-A");
  });

  test("首评 old=null 两写者：恰一行水位线、一条自评", () => {
    const db = openDb(tmpDbPath());
    const sid = "s3";
    const a = storeSelfReviewResult(db, gen(), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "first-A", entries: null },
    });
    const b = storeSelfReviewResult(db, gen(), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "first-B", entries: null },
    });
    expect(a.lostRace).toBeFalsy();
    expect(b.lostRace).toBe(true);
    expect(reviewCount(db, sid)).toBe(1);
    expect(watermark(db, sid)?.l).toBe("first-A");
  });

  test("不同 session：互不干扰，各自成功", () => {
    const db = openDb(tmpDbPath());
    const a = storeSelfReviewResult(db, gen(), {
      material: mat("sa"),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "ua", entries: null },
    });
    const b = storeSelfReviewResult(db, gen(), {
      material: mat("sb"),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "ub", entries: null },
    });
    expect(a.lostRace).toBeFalsy();
    expect(b.lostRace).toBeFalsy();
    expect(reviewCount(db, "sa")).toBe(1);
    expect(reviewCount(db, "sb")).toBe(1);
    expect(watermark(db, "sa")?.l).toBe("ua");
    expect(watermark(db, "sb")?.l).toBe("ub");
  });

  test("不传 advanceWatermark：零回归（旧行为，不碰水位线表）", () => {
    const db = openDb(tmpDbPath());
    const sid = "s-legacy";
    const r = storeSelfReviewResult(db, gen(), { material: mat(sid), clock: frozenClock(NOW) });
    expect(r.lostRace).toBeFalsy();
    expect(reviewCount(db, sid)).toBe(1);
    expect(watermark(db, sid)).toBeNull();
  });

  test("原子性：CAS 落空 → 自评、items 全不落（整体回滚）、水位线不动", () => {
    const db = openDb(tmpDbPath());
    const sid = "s-atomic";
    storeSelfReviewResult(db, gen(), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "X", entries: null },
    });
    const before = reviewCount(db, sid);
    const withItems = gen("应当整体回滚的复盘文本够长够具体", [
      { type: "decision", content: "这条决策不该落库因为 CAS 该落空", keywords: ["回滚"] },
    ]);
    const r = storeSelfReviewResult(db, withItems, {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: "STALE-不匹配", newUuid: "T", entries: null },
    });
    expect(r.lostRace).toBe(true);
    expect(reviewCount(db, sid)).toBe(before); // 自评没多
    expect(
      (
        db
          .query("SELECT count(*) c FROM experiences WHERE kind='decision' AND source_session=?")
          .get(sid) as { c: number }
      ).c,
    ).toBe(0); // items 也没落
    expect(watermark(db, sid)?.l).toBe("X"); // 水位线没动
  });
});

describe("块② 跨连接去重（两 Database 连同一文件 WAL）", () => {
  test("两连接首评同 session：恰一行水位线、一条自评", () => {
    const path = tmpDbPath();
    const db1 = openDb(path);
    const db2 = openDb(path);
    const sid = "x-conn";
    const r1 = storeSelfReviewResult(db1, gen("连接1的复盘文本够长够具体"), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "c1", entries: null },
    });
    const r2 = storeSelfReviewResult(db2, gen("连接2的复盘文本够长够具体"), {
      material: mat(sid),
      clock: frozenClock(NOW),
      advanceWatermark: { oldUuid: null, newUuid: "c2", entries: null },
    });
    expect(r1.lostRace).toBeFalsy();
    expect(r2.lostRace).toBe(true);
    const db3 = openDb(path);
    expect(reviewCount(db3, sid)).toBe(1);
    expect(watermark(db3, sid)?.l).toBe("c1");
    db1.close();
    db2.close();
    db3.close();
  });
});
