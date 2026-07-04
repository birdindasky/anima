// worker 守护进程端到端烟雾测试（DESIGN-WORKER §5 + §8 断环烟雾测试）。真起 bun scripts/worker.ts 子进程，
// 用桩 claude（ANIMA_CLAUDE_BIN，不烧真 LLM）+ 临时库（ANIMA_DATA_DIR）跑通整条链路。坐实：
//   ① 端到端：enqueue → worker 取活 → 桩 LLM → 写自评 + 推水位线 + 队列 done → idle 自退；
//   ② 递归隔离：worker spawn 的 claude env **带 ANIMA_HEADLESS=1**（万一隔离参数失效，子 claude 的 hook 哨兵秒退）；
//   ③ 哨兵：worker 进程自身带 ANIMA_HEADLESS=1 启动 → 立即 exit、绝不动队列；
//   ④ 单例锁：worker.lock 被活 pid 持有 → 第二个 worker 取锁失败立即退、不动队列。

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db";
import { enqueueReview } from "../src/workQueue";
import { acquireRunLock, isPidAlive, readRunStatus, releaseRunLock, taskRunPaths } from "../src/runLock";

const WORKER_SCRIPT = join(import.meta.dir, "..", "scripts", "worker.ts");
const WORKERCTL_SCRIPT = join(import.meta.dir, "..", "scripts", "workerctl.ts");

