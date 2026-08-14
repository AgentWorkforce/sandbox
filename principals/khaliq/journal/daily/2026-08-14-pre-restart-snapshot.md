---
date: 2026-08-14
repos: [chief, cloud, relay, relaycast, relaycast-cloud, relayfile, factory, workforce, relayauth, relayhistory]
tags: [pre-restart-audit, fleet, infrastructure]
---

# Pre-restart fleet snapshot — 2026-08-14 ~09:20 CEST

Full audit requested by Khaliq before a coordinated restart across all fleet
nodes (chief-broker, sf-mini, finn-mini, barry). Purpose: know what's running,
what would be lost, and fix what's fixable before wiping broker state.

## Why a restart is on the table

`chief-broker`'s broker process has been running continuously since **Tue Aug
11 00:36** (3+ days), with binary version drift: on-disk binary reports
11.5.4, the running process's self-advertised version is **11.5.1** (older
binary was loaded into memory and never picked up updates), and latest
published is 11.6.1. This is confirmed root cause for `agent-relay node agent
attach --node chief-broker` failing with "no terminal transport" — the loaded
binary predates `relay#1484`'s terminal-transport feature entirely.
`finn-mini` and `barry` report the same stale `11.5.1` self-advertised
version. Likely the same fix (upgrade + restart) is needed fleet-wide, not
just on chief-broker.

## Broker health per node

| Node | Status | Active agents (real PTY count) | Version (self-reported) | Notes |
|---|---|---|---|---|
| chief-broker (this laptop) | online, healthy | 43 | 11.5.1 | Hosts this Chief session. Process up since Aug 11 00:36. |
| finn-mini | online, healthy | 13 | 11.5.1 | Multiple multi-day-old sessions (some since Tue 08PM). |
| barry | online, healthy | 3 | 11.5.1 | |
| sf-mini | **broker alive but NOT visible to control plane** (`query_nodes` returns empty) despite its own `/api/status` reporting `node_connected: true`, `authenticated: true` | 1 idle + 2 freshly respawned | unknown | Real desync — broker believes it's connected, roster doesn't show it. Likely caused by last night's identity churn (see below). Needs its own investigation before trusting it in a restart plan. |

## Cleanup already done tonight/this morning (self-inflicted mess from an earlier failed Chief-relocation attempt)

Last night I attempted to relocate the Chief resident to sf-mini; it produced
an identity ping-pong (platform releases the old identity the instant a new
one registers, no negotiation) and I aborted it. In the process I left real
orphaned processes running on sf-mini uncleaned: a rogue `chief-sfm-final`
broker plus two spawned residents (`factory-lead`, `marketing-lead`) under
wrong identities. **Killed all four this morning.** Killing the orphaned
`factory-lead`/`marketing-lead` triggered what looks like the platform's own
"one supported same-name respawn" reconciliation — fresh, legitimate copies
of both immediately respawned on sf-mini's real broker (new session IDs,
new tokens, confirmed via direct process check). This appears to be normal
platform behavior for a released resident seat, not something I caused
directly — noting it because it was unexpected in the moment.

**Anomaly worth flagging**: Barry *also* has its own long-running
`factory-lead` (alive since Tue 07AM). So the same declared resident name is
now running simultaneously on both Barry and sf-mini. The "one supported
same-name respawn" protection isn't preventing duplicate spawns across
different nodes — only (maybe) within a single identity slot. Not chased
further given time — worth a real look before assuming residents are
singleton across the fleet.

## Real orphaned identities left over (junk, safe to ignore or clean up later)

`chief-sf-mini`, `chief-sfm-v2`, `chief-sfm-final` — three registration
records from last night's failed handoff attempts. Not live processes
(confirmed killed). `relay#1499` (identity-reclaim gate, still unmerged)
would be the proper mechanism to formally reclaim/retire these names if
anyone ever wants them back; otherwise they're harmless dead weight.

## Uncommitted work sweep — every checkout and worktree on this laptop

Full sweep of every repo checkout + worktree under
`~/Projects/AgentWorkforce/` for uncommitted or unpushed work. Only ONE had
anything real and unprotected:

**`factory` (shared checkout, branch `codex/222-routed-pr-babysitter-v2`) —
34 modified source files + 6 new files**, spanning CLI (`fleet.ts`), GitHub
integration (`merge-gate.ts`, `probe-closer.ts`, `routed-pr-babysitter.ts`,
`standalone-babysitter.ts`), orchestrator, dispatch templates, and state
management — real, substantial, unpushed engineering work on the Factory
system itself, on a branch with **no upstream tracking at all** (would have
been unrecoverable if this checkout were lost). **Fixed this morning**:
committed and pushed to `origin/codex/222-routed-pr-babysitter-v2`
(commit `b69c96f`, wip-labeled, not claimed reviewed/complete).

**Real secret caught by GitHub's push protection during this rescue**:
`opencode.json` (a newly-added, previously-untracked file) contained a live
`RELAY_AGENT_TOKEN`/`RELAY_API_KEY` pair for what looks like a *different*
workspace (`RELAY_BASE_URL: gateway.relaycast.dev`, workspace id
`193079805564526592` — not our own `cast.agentrelay.com` / `rw_7ccfea89`).
GitHub blocked the push. Removed the file from the commit, added it to
`.gitignore`, pushed clean. **The file still exists locally with the live
credential in it — this needs rotation.** Flagging directly per standing
operating rule: never leave a live credential unflagged once spotted.

