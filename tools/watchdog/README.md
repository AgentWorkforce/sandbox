# Fleet liveness watchdog

The org's pager. Every 10 minutes it asks one question of each resident agent on
this machine: **is there work addressed to this resident that it has not
processed?** Suspicion is cheap and passive; proof costs one DM; only a resident
that fails to answer wakes chief.

Alert-only. It never kickstarts, restarts, or interrupts anything.

```
node tools/watchdog/fleet-watchdog.mjs               # sweep (may probe)
node tools/watchdog/fleet-watchdog.mjs --no-ping     # tier 1 only, never probes
node tools/watchdog/fleet-watchdog.mjs --dry-run     # evaluate only; no sends, state, or log writes
node tools/watchdog/fleet-watchdog.mjs --json        # machine-readable
node tools/watchdog/test-watchdog.mjs                # tier-ladder tests
```

## The tiers

| Tier | When | Cost | What it does |
|---|---|---|---|
| **1** | every 10 min, all residents | zero tokens, pure data reads | Is there unread work addressed to this resident, while its own relay activity has stopped? |
| **2** | only for a resident that tripped T1 | one DM + a bare ACK | Probe *that* resident from the `watchdog` identity and wait `RESPONSE_MINUTES` for a reply |
| **3** | probe unanswered | one DM to chief | Page with the evidence chain and "recommend kickstart" |

A resident with an empty inbox sitting idle is **healthy** — it trips nothing
and costs nothing. Probes go out only on suspicion, capped at
`MAX_PINGS_PER_SWEEP` (3) so a fleet-wide fault cannot spam every resident.

## Why an active probe, and why not a routine one

The failure this exists for: PTY alive and idle-sleeping, broker `/health`
green, node log silent, injected relay messages unprocessed for 50–75 minutes.

Broker state cannot see it. A `delivery_read_ack` fires when injected text
**echoes back on the PTY** — or simply after a 5-second timeout if no echo
appears — and the broker then clears the pending delivery and marks the worker
`Working`. Queue depth, `current_state` and `/health` all read healthy while the
model never touched the message.

Only exercising the real path proves responsiveness: injection → the session
processes it → a reply comes back. That is tier 2. Tier 1 exists so that path is
exercised on suspicion rather than on a timer, because every probe spends a few
of the resident's tokens and interrupts whatever it is doing.

## Tier 1 signals

Both are read with the workspace key against `cast.agentrelay.com`; no harness
runs and no tokens are spent.

| Signal | Source | Means |
|---|---|---|
| Unread inbound | `GET /v1/dm/conversations/all`, then `GET /v1/messages/{id}/readers` per candidate | a message addressed to the resident that it has not read |
| `last_seen` | `GET /v1/agents` | the last time *that agent's own credentials* made an authenticated API call |

**Trip:** at least one message addressed to the resident, older than
`STALE_MINUTES` and unread, **and** the resident's `last_seen` predates that
message by more than `STALE_MINUTES`.

This is precisely how today's relay hang was proven — empty `readers` on a
50-minute-old order. Both halves are needed: unread alone is noisy (receipts do
not always stick), and a stale `last_seen` alone is meaningless for an agent
that simply has nothing to do.

Scope is bounded so a trip cannot become permanent. Only messages that are
inside `LOOKBACK_HOURS`, newer than the current PTY session's start, and newer
than the last id already adjudicated for that agent are considered — otherwise a
message that stays unread forever would re-trip on every sweep.

### What `last_seen` actually measures

It is touched (debounced 30s) by any authenticated call carrying that agent's
token, and it is *not* moved by the background sweep that flips `status` to
offline. So it tracks relay activity, not model work: a resident deep in a local
build with no messaging shows a stale `last_seen` while being perfectly healthy.
That is why it only ever contributes to *suspicion*, never to a page.

## Passive corroboration

Gathered for every resident on every sweep, attached to every alert, and
**never a trip condition** — it is there so a reader can tell "hung" from
"mid-heavy-build and slow":

- **Turn state.** Both harnesses mark turn completion explicitly — codex writes
  `task_complete`, claude writes `stop_reason: end_turn`. A *closed* last turn
  means the agent finished and is legitimately idle; an *open* one that has
  stopped growing means it stalled mid-thought.
- **Transcript age** — when the session last produced any output at all.
- **CPU delta** across sweeps over the agent's whole process subtree. An agent
  burning CPU while silent is probably building, not hung.
- **Broker view** — `current_state` and `pending_messages` from the local
  `GET /api/status`.

Resolving which transcript belongs to a resident is deliberately strict, because
reading the wrong session silently produces confident nonsense:

- **codex** — match `session_meta.cwd` **and** require `originator: agent-relay`.
  Codex forks a new rollout on compaction, so the `session_id` recorded at spawn
  goes stale (observed live: `relay`'s state file pointed at a 15:08 rollout
  while the resident was writing an 18:02 one). Will also runs Codex Desktop in
  these repos and those rollouts share the cwd.
