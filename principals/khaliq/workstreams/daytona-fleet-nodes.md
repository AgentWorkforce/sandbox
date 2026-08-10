---
status: active
owner: daytona-lead-0810
updated: 2026-08-10
repos: [cloud, relay]
---

# Daytona sandboxes as live fleet nodes

**2026-08-10: `cloud#2963` merged (`52ebc1d8a1`) and `cloud#2946` merged and DEPLOYED (`639ec90c9d`). The cold-start toolbox defect is fixed: `buildWarmStepContext` no longer awaits `getUserHomeDir()` while a sandbox is `STARTING`, which had been burning the queue retry budget so the ten-minute polling loop never ran.**


Goal: make a provisioned Daytona sandbox behave as a sustained, live agent-relay
fleet node that Chief can place work onto, with the same reliability the Mac mini
nodes already demonstrate.

Spec: `cloud/docs/specs/2656-daytona-fleet-node-and-chief-placement.md` (217 lines,
verified against production fleet state 2026-08-06). Read it before starting —
it is unusually well-evidenced and it corrects a stale diagnosis that would
otherwise waste a lane's time.

Related: `cloud#2656`, `cloud#2683`, `cloud#2689` (decided), `relay#1328`, `relay#1446`.

## Now

**There is no pipeline to debug. Every enrollment mechanism in the repo is
disconnected at a different joint, and one of them is wired to a command that
was deleted.** "The wiring is merged and does not work" was wrong in a way that
mattered: nothing was ever connected, so H1/H2/H3 were ranked against a system
that does not exist. This is a design decision, not a measurement run.

All findings below verified 2026-08-10 at named refs — `cloud@639ec90c9d`
(origin/main tip) and `relay@v11.4.0`/`v11.4.1` (the pinned snapshot versions)
— in an isolated clone. The shared `cloud` checkout is **117 commits stale**
(at `7807ba35ba`); do not read facts from it.

## The mechanism map

Three enrollment mechanisms exist. Not two. None is connected.

| | Mechanism | Broken at | Evidence |
|---|---|---|---|
| **A** | `dev-stack/fleet-node-bootstrap/sandbox-node-bootstrap.sh` | No caller *by design* — it is an operator runbook | Referenced only by its own README and its own two tests |
| **B** | `provisionFleetSandboxNode()`, `packages/web/lib/fleet/sandbox-bridge.ts:464` | **Function with no caller** | Zero production call sites |
| **C** | `start_fleet_serve()`, `deploy/daytona/relay-sandbox-entrypoint.sh:11` | **Reader with no writer — and it calls a deleted command** | `AGENT_RELAY_FLEET_ENROLLMENT_TOKEN` is only ever read, never written |

Scope for both counts: `grep -rn` over the whole repo at `cloud@639ec90c9d`,
`--include='*.ts' --include='*.tsx'` for B and unrestricted for C, excluding
`node_modules/`, `dist/`, and `.git/`.

- **B is complete and tested, and nothing calls it.** `box-manager.ts:57-63`
  imports seven *other* symbols from `sandbox-bridge.ts` and pointedly not this
  one. The only references to `provisionFleetSandboxNode` outside its own
  definition are in `sandbox-bridge.test.ts`. It provisions, mounts Relayfile,
  mints a token, and runs the correct two-command flow — into a vacuum.
- **C is dead on arrival, not merely unwired.** It builds
  `agent-relay fleet serve --enrollment-token …`, but at both pinned versions
  (`relay@v11.4.0` and `v11.4.1`, `packages/cli/src/cli/commands/fleet.ts:24-77`)
  `fleet serve` is a **hidden stub that prints a migration message and
  `exit(1)`**. `allowUnknownOption(true)` means the old flags are swallowed
  without an argument error. Cloud's own source says so at
  `packages/web/lib/fleet/nodes.ts:281-286`; verified independently in `relay`.
  Worse, the entrypoint runs it as `nohup … &` and writes a PID file, so the
  exit code is discarded and the failure lands only in
  `~/.agent-relay/fleet-serve.log`. **A sandbox that took this path would look
  healthy and never produce a node.** That is the symptom this workstream has
  been chasing.
- C is additionally gated on `AGENT_RELAY_FLEET_SERVE` being truthy — a third
  unset variable. Three gates, all closed, in front of a broken command.

## Next

**The question is which mechanism is intended, and it is Khaliq's or the Cloud
owner's call — not a lane's.** Do not schedule a live run until it is answered.

1. **Decide the intended mechanism.** The evidence points hard at **B**: it is
   already built, already tested, already uses the supported `relay cloud enroll
   && relay node up` flow, and lives in the control plane where the token is
   minted. **C should be retired, not connected** — it targets a command that
   no longer exists. Recommendation: adopt B, delete C's `start_fleet_serve`
   enrollment branch, keep A as the manual proof harness.
2. **Answer the design question B leaves open: what calls it?** There is no API
   route, no dashboard action, and no Chief-facing command that provisions a
   fleet node. That missing caller *is* the work — Phase 1 cannot start without
   it. Options to weigh: a `POST /api/v1/fleet/nodes/sandbox` route; an
   extension of the existing cloud-agents box route; or a Chief-invoked script.
