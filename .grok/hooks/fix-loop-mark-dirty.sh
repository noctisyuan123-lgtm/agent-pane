#!/usr/bin/env bash
# PostToolUse: if we edited agent-pane sources, mark session dirty for ensure-web on Stop.
set -euo pipefail

ROOT="${GROK_WORKSPACE_ROOT:-${CLAUDE_PROJECT_DIR:-}}"
INPUT="$(cat || true)"

# Only this repo
case "$ROOT/" in
  */agent-pane/*|*/agent-pane/) ;;
  *) exit 0 ;;
esac

# Prefer real tool name from envelope
TOOL="$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try:
  o=json.load(sys.stdin)
except Exception:
  o={}
print(o.get("toolName") or o.get("tool_name") or "")
' 2>/dev/null || true)"

# Edit-ish tools only (Grok + Claude aliases)
case "$TOOL" in
  search_replace|Write|Edit|MultiEdit|write|StrReplace|apply_patch) ;;
  run_terminal_command|Bash)
    # shell edits count only if they look like file mutations in-repo
    CMD="$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try:
  o=json.load(sys.stdin)
except Exception:
  o={}
ti=o.get("toolInput") or o.get("tool_input") or {}
print(ti.get("command") or "")
' 2>/dev/null || true)"
    if ! printf '%s' "$CMD" | grep -qE '(search_replace|>>|tee |sed -i|npm run build|vite|apps/web|apps/bridge)'; then
      exit 0
    fi
    ;;
  *) exit 0 ;;
esac

FLAG_DIR="${HOME}/.agent-pane"
mkdir -p "$FLAG_DIR"
FLAG="$FLAG_DIR/fix-loop-dirty"
{
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  echo "session=${GROK_SESSION_ID:-unknown}"
  echo "tool=$TOOL"
  echo "cwd=$ROOT"
} >"$FLAG"

exit 0
