---
status: done
owner: fleet-mount-lead-0811
updated: 2026-08-11
repos: [chief, relayfile]
---

## Goal

Run a live relayfile-mount on barry and finn-mini so agents placed on those nodes
can access repo content at a predictable path without requiring local git clones.
Unblocks routing real coding work off the local Mac (currently running 22+ agents).

## Now

**Both mounts running and verified syncing as of 2026-08-11 ~10:50Z.**

### barry

- **Binary**: `/opt/homebrew/lib/node_modules/agent-relay/node_modules/@relayfile/mount-darwin-arm64/bin/relayfile-mount`
- **Mount root**: `~/github/github/` (scoped layout: local-dir=`~/github`, remote-path=`/github`)
- **Repos appear at**: `~/github/github/repos/AgentWorkforce/<repo>/`
- **Creds file**: `~/.agentworkforce/relayfile/barry-fleet-mount-creds.json` (format: `{"token":"eyJ..."}`)
- **State dir**: `~/.agentworkforce/relayfile/barry-fleet-mount-state/`
- **Credential**: Minted via `POST https://agentrelay.com/cloud/api/v1/workspaces/rw_7ccfea89/relayfile/mount-session`, agentName=`barry-fleet-mount`, scopes=`["relayfile:fs:read:/github/**"]`
- **Log**: `~/.agentworkforce/relayfile/barry-fleet-mount.log`
- **Verified**: `meta.json` from `AgentWorkforce/agent-assistant` read, contains correct GitHub payload (provider=github, objectType=repository, TypeScript language). 26+ repos synced under AgentWorkforce at time of check.

**Full invocation** (do not hand-copy the token — re-mint via mount-session):
```bash
nohup /opt/homebrew/lib/node_modules/agent-relay/node_modules/@relayfile/mount-darwin-arm64/bin/relayfile-mount \
  --base-url https://file.agentrelay.com \
  --workspace rw_7ccfea89 \
  --creds-file ~/.agentworkforce/relayfile/barry-fleet-mount-creds.json \
  --local-dir ~/github \
  --local-layout scoped \
  --remote-path /github \
  --state-dir ~/.agentworkforce/relayfile/barry-fleet-mount-state \
  --mode poll \
  --interval 30s \
  --websocket=true \
  > ~/.agentworkforce/relayfile/barry-fleet-mount.log 2>&1 &
```

### finn-mini

- **Binary**: `/opt/homebrew/lib/node_modules/agentworkforce/node_modules/@relayfile/mount-darwin-arm64/bin/relayfile-mount`
- **Mount root**: `~/github/` (exact layout: local-dir=`~/github`, remote-path=`/github`)
- **Repos appear at**: `~/github/repos/AgentWorkforce/<repo>/`
- **Creds file**: `~/.agentworkforce/relayfile/finn-mini-fleet-mount-creds.json` (format: `{"token":"eyJ..."}`)
- **State dir**: `~/.agentworkforce/relayfile/finn-mini-fleet-mount-state/`
- **Credential**: Minted via mount-session, agentName=`finn-mini-fleet-mount`, same scopes
- **Log**: `~/.agentworkforce/relayfile/finn-mini-fleet-mount.log`
- **Verified**: `meta.json` from `AgentWorkforce/agent-assistant` read, matches barry's content exactly (same objectId, same payload). 10+ repos synced at time of check; bootstrap still in progress.

**Note**: finn-mini's binary (`agentworkforce` package) does NOT support `--local-layout=scoped` — use `--local-layout=exact` only. The `agent-relay` package binary on barry does support scoped.

**Full invocation** (re-mint token before use):
```bash
nohup /opt/homebrew/lib/node_modules/agentworkforce/node_modules/@relayfile/mount-darwin-arm64/bin/relayfile-mount \
  --base-url https://file.agentrelay.com \
  --workspace rw_7ccfea89 \
  --creds-file ~/.agentworkforce/relayfile/finn-mini-fleet-mount-creds.json \
  --local-dir ~/github \
  --local-layout exact \
  --remote-path /github \
  --state-dir ~/.agentworkforce/relayfile/finn-mini-fleet-mount-state \
  --mode poll \
  --interval 30s \
  --websocket=true \
  > ~/.agentworkforce/relayfile/finn-mini-fleet-mount.log 2>&1 &
```

## Auto-refresh — launchd timer (RUNNING)

**Job label**: `com.agentworkforce.relayfile-fleet-mount-refresh`
**Plist**: `~/Library/LaunchAgents/com.agentworkforce.relayfile-fleet-mount-refresh.plist`
**Script**: `~/.agentworkforce/relayfile/fleet-mount-refresh.sh`
**Schedule**: every 45 minutes (`StartInterval: 2700`), plus `RunAtLoad: true`
**Log**: `~/.agentworkforce/relayfile/fleet-mount-refresh.log`

