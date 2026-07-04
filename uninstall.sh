#!/usr/bin/env bash
# anima uninstaller.
#   bash uninstall.sh           — remove hooks + nightly schedule; KEEP memories/diary/personality
#   bash uninstall.sh --purge   — remove everything, including all memories (irreversible)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$HOME/.claude/anima"
PLIST_PATH="$HOME/Library/LaunchAgents/com.anima.digest.plist"

say() { printf '\033[1;36m[anima]\033[0m %s\n' "$*"; }

# 1. stop + remove nightly schedule
if [[ -f "$PLIST_PATH" ]]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  say "nightly schedule removed."
fi

# 2. deregister hooks from ~/.claude/settings.json (backs up first)
if command -v bun >/dev/null 2>&1; then
  bun "$APP_DIR/scripts/setup-hooks.ts" remove
  say "Claude Code hooks removed."
else
  say "warning: bun not found — remove anima entries from ~/.claude/settings.json manually."
fi

# 2b. /mood skill (only if it's ours — check for the anima marker before touching)
if [[ -f "$HOME/.claude/skills/mood/SKILL.md" ]] && grep -q "anima" "$HOME/.claude/skills/mood/SKILL.md"; then
  rm -rf "$HOME/.claude/skills/mood"
  say "/mood skill removed."
fi

# 3. MCP server
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user anima >/dev/null 2>&1 || true
  say "MCP server deregistered."
fi

# 4. data
if [[ "${1:-}" == "--purge" ]]; then
  printf '\033[1;31m[anima]\033[0m This deletes ALL memories, diary and personality at %s. Type "purge" to confirm: ' "$DATA_DIR"
  read -r answer
  if [[ "$answer" == "purge" ]]; then
    rm -rf "$DATA_DIR"
    say "all data deleted."
  else
    say "purge cancelled — data kept."
  fi
else
  say "memories, diary and personality kept at $DATA_DIR"
  say "(delete them later with: bash uninstall.sh --purge)"
fi

if [[ -d "$APP_DIR" ]]; then
  say "✓ uninstalled. Code remains at $APP_DIR — delete the folder if you don't plan to come back."
else
  say "✓ uninstalled. Everything is gone — reinstall anytime with the one-line installer."
fi
