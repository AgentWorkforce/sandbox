# Fleet liveness watchdog

The org's pager. Every 10 minutes it asks one question of each resident agent on
this machine: **did work arrive that the session never processed?** On a trip it
writes a line to `~/Library/Logs/fleet-watchdog.log` and DMs `chief` over relay.

Alert-only. It never kickstarts, restarts, or interrupts anything.

```
node tools/watchdog/fleet-watchdog.mjs            # sweep + table
node tools/watchdog/fleet-watchdog.mjs --dry-run  # evaluate and log, never DM
node tools/watchdog/fleet-watchdog.mjs --json     # machine-readable
node tools/watchdog/test-watchdog.mjs             # trip-logic tests
```

## Why liveness is not obvious here

The failure this exists for: PTY process alive and idle-sleeping, broker
`/health` green, node log silent, and injected relay messages unprocessed for
50–75 minutes.

Nothing in the broker notices, because a `delivery_read_ack` fires when the
injected text **echoes back on the PTY** — or simply after a 5-second timeout if
no echo is seen. The broker then clears the pending delivery and marks the
worker `Working`. So queue depth, `current_state`, and `/health` all read
healthy while the model never touched the message. Broker state alone cannot
detect this; the evidence has to come from the harness.

## Signals

| Signal | Source | Means |
|---|---|---|
| Turn state | last record of the session transcript | whether a turn is open or completed |
| Transcript mtime | same file | when the session last produced *anything* |
| Delivery ack | `<repo>/.agentworkforce/relay/dedup-*.json`, `delivery_read_ack:<agent>:<id>` → `inserted_at_ms` | when work last arrived at the terminal |
| Unacked deliveries | broker `GET /api/status` → `pending_deliveries[].age_ms` | work the broker could not get acked at all |
| PTY liveness | `kill(pid, 0)` against `state-*.json` | the process still exists |
| CPU delta | `ps` over the agent's process subtree, compared across runs | the agent is burning cycles even while silent |

**Turn completion is the load-bearing signal**, because it separates "finished
and legitimately idle" from "stopped mid-thought". Both harnesses mark it
explicitly:

- **codex** — `event_msg` with `payload.type: task_complete`
- **claude** — `assistant` record with `message.stop_reason: end_turn`

Without it, staleness is meaningless: on a normal afternoon 8 of 15 residents
have been quiet for 1.5–3 hours simply because nobody has asked them anything.

### Resolving which transcript belongs to a resident

Getting this wrong silently reads someone else's session, so neither harness is
resolved by "newest file in the directory":

- **codex** — match `session_meta.cwd` to the repo **and** require
  `originator: agent-relay`. Codex forks a new rollout on compaction, so the
  `session_id` recorded at spawn goes stale (observed live: `relay`'s state file
  pointed at a 15:08 rollout while the resident was writing an 18:02 one). Will
  also runs Codex Desktop in these repos; those rollouts share the cwd and must
  not be mistaken for the resident.
- **claude** — `~/.claude/projects/<slugified-cwd>/<session_id>.jsonl`, the
  session id being recorded per agent in `state-*.json`. The fallback to
  "newest non-sidechain transcript" is a guess, and any page derived from it is
  labelled `[transcript inferred, not session-id matched]`.

Delivery-ack timestamps are cached in the watchdog's own state file, because the
broker's dedup cache expires entries after 5 minutes and evicts lazily.

## Trip conditions

Evaluated in order; the first match wins. `M` = `WATCHDOG_STALE_MINUTES`, 15.

| Verdict | Pages | Condition |
|---|---|---|
| `DEAD_PTY` | yes | `state-*.json` lists the agent but its pid is gone |
| `QUEUED_STUCK` | yes | a delivery has gone unacked for > M — never even reached the terminal |
| `HUNG_UNCONSUMED` | yes | a delivery landed > M ago and the transcript has written **nothing** since (ack post-dates last transcript write by > 120s) |
| `HUNG` | yes | a turn is open and has produced no output for > M |
| `NO_TRANSCRIPT` | no | no session file resolved — reported, not paged |
| `UNREADABLE` | no | no turn boundary in the transcript tail |
| `WORKING_LONG` | no | open turn, stale, but the process tree burned ≥ 5s CPU since the last run |
| `BOOTING` | no | spawned less than 10 minutes ago |
| `ACTIVE` | no | open turn, output within the last M |
| `IDLE_OK` | no | last turn completed — quiet for any duration is fine |

The three paging conditions cover the delivery pipeline end to end: never
injected (`QUEUED_STUCK`), injected but never consumed (`HUNG_UNCONSUMED`),
consumed but then frozen (`HUNG`).

A tripping condition pages once, then stays quiet for
`WATCHDOG_REALERT_MINUTES` (60) unless the verdict changes.

