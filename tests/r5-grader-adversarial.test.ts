// R5 独立盲考官对抗测试（非作者所写）。目标：证伪导向——每条都设计成"旧手搓 pid 锁"下红、"内核 flock"下绿。
// 只 import 新旧都存在的符号，保证把 runLock.ts 换回旧版仍能加载运行（用于跑红）。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 从子进程 stdout 只读第一段 flush（= fixture 打印的 {ok} 行），**不**读到 EOF，
// 否则会一路阻塞到子进程退出（进而放锁），把"持锁窗口"读没了。
async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (value) buf += new TextDecoder().decode(value);
    if (done) break;
  }
  reader.releaseLock();
  return buf.split("\n")[0].trim();
}
import {
  acquireRunLock,
  releaseRunLock,
  taskRunPaths,
  writeRunStatus,
} from "../src/runLock";

let dataDir: string;
const NOW = new Date("2026-07-03T09:00:00.000Z");

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "r5-grader-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ── 缺陷 ①：PID 复用永久锁死（确定性） ──────────────────────────────
// 崩溃进程留下锁文件，其 pid 事后被系统复用给一个**活着的无关进程**。真正的 flock 早随崩溃被内核释放。
// 旧码：isPidAlive(holder)==true → 永远判"已在跑"，任务再也拉不起（死穴）。
// 新码：权威判定问内核 flock（此刻是空的）→ 照样取得到。
test("① PID 复用不永久锁死：锁文件残留一个活着的无关 pid，仍能取到锁", () => {
  const paths = taskRunPaths(dataDir, "digest", NOW);
  // 用本测试进程 pid 冒充"被复用的活 pid"——它必然 isPidAlive==true。
  writeFileSync(
    paths.lockPath,
    JSON.stringify({ pid: process.pid, startedAt: NOW.toISOString() }),
  );
  const r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
  expect(r.ok).toBe(true); // 旧码这里=false（被复用 pid 卡死）
  releaseRunLock(paths);
});

// ── 缺陷 ②：真跨进程互斥必须成立（守住"flock 不是空转 no-op"） ──────
// 若把互斥退化成永远放行，任何并发都双持。此测确保：持锁者真活着时，同机第二方一定拿不到。
test("② 跨进程互斥：真持锁子进程存活期间，本进程取锁被拒；子进程退出后才放行", async () => {
  const paths = taskRunPaths(dataDir, "digest", NOW);
  const fixture = join(import.meta.dir, "fixtures", "runlock-acquire.ts");
  // 子进程取锁并持有 1.5s。
  const holder = Bun.spawn(["bun", fixture, dataDir, "digest", "1500"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // 等子进程确实先拿到锁（只读首行 {ok:true}，不读到 EOF）。
  const firstLine = await readFirstLine(holder.stdout as ReadableStream<Uint8Array>);
  expect(JSON.parse(firstLine).ok).toBe(true);
  // 此刻子进程仍在持锁窗口内：本进程取锁必须失败。
  const contend = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
  expect(contend.ok).toBe(false);
  await holder.exited; // 子进程放锁退出
  const after = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
  expect(after.ok).toBe(true);
  releaseRunLock(paths);
}, 20_000);

// ── 缺陷 ③：TOCTOU 双持锁（陈尸锁 + 多回收者并发抢） ────────────────
// 旧码回收路径：撞锁→探活死→rmSync 删锁→重试 wx。多个回收者交错时，B 的 rmSync 会删掉 A 刚建的活锁，
// 造成两个都 wx 成功=双持。新码：内核 flock 仲裁，恒好 1 个赢。多轮放大命中概率。
test("③ 陈尸锁 + 12 并发回收者 → 恰好 1 个拿到，绝不双持", async () => {
  const fixture = join(import.meta.dir, "fixtures", "runlock-acquire.ts");
  const N = 12;
  const HOLD = 1500;
  // 预置陈尸锁文件：pid 用一个必死的巨值，内容合法但无人持 flock。
  const paths = taskRunPaths(dataDir, "digest", NOW);
  writeFileSync(
    paths.lockPath,
    JSON.stringify({ pid: 99999999, startedAt: NOW.toISOString() }),
  );
  const procs = Array.from({ length: N }, () =>
    Bun.spawn(["bun", fixture, dataDir, "digest", String(HOLD)], {
      stdout: "pipe",
      stderr: "pipe",
    }),
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
  expect(oks.length).toBe(1); // 旧码可能 >1（双持）
}, 30_000);

// ── 缺陷 ④：状态文件撕裂读（原子 rename 应消除半截读） ───────────────
// 旧 writeRunStatus 是裸 writeFileSync（先 truncate 到 0 再写）→ 并发读者会撞到空/半截 JSON。
// 新码 tmp+rename 原子替换 → 读者只会见到旧全量或新全量，零撕裂。
test("④ 密集写 status 下并发读者零撕裂（parse 失败恒 0）", async () => {
  const paths = taskRunPaths(dataDir, "digest", NOW);
  writeRunStatus(paths, { pid: process.pid, status: "running", startedAt: NOW.toISOString() });
  const readerFx = join(import.meta.dir, "fixtures", "runlock-status-reader.ts");
  const reader = Bun.spawn(["bun", readerFx, dataDir, "digest", "1000"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const end = Date.now() + 950;
  let i = 0;
  while (Date.now() < end) {
    writeRunStatus(paths, {
      pid: process.pid,
      night: "y".repeat((i % 50) * 30), // 大小剧烈抖动，放大 truncate 撕裂窗
      status: i % 2 ? "running" : "done",
      startedAt: NOW.toISOString(),
      detail: { seq: i },
    });
    i++;
  }
  await reader.exited;
  const out = JSON.parse((await new Response(reader.stdout).text()).trim()) as {
    reads: number;
    failures: number;
  };
  expect(out.reads).toBeGreaterThan(0);
  expect(out.failures).toBe(0); // 旧裸写这里 >0
}, 20_000);

// ── 缺陷 ⑤：崩溃（不调 release）后内核自动放锁，且不留 stale-pid 后患 ──
// 子进程取锁后被 SIGKILL（模拟崩溃，不走 releaseRunLock）→ 锁文件仍在、里面是它的 pid。
// 内核随进程死自动放锁 → 本进程随后能取到。此为 flock "进程一死自动放锁" 的正面验证。
test("⑤ 持锁子进程被 SIGKILL 崩溃后，本进程仍能接管取锁", async () => {
  const paths = taskRunPaths(dataDir, "digest", NOW);
  const fixture = join(import.meta.dir, "fixtures", "runlock-acquire.ts");
  const holder = Bun.spawn(["bun", fixture, dataDir, "digest", "10000"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const firstLine = await readFirstLine(holder.stdout as ReadableStream<Uint8Array>);
  expect(JSON.parse(firstLine).ok).toBe(true);
  holder.kill("SIGKILL"); // 崩溃：不放锁
  await holder.exited;
  // 锁文件应仍存在（常驻不删），但内核已放锁。
  const stale = JSON.parse(readFileSync(paths.lockPath, "utf8")) as { pid: number };
  expect(typeof stale.pid).toBe("number");
  const r = acquireRunLock(paths, { cooldownMinutes: 0, now: NOW });
  expect(r.ok).toBe(true); // 内核自动放锁 → 接管成功
  releaseRunLock(paths);
}, 20_000);
