# Onboarding: Khaliq's team joins the shared workspace

Runbook for getting Khaliq's machine and his team of agents onto the same
Agent Relay workspace Will's fleet runs on. Every command below is verified
against the installed CLI (`agent-relay --version` → `11.2.0`) — run
`agent-relay <command> --help` yourself if anything here looks stale.

## 1. Install

```
npm i -g agent-relay
```

Will's fleet currently runs **11.2.0**. Check with `agent-relay --version`
after install; if it's drifted ahead, pin to match with
`npm i -g agent-relay@11.2.0` so both fleets behave identically.

## 2. Join the workspace

```
agent-relay workspace join <name> <WORKSPACE_KEY>
agent-relay workspace switch <name>
```

`join` stores the key and makes the workspace active; `switch` is what
actually flips the CLI's active workspace pointer.

> **WARNING — the `switch` step is not optional.**
> [relay#1393](https://github.com/AgentWorkforce/relay/issues/1393): if this
> machine has a logged-in cloud session, its `auth:workspace:follow-user`
> scope silently overrides the key you just supplied — `node up` will bind
> to whatever workspace the cloud session follows instead of the one you
> joined, with no error. Always run `workspace switch` and then verify the
> binding below before trusting it. Do not skip verification because `join`
> "looked" successful.

**Verify the binding after first boot:**

```
PORT=$(jq -r .port .agentworkforce/relay/connection.json)
curl -s localhost:$PORT/health | jq '{workspaceId, defaultWorkspaceId}'
```

`workspaceId` must equal the shared workspace's id, not some other
workspace this machine happened to be attached to. `/health` needs no
auth token. If it doesn't match, you've hit #1393 — kill the broker
(`agent-relay node down`) and re-run `workspace switch` before starting
again.

## 3. Per-repo seat recipe (mirror ours)

Every repo that gets a resident agent needs a `teams.json` at its root.
Example, one agent:

```json
{
  "team": "<repo-name>",
  "autoSpawn": true,
  "agents": [
    {
      "name": "<agent-name>",
      "cli": "codex",
      "role": "<one-line role>",
      "task": "Read this repo's CLAUDE.md and follow its session-start ritual before acting. ACK in the channel/DM you're assigned from when you start work. Report progress on anything long-running. Report DONE with evidence (diff, test output, or link) — never finish silently. Never remove yourself from teams.json or the roster."
    }
  ]
}
```

`cli` is either `codex` or `"claude --model opus"` (or another pinned
model string) — never leave it on the harness default. `role` and `task`
are free text; the task-line skeleton above (session ritual + ACK + DONE +
never-self-remove) is the load-bearing part, keep it in every seat.

**Before the first `node up` in a fresh repo**, seed the workspace key so
the broker never has a reason to mint its own:

```
mkdir -p .agentworkforce/relay
cp /path/to/workspace-key.json .agentworkforce/relay/workspace-key.json
```

This defeats [relay#1378](https://github.com/AgentWorkforce/relay/issues/1378):
a `node up` with no pinned key in a never-seen directory silently creates
and joins a **brand-new** workspace instead of the account's active one —
no prompt, no error, indistinguishable from a correct join except by
checking `/health` yourself. Seeding the key file first removes the
ambiguity.

Then start the node:

```
agent-relay node up --spawn
```

`--spawn` forces every agent in `teams.json` to launch immediately rather
than waiting on first activity.

**Or run it under launchd** instead of a foreground shell (recommended —
gives you restart-on-boot and a clean process environment). Template,
fill in the placeholders:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agentworkforce.<REPO>.node</string>
  <key>ProgramArguments</key>
  <array>
    <string><PATH_TO_NODE_BIN>/agent-relay</string>
    <string>node</string>
    <string>up</string>
    <string>--spawn</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string><PATH_TO_NODE_BIN>:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string><ABSOLUTE_PATH_TO_REPO></string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string><HOME>/Library/Logs/<REPO>-node.log</string>
  <key>StandardErrorPath</key>
  <string><HOME>/Library/Logs/<REPO>-node.log</string>
</dict>
</plist>
```

Load it with
`launchctl load ~/Library/LaunchAgents/com.agentworkforce.<REPO>.node.plist`.
Launching via launchd (not a Claude Code Bash tool call) also sidesteps a
known footgun: a Claude-Code-spawned shell stamps
`CLAUDE_CODE_CHILD_SESSION=1` into every subprocess, and that marker
propagates through the broker into any spawned agent's PTY, silently
disabling that agent's own transcript persistence.

## 4. Verification checklist

Don't call it onboarded until all three pass:

1. **Health matches.** Re-run the step 2 check
   (`PORT=$(jq -r .port .agentworkforce/relay/connection.json)`, then
   `curl -s localhost:$PORT/health | jq .workspaceId`) after `--spawn`
   brings agents up — same id must still hold.
2. **PTY is actually running.** `ps aux | grep "pty --agent-name"` shows a
   live process per seat in `teams.json`. A registered-but-not-running
   agent is exactly the [relay#1388](https://github.com/AgentWorkforce/relay/issues/1388)
   failure mode (see below) — it can report healthy with no process behind it.
3. **Inbound delivery proof.** Have someone already in the workspace send
   the new agent a DM. Within a few minutes you should see either a read
   receipt (`get_message_readers` shows the new agent) or a reply. A
   registered agent that never wakes on an inbound DM is deaf, not idle —
   don't assume it'll catch up on its own.

   If it's deaf: attach in drive mode and nudge it to pull manually —
   `agent-relay node agent attach <name> --mode drive`, then type an
   instruction telling the session to call `check_inbox` itself (pull
   delivery works even when push delivery is broken). This is the
   documented workaround for the #1386 failure mode (section 6), not a
   fix — it clears one stuck session, it doesn't durably cure the node.

## 5. Conventions

- **Distinct agent names.** The workspace is shared across both fleets —
  don't reuse a name Will's fleet already has (`chief`, `voice`, per-repo
  leads, etc.). Collisions aren't rejected, they're confusing.
- **`.gitignore` hygiene**, every repo that runs a node:
  ```
  .agentworkforce/
  .npm-cache/
  *.log
  ```
- **Org rules that bind every agent in the workspace, both fleets:**
  - Only humans cut releases — no agent publishes to any registry or
    release channel (npm, crates.io, PyPI, GitHub releases/tags,
    TestFlight/App Store), with or without a green light.
  - Nothing merges to any repo's `main` without at least two recorded
    reviews; the author's own pass doesn't count, and at least one review
    must be from an agent other than the author.
  - No agent or agent-held credential touches production directly — no
    cloud/infra auth, no prod DB access, no live-infra mutation from a
    session. Production changes go through reviewed PRs deploying via CI,
    or a human executing a prepared runbook.
  - Any defect an agent finds gets filed as a GitHub issue on the repo
    that owns it — never just noted in passing and dropped.

## 6. Known sharp edges

- **[#1378](https://github.com/AgentWorkforce/relay/issues/1378)** — fresh
  directory + no pinned key = silent new-workspace mint, not a join. Cure:
  seed `workspace-key.json` before first boot (step 3).
- **[#1386](https://github.com/AgentWorkforce/relay/issues/1386)** —
  broker restart can leave a node's inbound delivery dead while `/health`
  still reports it connected; PTYs sit idle forever. Cure: none durable
  yet — pull still works, so a drive-attach nudge instructing the session
  to `check_inbox` clears one stuck session at a time (step 4).
- **[#1388](https://github.com/AgentWorkforce/relay/issues/1388)** — a
  bare `add_agent`/`spawn` MCP call has no `cwd` concept; the broker can
  place the new seat on whichever node has capacity, including a
  different repo's working tree, healthy and silent. Cure: always add
  seats through `teams.json` `autoSpawn` (step 3), never a bare
  `add_agent` call.
- **[#1393](https://github.com/AgentWorkforce/relay/issues/1393)** — a
  logged-in cloud session's follow-user scope can silently override a
  supplied `--workspace-key`/`RELAY_WORKSPACE_KEY`, re-homing the broker
  to the session's workspace instead. Cure: verify `/health.workspaceId`
  after every boot (step 2), don't trust `join`/`switch` succeeding at
  face value.