## False positives

**Expected to trip, correctly, though they are not crashes:**

- An agent blocked on an interactive permission prompt. The turn is open, output
  has stopped, and it needs a human — a page is the right outcome.
- An agent waiting on a network call for over 15 minutes with no CPU burn.

**Known suppressions, and where they can fail:**

- *Long builds and tool calls* produce no transcript records for many minutes.
  Suppressed by the CPU-delta check (`WORKING_LONG`). This fails for a tool call
  that is genuinely idle-waiting, e.g. a long `sleep` or a slow remote fetch —
  that will page. It also means a hang with an unrelated CPU-burning child
  process is under-reported.
- *Boot* has a 10-minute grace window; an agent that takes longer than that to
  reach its first prompt pages once.
- *First run after a restart* has no previous CPU sample, so `WORKING_LONG`
  cannot apply and a long tool call may page. The detail line says
  `no prior CPU sample`.

**Structural blind spots:**

- `HUNG_UNCONSUMED` needs a delivery ack to compare against. An agent that has
  never received a message has no "work arrived" clock, and a hang is invisible
  until something is sent to it. This is intentional: a resident with no pending
  work that is idle is healthy.
- If the broker process itself is gone, `connection.json` is stale and the repo
  reports `BROKER_DOWN` rather than per-agent verdicts.
- The `newest-fallback` transcript path can select an abandoned session, which
  reliably looks hung. Pages from it are labelled; none of the 15 current
  residents use it.

Measured against the live fleet and a replay of a day of real transcripts, the
steady-state false-positive rate is zero: 15/15 residents classify `IDLE_OK`,
and no historical window showed an open turn going silent past the threshold.

## Configuration

All optional, all env vars:

| Var | Default | Meaning |
|---|---|---|
| `WATCHDOG_STALE_MINUTES` | 15 | the trip threshold, M |
| `WATCHDOG_BOOT_GRACE_MINUTES` | 10 | grace after spawn |
| `WATCHDOG_CPU_ACTIVE_SECONDS` | 5 | CPU burn that counts as working |
| `WATCHDOG_REALERT_MINUTES` | 60 | re-page interval for a standing condition |
| `WATCHDOG_ACK_TOLERANCE_SECONDS` | 120 | slack between an ack and the transcript write it should cause |
| `WATCHDOG_CODEX_LOOKBACK_DAYS` | 3 | how far back to index codex rollouts |
| `WATCHDOG_DM_TARGET` | `chief` | who gets paged |

`WATCHDOG_LAUNCH_AGENTS`, `WATCHDOG_LOG_FILE`, `WATCHDOG_STATE_FILE`,
`WATCHDOG_CLAUDE_PROJECTS` and `WATCHDOG_CODEX_SESSIONS` redirect the roots so
the whole pipeline can be exercised against fixtures.

## Install

```sh
cp tools/watchdog/com.agentworkforce.fleet-watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.agentworkforce.fleet-watchdog.plist
launchctl kickstart -p gui/501/com.agentworkforce.fleet-watchdog
```

Plain `node`, no harness, no tokens spent. Residents are discovered from
`com.agentworkforce.<repo>.node` plists, so a new one is picked up with no edit
here. Structured log: `~/Library/Logs/fleet-watchdog.log` (JSONL, self-truncating
at 2MB). Crashes: `~/Library/Logs/fleet-watchdog-run.log`. State:
`~/Library/Application Support/fleet-watchdog/state.json`.

Broker API keys are read from each repo's `connection.json` and used only as a
request header — never logged, never written to state, never sent in a DM.

## v2 — auto-kickstart

Not armed. Before it is, it needs:

1. **A quiet period of observation.** Trip lines accumulate in the log with no
   action; auto-recovery should only arm against a class of trip proven to have
   no false positives over a couple of weeks.
2. **A recovery action per verdict.** These are different failures:
   `DEAD_PTY` wants a node respawn; `QUEUED_STUCK` wants a broker-side redeliver
   (`POST /api/dead-letters/redeliver`); `HUNG_UNCONSUMED` wants the gentlest
   thing that makes the harness read its terminal — likely
   `POST /api/agents/by-name/<name>/interrupt` followed by a re-send, escalating
   to a PTY respawn only if the next sweep still trips.
3. **Confirmation before acting.** One sweep is a 10-minute-old observation. Any
   destructive step should re-verify immediately beforehand, since a hang can
   clear on its own.
4. **A rate limit and a kill switch.** At most one recovery per agent per hour,
   a global cap per sweep so a broker-wide fault cannot restart the fleet, and
   an env flag to disable it without unloading the job.
5. **Work preservation.** A resident may hold uncommitted work; respawning
   discards its context. Recovery should capture
   `GET /api/spawned/<name>/snapshot` into the log first.
