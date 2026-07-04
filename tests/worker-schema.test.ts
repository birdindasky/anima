// v5 worker schema —— work_queue（队列）+ review_watermark（复盘水位线）；附加迁移、幂等、唯一约束
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, SCHEMA_VERSION } from "../src/db";

const tmpDirs: string[] = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), "anima-wq-"));
  tmpDirs.push(d);
  return openDb(join(d, "anima.db"));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("v5 worker schema", () => {
  test("schema 版本升到 8", () => {
    const db = tmpDb();
    const row = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    expect(SCHEMA_VERSION).toBe(8);
    expect(row.value).toBe("8");
  });

  test("work_queue 表存在且列正确", () => {
    const db = tmpDb();
    const cols = (db.query("PRAGMA table_info(work_queue)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.sort()).toEqual(
      ["attempts", "enqueued_at", "kind", "session_id", "status", "target_uuid", "transcript_path"].sort(),
    );
  });

  test("review_watermark 表存在且列正确", () => {
    const db = tmpDb();
    const cols = (db.query("PRAGMA table_info(review_watermark)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.sort()).toEqual(["last_uuid", "session_id", "updated_at"]);
  });

  test("work_queue 主键 (session_id, kind)：同会话同种类只一行，ON CONFLICT 可 upsert", () => {
    const db = tmpDb();
    const ins = `INSERT INTO work_queue(session_id, kind, transcript_path, status, target_uuid, attempts, enqueued_at)
      VALUES('s1','self_review','/p','pending','u1',0,'t0')
      ON CONFLICT(session_id, kind) DO UPDATE SET target_uuid=excluded.target_uuid, status='pending'`;
    db.exec(ins);
    db.exec(ins.replace("'u1'", "'u2'")); // 同 (s1,self_review) 再来一次 = upsert，不新增行
    const rows = db.query("SELECT target_uuid FROM work_queue WHERE session_id='s1' AND kind='self_review'").all() as { target_uuid: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].target_uuid).toBe("u2"); // upsert 更到最新 target
  });

  test("review_watermark 主键 session_id：CAS 推进 + 重复主键被挡", () => {
    const db = tmpDb();
    db.exec("INSERT INTO review_watermark(session_id, last_uuid, updated_at) VALUES('s1','w0','t0')");
    // CAS：WHERE last_uuid=w0 命中 → 推进
    const adv = db.query("UPDATE review_watermark SET last_uuid='w1', updated_at='t1' WHERE session_id='s1' AND last_uuid='w0'").run();
    expect(adv.changes).toBe(1);
    // CAS 旧值已变 → 落空
    const lost = db.query("UPDATE review_watermark SET last_uuid='w2', updated_at='t2' WHERE session_id='s1' AND last_uuid='w0'").run();
    expect(lost.changes).toBe(0);
    // 首评并发：重复主键 INSERT 抛错（可 catch）
    expect(() => db.exec("INSERT INTO review_watermark(session_id, last_uuid, updated_at) VALUES('s1','x','t')")).toThrow();
  });

  test("迁移幂等：重复开同一库不报错、数据保留", () => {
    const d = mkdtempSync(join(tmpdir(), "anima-wq-"));
    tmpDirs.push(d);
    const path = join(d, "anima.db");
    const db1 = openDb(path);
    db1.exec("INSERT INTO review_watermark(session_id, last_uuid, updated_at) VALUES('keep','u','t')");
    db1.close();
    const db2 = openDb(path); // 再开 = migrate 幂等
    const got = db2.query("SELECT last_uuid FROM review_watermark WHERE session_id='keep'").get() as { last_uuid: string };
    expect(got.last_uuid).toBe("u");
  });
});
