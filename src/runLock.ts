// 后台任务运行闸门：全局互斥锁 + 冷却窗口 + pid/status/log 落盘
// 事故教训（2026-06-12）：digest 曾被 SessionStart hook nohup 拉起并递归调 claude -p，
// 导致开会话即满负载且退出前台也停不掉。此后所有 digest 启动必须过这道闸门。
//
// 锁实现（R5 修复，AUDIT-2026-07-03）：互斥的**真身是内核 flock(2)**，不再靠手搓 pid 文件锁。
// 进程一死内核自动放锁——一刀消灭旧手搓锁的整类 bug：① 死锁回收的 TOCTOU（无条件 rmSync 会删掉别人刚建的
// 活锁）② PID 复用（被复用的死 pid 让 isPidAlive 恒 true→任务永久拉不起）③ 状态文件裸写撕裂读。
// 锁文件（*.lock）**常驻不删**（flock 绑在打开它的 fd 上，close 即放锁；删文件反会引入 flock+unlink 竞态），
// pid/status/last-start 只作观测/冷却用途，权威「在不在跑」一律问内核（isRunLockActive）。
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dlopen, FFIType, read } from "bun:ffi";
import { join } from "node:path";
import { localDate } from "./tz";

// flock(2) 操作常量（BSD/Linux 通用值）：独占 / 释放 / 非阻塞。
const LOCK_EX = 2;
const LOCK_UN = 8;
const LOCK_NB = 4;

// EWOULDBLOCK(=EAGAIN)：非阻塞 flock 撞上已被别人持有的锁时的 errno。用来把「真被活进程持锁」跟
// 「flock 机制本身出故障（EBADF/ENOLCK/EOPNOTSUPP/文件系统不支持…）」区分开——前者是正常「已在跑」，
// 后者必须 loud，绝不能静默当成「已在跑」（那样 digest 会永久拉不起且无人察觉）。darwin=35，Linux=11。
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

/** flock 非阻塞取锁失败的分类：errno===EWOULDBLOCK ⇒ 确被活进程持锁；其它 errno ⇒ 机制故障（须 loud）。 */
export function isFlockContended(errno: number): boolean {
  return errno === EWOULDBLOCK;
}

// 惰性 dlopen 内核 flock + errno 定位函数并缓存符号（同一批 dlopen 解析，见 flockErrno 说明）。
// 非取锁路径（readRunStatus/appendRunLog/taskRunPaths 等）不触发它，万一本机拿不到 flock，那些纯文件
// 操作仍可用；真正取锁时若拿不到会 loud 抛（宁可崩也别静默无锁在跑）。
let flockFn: ((fd: number, op: number) => number) | null = null;
let errnoLocFn: (() => number | bigint) | null = null;
function loadFlockSyms(): void {
  if (flockFn) return;
  // macOS 走 libSystem；其余（Linux）走 libc.so.6。本项目 launchd 跑在 macOS 本地盘（flock 对本地盘可靠）。
  // errno 是线程局部量，经 __error()(macOS) / __errno_location()(glibc) 返回的指针访问。
  const libName = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  const errnoSym = process.platform === "darwin" ? "__error" : "__errno_location";
  const { symbols } = dlopen(libName, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoSym]: { args: [], returns: FFIType.ptr },
  });
  flockFn = symbols.flock as (fd: number, op: number) => number;
  errnoLocFn = symbols[errnoSym] as () => number | bigint;
}
function flock(fd: number, op: number): number {
  loadFlockSyms();
  return flockFn!(fd, op);
}
/**
 * 读线程局部 errno——**只在 flock 刚返回 -1 后紧接调用才有意义**。errno 定位符号与 flock 同批 dlopen
 * 预解析，故本调用只是直呼已缓存的 __error/__errno_location + 一次内存读，不再触发 dlopen，
 * 不会在读到之前把刚才那次 flock 的 errno clobber 掉。
 */
function flockErrno(): number {
  loadFlockSyms();
  return read.i32(errnoLocFn!() as number, 0);
}

// 本进程当前持有的锁 fd：lockPath → fd。flock 绑在 fd 上，进程存活期间必须一直开着；releaseRunLock 关它即放锁。
const heldFds = new Map<string, number>();

/**
 * 原子写：先写同目录 tmp 再 renameSync 覆盖目标（rename 在同一文件系统内原子）。
 * 消除裸 writeFileSync 的「先 truncate 到 0、再写」撕裂读窗口——并发读者要么读到旧全量、要么读到新全量，绝不半截。
 */
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

export interface RunPaths {
  /** 任务名（digest / worker / ...）：锁错误文案与各路径文件名都按它派生，两任务互不撞锁 */
  taskName: string;
  runDir: string;
  logDir: string;
  lockPath: string;
  pidPath: string;
  statusPath: string;
  lastStartPath: string;
  logPath: string;
  /** worker 唤醒信号文件（touch mtime，永不删；digest 不用） */
  wakePath: string;
  /** 当前 LLM 子进程 pid 落盘（worker 精杀用；digest 不用） */
  childPidPath: string;
}

