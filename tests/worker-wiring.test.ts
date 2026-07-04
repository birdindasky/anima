// worker 接线：每轮入队 enqueueReviewForStop + 懒启动决策 lazyStartWorker（注入 spawn spy，不真起进程）。
// 坐实：① 入队算对 tail uuid + sessionId；空 transcript 不入队；② worker 活→不重复 spawn；死/无→spawn 且
// env 已 delete ANIMA_HEADLESS（S4：worker 顶层进程不能带哨兵标记）。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db";
import { enqueueReviewForStop } from "../src/worker";
import { lazyStartWorker, type WorkerSpawn } from "../src/workerSpawn";
import { acquireRunLock, releaseRunLock, taskRunPaths } from "../src/runLock";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "anima-wire-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTranscript(dir: string, sid: string, uuids: string[]): string {
  const lines = uuids.map((u, i) =>
    JSON.stringify({ uuid: u, parentUuid: null, isSidechain: false, sessionId: sid, timestamp: `2026-06-10T0${i + 1}:00:00.000Z`, cwd: "/p", type: "user", isMeta: false, message: { role: "user", content: `第 ${i} 句` } }),
  );
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("enqueueReviewForStop", () => {
  test("算 tail uuid + sessionId 入队", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "s1", ["u1", "u2", "u3"]);
    enqueueReviewForStop(db, path, "s1");
    const r = db.query("SELECT session_id sid, target_uuid t, transcript_path p, status FROM work_queue WHERE kind='self_review'").get() as
      | { sid: string; t: string; p: string; status: string }
      | null;
    expect(r?.sid).toBe("s1");
    expect(r?.t).toBe("u3"); // 末条
    expect(r?.p).toBe(path);
    expect(r?.status).toBe("pending");
  });

  test("sessionId 缺省 → 从 transcript 首条取", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const path = writeTranscript(dir, "sess-from-file", ["a1", "a2"]);
    enqueueReviewForStop(db, path, null);
    const r = db.query("SELECT session_id sid, target_uuid t FROM work_queue").get() as { sid: string; t: string } | null;
    expect(r?.sid).toBe("sess-from-file");
    expect(r?.t).toBe("a2");
  });

  test("空 transcript → 不入队", () => {
    const dir = tmp();
    const db = openDb(join(dir, "anima.db"));
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    enqueueReviewForStop(db, empty, "s1");
    expect((db.query("SELECT count(*) c FROM work_queue").get() as { c: number }).c).toBe(0);
  });
});

describe("lazyStartWorker 决策", () => {
  const NOW = new Date("2026-06-10T05:00:00.000Z");

  test("worker 活（本进程真持 worker 锁）→ 不重复 spawn", () => {
    const dir = tmp();
    // 真持一把内核 flock（不再靠 pid 文件里的整数猜死活）。
    const paths = taskRunPaths(dir, "worker", NOW);
    expect(acquireRunLock(paths, { cooldownMinutes: 0, now: NOW }).ok).toBe(true);
    try {
      let spawned = 0;
      const spy: WorkerSpawn = () => { spawned++; };
      const r = lazyStartWorker({ dataDir: dir, scriptPath: "/x/worker.ts", now: NOW }, spy);
      expect(r).toBe("alive");
      expect(spawned).toBe(0);
    } finally {
      releaseRunLock(paths);
    }
  });

  test("无 worker.pid → spawn，且 env 已 delete ANIMA_HEADLESS（S4）", () => {
    const dir = tmp();
    let capturedEnv: NodeJS.ProcessEnv | null = null;
    const spy: WorkerSpawn = (_script, opts) => { capturedEnv = opts.env; };
    process.env.ANIMA_HEADLESS = "1"; // 模拟拉起方自己在 headless 环境里
    try {
      const r = lazyStartWorker({ dataDir: dir, scriptPath: "/x/worker.ts", now: NOW }, spy);
      expect(r).toBe("started");
      expect(capturedEnv).not.toBeNull();
      expect(capturedEnv!.ANIMA_HEADLESS).toBeUndefined(); // 必须 delete，否则 worker 被自己哨兵秒退
    } finally {
      delete process.env.ANIMA_HEADLESS;
    }
  });

  test("陈尸锁文件（死进程残留、无人持 flock）→ 照常 spawn（不被 PID 复用卡死）", () => {
    const dir = tmp();
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    // 残留一把陈尸锁文件：内容记着某 pid，但真正的 flock 早随崩溃进程被内核释放。旧逻辑靠 isPidAlive(pid) 猜活死，
    // 若那 pid 被复用成活进程会永久判"alive"、worker 再也拉不起；新逻辑问内核 flock（空的）→ 正确 spawn。
    writeFileSync(join(runDir, "worker.lock"), JSON.stringify({ pid: 99999999, startedAt: NOW.toISOString() }));
    let spawned = 0;
    const spy: WorkerSpawn = () => { spawned++; };
    const r = lazyStartWorker({ dataDir: dir, scriptPath: "/x/worker.ts", now: NOW }, spy);
    expect(r).toBe("started");
    expect(spawned).toBe(1);
  });
});
