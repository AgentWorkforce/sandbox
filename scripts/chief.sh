#!/bin/sh
# Attach to the resident Chief. If the broker isn't running, start it via the
# launchd job (clean env — never from a shell; see memory/learnings.md on
# CLAUDE_CODE_CHILD_SESSION leaking into chief's PTY).
cd "$(dirname "$0")/.." || exit 1
MODE="${1:-drive}"

if ! agent-relay node status 2>/dev/null | grep -q RUNNING; then
  echo "broker not running — starting via launchd…"
  launchctl kickstart "gui/$(id -u)/com.agentworkforce.chief.node" || exit 1
  i=0
  until agent-relay node status 2>/dev/null | grep -q RUNNING; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && { echo "broker did not come up — see ~/Library/Logs/chief-node.log"; exit 1; }
    sleep 1
  done
fi

i=0
until agent-relay node agent list 2>/dev/null | grep -q chief; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "chief agent not spawned yet (cold start can take ~1 min) — try again shortly"; exit 1; }
  sleep 1
done

exec agent-relay node agent attach chief --mode "$MODE"
