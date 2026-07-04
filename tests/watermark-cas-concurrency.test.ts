// 块② 真·多进程并发压测（HANDOFF 点名命门）：N 个独立 bun 进程，各开同一个 WAL 库连接，
// 同时抢同一 session 同一段水位线 CAS。不变量：无论调度怎么交错，恰一个进程赢、库里恰多一条
// 自评、水位线恰被推一次。这测的是 bun:sqlite WAL 跨进程下「同段并发只一个 CAS 成功」的真实行为
// （busy_timeout 串行化写锁 + CAS WHERE last_uuid=旧值 兜并发），不是单线程模拟。

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db";
import { storeSelfReviewResult, type GeneratedSelfReview, type Material } from "../src/selfReview";

const RACER = join(import.meta.dir, "helpers", "cas-racer.ts");
const N = 8;

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-cas-conc-"));
  tmpDirs.push(d);
  return join(d, "anima.db");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function reviewCount(db: Database, sid: string): number {
  return (
    db
      .query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=?")
      .get(sid) as { c: number }
  ).c;
}
function watermarkRows(db: Database, sid: string): number {
  return (
    db.query("SELECT count(*) c FROM review_watermark WHERE session_id=?").get(sid) as { c: number }
  ).c;
}

async function raceAll(dbPath: string, sid: string, oldUuid: string): Promise<string[]> {
  const procs = Array.from({ length: N }, (_, i) =>
    Bun.spawn(["bun", RACER, dbPath, sid, oldUuid, `t-${i}`], { stdout: "pipe", stderr: "pipe" }),
  );
  return Promise.all(
    procs.map(async (p) => {
      await p.exited;
      return (await new Response(p.stdout).text()).trim();
    }),
  );
}

describe("块② 真多进程并发压测", () => {
  test(`${N} 进程抢首评同 session：恰 1 赢、库里恰 1 条自评、恰 1 行水位线`, async () => {
    const path = tmpDbPath();
    openDb(path).close(); // 先建好 schema，避免 N 进程同时首次迁移
    const sid = "race-first";
    const outs = await raceAll(path, sid, "null");
    expect(outs.filter((o) => o === "WON").length).toBe(1);
    expect(outs.filter((o) => o === "LOST").length).toBe(N - 1);
    const db = openDb(path);
    expect(reviewCount(db, sid)).toBe(1);
    expect(watermarkRows(db, sid)).toBe(1);
    db.close();
  });

  test(`${N} 进程抢同一增量段（同 old）：恰 1 赢、恰 +1 条自评`, async () => {
    const path = tmpDbPath();
    const db0 = openDb(path);
    const sid = "race-incr";
    const seed: GeneratedSelfReview = {
      ok: true,
      attempts: 1,
      value: { review: "种子复盘文本够长够具体", feeling: "", intensity: "", keywords: ["seed"], items: [] },
    };
    const mat: Material = {
      sessionId: sid,
      project: "p",
      conversation: ["用户：种子"],
      events: [],
      bookmarks: [],
      evidenceText: "种子",
    };
    storeSelfReviewResult(db0, seed, { material: mat, advanceWatermark: { oldUuid: null, newUuid: "X", entries: null } });
    db0.close();

    const outs = await raceAll(path, sid, "X");
    expect(outs.filter((o) => o === "WON").length).toBe(1);
    const db = openDb(path);
    expect(reviewCount(db, sid)).toBe(2); // 种子 + 1 赢家
    db.close();
  });
});