Every other checkout with uncommitted changes (`relayfile`, `relayauth`,
`relaycast-cloud`, `cloud`, `workforce`, `relayhistory`) turned out to be
noise on inspection — `.agent-runs/` and `claude-code-native-*/` scratch
directories (agent session artifacts), `.trajectories/index.json` bookkeeping,
a build cache file (`tsconfig.tsbuildinfo`). Nothing else needed rescuing.

Isolated worktrees (not shared checkouts) with minor uncommitted diffs, lower
risk since nothing else touches them: `chief-worktrees/notion-portable-20260806`
(4 files), `cloud-worktrees/yc-chief-05-living-topology` (1 file),
`relaycast-cloud-worktrees/soc2-hole1-security-0813` (1 file),
`relayhistory-worktrees/reveal-token` (1 file). Not investigated further —
low urgency given worktree isolation, but not zero risk either.

## Full agent inventory by node (real PTY processes, persona-deploy cloud agents excluded — those are cloud-hosted, unaffected by any of these 3 physical nodes restarting)

**chief-broker (43)**: ar-1506-impl-relay, ar-1506-review-relay,
ar-2144-impl-cloud, ar-2144-review-cloud, ar-3002-impl-cloud,
ar-3002-review-cloud, ar-3021-impl-cloud, ar-3021-review-cloud,
ar-44-impl-chief, ar-44-review-chief, bridge-fleet-inventory-0813, chief
(this session), chief-app-claude-ux-v2, cloud-3011-ci-fix-0813,
cloud-3016-ci-finish-0813, cloud-3016-ci-rescue-0813,
cloud-3016-ci-review-fix-0813, cloud-3017-ci-fix-0813,
cloud-agent-metadata-write-0813, cloud-chief-display-stale-0813,
cloud-metadata-rescue-0813, cloud-org-tree-stale-0813,
disk-cleanup-triage-0813, factory-238-review-fix-0813,
factory-relaycast-gap-investigate-0814, orgchart-naming-fix-0813,
p0-mount-stale-investigate-0814, relay-1410-mcp-timeout-fix-0813,
relay-1468-review-fix-0813, relay-1497-security-fix-0813,
relay-1499-review-fix-0813, relay-1502-review-fix-0813,
relay-1502-review-fix-v2-0813, relay-inbox-delivery-fix-0813,
relaycast-326-review-fix-0813, relaycast-326-review-fix-v2-0813,
relaycast-cloud-59-review-fix-0813, relayfile-416-review-fix-0813,
roster-lag-fix-0813, roster-status-bug-0812, sf-mini-commit-rescue-0813,
sf-mini-pr-mcp-fix-0813, workforce-208-review-fix-0813.

Many of these predate this session's active tracking (compacted context) —
several appeared "offline" in the relay roster earlier tonight when checked
via `list_agents`, but their local processes are confirmed still alive here.
This matches the standing finding that registration/online-status is not a
reliable liveness signal — the roster can be wrong in both directions.

**finn-mini (13)**: relay-1504-fix-0814, factory-dispatch-fix-finn-0812,
daytona-overnight-fix-0813, mp-cred-probe-0812, chief-proof-coordinator-0811,
webhook-queue-incident-lead-0812, relay-spawn-metadata-overnight-0813,
claude-2918-signoff-finn, soc2-attestation-0813, mp-integration-proof-0813,
relayfile-backend-fix-v3-0812, fleet-attach-impl-0811,
workforce-relayflows-release-barry-0811. Several are multi-day-old (some
since Tuesday) — real accumulated context not reviewed in this session.

**barry (3)**: claude-2918-final-9b611, claude-2918-signoff-63533,
factory-lead (duplicate of sf-mini's, see anomaly above).

**sf-mini (3, post-cleanup)**: cross-repo-coordinator-0813 (idle 9+ hours,
nothing pending), factory-lead (freshly respawned this morning),
marketing-lead (freshly respawned this morning).

## What would actually be lost in an immediate full restart, honestly assessed

- **Nothing uncommitted/unprotected** — the one real gap (`factory`) is now
  pushed to a remote branch.
- **In-flight reasoning/context inside each of the ~62 live agent sessions**
  above would be lost — none of that is recoverable by a restart regardless
  of git state, since it's conversation state, not file state. Some of the
  `codex`-harness sessions run with `resume <session-id>` flags, suggesting
  they may be resumable post-restart if the session store survives — not
  verified.
- **This Chief session itself** dies the moment chief-broker restarts —
  same continuity question as last night, unresolved.
- **sf-mini's registration desync** is unexplained — restarting it blind
  might fix the desync, or might not; not root-caused.

## Not done, given time — flag before deciding

Did not individually status-check each of the ~62 live agents (many
multi-day-old, unfamiliar names from earlier in this session predating
compaction). If any is holding real unreported progress toward a goal
Khaliq cares about, a restart loses it silently. A fast targeted DM sweep
("what are you doing, is there anything uncommitted") to the unfamiliar
older names — especially `webhook-queue-incident-lead-0812` (matches the
open P0 webhook-backlog task), `fleet-attach-impl-0811`,
`workforce-relayflows-release-barry-0811`, `relayfile-backend-fix-v3-0812`,
`soc2-attestation-0813` — would close this gap before an irreversible
restart, if wanted.
