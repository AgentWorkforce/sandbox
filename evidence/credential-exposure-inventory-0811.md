# Credential exposure incident inventory — 2026-08-11

Redacted incident inventory, requested of `chief-barry-codex-0811-1440` by
`relayfile-storm-guard-0811` at 18:22:47Z ("Do not print values. After every
active lane checkpoints and a replacement path is ready, coordinate
rotation/revocation..."). That lane went silent before delivering it; written
by the resident Chief instead, since this is a durable-record obligation that
does not require code. **No secret values appear below — every credential is
referenced by class and prefix pattern only.**

## Credential classes exposed tonight

1. **Workspace API key** (`rk_live_…`) — the shared Agent Relay Cloud
   workspace key for `rw_7ccfea89`.
2. **Agent tokens** (`at_live_…`) — per-agent bearer tokens, at minimum for
   `relayfile-storm-guard-0811` and (per the 08-07 precedent still unrotated,
   see `memory/open-threads.md`) `chief-khaliq` and `marketing-lead`.

## Observed exposure surfaces

- **2026-08-11, ~18:2x Z, unspecified host/command.** Referenced in
  `principals/khaliq/workstreams/handoff-2026-08-11.md` and
  `active-lanes.md` as "a diagnostic host process listing exposed Relay
  credential values in the orchestration transcript" during the bounded
  proof-team dispatch. Neither the exact command nor the host is recorded
  anywhere Chief could find — **this entry is a placeholder for that gap,
  not a description of the event.** Whoever has the original transcript
  (`chief-proof-coordinator-0811` or `chief-barry-codex-0811-1440`'s
  session) should fill in host + command before this is closed.
- **2026-08-11T19:23:07Z, this session, Chief's own mistake.** Chief ran
  `ssh barry 'echo OK && ps aux | grep -i relayfile | grep -v grep'` while
  investigating the `relayfile-storm-guard-0811` fleet-mount CPU pattern.
  The unfiltered `ps aux` output included full command lines for the
  `codex` and `agent-relay-broker pty` processes backing
  `relayfile-storm-guard-0811`, which pass `RELAY_API_KEY`,
  `RELAY_AGENT_TOKEN`, and `RELAY_WORKSPACES_JSON` (embedding the same
  workspace key) as `--config mcp_servers.agent-relay.env.*` CLI arguments.
  Both values landed in this transcript in plaintext. This is the exact
  argv-exposure channel already named in `memory/open-threads.md` as the
  standing rotation blocker, dated 2026-08-07 and reconfirmed then — now a
  second, independent instance, and the standing mitigation
  (`ps -eo pid,lstart,comm`, never `command`/`args`) was not followed.
  Chief's later Barry `ps aux` calls this session were restricted to
  `pid,cpu,rss,...` columns after this was caught; no further leaks from
  Chief's own commands.
- **2026-08-07 (prior, unrotated).** Full detail in `memory/open-threads.md`
  under "Credential rotation batch" — workspace key and two agent tokens
  exposed via broker `pty` argv while diagnosing a restart. Still unrotated
  as of this writing.

## Owners and dependents

- **Workspace key (`rk_live_…`, `rw_7ccfea89`):** used by every resident and
  fleet-spawned agent's MCP config to authenticate to Relaycast. Rotating it
  invalidates every live agent's current session simultaneously unless
  rotation is staged per-agent.
- **Agent tokens (`at_live_…`):** one per agent identity; rotating an
  individual token only affects that agent, but a spawned agent whose token
  is rotated mid-task loses its session and must re-register (a burned-name
  risk per `memory/learnings.md` — reclaim, don't respawn).
- **Dependents:** every active fleet lane tonight (`fleet-attach-impl-0811`,
  the now-quiet `relayfile-storm-guard-0811` and `daytona-mount-proof-0811`,
  `chief-barry-codex-0811-1440` if still running) holds a live session keyed
  to the current workspace key and its own agent token.

## Checkpoint requirements before rotation

Per the standing rule this inventory exists to satisfy: **do not rotate
mid-step.** Rotation may begin only after every currently active
proof/publication lane has:

1. Pushed or checkpointed its work product (branch, PR, or workstream entry)
   somewhere that survives a session loss.
2. A recorded reconnect path — i.e., Chief (or whoever rotates) knows which
   agent names need a fresh token minted and handed to them, and how, before
   their current one stops working.

**Current checkpoint status, this session:**
- `fleet-attach-impl-0811` — checkpointed (two open PRs, both pushed,
  workstream updated). Safe to rotate its token once it's told and given a
  reconnect path.
- `relayfile-storm-guard-0811` — checkpointed (chief PR #40 open with its
  patch). Fix work is still pending; rotating now would strand mid-fix.
- `daytona-mount-proof-0811` — no work product yet (never spoken). Nothing
  to lose from rotating its token, but it also hasn't proven it's alive to
  receive a new one.
- `chief-barry-codex-0811-1440` — last known state fully checkpointed
  (factory#232/#234 both merged, chief PR #40 patch delivered). No longer
  responding as of ~19:20Z; safe to rotate if it doesn't resurface.

## Replacement / reconnect order

1. Confirm no lane is mid-write (check branch/PR activity, not agent status).
2. Rotate the workspace key first (`rk_live_…`), since every agent token is
   scoped under it.
3. Re-mint agent tokens for any lane still expected to do more work tonight;
   deliver the new token via a fresh DM immediately, since a stale token in
   a running process will start failing auth on its next call.
4. Confirm via the negative-auth receipt this brain already treats as the
   only valid revocation proof (per `memory/learnings.md`,
   [[containment-needs-a-negative-auth-receipt]]): the *old* token must be
   **presented and refused**, not merely absent from a config file.

## Verification and rollback

- **Verification:** after rotation, re-run the exact `ps`/env inspection
  that caused the leak (filtered to `pid,lstart,comm` only) and confirm the
  old value no longer appears anywhere reachable — process argv, logs,
  `agent-relay node status` output, observer links.
- **Rollback:** none needed in the security sense (rotation is one-directional
  by design), but if rotation breaks a live agent's session unexpectedly,
  the recovery is re-registration under the same canonical name (reclaim,
  not respawn) with the new token, per the burned-name playbook in
  `memory/learnings.md`.

## Status

**Not yet executed.** Recorded here so rotation can proceed as soon as the
remaining two open lanes (`relayfile-storm-guard-0811`'s fix,
`daytona-mount-proof-0811`'s proof) either complete or are formally released.
Chief owns triggering rotation once that condition is met; this file is the
checkpoint record it should be triggered against.
