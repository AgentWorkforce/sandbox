#!/bin/sh
# Attach to chief's voice (Will's entry point). Pass "brain" as the first arg
# to reach the resident Chief directly instead. Broker starts via launchd
# (clean env — see memory/learnings.md on CLAUDE_CODE_CHILD_SESSION leaking
# into chief's PTY).
cd "$(dirname "$0")/.." || exit 1

if [ "$1" = "brain" ]; then
  TARGET=chief
  MODE="${2:-drive}"
else
  TARGET=voice
  MODE="${1:-drive}"
fi

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

has_agent() { agent-relay node agent list 2>/dev/null | grep -q "\"name\": *\"$1\""; }

spawn_agent() {
  case "$1" in
    chief)
      agent-relay node agent spawn claude --name chief --model opus \
        --task "$(node -p 'require("./teams.json").agents.find(a => a.name === "chief").task')"
      ;;
    voice)
      agent-relay node agent spawn claude --name voice --model sonnet \
        --task "$(node -p 'require("./teams.json").agents.find(a => a.name === "voice").task')"
      ;;
  esac
}

if ! has_agent "$TARGET"; then
  echo "$TARGET not spawned — spawning…"
  spawn_agent "$TARGET" || exit 1
fi

# autoSpawn (teams.json) normally brings both agents up on node start; this
# loop tolerates the case where attach races ahead of that.
i=0
until has_agent "$TARGET"; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "$TARGET did not register — check: agent-relay node agent list"; exit 1; }
  sleep 1
done

exec agent-relay node agent attach "$TARGET" --mode "$MODE"
