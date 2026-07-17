#!/usr/bin/env bash
# Stop: after a turn that dirtied agent-pane, ensure web(+bridge) is up for 哥哥 to test.
# Does NOT reload Applications app or git push — that stays human-confirmed (skill stage ③).
set -euo pipefail

ROOT="${GROK_WORKSPACE_ROOT:-${CLAUDE_PROJECT_DIR:-}}"
case "$ROOT/" in
  */agent-pane/*|*/agent-pane/) ;;
  *) exit 0 ;;
esac

FLAG="${HOME}/.agent-pane/fix-loop-dirty"
LOG="${HOME}/.agent-pane/fix-loop-hook.log"
mkdir -p "${HOME}/.agent-pane"

log() {
  printf '[%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >>"$LOG"
}

# No edits this turn-batch → no-op
if [[ ! -f "$FLAG" ]]; then
  exit 0
fi

# Stale flag (>45 min) — ignore
if [[ "$(uname)" == "Darwin" ]]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$FLAG") ))
else
  AGE=$(( $(date +%s) - $(stat -c %Y "$FLAG") ))
fi
if (( AGE > 2700 )); then
  log "skip stale dirty flag age=${AGE}s"
  rm -f "$FLAG"
  exit 0
fi

WEB_URL="http://127.0.0.1:5173/"
BRIDGE_HEALTH="http://127.0.0.1:8787/health"
started_web=0
started_bridge=0

web_up() { curl -sf -o /dev/null --max-time 1 "$WEB_URL" 2>/dev/null; }
bridge_up() { curl -sf -o /dev/null --max-time 1 "$BRIDGE_HEALTH" 2>/dev/null; }

# Start bridge first if needed (background, nohup)
if ! bridge_up; then
  log "starting bridge"
  (
    cd "$ROOT"
    nohup npm run dev:bridge >>"${HOME}/.agent-pane/fix-loop-bridge.log" 2>&1 &
  )
  started_bridge=1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    bridge_up && break
    sleep 0.4
  done
fi

if ! web_up; then
  log "starting web"
  (
    cd "$ROOT"
    nohup npm run dev:web >>"${HOME}/.agent-pane/fix-loop-web.log" 2>&1 &
  )
  started_web=1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    web_up && break
    sleep 0.4
  done
fi

web_ok=0
bridge_ok=0
web_up && web_ok=1
bridge_up && bridge_ok=1

log "ensure-web done web_ok=$web_ok bridge_ok=$bridge_ok started_web=$started_web started_bridge=$started_bridge"

# macOS notification (best-effort)
if command -v osascript >/dev/null 2>&1; then
  if [[ "$web_ok" -eq 1 ]]; then
    MSG="agent-pane web 可测 $WEB_URL"
    [[ "$bridge_ok" -eq 1 ]] || MSG="$MSG (bridge 还没好)"
    osascript -e "display notification \"$MSG\" with title \"agent-pane fix-loop\"" 2>/dev/null || true
  else
    osascript -e 'display notification "web 没拉起来，看 ~/.agent-pane/fix-loop-web.log" with title "agent-pane fix-loop"' 2>/dev/null || true
  fi
fi

# Keep dirty until next edit cycle is fine; clear so we don't re-spam every Stop
# only if both ok or we already attempted this batch
rm -f "$FLAG"

exit 0
