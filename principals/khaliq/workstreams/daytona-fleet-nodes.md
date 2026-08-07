---
status: queued
owner: unassigned
updated: 2026-08-06
repos: [cloud, relay]
---

# Daytona sandboxes as live fleet nodes

Goal: make a provisioned Daytona sandbox behave as a sustained, live agent-relay
fleet node that Chief can place work onto, with the same reliability the Mac mini
nodes already demonstrate.

Spec: `cloud/docs/specs/2656-daytona-fleet-node-and-chief-placement.md` (217 lines,
verified against production fleet state 2026-08-06). Read it before starting —
it is unusually well-evidenced and it corrects a stale diagnosis that would
otherwise waste a lane's time.

Related: `cloud#2656`, `cloud#2683`, `cloud#2689` (decided), `relay#1328`, `relay#1446`.

## Now

Queued deliberately behind the YC demo (2026-08-06). Not started, no owner.
The wiring is merged and does not work.

## Next

1. Appoint an owner once the demo is done. This is a good first assignment for
   the Fleet & Coordination focus-area lead when Cloud appointments happen — see
   the banked appointment plan.
2. **Rule out H3 first** — that the Aug 5 sandbox was torn down by its own test
   harness. Cheapest to eliminate, and if true the real behaviour is unmeasured
   and every other hypothesis is premature.
3. Then H1: does the node process die with the provisioning exec session that
   started it? Two distinct bugs to separate — sandbox gone after 39s, versus
   process gone inside a still-running sandbox.
4. Then H2 before claiming Phase 1: Daytona `autoStopInterval` measures inactivity
   at the Daytona API level, and an outbound heartbeat generates none — so a
   healthy node looks idle and gets stopped. Three different values are in play
   across call sites (5, 15, 60).

## Key facts, so nobody re-derives them

- **The recorded 2026-08-04 diagnosis is false.** It blamed a pinned snapshot
  shipping agent-relay 10.0.0 against a >=10.6.0 heartbeat requirement. The node
  actually registered on broker **11.4.0** with the full capability set and did
  heartbeat. The version gate is not the problem, and the spec asks for that
  correction to be written down wherever the stale theory is recorded.
- **The failure moved**: not "never comes online" but **"comes online, then dies
  after ~39 seconds."** With `DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000`, 39s is
  registration plus roughly one heartbeat, then silence. One beat then nothing
  means the process or the sandbox stopped — not a heartbeat misconfiguration.
- `finn-mini` and `sf-mini` are live with an **identical** capability set, and
  end-to-end placement onto `finn-mini` was proven on 2026-08-06. So the
  difference is not capabilities, not enrollment, not broker version.
- `maxAgents: 0` on the dead `cloud` record means *unlimited*, same as every
  healthy node. Do not chase it.

## Done when

Phase 1 — a fresh sandbox appears `online`/`live` with `spawn:*`, stays online
**continuously for 24 hours** with `lastHeartbeatAt` advancing throughout,
survives a stop/start cycle without re-enrolling, and the root cause is written
into the PR with evidence. Criterion 2 is a **duration** test: a node that is
online when you look at it already passed that bar once on Aug 5 and was still
broken.

Phase 2 — Chief places work onto a Daytona node, verified **on the target host**
(broker pty and CLI process observed inside the sandbox), not merely from the
control plane's `dispatchedNodeId`. Control-plane dispatch and actual execution
are different claims.

## Explicit non-goals

- Hosting the Chief node itself on Daytona. Chief stays on local hardware.
- Making a node a second authority for delivery durability — `cloud#2689` decided
  a node is a placement target and nothing more. Postgres stays the single
  idempotency and reporting ledger; persist no delivery state on the node.
- Building a provider SDK.

## History

### 2026-08-06

- Khaliq asked for the spec to be carried into the brain with a task to pick up
  after the YC demo. Queued, unassigned.