export interface RunStatus {
  pid: number;
  /** digest 用（消化哪一夜）；worker 无此概念，可省 */
  night?: string;
  status: "running" | "done" | "failed" | "stopped" | "idle_exit" | "shutting_down";
  startedAt: string;
  finishedAt?: string;
  detail?: unknown;
}

/**
 * 通用任务运行路径集合（run/ 放锁与状态，logs/ 放日志，目录就地补齐）。
 * 按 taskName 派生文件名，让 digest 与 worker 在同一 run/ 目录下各持独立锁/状态/日志，互不撞锁
 * （§5.2：worker 绝不复用 digestPaths，否则与 02:00 梦游抢同一把锁）。
 */
export function taskRunPaths(dataDir: string, taskName: string, now: Date): RunPaths {
  const runDir = join(dataDir, "run");
  const logDir = join(dataDir, "logs");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  return {
    taskName,
    runDir,
    logDir,
    lockPath: join(runDir, `${taskName}.lock`),
    pidPath: join(runDir, `${taskName}.pid`),
    statusPath: join(runDir, `${taskName}.status.json`),
    lastStartPath: join(runDir, `${taskName}.last-start`),
    logPath: join(logDir, `${taskName}-${localDate(now)}.log`),
    wakePath: join(runDir, `${taskName}.wake`),
    childPidPath: join(runDir, `${taskName}.child.pid`),
  };
}

/** digest 专用路径（= taskRunPaths(dataDir,"digest",now) 的薄封装，行为不变） */
export function digestPaths(dataDir: string, now: Date): RunPaths {
  return taskRunPaths(dataDir, "digest", now);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0 只探活不发信号
    return true;
  } catch {
    return false;
  }
}

export type AcquireResult = { ok: true } | { ok: false; reason: string };

/**
 * 取锁顺序：冷却检查 → 打开常驻锁文件 → **内核 flock 独占（非阻塞）**。
 * 拿到锁即记录本次启动时间（冷却窗口从"启动"算，不是"结束"——防快速失败后立刻重启风暴）。
 * 无手搓死锁回收：死进程的 flock 由内核自动释放，后来者直接 flock 成功即接管——TOCTOU/陈尸锁/PID复用整类消失。
 */
export function acquireRunLock(
  paths: RunPaths,
  opts: { cooldownMinutes: number; force?: boolean; now?: Date } = { cooldownMinutes: 30 },
): AcquireResult {
  const now = opts.now ?? new Date();

  if (!opts.force && existsSync(paths.lastStartPath)) {
    const last = Date.parse(readFileSync(paths.lastStartPath, "utf8").trim());
    if (!Number.isNaN(last)) {
      const elapsedMin = (now.getTime() - last) / 60_000;
      if (elapsedMin >= 0 && elapsedMin < opts.cooldownMinutes) {
        return {
          ok: false,
          reason: `冷却中：距上次启动 ${elapsedMin.toFixed(1)} 分钟 < ${opts.cooldownMinutes} 分钟（--force 可跳过）`,
        };
      }
    }
  }

  // 打开常驻锁文件（O_RDWR|O_CREAT，存在则复用、不截断、不 append，配合下面 ftruncate+定位写覆盖内容）。
  // O_CLOEXEC：Bun 1.3.13 的 constants.O_CLOEXEC 为 undefined，`?? 0` 兜底成空转（今天不改变行为）；
  // 一旦将来某个 Bun 补齐该常量即自动生效——子进程 exec 时内核自动关掉锁 fd，杜绝继承泄漏。
  // 现状仍安全：实测 Bun.spawn 不继承 stdio 之外的 fd，故这把锁 fd 不会漏给 worker/digest spawn 的 claude
  // 子进程，「进程一死内核自动放锁」成立。（若将来换到会继承 fd 的 spawn 路径，本 O_CLOEXEC 即成主防线。）
  // 类型侧 fs.constants 未声明 O_CLOEXEC（平台相关），故 as 收口再 `?? 0` 兜底。
  const O_CLOEXEC = (fsConstants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
  let fd: number;
  try {
    fd = openSync(paths.lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT | O_CLOEXEC, 0o644);
  } catch (e) {
    return { ok: false, reason: `锁文件打开失败：${(e as Error).message}` };
  }

  // 内核独占非阻塞加锁。rc!==0 时按 errno 区分：EWOULDBLOCK=确被活进程持有（死进程内核早自动放了，不会
  // 误报陈尸）；其它 errno=flock 机制本身故障——绝不静默当「已在跑」（那样任务永久拉不起且无人知），loud 抛。
  const rc = flock(fd, LOCK_EX | LOCK_NB);
  if (rc !== 0) {
    const errno = flockErrno();
    closeSync(fd);
    if (!isFlockContended(errno)) {
      throw new Error(
        `flock 取锁失败且非撞锁（errno=${errno}，非 EWOULDBLOCK）：互斥机制异常，拒绝在无锁保护下启动 ${paths.taskName}`,
      );
    }
    let holder = NaN;
    try {
      holder = (JSON.parse(readFileSync(paths.lockPath, "utf8")) as { pid: number }).pid;
    } catch {
      // 锁文件内容读不出仅影响文案，不影响判定（判定已由 flock 定死）
    }
    return { ok: false, reason: `已有 ${paths.taskName} 在跑（pid ${holder}），本次退出` };
  }

  // 拿到锁：fd 必须留活（close 即放锁），登记进 heldFds 供 releaseRunLock 关闭。
  // 锁文件写入 pid+startedAt 仅供观测/撞锁文案；用 ftruncate+定位写覆盖旧持有者残留内容。
  heldFds.set(paths.lockPath, fd);
  try {
    ftruncateSync(fd, 0);
    const buf = Buffer.from(JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }), "utf8");
    writeSync(fd, buf, 0, buf.length, 0);
  } catch {
    // 写锁文件内容失败不致命：锁已到手，观测内容缺失不影响互斥
  }
  // pid/last-start 落盘失败时**不能直接抛**：此刻锁已到手、fd 已进 heldFds，若异常穿出，调用方以为取锁
  // 失败却不知本进程仍持锁 → 锁 fd 永久泄漏（本进程再也起不来、也没人放）。故显式放锁再以失败返回，
  // 守住「ok:false ⇒ 不持锁」不变量（R5 codex 复审：fd 泄漏）。
  try {
    atomicWrite(paths.pidPath, String(process.pid));
    atomicWrite(paths.lastStartPath, now.toISOString());
  } catch (e) {
    heldFds.delete(paths.lockPath);
    try {
      closeSync(fd); // close 即释放 flock
    } catch {
      // fd 已无效也无妨，目标就是让它不再持锁
    }
    try {
      rmSync(paths.pidPath, { force: true }); // 清掉可能半写的 pid 观测文件（force 吞 ENOENT）
    } catch {
      // 清理失败不影响「已放锁」这个关键结论
    }
    return { ok: false, reason: `锁元数据落盘失败：${(e as Error).message}` };
  }
  return { ok: true };
}

