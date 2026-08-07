---
status: active
owner: chief-khaliq
updated: 2026-08-07
repos: [cloud, relaycast, relay]
---

# Cloud focus-area leads

Goal: give Cloud six accountable ownership boundaries so that merge order,
release authority, and the meaning of "node" stop being contested.

## Now

**The appointment did not survive the night, and only the replacements
delivered.** All six `-0806` lanes are offline as of 2026-08-07; five share
`lastSeen 07:11:08Z` to the second, which by the brain's own rule is a stamp
event and means they died earlier and unobserved. Three separate `-k1`/`-b1`
replacements independently audited their predecessor and each found no branch,
PR, worktree, commit, contract or consumed message, with no answer to a direct
takeover DM.

What actually exists, and it is worth keeping:

| Area | Artifact | State |
|---|---|---|
| Agent Execution & Orchestration | cloud#2948 — execution state and route authority | open, draft, docs-only |
| Fleet & Coordination | cloud#2947 — canonical identity and dispatch authority | open, docs-only |
| Identity & Credential Security | custody/token-authority contract v1 | **Relay message only, no artifact** |
| Platform Reliability, Integrations, Control Plane | — | nothing |

Identity's is the weakest of the three precisely because it has no artifact: a
contract that exists only in a message dies with the mailbox. Platform
Reliability produced nothing, and it was appointment #1 — the one whose
release-authority contract every other area's release was gated on. **That gate
is therefore still unwritten, and the sequencing rule below is still binding.**

Original appointment (2026-08-06, on Khaliq's word, immediately after the demo;
banked plan audited `main` @ `7807ba3`):

| Area | Lane | CLI |
|---|---|---|
| Platform Reliability & Release | `cloud-platform-reliability-lead-0806` | claude |
| Agent Execution & Orchestration | `cloud-execution-orchestration-lead-0806` | claude |
| Fleet & Coordination | `cloud-fleet-coordination-lead-0806` | claude |
| Identity & Credential Security | `cloud-identity-credential-lead-0806` | claude |
| Integrations & Relayfile Data | `cloud-integrations-relayfile-lead-0806` | opencode |
| Control Plane & Tenancy | `cloud-control-plane-tenancy-lead-0806` | codex |

**Every first deliverable is a decision/contract, not code.** That is the
plan's design, not a scheduling accident: appointing six leads who all start
writing code would multiply the cross-service change the appointment was meant
to control.

Platform Reliability is appointment #1 because the full-SST / fast-path / apex
collision can invalidate every other area's work. **No cross-area release
proceeds until its release-authority contract exists** — that sequencing was
carried into all six briefs so parallel appointment does not lose it.

## Next

1. **Khaliq decides whether to re-appoint at all**, now that YC is in and the
   demo is no longer setting priority. Chief's recommendation is not to re-run
   yesterday's pattern unchanged — twelve lanes bought three contracts and six
   silent deaths.
2. Land the three surviving contracts as artifacts before anything else.
   Identity's exists only as a message and must be written into a PR or it is
   lost. Verify each against the repo rather than accepting its summary — a
   contract that names a gate nobody invokes is not a contract, and #2948
   already admits its own enforcement line does not exist.
3. Re-appoint Platform Reliability first if re-appointing. It is the missing
   release-authority contract, and rule "no cross-area release proceeds until it
   exists" still holds with nothing behind it.
4. Resolve the two genuinely contested things the contracts must settle:
   Fleet's dual system of record (Postgres `workers`/`work_assignments` vs
   Relaycast D1 `nodes`), and release authority across a shared SST graph where
   one area's change mutates another area's worker.
5. Only then let leads appoint workers beneath them.

**Blocking dependency, new on 2026-08-07:** cloud#2947 defines canonical fleet
identity while relay AR-448 — durable workspace identity — still has two
competing open PRs and no lineage decision. Do not accept #2947 as settled
before that lands underneath it.

## Lane durability is the real finding

Six of twelve lanes died silently within hours, and the six that produced
nothing were the *originals*. Before another org structure is placed on these
lanes, the silent-death defect needs an owner — `status`, `live` and
`currentState` are registration facts never revoked on PTY exit, and nothing
reaps a stale agent since the Cloudflare migration dropped `sweepStaleAgents`'
timer (relaycast#306, still open). An org chart drawn on lanes that die
unobserved is a diagram, not an organization.

## Deliberately not appointed

Recorded so nobody fills these boxes by implication:

- **Relaycast server/runtime repository ownership.** Cloud's deployment and the
  standalone `../relaycast` run side by side; `infra/relaycast.ts` calls Cloud
  the future home without naming a migration authority. Fleet owns Cloud's edge
  only, and may not claim the external repo.
- **Relayfile server operations.** Cloud keeps URL, client, mount, sync and
  writeback edges; the server package is gone. Integrations owns the Cloud-side
  contract, not the external server.
- **Production apex routing.** Owned by the standalone `agentrelay.com` repo.
  Platform owns Cloud-side safety and must not be named apex owner without an
  explicit cross-repository decision from Khaliq.
- **`workflows/` as an area, a database/schema lead, and standalone Sage,
  Specialist, Cataloging or Transcription seats.** Each would freeze a wrong
  boundary at current scale.
- **The YC demo lane as durable ownership.** `cloud-yc-demo-integration-lead`
  held PR #2944 and its branch for the demo only. #2944 merged
  2026-08-06T10:44:56Z, so that authority has expired.

## Rollup contract

Workers report only to their area lead. Each lead sends one bounded rollup to
`cloud-platform-org-lead`. Cross-area work begins only through an explicit
lead-to-lead contract naming owner, interface, dependency and acceptance gate.

## History

### 2026-08-07

- Audited the appointment against the roster. All six `-0806` leads offline;
  five stamped at one identical second. Three replacements delivered contracts,
  three areas produced nothing at all, including appointment #1.
- Open-PR pressure in cloud is now 77, up from the 75 that motivated the
  appointment. The problem the org was meant to fix has not moved.

### 2026-08-06

- Six leads appointed after the YC demo. The plan had been banked and
  deliberately deferred on the reasoning that six new leads is org-building and
  competes with shipping; Khaliq released it the same day the demo ended.
- Open-PR pressure is itself part of the problem the appointment addresses:
  75 open PRs in cloud, 28 updated since Jul 1, with no durable area-level
  merge order.
