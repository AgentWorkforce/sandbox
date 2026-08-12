---
status: active
owner: daytona-mount-proof-0811
previous_owner: daytona-relayfile-closeout-barry-0811
reports_to: chief
updated: 2026-08-11
repos: [cloud, relay]
---

## 2026-08-11 19:26Z — production deploy blocker CLEARED

Deploy run `31526176137` (headSha `935178de`) **succeeded**. Root cause of the
`TranscriptionWorkerServiceToken` failure (prior runs `31516360915`,
`31522436779`) was cloud#2994: the secret had no constructor default, so
`sst diff`'s read-only preflight (seed-sst-secrets disabled by design) threw
`SecretMissingError` before a deploy could even be evaluated — production had
never had `sst secret set TranscriptionWorkerServiceToken` run. Fix follows the
same pattern already used for `LinearWebhookSecret`: an "unset" placeholder
default so diff/plan always resolves, while the real deploy step still
unconditionally overwrites it from the GitHub Actions secret. No manual `sst
secret set` needed going forward.

**This clears the production blocker on the multi-host proof.** DM'd
`daytona-mount-proof-0811` (offline since 18:27Z but the underlying node
`daytona-fleet-proof-0811` / `node_212862301507432448` confirmed live/heartbeating
independently) to resume. Still outstanding, unrelated to this blocker: the
four read-only proof gates `daytona-mount-proof-0811` found in the merged
mount code (`/workspace` default unwritable for unprivileged Daytona, argv-order
env bug in the refresh loop, Relayfile token visible in mount argv, no
existing-sandbox retrofit path) and the stale-projection currency check
(`known-true-now`, `workspace-joined-not-created`, `cross-host-write-visible`,
etc.) from the 08-11 19:28Z closeout entry below.

# Daytona sandboxes as live fleet nodes

**2026-08-11: PHASE 2 PROVEN. `cloud#2984` MERGED (`16f58648e`). Node `daytona-fleet-proof-0811` (`node_212862301507432448`) ONLINE. Full loop confirmed: Chief dispatched `daytona-proof-worker-0811` → agent landed inside sandbox `dedfeb9a-8682-4b89-957f-5bd15603ee0c` → replied from hostname matching sandbox ID, pwd `/home/daytona` → Claude process (PID 380) observed on-host via SSH. 24h heartbeat gate in progress (~2026-08-12T09:22Z).**

## Proof team dispatch — 2026-08-11 18:20Z

`daytona-mount-proof-0811` is registered on the exact existing node
`node_212862301507432448`; the placement receipt matched its handler and
dispatched node IDs. It must reuse sandbox
`dedfeb9a-8682-4b89-957f-5bd15603ee0c` and Relay workspace
`50587328-441d-4acb-b8f3-dbe1b3c5de99` without cloning, reprovisioning, or
creating a replacement workspace.

The lane is blocked before provider mutation. Cloud `#2991` merged as
`5c90d2994` but is not in production: run `31516360915` failed during `sst
diff` because the production SST secret `TranscriptionWorkerServiceToken` has
no value. A later GitHub repository-secret update does not itself seed SST, and
there is no later deploy run.

Read-only review found four additional proof gates in the merged code:

1. `/workspace` is the default mount root even though unprivileged Daytona uses
   `/home/daytona/workspace` and cannot create `/workspace`.
2. Refresh-loop variables are assigned after `node -e`, making them argv rather
   than environment; the mount would lose refresh around its first 55-minute
   tick.
3. The Relayfile token remains visible in the mount process argv.
4. The provisioning route has only a broad boolean full-workspace write mount
   and cannot retrofit the existing sandbox.

The source projection also fails the required `known-true-now` check: workspace
`rw_7ccfea89` returns 404 for merged Cloud PR `#2991` and its newest projected
PR is `#2873`. GitHub reports `healthy`/`lag: 0s` despite its last provider event
being about 203 hours old; Linear is about 285 hours old. Those scopes are
uncertified until content currency, not merely a green health label, is restored.

Fix, generated-shell execution tests, independent review, production deploy,
and a valid existing-sandbox attach path are prerequisites. The final proof
must still capture all named multi-host assertions plus dispatched-node and
on-target-process identity. The 24-hour node gate is not due until about
2026-08-12T09:22Z.

## Relayfile mount closeout — 2026-08-11 19:28Z

Replacement owner `daytona-relayfile-closeout-barry-0811` ran on Barry and
reused the exact existing Daytona node, sandbox, and Relay workspace; it did
not clone, reprovision, or mutate the historical worker. The original node
enrollment had no Relayfile mount. The owner verified that the authenticated
production route still returned HTTP 404 at 17:25:04Z, so mounting and the
downstream currency/write assertions were not attempted.

Production run `31516360915` reached the deploy target and failed because the
SST secret `TranscriptionWorkerServiceToken` has no value. A production admin
must set the correct GitHub Actions or production SST secret and trigger a new
production deploy. Until then, there is no honest full mount proof. After a
successful deploy, resume on the same resources and capture:
`workspace-joined-not-created`, `scope-declared`, `mirror-matches-cloud` with
coverage, `known-true-now`, `cross-host-write-visible` or the exact read-only
rejection, `placement-target-live`, `placement-executed`, and `nothing-cloned`.
The replacement owner was released after this blocker and evidence were made
durable. Chief owns reappointment after the production secret/deploy unblock.

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

### 2026-08-11

- Lead passed to `daytona-lead-0811v3` after v1 and v2 both failed due to task-injection silence (brief dropped at spawn for local PTY agents — 1420-byte log files, raw banner only).
- **`cloud#2984` opened.** Three files changed:
  - `packages/web/app/api/v1/fleet/nodes/sandbox/route.ts` — new `POST /api/v1/fleet/nodes/sandbox` route that calls `provisionFleetSandboxNode()`.
  - `packages/web/lib/daytona-auth.ts` — new `createSharedDaytonaClient()` export shared across fleet routes.
  - `deploy/daytona/relay-sandbox-entrypoint.sh` — path C (`start_fleet_serve`, `truthy`) removed.
- **Design decisions recorded:**
  - `autoStopInterval: 0` — disables Daytona's idle timer for fleet nodes. Daytona auto-stop measures inactivity at the API level; relay heartbeats are outbound-only and don't reset the Daytona idle clock. Per Daytona SDK, `0` means no auto-stop. All existing call sites use 5–60 min values that would stop a healthy fleet node.
  - No relayfile mount at enrollment time — bare fleet nodes. Mount can be added post-enrollment via `startFleetSandboxRelayfileMount()`.
  - Path C confirmed dead: `agent-relay fleet serve` exits 1 at relay@v11.4.x; nohup discarded the exit code; `AGENT_RELAY_FLEET_ENROLLMENT_TOKEN` was never written; `AGENT_RELAY_FLEET_SERVE` was never set. Three closed gates in front of a broken command.
- CI queued (Smoke Sandbox Image + CI + Snapshot Impact Check). Awaiting Khaliq merge.
- **Next:** after merge, run Phase 1 proof: `POST /api/v1/fleet/nodes/sandbox` → poll roster → verify `online` + `spawn:*` → 24h liveness check with `lastHeartbeatAt` advancing. Credential availability confirmed (Daytona credentials are available on the web server; `createSharedDaytonaClient()` uses the same SST Resource path as existing cloud agents).

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