- **claude** — `~/.claude/projects/<slugified-cwd>/<session_id>.jsonl`. The
  fallback to "newest non-sidechain transcript" is a guess and is labelled as
  such wherever it appears.

## Verdicts

| Verdict | Tier | Pages | Meaning |
|---|---|---|---|
| `OK` | 1 | no | nothing addressed to this resident is unread |
| `OK_ACTIVE` | 1 | no | unread exists but `last_seen` is recent relative to it — receipts just did not stick |
| `BOOTING` | 1 | no | spawned less than `BOOT_GRACE_MINUTES` ago |
| `PROBE` | 1 | no | tripped; a liveness probe was just sent |
| `SUSPECT` | 1 | no | tripped but the per-sweep probe budget was spent; probed next sweep |
| `PROBE_FAILED` | 1 | no | the probe could not be sent |
| `AWAITING_ACK` | 2 | no | probe in flight, still inside the response window |
| `NEAR_MISS` | 2 | no | answered the probe — it was slow or deep-working, logged for tuning |
| `UNRESPONSIVE` | 3 | **yes** | no reply within the window |
| `DEAD_PTY` | 0 | **yes** | the state file lists an agent whose pid is gone |
| `BROKER_DOWN` | 0 | **yes** | the repo's broker is unreachable, so nothing can be delivered |
| `MISSING_RESIDENT` | 0 | **yes** | an agent declared in `teams.json` is absent from broker state |
| `IDENTITY_SPLIT` | 0 | **yes** | a renamed successor is fresher than the offline canonical resident |
| `CLOUD_DEGRADED` | 0 | no | one Relaycast inspection failed; wait for confirmation before paging |
| `CLOUD_BLIND` | 0 | **yes** | Relaycast failed for consecutive sweeps, so unread-work liveness is unknown |
| `PTY_UNREACHABLE` | 0 | **yes** | repeated PTY writes timed out with no later transcript activity |
| `DELIVERY_UNVERIFIED` | 0 | **yes** | repeated deliveries lacked terminal echo proof and the transcript made no later progress |
| `NO_AGENTS` | 1 | no | broker up, no agents in its state file |

A page repeats at most every `REALERT_MINUTES` (60) unless the verdict changes.

## False positives

**Expected to trip, correctly, though they are not crashes:**

- A resident blocked on an interactive permission prompt cannot answer a probe.
  It needs a human, so a page is the right outcome.
- A resident whose harness is mid-turn on a very long tool call may not read a
  DM for many minutes. It will page; the attached evidence will show an open
  turn and a positive CPU delta, which reads as "busy" rather than "dead".

**Suppressed by design:**

- *Idle residents* — an empty inbox never trips, at any age.
- *Receipt gaps* — `OK_ACTIVE` absorbs the case where a receipt did not record
  but the agent is demonstrably transacting on relay.
- *Boot* — `BOOT_GRACE_MINUTES` after spawn.
- *Backlog from before a restart* — messages older than the current PTY session
  are ignored, since the agent that would have read them no longer exists.
- *Repeat suspicion on the same message* — once a probe adjudicates a message,
  its id is recorded and never reconsidered.
- *Transient control-plane failures* — one blind Relaycast sweep degrades the
  monitor; only consecutive failures page.
- *Recovered broker writes* — PTY timeouts and unverified acknowledgements clear
  when a newer transcript write proves the resident made progress.

**Structural blind spots:**

- **Only DM traffic is inspected.** Work delivered as a channel message or an
  `@mention` is not part of tier 1. A resident that ignores channel work but has
  a clean DM inbox will not be caught.
- **A read receipt does not mean the model consumed the message.** The broker
  marks a delivery read when the text echoes on the PTY. So a resident that
  receives, echoes, and then ignores a message reads as `OK` at tier 1. The
  passive turn-state signal is the only evidence of that shape, and it does not
  page on its own — if that case matters, it should become a tier-1 trigger in
  its own right.
- **`last_seen` is workspace-wide, not per-node**, so an identity used from more
  than one place would look more alive than it is.
- If the cloud API is unreachable, tier 1 cannot evaluate; the sweep logs
  `cloud=error:...` and only local checks apply. The first failed sweep is
  `CLOUD_DEGRADED`; the second consecutive failure is `CLOUD_BLIND` and pages.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `WATCHDOG_STALE_MINUTES` | 15 | how long unread work must sit, and the `last_seen` gap required |