3. **Fix `autoStopInterval` before any measurement.** See the corrected
   enumeration below. No current call site is safe, and one can produce a
   **one-minute** auto-stop.
4. **Then, and only then**, re-derive H1/H2/H3 against the pipeline that
   actually exists. The current hypotheses are not salvageable as written.

**Blocked on Khaliq, independent of the above:** Daytona credentials are absent
from the agent environment (`packages/daytona-runner/src/auth.ts:11` needs
`DAYTONA_API_KEY`, or `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID`; all
unset). Phase 1 and Phase 2 are unschedulable until that is answered — it is a
question to ask, not a thing to work around.

## Key facts, so nobody re-derives them

- **The recorded 2026-08-04 diagnosis is false.** It blamed a pinned snapshot
  shipping agent-relay 10.0.0 against a >=10.6.0 heartbeat requirement. The node
  actually registered on broker **11.4.0** with the full capability set and did
  heartbeat. The version gate is not the problem, and the spec asks for that
  correction to be written down wherever the stale theory is recorded.
- **The failure moved**: not "never comes online" but **"comes online, then dies
  after ~39 seconds."** **FALSIFIED 2026-08-09 by `daytona-lead`, re-derived from
  source.** The heartbeat interval is **12s, not 30s** — `relay@v11.4.0
  crates/broker/src/node_control.rs:29`, `const HEARTBEAT_INTERVAL:
  Duration = Duration::from_secs(12)`. An explicit `NodeHeartbeat` fires at
  `:1606` *before* the interval is created at `:1614`, and tokio's first tick is
  immediate — so 39s holds roughly **five** beats (~0, ~0, 12, 24, 36), not one.
  Offline detection is a 45s TTL swept every 30s (`cloud
  packages/relaycast/src/durable-objects/node.ts:18,19`, handler `:869-877`), so
  offline lands **45–75s** after the last beat. **39s is inside the window where
  nothing should have been declared offline at all — it was never a clue.**
  H1's "most likely" ranking rested on this number and is now **unranked**.
  **The real behaviour has never been measured.**
- `finn-mini` and `sf-mini` are live with an **identical** capability set, and
  end-to-end placement onto `finn-mini` was proven on 2026-08-06. So the
  difference is not capabilities, not enrollment, not broker version.
- `maxAgents: 0` on the dead `cloud` record means *unlimited*, same as every
  healthy node. Do not chase it.
- **`autoStopInterval`: five distinct literals and three computed call sites.**
  Scope: `grep -rn 'autoStopInterval' --include='*.ts' --include='*.sh'` over the
  whole repo at `cloud@639ec90c9d`, excluding `node_modules/` and `dist/` — 22
  hits across 16 files. Literals **5** (`packages/core/src/cli-auth.ts:158,188`),
  **10** (four `tests/code-sync-bench*.ts`, `tests/code-sync-e2e.ts:88`), **15**
  (`packages/core/src/auth/sandbox-auth.ts:318`, `tests/check-sandbox.ts:3`,
  `tests/quick-sandbox.ts:16`), **30** (`workflows/optimize-sandbox-startup.ts:97`),
  **60** (`tests/orchestrator/launcher.test.ts:112,122`,
  `workflows/optimize-sandbox-startup.ts:234,245,254`). Computed:
  `packages/core/src/bootstrap/launcher.ts:1422` (60, or
  `normalizeSharedSandboxTtlMinutes(ttlMinutes)` in shared-sandbox mode);
  `…/box/box-manager.ts:2349` (`Math.ceil(DEFAULT_BOX_TIMEOUT_SECONDS / 60)`,
  which evaluates to 60 given `= 60 * 60` at `:73`); and
  `…/sandboxes/route.ts:181` (`Math.max(1, Math.ceil(body.timeoutSeconds / 60))`
  — caller-driven with a floor of **one minute**). *Correction to the 2026-08-09
  handoff, which listed four literals and missed **30**; and to the pre-08-09
  note above, which listed three.* Daytona's idle clock does not reset on
  outbound relay heartbeats, so **none of these is safe for a measurement run**:
  any of them can stop a healthy node mid-run and present as a sandbox-death
  event that is really our own misconfiguration.

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

### 2026-08-10

- Lead handed to `daytona-lead-0810`. Acted on the previous lead's
  recommendation: **Next rewritten from a live-run plan into a design question.**
- Confirmed and sharpened the structural finding. It is **three** mechanisms,
  not two, and mechanism **C is dead on arrival** — it invokes `agent-relay
  fleet serve`, a hidden stub that `exit(1)`s at both pinned relay versions,
  under `nohup … &` so the exit code is discarded. Verified in `relay` itself
  rather than trusting cloud's comment about it.
- Corrected the `autoStopInterval` enumeration: five literals (the 08-09 handoff
  missed **30**) plus three computed sites, one with a one-minute floor. Scope
  stated with the count.
- Shared `cloud` checkout re-measured: **117** commits behind `origin/main`
  (was 115 on 08-09; `origin/main` also advanced to `639ec90c9d`). All work done
  in an isolated clone; the shared tree was not modified.

### 2026-08-06

- Khaliq asked for the spec to be carried into the brain with a task to pick up
  after the YC demo. Queued, unassigned.
