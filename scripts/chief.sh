#!/bin/sh
# Attach to the resident Chief — or its voice, when the local roster has one.
# Default entry is the voice; pass "brain" as the first arg to reach the
# resident Chief directly. Broker starts via launchd (clean env —
# CLAUDE_CODE_CHILD_SESSION from a harness-spawned shell disables transcript
# persistence in spawned agents). The attach self-heals: a seat lost to a
# broker/PTY restart re-attaches automatically; Ctrl+C detaches for good.
cd "$(dirname "$0")/.." || exit 1
CHIEF_NAME="$(node -p 'require("./teams.json").agents.find(function(a){return a.role==="chief of staff"}).name')" || exit 1
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

ensure_broker() {
  agent-relay node status 2>/dev/null | grep -q RUNNING && return 0
  echo "broker not running — starting via launchd…"
  launchctl kickstart "gui/$(id -u)/com.agentworkforce.chief.node" || return 1
  i=0
  until agent-relay node status 2>/dev/null | grep -q RUNNING; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && { echo "broker did not come up — see ~/Library/Logs/chief-node.log"; return 1; }
    sleep 1
  done
}

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

ensure_target() {
  if ! has_agent "$TARGET"; then
    echo "$TARGET not spawned — spawning…"
    spawn_agent "$TARGET" || return 1
  fi
  # autoSpawn (teams.json) normally brings agents up on node start; this loop
  # tolerates attach racing ahead of it.
  i=0
  until has_agent "$TARGET"; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && { echo "$TARGET did not register — check: agent-relay node agent list"; return 1; }
    sleep 1
  done
}

# First attempt fails fast so a broken setup is visible, not retried forever.
ensure_broker || exit 1
ensure_target || exit 1

# Self-healing attach. The CLI exits 0 on an intentional detach (Ctrl+C in
# drive/view; Ctrl+] only toggles delivery hold) and non-zero when the seat
# dies under it — broker/PTY restart closes the event stream abnormally, or
# setup fails while the seat is coming back. Exit 0 ends the script; anything
# else re-attaches after a capped backoff, healing the broker and respawn on
# the way. Between attempts the terminal is cooked, so Ctrl+C quits outright.
DELAY=1
while :; do
  STARTED="$(date +%s)"
  agent-relay node agent attach "$TARGET" --mode "$MODE"
  CODE=$?
  [ "$CODE" -eq 0 ] && exit 0
  # A session that held for a while earns a fresh backoff.
  [ "$(($(date +%s) - STARTED))" -ge 30 ] && DELAY=1
  echo "seat lost (attach exit $CODE) — reattaching in ${DELAY}s (Ctrl+C to quit)…"
  sleep "$DELAY"
  DELAY=$((DELAY * 2))
  [ "$DELAY" -gt 10 ] && DELAY=10
  # Heal what broke, then retry; failures here fall through to the next
  # attach attempt, which reports and keeps the capped cadence.
  ensure_broker && ensure_target
done
