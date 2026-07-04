// 运行闸门测试：互斥锁 / 陈尸锁接管 / 冷却窗口 / --force
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunLock,
  appendRunLog,
  digestPaths,
  isFlockContended,
  isPidAlive,
  isRunLockActive,
  readRunStatus,
  releaseRunLock,
  writeRunStatus,
} from "../src/runLock";

let dataDir: string;
const NOW = new Date("2026-06-12T10:00:00.000Z");

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "anima-runlock-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  test("首次取锁成功，落 lock/pid/last-start 三件套", () => {
    const paths = digestPaths(dataDir, NOW);
    const r = acquireRunLock(paths, { cooldownMinutes: 30, now: NOW });
    expect(r.ok).toBe(true);
    expect(existsSync(paths.lockPath)).toBe(true);
    expect(readFileSync(paths.pidPath, "utf8")).toBe(String(process.pid));
    expect(readFileSync(paths.lastStartPath, "utf8")).toBe(NOW.toISOString());
  });

  test("持有者存活时第二次取锁被拒", () => {
    const paths = digestPaths(dataDir, NOW);
    expect(acquireRunLock(paths, { cooldownMinutes: 0, now: NOW }).ok).toBe(true);
    // 冷却设 0 排除冷却干扰，纯测互斥
    const r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("已有 digest 在跑");
  });

  test("持有者已死（陈尸锁）→ 自动接管", () => {
    const paths = digestPaths(dataDir, NOW);
    writeFileSync(
      paths.lockPath,
      JSON.stringify({ pid: 99999999, startedAt: NOW.toISOString() }),
    );
    const r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    expect(r.ok).toBe(true);
  });

  test("锁文件损坏 → 视为陈尸锁接管", () => {
    const paths = digestPaths(dataDir, NOW);
    writeFileSync(paths.lockPath, "not-json");
    const r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    expect(r.ok).toBe(true);
  });

  test("冷却窗口内被拒，--force 可破", () => {
    const paths = digestPaths(dataDir, NOW);
    expect(acquireRunLock(paths, { cooldownMinutes: 30, now: NOW }).ok).toBe(true);
    releaseRunLock(paths);

    const tenMinLater = new Date(NOW.getTime() + 10 * 60_000);
    const cold = acquireRunLock(paths, { cooldownMinutes: 30, now: tenMinLater });
    expect(cold.ok).toBe(false);
    if (!cold.ok) expect(cold.reason).toContain("冷却中");

    const forced = acquireRunLock(paths, { cooldownMinutes: 30, force: true, now: tenMinLater });
    expect(forced.ok).toBe(true);
    releaseRunLock(paths);

    const past = new Date(NOW.getTime() + 90 * 60_000);
    // force 那次也刷新了 last-start（tenMinLater），90 分钟后已出窗
    expect(acquireRunLock(paths, { cooldownMinutes: 30, now: past }).ok).toBe(true);
  });
});