First run at 11:14:38Z confirmed both nodes refreshed successfully (tokens extended to 12:14Z).
The script reads chief's current relayfile JWT from `chief-mount.json` (auto-refreshed by the
chief mount supervisor), calls mount-session for each node, and SSHes the new creds-file in.

To check status: `launchctl list | grep relayfile-fleet-mount`
To reload after edits: `launchctl unload ~/Library/LaunchAgents/com.agentworkforce.relayfile-fleet-mount-refresh.plist && launchctl load ...`
To stop: `launchctl unload ~/Library/LaunchAgents/com.agentworkforce.relayfile-fleet-mount-refresh.plist`

## Credential minting — manual refresh (fallback if launchd is stopped)

Mount-session tokens expire in 1 hour. The mount process reads the creds-file on every
sync interval (30s) — if the file is updated externally with a new token, it picks it up
without restart.

**Minting pattern** (run from this Mac, which has the chief relayfile JWT):
```bash
CHIEF_TOKEN=$(cat /Users/khaliqgant/Projects/AgentWorkforce/chief/.agentworkforce/relayfile/chief-mount.json | python3 -c "import sys, json; d=json.load(sys.stdin); print(d['relayfileToken'])")

# For barry:
NEW_TOKEN=$(curl -s -X POST "https://agentrelay.com/cloud/api/v1/workspaces/rw_7ccfea89/relayfile/mount-session" \
  -H "Authorization: Bearer $CHIEF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"localDir":"/tmp","remotePath":"/github","mode":"poll","agentName":"barry-fleet-mount","scopes":["relayfile:fs:read:/github/**"]}' \
  | python3 -c "import sys, json; d=json.load(sys.stdin); print(d['relayfileToken'])")
ssh barry "printf '{\"token\":\"%s\"}' '$NEW_TOKEN' > ~/.agentworkforce/relayfile/barry-fleet-mount-creds.json"

# For finn-mini (same pattern, agentName=finn-mini-fleet-mount):
NEW_TOKEN=$(curl -s ... same ... | python3 ...)
ssh finn-mini "printf '{\"token\":\"%s\"}' '$NEW_TOKEN' > ~/.agentworkforce/relayfile/finn-mini-fleet-mount-creds.json"
```

**Delivered 2026-08-11:** the launchd timer described above now runs every 45
minutes and refreshed both nodes successfully on its first run. The remaining
reboot gap is mount-process restart on each remote node; the token refresh alone
does not restart a mount after that node reboots.

## Cleanup checkpoint — 2026-08-11 15:48 CEST

This workstream remains done. `fleet-mount-lead-0811` was waiting 147 minutes
with no pending messages and was released after its commits and completion
report were harvested.

## Scope decision (from relayfile-coordination-lead-0809 analysis)

`/github/**` read-only. This gives agents on barry/finn-mini access to:
- `repos/AgentWorkforce/<repo>/` — issues, PRs, commits, checks, code (all GitHub adapter surfaces)
- `_agents/` — agent registration data
- `_index.json` — workspace index

Excluded (per security analysis from 2026-08-09):
- `/linear/**`, `/notion/**`, `/google-mail/**`, `/slack/**`, `/granola/**` — private surfaces
- Root-scoped `relayfile:fs:read:/**` — never grant to fleet nodes

## What an agent on these nodes should know

- **barry repo path**: `/Users/barry/github/github/repos/AgentWorkforce/<repo>/`
  - Check issues at `.../issues/*.json`
  - Check PRs at `.../pulls/*.json`
  - Read meta at `.../meta.json`
- **finn-mini repo path**: `/Users/khaliqgant/github/repos/AgentWorkforce/<repo>/`
  - Same structure, different prefix
- Both paths are **read-only relayfile mirrors** — write via GitHub API/CLI, not by editing these files
- Content refreshes every ~30s; bootstrap of new repos may take a few minutes

## Next

1. ~~Token refresh automation~~ — **DONE**: launchd timer running, first refresh confirmed at 11:14Z
2. **Mount-on-restart** — add launchd `.plist` entries on barry and finn-mini so their `relayfile-mount` processes survive reboots (separate from the token-refresh timer, which already persists). The refresh timer on this Mac will keep the creds-files current; the per-node launchd jobs just need to start the mount process on boot.
3. If chief-mount.json token ever expires (supervisor offline), the refresh script will log `ERROR: could not read relayfileToken` and exit non-zero — detectable in the log.

## History

- 2026-08-11 11:14Z: launchd timer live, first auto-refresh completed (barry + finn-mini tokens → 12:14Z)
- 2026-08-11 ~10:50Z: both mounts running and content verified (28 repos each, meta.json confirmed)
- 2026-08-11 ~10:30Z: Appointed by broker, read contract, searched relay history for daytona pattern
- Background: barry had no canonical repo layout (scattered clones across repos/, projects/, workspace/); finn-mini had broken zsh profile blocking agent-relay PATH; both were blocking work placement from this Mac
