// 自省探针注册表（Phase 1 / 影子模式）。验收点：C1 封闭名单、C2 PARK-on-miss、读的是真源。
import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openDb } from "../src/db";
import { INTROSPECT_KEYS, probe, probeAll, type IntrospectKey } from "../src/introspect";

let n = 0;
const freshDb = () => openDb(join(tmpdir(), `anima-ip-${Date.now()}-${n++}.db`));

describe("introspect 探针读真源", () => {
  test("schema_version 读 anima.db meta = 当前版本字符串", () => {
    const r = probe("anima.schema_version", freshDb());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("8"); // 跟 SCHEMA_VERSION 同步；改库版本时这条会红，提醒同步
  });

  test("digest_stages 含 heal —— 自愈这条腿在不在线（烧过我们的那条事实）", () => {
    const r = probe("anima.digest_stages");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.split(",")).toContain("heal");
  });

  test("selfheal.wired = 'true'（heal 在阶段表里）", () => {
    const r = probe("anima.selfheal.wired");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("true");
  });

  test("selfheal.max_attempts = '3'", () => {
    const r = probe("anima.selfheal.max_attempts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("3");
  });

  test("db.tables 列出真实表（含 experiences / review_heal）", () => {
    const r = probe("anima.db.tables", freshDb());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const tables = r.value.split(",");
      expect(tables).toContain("experiences");
      expect(tables).toContain("review_heal");
    }
  });
});

describe("C2 PARK-on-miss：读不到绝不编造", () => {
  test("DB-backed key 缺只读句柄 → ok:false，不返回任何值", () => {
    const r = probe("anima.schema_version"); // 不传 db
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("只读句柄");
  });
});

describe("C1 封闭注册表：名单外的 key 进不来", () => {
  test("点一个不在 enum 里的 key → ok:false（绝不执行、绝不新增探针）", () => {
    const r = probe("anima.__attacker_injected__" as IntrospectKey);
    expect(r.ok).toBe(false);
  });

  test("probeAll 恰好覆盖封闭名单的每一个 key（C4-R1：无跳过）", () => {
    const all = probeAll(freshDb());
    expect(all.map((r) => r.key).sort()).toEqual([...INTROSPECT_KEYS].sort());
  });
});
