#!/bin/sh
# Attach to the resident Chief — or its voice, when the local roster has one.
# Default entry is the voice; pass "brain" as the first arg to reach the
# resident Chief directly. Broker starts via launchd (clean env —
# CLAUDE_CODE_CHILD_SESSION from a harness-spawned shell disables transcript
# persistence in spawned agents).
cd "$(dirname "$0")/.." || exit 1
CHIEF_NAME="$(node -p 'require("./chief.config.json").agent.name')" || exit 1
HAS_VOICE="$(node -p '(require("./teams.json").agents||[]).some(a=>a.name==="voice")?"1":""' 2>/dev/null)"

if [ "$1" = "brain" ]; then
  TARGET="$CHIEF_NAME"
  MODE="${2:-drive}"
elif [ -n "$HAS_VOICE" ]; then
  TARGET=voice
  MODE="${1:-drive}"
else
  TARGET="$CHIEF_NAME"
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

has_agent() {
  agent-relay node agent list 2>/dev/null | AGENT_NAME="$1" node -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => text += chunk);
    process.stdin.on("end", () => {
      try {
        const body = JSON.parse(text);
        const agents = Array.isArray(body) ? body : (body.agents || []);
        process.exit(agents.some(agent => agent.name === process.env.AGENT_NAME) ? 0 : 1);
      } catch {
        process.exit(text.includes(`"name": "${process.env.AGENT_NAME}"`) ? 0 : 1);
      }
    });
  '
}

spawn_agent() {
  TASK="$(AGENT_NAME="$1" node -p 'require("./teams.json").agents.find(a => a.name === process.env.AGENT_NAME).task')" || return 1
  MODEL="$(AGENT_NAME="$1" node -p '((require("./teams.json").agents.find(a => a.name === process.env.AGENT_NAME).cli || "").match(/--model (\S+)/) || [])[1] || ""')"
  if [ -n "$MODEL" ]; then
    agent-relay node agent spawn claude --name "$1" --model "$MODEL" --task "$TASK"
  else
    agent-relay node agent spawn claude --name "$1" --task "$TASK"
  fi
}

if ! has_agent "$TARGET"; then
  echo "$TARGET not spawned — spawning…"
  spawn_agent "$TARGET" || exit 1
fi

# autoSpawn (teams.json) normally brings agents up on node start; this loop
# tolerates attach racing ahead of it.
i=0
until has_agent "$TARGET"; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "$TARGET did not register — check: agent-relay node agent list"; exit 1; }
  sleep 1
done

exec agent-relay node agent attach "$TARGET" --mode "$MODE"
