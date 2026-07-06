#!/usr/bin/env bash
# anima installer — memory, emotions, and a growable personality for Claude Code.
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/birdindasky/anima/main/install.sh | bash
# Or from a local checkout:
#   bash install.sh
set -euo pipefail

REPO_URL="${ANIMA_REPO:-https://github.com/birdindasky/anima.git}"
APP_DIR="${ANIMA_APP_DIR:-$HOME/.claude/anima/app}"
PLIST_LABEL="com.anima.digest"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

say() { printf '\033[1;36m[anima]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[anima] error:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. preflight ─────────────────────────────────────────────
[[ "$(uname -s)" == "Darwin" ]] || die "anima v1 is macOS-only (the nightly digest runs on launchd). Linux support: contributions welcome."
command -v git >/dev/null 2>&1 || die "git not found."
command -v bun >/dev/null 2>&1 || die "bun not found — install it first: https://bun.sh (curl -fsSL https://bun.sh/install | bash)"
command -v claude >/dev/null 2>&1 || die "Claude Code CLI not found — anima is a Claude Code plugin: https://claude.com/claude-code"
BUN_BIN="$(command -v bun)"
BUN_DIR="$(dirname "$BUN_BIN")"

# ── 2. get the code ──────────────────────────────────────────
if [[ -f "${BASH_SOURCE[0]:-}" ]] && [[ -d "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src" ]]; then
  # running from a local checkout — install in place
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  say "installing from local checkout: $APP_DIR"
elif [[ -d "$APP_DIR/.git" ]]; then
  say "existing install found — updating…"
  git -C "$APP_DIR" pull --ff-only
else
  say "cloning to $APP_DIR …"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

# ── 3. dependencies ──────────────────────────────────────────
say "installing dependencies…"
(cd "$APP_DIR" && "$BUN_BIN" install)

# ── 4. timezone config (day-boundary logic; auto-detected, override anytime) ──
"$BUN_BIN" "$APP_DIR/scripts/setup-config.ts"

# ── 5. embedding model (one-time ~400 MB download; runtime stays fully offline) ──
say "downloading the local embedding model (one-time, ~400 MB)…"
"$BUN_BIN" "$APP_DIR/scripts/fetch-model.ts" || die "model download failed — check your network and re-run install.sh"

# ── 6. register Claude Code hooks (backs up settings.json first; idempotent) ──
say "registering Claude Code hooks…"
"$BUN_BIN" "$APP_DIR/scripts/setup-hooks.ts" install "$BUN_BIN" "$APP_DIR"

# ── 6b. recall/bookmark MCP server ───────────────────────────
say "registering the anima MCP server (recall / recall_detail / bookmark)…"
claude mcp remove --scope user anima >/dev/null 2>&1 || true
claude mcp add --scope user anima -- "$BUN_BIN" --preload "$APP_DIR/src/stub-sharp.ts" "$APP_DIR/src/mcp/server.ts"

# ── 6c. /mood skill ──────────────────────────────────────────
say "installing the /mood skill…"
mkdir -p "$HOME/.claude/skills/mood"
sed "s|\${CLAUDE_PLUGIN_ROOT}|$APP_DIR|g" "$APP_DIR/skills/mood/SKILL.md" > "$HOME/.claude/skills/mood/SKILL.md"

# ── 7. nightly digest schedule (launchd) ─────────────────────
say "installing the nightly digest schedule…"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude/anima/logs"
sed -e "s|__BUN__|$BUN_BIN|g" \
    -e "s|__BUN_DIR__|$BUN_DIR|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__DATA_DIR__|$HOME/.claude/anima|g" \
    "$APP_DIR/launchd/com.anima.digest.plist.template" > "$PLIST_PATH"
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH" || die "launchctl load failed — run 'launchctl load $PLIST_PATH' manually to see why"

# ── 8. create the database, then self-check ──────────────────
say "initializing the database…"
"$BUN_BIN" "$APP_DIR/scripts/init-db.ts"
say "running self-check (whoami)…"
(cd "$APP_DIR" && "$BUN_BIN" scripts/whoami.ts) || die "self-check failed — see output above"

say ""
say "✓ installed. Your first 24 hours:"
say ""
say "  now        → open a new Claude Code session; Claude itself will tell you anima is live"
say "  all day    → sessions are captured locally (milliseconds per turn, secrets scrubbed)"
say "  ~2:00 AM   → first nightly digest: today becomes first-person memories + a diary entry"
say "  tomorrow   → sessions open with memories; try asking \"what did we do yesterday?\""
say ""
say "  mood panel:            /mood in any session (works already)"
say "  diary (from tomorrow): ~/.claude/anima/diary/"
say "  health check:          cd $APP_DIR && bun scripts/whoami.ts"
say "  uninstall:             bash $APP_DIR/uninstall.sh"