const tmpDirs: string[] = [];
function setup(): { dataDir: string; dbPath: string; stub: string; envOut: string } {
  const root = mkdtempSync(join(tmpdir(), "anima-daemon-"));
  tmpDirs.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "anima.db");
  // 桩 claude：忽略 args、漏掉 stdin、输出合法自评 JSON；把自己的 ANIMA_HEADLESS 写到 envOut 供断言。
  const stub = join(root, "stub-claude.sh");
  const envOut = join(root, "stub-env.json");
  writeFileSync(
    stub,
    `#!/bin/sh
if [ -n "$ANIMA_STUB_ENV_OUT" ]; then printf '{"ANIMA_HEADLESS":"%s"}' "$ANIMA_HEADLESS" > "$ANIMA_STUB_ENV_OUT"; fi
cat > /dev/null
printf '{"review":"stub 增量复盘：把这段没复盘的尾巴回顾了一下，挺顺的。","feeling":"","intensity":"","keywords":["stub"],"items":[]}'
`,
    "utf8",
  );
  chmodSync(stub, 0o755);
  return { dataDir, dbPath, stub, envOut };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTranscript(dataDir: string, sid: string): string {
  const turns = [
    { uuid: "u1", ts: "2026-06-10T01:00:00.000Z", role: "user", text: "把权限回归测试修好。" },
    { uuid: "u2", ts: "2026-06-10T01:05:00.000Z", role: "assistant", text: "好，先看鉴权 mock。" },
    { uuid: "u3", ts: "2026-06-10T01:10:00.000Z", role: "user", text: "配色先别改，等我确认。" },
  ];
  const lines = turns.map((t) =>
    JSON.stringify({ uuid: t.uuid, parentUuid: null, isSidechain: false, sessionId: sid, timestamp: t.ts, cwd: "/proj", type: t.role, isMeta: false, message: { role: t.role, content: t.text } }),
  );
  const p = join(dataDir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

async function runWorkerProc(env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const proc = Bun.spawn(["bun", WORKER_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  await proc.exited;
  return { code: proc.exitCode, out: (await new Response(proc.stdout).text()).trim(), err: (await new Response(proc.stderr).text()).trim() };
}

function selfReviewCount(dbPath: string, sid: string): number {
  const db = openDb(dbPath);
  const c = (db.query("SELECT count(*) c FROM experiences WHERE kind='self_review' AND source_session=?").get(sid) as { c: number }).c;
  db.close();
  return c;
}
function qStatus(dbPath: string, sid: string): string | undefined {
  const db = openDb(dbPath);
  const r = (db.query("SELECT status s FROM work_queue WHERE session_id=? AND kind='self_review'").get(sid) as { s: string } | null)?.s;
  db.close();
  return r;
}

describe("worker 守护进程端到端烟雾", () => {
  test("① 端到端：enqueue → 桩 LLM 复盘 → 写自评 + 队列 done；② spawn 的 claude env 带 ANIMA_HEADLESS=1", async () => {
    const { dataDir, dbPath, stub, envOut } = setup();
    const path = writeTranscript(dataDir, "s1");
    const db = openDb(dbPath);
    enqueueReview(db, { sessionId: "s1", transcriptPath: path, targetUuid: "u3" });
    db.close();

    const r = await runWorkerProc({
      ANIMA_DATA_DIR: dataDir,
      ANIMA_CLAUDE_BIN: stub,
      ANIMA_STUB_ENV_OUT: envOut,
      ANIMA_WORKER_IDLE_MS: "0",
      ANIMA_WORKER_POLL_MS: "0",
    });
    expect(r.code).toBe(0);
    expect(selfReviewCount(dbPath, "s1")).toBe(1); // 端到端写出自评
    expect(qStatus(dbPath, "s1")).toBe("done");
    // 递归隔离：worker 经 claudeCli spawn 的桩 claude，其 env 必带 ANIMA_HEADLESS=1
    expect(existsSync(envOut)).toBe(true);
    expect(JSON.parse(readFileSync(envOut, "utf8")).ANIMA_HEADLESS).toBe("1");
  }, 30_000);

  test("③ 哨兵：worker 自身带 ANIMA_HEADLESS=1 → 立即退、不动队列", async () => {
    const { dataDir, dbPath, stub } = setup();
    const path = writeTranscript(dataDir, "s1");
    const db = openDb(dbPath);
    enqueueReview(db, { sessionId: "s1", transcriptPath: path, targetUuid: "u3" });
    db.close();

    const r = await runWorkerProc({
      ANIMA_DATA_DIR: dataDir,
      ANIMA_CLAUDE_BIN: stub,
      ANIMA_HEADLESS: "1", // 哨兵该秒退
      ANIMA_WORKER_IDLE_MS: "0",
      ANIMA_WORKER_POLL_MS: "0",
    });
    expect(r.code).toBe(0);
    expect(selfReviewCount(dbPath, "s1")).toBe(0); // 没干活
    expect(qStatus(dbPath, "s1")).toBe("pending"); // 队列没动
  }, 15_000);

  test("④ 单例锁：worker 锁被活进程 flock 持有 → 第二个 worker 取锁失败立即退、不动队列", async () => {
    const { dataDir, dbPath, stub } = setup();
    const path = writeTranscript(dataDir, "s1");
    const db = openDb(dbPath);
    enqueueReview(db, { sessionId: "s1", transcriptPath: path, targetUuid: "u3" });
    db.close();
    // 预占锁：本测试进程真持一把内核 flock（跨进程对子 worker 生效——不再靠"写个 pid 文件"假装持锁）。
    const paths = taskRunPaths(dataDir, "worker", new Date());
    expect(acquireRunLock(paths, { cooldownMinutes: 0 }).ok).toBe(true);
    try {
      const r = await runWorkerProc({
        ANIMA_DATA_DIR: dataDir,
        ANIMA_CLAUDE_BIN: stub,
        ANIMA_WORKER_IDLE_MS: "0",
        ANIMA_WORKER_POLL_MS: "0",
      });
      expect(r.code).toBe(0);
      expect(r.out).toContain("lock_failed");
      expect(selfReviewCount(dbPath, "s1")).toBe(0); // 第二个 worker 零副作用
      expect(qStatus(dbPath, "s1")).toBe("pending");
    } finally {
      releaseRunLock(paths);
    }
  }, 15_000);

  test("workerctl stop：SIGTERM 优雅停 idle worker → 进程退、status=stopped、pid 清理", async () => {
    const { dataDir, stub } = setup();
    // 空队列 + 大 idle → worker 起来后 idle-poll，不自退，等 workerctl 停
    const worker = Bun.spawn(["bun", WORKER_SCRIPT], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, ANIMA_DATA_DIR: dataDir, ANIMA_CLAUDE_BIN: stub, ANIMA_WORKER_IDLE_MS: "60000", ANIMA_WORKER_POLL_MS: "150" },
    });
    const paths = taskRunPaths(dataDir, "worker", new Date());
    // 等 worker 取锁起来（pid 文件出现且活）
    const startDeadline = Date.now() + 8000;
    while (Date.now() < startDeadline) {
      const s = readRunStatus(paths);
      if (s?.pid && isPidAlive(s.pid)) break;
      await Bun.sleep(100);
    }
    expect(readRunStatus(paths)?.status).toBe("running");

    // workerctl stop
    const ctl = Bun.spawn(["bun", WORKERCTL_SCRIPT, "stop"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ANIMA_DATA_DIR: dataDir },
    });
    await ctl.exited;
    await worker.exited; // worker 应已被 SIGTERM 优雅退出

    expect(worker.exitCode).toBe(0);
    expect(existsSync(paths.pidPath)).toBe(false); // pid 清理
    expect(["stopped", "idle_exit"]).toContain(readRunStatus(paths)?.status); // 终态（stopped；极快 idle 也可能 idle_exit）
  }, 20_000);
});