| `WATCHDOG_RESPONSE_MINUTES` | 10 | how long a resident has to answer a probe |
| `WATCHDOG_MAX_PINGS_PER_SWEEP` | 3 | cap on probes per sweep |
| `WATCHDOG_BOOT_GRACE_MINUTES` | 10 | grace after spawn |
| `WATCHDOG_LOOKBACK_HOURS` | 12 | how far back inbound messages are considered |
| `WATCHDOG_MAX_CANDIDATES` | 5 | receipt checks per resident per sweep |
| `WATCHDOG_CPU_ACTIVE_SECONDS` | 5 | CPU burn that reads as "working" in the evidence line |
| `WATCHDOG_REALERT_MINUTES` | 60 | re-page interval for a standing condition |
| `WATCHDOG_DM_TARGET` | roster principal | who gets paged; explicit override when needed |
| `WATCHDOG_BROKER_FAILURE_MINUTES` | 20 | broker-log window for PTY and delivery failures |
| `WATCHDOG_PTY_TIMEOUT_LIMIT` | 2 | unrecovered PTY write timeouts in the window before paging |
| `WATCHDOG_UNVERIFIED_DELIVERY_LIMIT` | 3 | unverified acknowledgements in the window before paging |
| `WATCHDOG_CLOUD_FAILURE_SWEEPS` | 2 | consecutive Relaycast inspection failures before paging |

`WATCHDOG_LAUNCH_AGENTS`, `WATCHDOG_LOG_FILE`, `WATCHDOG_STATE_FILE`,
`WATCHDOG_IDENTITY_FILE`, `WATCHDOG_CLAUDE_PROJECTS`, `WATCHDOG_CODEX_SESSIONS`
and `WATCHDOG_API_BASE` redirect the roots so the pipeline can be exercised
against fixtures.

`WATCHDOG_DM_TARGET` overrides the page recipient. Normally it is omitted and
the watchdog resolves `principal.handle`, because a dead Chief cannot consume
its own page. It falls back to the rostered Chief when no principal handle is
declared.

## Identity and secrets

Probes and pages are sent as a dedicated registered agent, **`watchdog`**, so
that ACKs land in the watchdog's own DM threads instead of chief's inbox. Chief
hears from it only on a tier-3 page.

Register once (already done on this machine):

```sh
curl -sS -X POST https://cast.agentrelay.com/v1/agents \
  -H "Authorization: Bearer $WORKSPACE_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"watchdog","type":"agent","persona":"Automated fleet liveness monitor."}'
```

The returned `at_live_` token is issued **once**. It is stored at
`~/Library/Application Support/fleet-watchdog/identity.json`, mode 0600, outside
the repo. The workspace key is read from `.agentworkforce/relay/workspace-key.json`
and the broker key from `connection.json`; all three are used only as request
headers. No key is ever logged, written to state, or included in a DM, and HTTP
error bodies are never echoed.

## Install

```sh
npm run watchdog:install       # safe on a live broker
# `npm run install:services` installs/restarts the full resident service set.
```

The installer renders a machine-local LaunchAgent with the current Node path,
repository path, and user id. It runs every ten minutes and is verified by
`npm run doctor`; the doctor requires a sweep no older than 25 minutes, so an
installed-but-stopped watchdog cannot stay falsely green because of an old log.
No user-specific plist is committed.

Plain `node`, no harness. Residents are discovered from
`com.agentworkforce.<repo>.node` plists, so a new one is picked up with no edit
here. Structured log: `~/Library/Logs/fleet-watchdog.log` (JSONL, self-truncating
at 2MB) with `sweep`, `probe`, `near-miss`, `trip` and `page` events. Crashes:
`~/Library/Logs/fleet-watchdog-run.log`.

## v2 — not built yet

**Richer activity signals** could replace the `last_seen` heuristic, which is
the weakest input here. `agent-relay node --log-file` emits per-action events
(actions invoked and completed), and the observer WS stream carries
`agent_idle` / `agent_blocked_on_send` / `agent_state_transition` — that stream
needs an observer token, which the local broker can mint via
`POST /api/observer-token`. Either would give real per-action progress instead of
"this identity made an API call recently".

**The durable fix is broker-native.** A responsiveness feature is already filed
with relay; when it lands, tier 1 should read it directly rather than inferring
liveness from read receipts.

**Auto-kickstart** stays off until the trip record is boring. Before arming it:

1. A quiet period of observation — `UNRESPONSIVE` pages accumulate with no
   action, and recovery arms only against a shape proven clean over weeks.
2. A recovery action per verdict. `DEAD_PTY` wants a node respawn;
   `BROKER_DOWN` wants the launchd job kickstarted; `UNRESPONSIVE` wants the
   gentlest thing that makes the harness read its terminal —
   `POST /api/agents/by-name/<name>/interrupt` then a re-send, escalating to a
   PTY respawn only if the next sweep still fails.
3. Re-verification immediately before acting: a sweep observation is up to ten
   minutes old and a hang can clear on its own.
4. A rate limit and a kill switch — at most one recovery per agent per hour, a
   global per-sweep cap, and an env flag to disable without unloading the job.
5. Work preservation: capture `GET /api/spawned/<name>/snapshot` into the log
   before anything destructive, since a resident may hold uncommitted work.