describe("status / log / pid", () => {
  test("writeRunStatus / readRunStatus round-trip", () => {
    const paths = digestPaths(dataDir, NOW);
    writeRunStatus(paths, {
      pid: process.pid,
      night: "2026-06-11",
      status: "running",
      startedAt: NOW.toISOString(),
    });
    const s = readRunStatus(paths);
    expect(s?.status).toBe("running");
    expect(s?.night).toBe("2026-06-11");
  });

  test("appendRunLog 带时间戳追加", () => {
    const paths = digestPaths(dataDir, NOW);
    appendRunLog(paths, "第一行", NOW);
    appendRunLog(paths, "第二行", NOW);
    const content = readFileSync(paths.logPath, "utf8");
    expect(content).toContain(`[${NOW.toISOString()}] 第一行`);
    expect(content.trim().split("\n").length).toBe(2);
  });

  test("isPidAlive：自己活着，不存在的 pid 死", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(99999999)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  test("releaseRunLock 放锁（fd close）+ 清 pid，锁文件常驻、status 留查、锁可再取", () => {
    const paths = digestPaths(dataDir, NOW);
    acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    writeRunStatus(paths, {
      pid: process.pid,
      night: "2026-06-11",
      status: "done",
      startedAt: NOW.toISOString(),
    });
    releaseRunLock(paths);
    // 锁文件常驻不删（避免 flock+unlink 竞态）；pid 提示清掉；status 留着供查询。
    expect(existsSync(paths.lockPath)).toBe(true);
    expect(existsSync(paths.pidPath)).toBe(false);
    expect(readRunStatus(paths)?.status).toBe("done");
    // 关键：flock 已真正释放 → 同进程能立刻再取到（若 close 没放锁，这里会拿不到）。
    const again = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    expect(again.ok).toBe(true);
    releaseRunLock(paths);
  });
});

// R5（AUDIT-2026-07-03）：手搓 pid 锁 → 内核 flock。以下三条盯死修掉的三类 bug。
describe("R5 flock 锁语义", () => {
  const FIXDIR = join(import.meta.dir, "fixtures");

  test("PID 复用不永久锁死：锁文件残留一个活着的（无关）pid，但没人真持 flock → 照样取得到", () => {
    const paths = digestPaths(dataDir, NOW);
    // 模拟：崩溃 worker 的死 pid 被系统复用给一个无关活进程。锁文件里记着这个 pid（活），但真正的
    // flock 早随崩溃进程被内核释放。旧手搓锁会 isPidAlive(holder)=true → 永久判"已在跑"、任务再也起不来。
    writeFileSync(
      paths.lockPath,
      JSON.stringify({ pid: process.pid, startedAt: NOW.toISOString() }), // 本测试进程=活着的无关 pid
    );
    const r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    expect(r.ok).toBe(true); // 内核 flock 是空的 → 取得到，不被复用 pid 卡死
    releaseRunLock(paths);
  });

  test("isRunLockActive：无锁文件=false；死进程残留锁文件（未持 flock）=false；本进程持锁=true", () => {
    const paths = digestPaths(dataDir, NOW);
    expect(isRunLockActive(paths)).toBe(false); // 从没跑过
    writeFileSync(paths.lockPath, JSON.stringify({ pid: 99999999, startedAt: NOW.toISOString() }));
    expect(isRunLockActive(paths)).toBe(false); // 残留文件但没人 flock → 不算在跑
    acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    expect(isRunLockActive(paths)).toBe(true); // 本进程真持锁
    releaseRunLock(paths);
    expect(isRunLockActive(paths)).toBe(false); // 放锁后回到 false
  });

  test("两回收者交错不双持锁：残留陈尸锁 + N 个进程并发抢 → 恰好 1 个拿到", async () => {
    const paths = digestPaths(dataDir, NOW);
    // 预置一把陈尸锁文件（内容随便，关键是没人持 flock），模拟"崩溃后一堆回收者同时来抢"。
    writeFileSync(paths.lockPath, JSON.stringify({ pid: 99999999, startedAt: NOW.toISOString() }));
    const fixture = join(FIXDIR, "runlock-acquire.ts");
    const N = 6;
    const HOLD = 1200; // 赢家持锁 1.2s，保证同伴都落在持锁窗口内撞锁
    const procs = Array.from({ length: N }, () =>
      Bun.spawn(["bun", fixture, dataDir, "digest", String(HOLD)], { stdout: "pipe", stderr: "pipe" }),
    );
    const outs = await Promise.all(
      procs.map(async (p) => {
        await p.exited;
        return (await new Response(p.stdout).text()).trim();
      }),
    );
    const oks = outs.filter((o) => {
      try {
        return JSON.parse(o).ok === true;
      } catch {
        return false;
      }
    });
    expect(oks.length).toBe(1); // 内核 flock 仲裁：并发抢锁恰好一个赢，绝不双持
  }, 20_000);

  test("状态撕裂读被原子写消除：并发读者在密集 writeRunStatus 下零 parse 失败", async () => {
    const paths = digestPaths(dataDir, NOW);
    // 先落一份完整 status，让读者一开始就有得读。
    writeRunStatus(paths, { pid: process.pid, status: "running", startedAt: NOW.toISOString() });
    const reader = Bun.spawn(
      ["bun", join(FIXDIR, "runlock-status-reader.ts"), dataDir, "digest", "900"],
      { stdout: "pipe", stderr: "pipe" },
    );
    // 读者跑的这段时间里疯狂重写 status（大小交替，放大裸 truncate 的撕裂窗口）。
    const end = Date.now() + 800;
    let i = 0;
    while (Date.now() < end) {
      writeRunStatus(paths, {
        pid: process.pid,
        night: "x".repeat((i % 40) * 20), // 长度抖动
        status: i % 2 ? "running" : "done",
        startedAt: NOW.toISOString(),
        detail: { n: i },
      });
      i++;
    }
    await reader.exited;
    const out = JSON.parse((await new Response(reader.stdout).text()).trim()) as { reads: number; failures: number };
    expect(out.reads).toBeGreaterThan(0); // 读者确实读到了
    expect(out.failures).toBe(0); // 原子 rename → 永远读到完整 JSON，零撕裂
  }, 20_000);
});

// R5 codex 复审（AUDIT-2026-07-03）：flock 迁移的三处收尾——① 元数据落盘失败不泄漏锁 fd
// ② flock 非 0 按 errno 区分真撞锁(EWOULDBLOCK)与机制故障 ③ digestctl 停法不删锁文件。
describe("R5 codex 复审收尾", () => {
  test("errno 分支：EWOULDBLOCK=确被活进程持锁；其它 errno=flock 机制故障（须 loud）", () => {
    const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
    expect(isFlockContended(EWOULDBLOCK)).toBe(true); // 真撞锁
    expect(isFlockContended(9)).toBe(false); // EBADF：不是撞锁，是坏 fd
    expect(isFlockContended(77)).toBe(false); // ENOLCK 一类：机制故障
    expect(isFlockContended(0)).toBe(false); // 0 不该被当撞锁
  });

  test("元数据落盘失败不泄漏锁 fd：pid/last-start 写失败 → 放锁并以 ok:false 返回（非抛出/非泄漏）", () => {
    const paths = digestPaths(dataDir, NOW);
    // 预置锁文件（存在→O_RDWR 打开只需文件写权限，不需目录写权限），再把 run 目录设只读：
    // 取锁与 flock 都成功，但随后 atomicWrite(pidPath) 要在只读目录里建 tmp 文件 → EACCES 抛。
    writeFileSync(paths.lockPath, "");
    chmodSync(paths.runDir, 0o555);
    let r: { ok: boolean };
    try {
      r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    } finally {
      chmodSync(paths.runDir, 0o755); // 恢复，afterEach 才删得掉
    }
    expect(r.ok).toBe(false); // 落盘失败 → 干净失败返回，不把异常抛给调用方
    // 关键：失败路径必须已放锁（close fd）。若泄漏了 fd，同进程再取锁会被自己残留的 flock 挡住
    //（flock 绑在打开描述上，同进程不同 fd 也互斥）。这里能再取到 = 上一把确实放了。
    const again = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
    expect(again.ok).toBe(true);
    releaseRunLock(paths);
  });
});

describe("R5-digestctl 停法（迁到 flock 常驻锁模型）", () => {
  const DIGESTCTL = join(import.meta.dir, "..", "scripts", "digestctl.ts");

  test("无 digest 在跑时 stop：清 pid 残留、**绝不删 .lock 锁文件**、退出 0", async () => {
    const paths = digestPaths(dataDir, NOW);
    // 残留一把陈尸锁文件（无人持 flock）+ 残留 pid 文件，模拟崩溃后手动 stop。
    writeFileSync(paths.lockPath, JSON.stringify({ pid: 99999999, startedAt: NOW.toISOString() }));
    writeFileSync(paths.pidPath, "99999999");
    const proc = Bun.spawn(["bun", DIGESTCTL, "stop"], {
      env: { ...process.env, ANIMA_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    // 核心不变量：锁文件常驻不删（删了会开 flock+unlink 竞态 → 双持锁后门）。
    expect(existsSync(paths.lockPath)).toBe(true);
    // pid 残留清掉。
    expect(existsSync(paths.pidPath)).toBe(false);
  }, 20_000);

  test("status：无活锁时 alive=false（不再把常驻锁文件的存在误当在跑）", async () => {
    const paths = digestPaths(dataDir, NOW);
    writeFileSync(paths.lockPath, JSON.stringify({ pid: 99999999, startedAt: NOW.toISOString() }));
    const proc = Bun.spawn(["bun", DIGESTCTL, "status"], {
      env: { ...process.env, ANIMA_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const out = JSON.parse((await new Response(proc.stdout).text()).trim()) as { alive: boolean };
    expect(out.alive).toBe(false); // 残留锁文件但无人持 flock → 不算在跑
  }, 20_000);
});
