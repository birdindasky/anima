// Phase 0 骨架与数据层 — T0.1~T0.5（见 tests/TEST-PLAN.md）
// 规矩：独立临时数据目录、frozen clock、绝不碰真实 ~/.claude/anima/

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frozenClock } from "../src/clock";
import { resolveConfig } from "../src/config";
import { initDataDir } from "../src/dataDir";
import { openDb } from "../src/db";
import {
  getExperience,
  insertExperience,
  invalidateExperience,
  searchExperiences,
} from "../src/experiences";
import {
  getHookAlerts,
  getHookHealth,
  recordHookFailure,
  recordHookSuccess,
} from "../src/hookHealth";
import { appendSituation, listSituations } from "../src/situation";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-06-10T09:00:00.000Z";

describe("T0.0 数据目录初始化与路径配置化", () => {
  test("initDataDir 创建全套文件，重复调用不覆盖已有内容", () => {
    const dir = tmpDir();
    const config = resolveConfig({ dataDir: join(dir, "anima-home") });

    // 路径配置化：所有派生路径都落在指定 dataDir 下（发布接缝）
    expect(config.dbPath.startsWith(config.dataDir)).toBe(true);
    expect(config.personalityPath.startsWith(config.dataDir)).toBe(true);
    expect(config.diaryDir.startsWith(config.dataDir)).toBe(true);
    expect(config.badgePath.startsWith(config.dataDir)).toBe(true);

    initDataDir(config);
    expect(existsSync(config.dataDir)).toBe(true);
    expect(existsSync(config.diaryDir)).toBe(true);
    expect(existsSync(config.personalityPath)).toBe(true);
    expect(existsSync(config.badgePath)).toBe(true);

    // 再跑一次：personality.md 内容不被覆盖（人格不由插件重置）
    const before = readFileSync(config.personalityPath, "utf8");
    initDataDir(config);
    expect(readFileSync(config.personalityPath, "utf8")).toBe(before);
  });
});

