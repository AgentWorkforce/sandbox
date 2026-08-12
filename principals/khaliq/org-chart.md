# Org chart — live

Single source of truth for who reports to whom. Update this file, not just a
DM, when a reporting line changes — DMs vanish with the session, this doesn't.
See `OPERATING.md` § Span of control for the rule this implements.

Format per entry: `name — role — workstream file — status`.

## Chief
Reports to: Khaliq.

### Remote continuity Chief

- **`chief-barry-codex-0811-1440`** — Codex Chief on `barry`, ACKed and active.
  Completed the bounded `factory#230` generation/token + CAS slice at pushed
  SHA `0024c6b`; opened draft Factory PR #232 and is continuing to the next
  highest-priority bounded lane. It may drive implementation and review but
  must not touch Relayfile mounts or the disabled local launchd supervisors.

### Sub-leads (direct reports to Chief)

- **`soc2-program-lead-0811`** — SOC-2 traceability program
  - Local specialists were harvested and released 2026-08-11; the program lead
    remains responsible for `workstreams/soc2-agent-traceability.md` and
    reassigning the remaining Factory link.

- **`agent-coordination-lead-0811`** — agent coordination infrastructure
  - `pr-shepherd-lead-0811v3` — `workstreams/pr-shepherd-agent.md`
  - `relayfile-subs-lead-0811` — `workstreams/agent-event-subscriptions.md` (itself may form a sub-team; those workers report to it, not to `agent-coordination-lead-0811` directly)
  - `relaycast-kv-lead-0811` — production KV binding fix blocking relayfile subscriptions workspace-wide
  - Trajectory and C2A specialist seats were harvested and released; their
    unassigned follow-ups live in `intent-trajectory-lineage.md`,
    `chief-memory-encoding.md`, and `agent-lifecycle-workflows.md`.

### Direct to Chief (severity or deliberately not nested)

- `webhook-queue-lead-0811` (codex) — production webhook-queue incident, escalated directly per Khaliq's "GET CODEX AGENT ON THIS"
- `daytona-lead-0811v3` — temporarily direct after the inactive delivery
  sub-lead was released; `workstreams/daytona-fleet-nodes.md`
- `obligation-boomerang-lead-0811` (codex, on `barry`) — implements the real
  fix for `relay#1474` (Khaliq's own issue: read-but-unanswered messages),
  verified against the test-only fixture in `relay#1476`
- `lifecycle-workflows-lead-0811` (on `finn-mini`) — resumes
  `agent-lifecycle-workflows.md` (Nabis/Julian point 2), stale since 08-10

### Existing resident, not a new sub-lead (already owned this domain)

- **`factory-lead`** — resident, `teams.json`. Owns Factory end to end.
  Node: **`barry`** (moved 2026-08-11 — Khaliq: "respawn with same name on
  another node," offloading the local Mac; previous instance was fully
  offline, clean respawn, briefed with its own prior root-cause writeup for
  continuity — see `evidence/factory-not-dispatching-rootcause-0811.md`).
  - `factory-230-lead-0811` — design harvested and local seat released; two
    red-check gaps recorded in `workstreams/active-lanes.md`

### Released local seats — 2026-08-11 cleanup

All had zero pending messages and were bridge-waiting or explicitly idle:
`marketing-lead`, `delivery-lead-0811`, `trajectory-lead-0811v3`,
`relayscribe-lead-0811`, `relay-attest-session-lead-0811`,
`factory-230-lead-0811`, `finn-mini-upgrade-lead-0811`,
`cloud-identity-lead-0811v3`, `orgchart-dashboard-lead-0811`,
`fleet-mount-lead-0811`, `cross-node-attach-lead-0811`,
`c2a-lead-0811b`, `soc2-lead-0811b`, and
`relayfile-helm-lead-0811`. Their final state is indexed in
`workstreams/active-lanes.md` and the named workstream files.

### Dead / abandoned, not under any active management

- `soc2-lead-0811` (on `barry`) — Claude Code session login expired mid-run,
  confirmed via SSH 2026-08-11. Left in place; slot not force-released.
- `relayfile-lead-0811` (on `finn-mini`) — unresponsive, undiagnosed root
  cause; being superseded by `finn-mini-upgrade-lead-0811`'s broker fix rather
  than directly revived.

## History

- **2026-08-11** — Created. Consolidated 11 flat direct reports into 3
  sub-leads + 1 routed to an existing resident, after Khaliq flagged Chief was
  directly owning too many agents (see `OPERATING.md` § Span of control).
- **2026-08-11** — `factory-lead` relocated from the local Mac to `barry`.
  Added leads spawned since the initial cut: `fleet-mount-lead-0811`,
  `cross-node-attach-lead-0811`, `relaycast-kv-lead-0811`,
  `webhook-queue-lead-0811`, `orgchart-dashboard-lead-0811`. Noted
  `delivery-lead-0811` is now 1 over the span-of-control guideline.
- **2026-08-11** — Added remote continuity Chief
  `chief-barry-codex-0811-1440` after the local Chief freeze; first bounded
  Factory slice pushed and the agent remains active on `barry`.