/**
 * 放锁：关掉持锁 fd（= 释放 flock），清掉 pid 观测文件。**锁文件本身常驻不删**（避免 flock+unlink 竞态：
 * 若删了文件，两个后来者可能各在不同 inode 上各 flock 成功→双持）。可幂等重复调用（digest 有多处 early-exit + finally）。
 */
export function releaseRunLock(paths: RunPaths): void {
  const fd = heldFds.get(paths.lockPath);
  if (fd !== undefined) {
    try {
      flock(fd, LOCK_UN);
    } catch {
      // 即便显式 UN 失败，下面 close 也会彻底放锁
    }
    try {
      closeSync(fd);
    } catch {
      // fd 已被关/无效：无所谓，目标就是让它不再持锁
    }
    heldFds.delete(paths.lockPath);
  }
  rmSync(paths.pidPath, { force: true });
}

/**
 * 权威「任务在不在跑」判据：尝试对锁文件非阻塞 flock——能拿到=没有活进程持锁（自己不在则立即放回），拿不到=有活进程持锁。
 * 全程问内核，不比对 pid 整数，故对 PID 复用免疫（旧手搓锁的死穴）。锁文件不存在=从没跑过=false。
 * 注意：本进程自己持锁时探测也会得 -1（同进程不同 fd 亦互斥）→ 返回 true（正确：本进程确实在跑）。
 */
export function isRunLockActive(paths: RunPaths): boolean {
  let fd: number;
  try {
    fd = openSync(paths.lockPath, "r"); // 只读探测，不存在则 ENOENT
  } catch {
    return false; // 锁文件不存在 → 没在跑
  }
  try {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
      flock(fd, LOCK_UN); // 探测成功=没人持锁；立即放回，别把这把探测锁留着
      return false;
    }
    // flock 非 0：按 errno 区分。EWOULDBLOCK=真被活进程持有；其它 errno=flock 机制故障——不能默默
    // 返回 true（会让 workerctl/digestctl/heal-now 误判"永远在跑"、永远停不下也拉不起），loud 抛。
    const errno = flockErrno();
    if (!isFlockContended(errno)) {
      throw new Error(`flock 探测失败且非撞锁（errno=${errno}，非 EWOULDBLOCK）：无法判定 ${paths.taskName} 运行状态`);
    }
    return true; // EWOULDBLOCK = 被活进程持有
  } finally {
    closeSync(fd);
  }
}

export function writeRunStatus(paths: RunPaths, status: RunStatus): void {
  // 原子写：消除并发 readRunStatus 撞上"truncate 到 0 尚未写完"的撕裂读（会误判无状态、废掉 worker 退出 F5 补位）。
  atomicWrite(paths.statusPath, JSON.stringify(status, null, 2) + "\n");
}

export function readRunStatus(paths: RunPaths): RunStatus | null {
  if (!existsSync(paths.statusPath)) return null;
  try {
    return JSON.parse(readFileSync(paths.statusPath, "utf8")) as RunStatus;
  } catch {
    return null;
  }
}

export function appendRunLog(paths: RunPaths, line: string, now?: Date): void {
  const ts = (now ?? new Date()).toISOString();
  appendFileSync(paths.logPath, `[${ts}] ${line}\n`, "utf8");
}