describe("T0.1 经历写读往返", () => {
  test("写入一条带情绪烙印的经历，读回逐字段相等", () => {
    const db = openDb(join(tmpDir(), "anima.db"));
    const clock = frozenClock(NOW);

    const input = {
      kind: "bookmark",
      project: "acme-app",
      content: "权限回归测试连挂三次后终于定位到 mock 没复位",
      feeling: "又烦又松一口气，最后那下挺爽的",
      intensity: "挺强烈，磨了快三个小时",
      keywords: ["权限", "mock", "回归测试"],
      sourceSession: "sess-001",
      occurredAt: "2026-06-10T08:30:00.000Z",
      validAt: "2026-06-10T08:30:00.000Z",
    };
    const written = insertExperience(db, input, clock);
    const read = getExperience(db, written.id);

    expect(read).not.toBeNull();
    expect(read!.kind).toBe(input.kind);
    expect(read!.project).toBe(input.project);
    expect(read!.content).toBe(input.content);
    expect(read!.feeling).toBe(input.feeling);
    expect(read!.intensity).toBe(input.intensity);
    expect(read!.keywords).toEqual(input.keywords);
    expect(read!.sourceSession).toBe(input.sourceSession);
    expect(read!.occurredAt).toBe(input.occurredAt);
    expect(read!.validAt).toBe(input.validAt);
    // bi-temporal：created_at 来自注入时钟；尚未失效
    expect(read!.createdAt).toBe(NOW);
    expect(read!.expiredAt).toBeNull();
    expect(read!.invalidAt).toBeNull();
    expect(read!.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("T0.2 中文召回（trigram，Codex 审计最疼那条）", () => {
  test("权限测试/权限 mock 命中，支付不命中", () => {
    const db = openDb(join(tmpDir(), "anima.db"));
    const clock = frozenClock(NOW);

    const target = insertExperience(
      db,
      { kind: "event", content: "昨晚卡在权限回归测试的 mock 上" },
      clock,
    );
    // 干扰项：不该被以下任何查询命中
    insertExperience(db, { kind: "event", content: "部署流程改成了蓝绿发布" }, clock);
    insertExperience(db, { kind: "event", content: "给日报站点换了暖白配色" }, clock);

    const hit1 = searchExperiences(db, "权限测试");
    expect(hit1.map((r) => r.uuid)).toContain(target.uuid);
    expect(hit1.length).toBe(1);

    const hit2 = searchExperiences(db, "权限 mock");
    expect(hit2.map((r) => r.uuid)).toContain(target.uuid);
    expect(hit2.length).toBe(1);

    expect(searchExperiences(db, "支付")).toHaveLength(0);
  });
});

describe("T0.3 bi-temporal 失效语义", () => {
  test("矛盾偏好失效不删除：默认只见新，带历史 flag 能见旧", () => {
    const db = openDb(join(tmpDir(), "anima.db"));
    const clock = frozenClock(NOW);

    const prefA = insertExperience(
      db,
      { kind: "event", content: "用户偏好深色主题的界面" },
      clock,
    );
    const prefB = insertExperience(
      db,
      { kind: "event", content: "用户改主意了，现在偏好浅色主题的界面" },
      clock,
    );
    invalidateExperience(db, prefA.id, clock);

    // 默认查询：只返回 B
    const live = searchExperiences(db, "主题");
    expect(live.map((r) => r.uuid)).toEqual([prefB.uuid]);

    // 带历史 flag：A 仍可见（失效不删除）
    const all = searchExperiences(db, "主题", { includeHistory: true });
    expect(all.map((r) => r.uuid).sort()).toEqual([prefA.uuid, prefB.uuid].sort());

    // A 的失效时间戳被记录，原文未动
    const a = getExperience(db, prefA.id);
    expect(a!.invalidAt).toBe(NOW);
    expect(a!.expiredAt).toBe(NOW);
    expect(a!.content).toBe("用户偏好深色主题的界面");
  });
});

describe("T0.4 并发追加不丢（WAL）", () => {
  test("两个进程各写 50 条流水 → 恰好 100 条，库无损坏", async () => {
    const dbPath = join(tmpDir(), "anima.db");
    openDb(dbPath); // 预建 schema，让两个写进程跳过建表竞争

    const writer = join(import.meta.dir, "helpers", "concurrent-writer.ts");
    const spawnWriter = (tag: string) =>
      Bun.spawn(["bun", writer, dbPath, "50", tag], { stdout: "pipe", stderr: "pipe" });
    const p1 = spawnWriter("proc-A");
    const p2 = spawnWriter("proc-B");
    const [c1, c2] = await Promise.all([p1.exited, p2.exited]);
    if (c1 !== 0) console.error(await new Response(p1.stderr).text());
    if (c2 !== 0) console.error(await new Response(p2.stderr).text());
    expect(c1).toBe(0);
    expect(c2).toBe(0);

    const db = openDb(dbPath);
    const rows = listSituations(db);
    expect(rows.length).toBe(100);
    expect(rows.filter((r) => r.sessionId === "proc-A").length).toBe(50);
    expect(rows.filter((r) => r.sessionId === "proc-B").length).toBe(50);

    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    expect((db.query("PRAGMA integrity_check").get() as any).integrity_check).toBe("ok");
  });
});

describe("T0.5 hook 失败连败计数器", () => {
  test("连挂 3 次报警；挂 2 次后成功 1 次归零无报警", () => {
    const db = openDb(join(tmpDir(), "anima.db"));
    const clock = frozenClock(NOW);

    // 场景一：连挂 3 次 → 报警
    let r = recordHookFailure(db, "SessionEnd", { error: "timeout", clock });
    expect(r.alerted).toBe(false);
    r = recordHookFailure(db, "SessionEnd", { error: "timeout", clock });
    expect(r.alerted).toBe(false);
    expect(getHookAlerts(db)).toHaveLength(0);
    r = recordHookFailure(db, "SessionEnd", { error: "timeout", clock });
    expect(r.failures).toBe(3);
    expect(r.alerted).toBe(true);
    expect(getHookAlerts(db).map((a) => a.hookName)).toEqual(["SessionEnd"]);

    // 场景二：挂 2 次后成功 → 计数归零、无报警
    recordHookFailure(db, "PostToolUse", { error: "ENOENT", clock });
    recordHookFailure(db, "PostToolUse", { error: "ENOENT", clock });
    recordHookSuccess(db, "PostToolUse");
    expect(getHookHealth(db, "PostToolUse")!.failures).toBe(0);
    expect(getHookAlerts(db).map((a) => a.hookName)).toEqual(["SessionEnd"]);
  });
});
