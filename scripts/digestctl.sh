#!/bin/bash
# anima 消化任务控制台：bash digestctl.sh {status|stop|run|log}
#   status — 运行状态（走内核 flock 权威判据 isRunLockActive，对 PID 复用免疫）
#   stop   — 安全停止正在跑的 digest（SIGTERM→10s→SIGKILL；**绝不删 .lock 锁文件**）
#   run    — 手动触发一次（透传参数，如 --force 跳过冷却）
#   log    — 看最新日志尾部
#
# R5（AUDIT-2026-07-03）：status/stop 迁到 scripts/digestctl.ts，与 src/runLock.ts 的内核 flock 常驻锁
#   语义对齐。旧版按 `-f digest.lock` 判在跑 + stop 时 `rm digest.lock`，会踩爆「锁文件常驻不删」不变量
#   （删文件→flock+unlink 竞态→双持锁后门），且用 `kill -0 pid` 对 PID 复用失明。macOS 无 flock(1) 命令，
#   bash 做不了权威判据，故把 status/stop 委给 bun 端的 isRunLockActive；run/log 仍留 shell。
set -euo pipefail

DATA_DIR="${ANIMA_DATA_DIR:-$HOME/.claude/anima}"
LOG_DIR="$DATA_DIR/logs"
ANIMA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# launchd 的 PATH 常缺 /opt/homebrew/bin，裸 `bun` 找不到 → 用绝对路径（可用 ANIMA_BUN 覆盖）。
BUN="${ANIMA_BUN:-/opt/homebrew/bin/bun}"

cmd="${1:-status}"
case "$cmd" in
  status)
    echo "== anima digest status =="
    exec "$BUN" "$ANIMA_ROOT/scripts/digestctl.ts" status
    ;;
  stop)
    exec "$BUN" "$ANIMA_ROOT/scripts/digestctl.ts" stop
    ;;
  run)
    shift || true
    exec "$BUN" "$ANIMA_ROOT/scripts/digest.ts" "$@"
    ;;
  log)
    latest=$(ls -t "$LOG_DIR"/digest-*.log 2>/dev/null | head -1 || true)
    if [[ -z "${latest:-}" ]]; then echo "还没有日志"; exit 0; fi
    echo "== $latest =="
    tail -n 50 "$latest"
    ;;
  *)
    echo "用法: bash digestctl.sh {status|stop|run [--force]|log}" >&2
    exit 1
    ;;
esac
