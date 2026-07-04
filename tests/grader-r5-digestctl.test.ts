// 独立盲考官对抗测试 R5-digestctl（AUDIT-2026-07-03）。
// 需求盯死四点：
//  ① stop 停进程不再删 .lock 锁文件（旧硬伤：rm digest.lock → flock+unlink 竞态 → 双持锁后门）
//  ② stop/status 与 runLock 内核 flock 常驻锁模型一致（权威判据走 isRunLockActive，不靠 kill -0/文件存在）
//  ③ 不再重新引入 TOCTOU/双持锁
//  ④ atomicWrite 抛错不泄漏锁 fd；flock 失败按 errno 区分
// 关键补洞：作者自测只覆盖"没在跑"的陈尸锁场景；本文件补齐"真有 digest 在跑"的整条 stop 语义。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunLock,
  digestPaths,
  isFlockContended,
  isPidAlive,
  isRunLockActive,
  releaseRunLock,
} from "../src/runLock";

const DIGESTCTL = join(import.meta.dir, "..", "scripts", "digestctl.ts");
const DAEMON = join(import.meta.dir, "fixtures", "grader-digest-daemon.ts");
const NOW = new Date("2026-06-12T10:00:00.000Z");

function mkDir(): string {
  return mkdtempSync(join(tmpdir(), "grader-r5-digestctl-"));
}
async function waitUntil(fn: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await Bun.sleep(30);
  }
  return fn();
}

describe("R5-digestctl：真在跑的 digest 的 stop 语义（作者未覆盖）", () => {
  test("stop 真杀掉在跑 digest + 锁文件常驻不删 + flock 真被释放（停后可再取锁）", async () => {
    const dataDir = mkDir();
    try {
      const paths = digestPaths(dataDir, NOW);
      // 起一个真持内核 flock 的 daemon（= 真在跑的 digest）。
      const daemon = Bun.spawn(["bun", DAEMON, dataDir, "digest"], { stdout: "pipe", stderr: "pipe" });
      // 等它真拿到锁：grader 进程 flock 撞锁 → isRunLockActive=true。
      const up = await waitUntil(() => isRunLockActive(paths), 8000);
      expect(up).toBe(true);
      const daemonPid = daemon.pid;
      expect(isPidAlive(daemonPid)).toBe(true);
      expect(existsSync(paths.pidPath)).toBe(true);

      // digestctl stop：应 SIGTERM daemon → daemon 优雅放锁退出。
      const stop = Bun.spawn(["bun", DIGESTCTL, "stop"], {
        env: { ...process.env, ANIMA_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      await stop.exited;
      expect(stop.exitCode).toBe(0);
      await daemon.exited;

      // ① 锁文件常驻不删（核心不变量：删了会开 flock+unlink 竞态）。
      expect(existsSync(paths.lockPath)).toBe(true);
      // pid 观测文件清掉。
      expect(existsSync(paths.pidPath)).toBe(false);
      // daemon 真死了。
      expect(isPidAlive(daemonPid)).toBe(false);
      // ② flock 真被释放：停后本进程能立刻取到锁（若锁没真放，这里会撞 EWOULDBLOCK 拿不到）。
      const again = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
      expect(again.ok).toBe(true);
      releaseRunLock(paths);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("digest 在跑期间并发 acquireRunLock 被内核 flock 挡下（真互斥，非文件存在猜测）", async () => {
    const dataDir = mkDir();
    try {
      const paths = digestPaths(dataDir, NOW);
      const daemon = Bun.spawn(["bun", DAEMON, dataDir, "digest"], { stdout: "pipe", stderr: "pipe" });
      const up = await waitUntil(() => isRunLockActive(paths), 8000);
      expect(up).toBe(true);
      // daemon 真持 flock 时，第三方取锁必须 ok:false 且文案是"已在跑"。
      const r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("已有 digest 在跑");
      // 收尾：停掉 daemon（await 完再 rmSync，避免 dir 被删后 digestctl 写 status 报 ENOENT 噪声）。
      const cleanup = Bun.spawn(["bun", DIGESTCTL, "stop"], {
        env: { ...process.env, ANIMA_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      await cleanup.exited;
      await daemon.exited;
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("R5-digestctl：陈尸锁场景 stop 不误删、不误杀", () => {
  test("残留活着的无关 pid（PID 复用）在 .lock 里，stop 不 SIGTERM 它（走 flock 判据不走 kill -0）", async () => {
    const dataDir = mkDir();
    try {
      const paths = digestPaths(dataDir, NOW);
      // 锁文件里写一个"活着但无关"的 pid（本 grader 进程），但没人真持 flock。
      // 旧法 kill -0(holder)=活 → 会 SIGTERM 这个无关进程（误杀）。新法 isRunLockActive=false → 不动它。
      writeFileSync(paths.lockPath, JSON.stringify({ pid: process.pid, startedAt: NOW.toISOString() }));
      writeFileSync(paths.pidPath, String(process.pid));
      const stop = Bun.spawn(["bun", DIGESTCTL, "stop"], {
        env: { ...process.env, ANIMA_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      await stop.exited;
      const out = (await new Response(stop.stdout).text()).trim();
      expect(stop.exitCode).toBe(0);
      expect(out).toContain("没有在跑");
      // 本 grader 进程没被误杀（还活着）。
      expect(isPidAlive(process.pid)).toBe(true);
      // 锁文件常驻不删。
      expect(existsSync(paths.lockPath)).toBe(true);
      // pid 残留清掉。
      expect(existsSync(paths.pidPath)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("R5-digestctl：errno 分支纯函数（真撞锁 vs 机制故障）", () => {
  test("只有 EWOULDBLOCK 算撞锁，其它 errno（EBADF/ENOLCK/0）一律非撞锁（须 loud）", () => {
    const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
    expect(isFlockContended(EWOULDBLOCK)).toBe(true);
    expect(isFlockContended(9)).toBe(false); // EBADF
    expect(isFlockContended(77)).toBe(false); // ENOLCK 一类
    expect(isFlockContended(0)).toBe(false);
    // 对侧平台的值不应误判本平台
    const OTHER = process.platform === "darwin" ? 11 : 35;
    expect(isFlockContended(OTHER)).toBe(false);
  });
});
