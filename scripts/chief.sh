#!/bin/sh
# Attach to the resident Chief. Broker starts via launchd (clean env — see
# memory/learnings.md on CLAUDE_CODE_CHILD_SESSION leaking into chief's PTY).
cd "$(dirname "$0")/.." || exit 1
MODE="${1:-drive}"
CHIEF_NAME="$(node -p 'require("./chief.config.json").agent.name')" || exit 1

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

has_chief() {
  agent-relay node agent list 2>/dev/null | CHIEF_NAME="$CHIEF_NAME" node -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => text += chunk);
    process.stdin.on("end", () => {
      try {
        const body = JSON.parse(text);
        const agents = Array.isArray(body) ? body : (body.agents || []);
        process.exit(agents.some(agent => agent.name === process.env.CHIEF_NAME) ? 0 : 1);
      } catch {
        process.exit(text.includes(`"name": "${process.env.CHIEF_NAME}"`) ? 0 : 1);
      }
    });
  '
}

if ! has_chief; then
  echo "$CHIEF_NAME not spawned — spawning…"
  agent-relay node agent spawn claude --name "$CHIEF_NAME" --model opus \
    --task "$(node -p 'require("./teams.json").agents[0].task')" || exit 1
fi

i=0
until has_chief; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "chief did not register — check: agent-relay node agent list"; exit 1; }
  sleep 1
done

exec agent-relay node agent attach "$CHIEF_NAME" --mode "$MODE"
