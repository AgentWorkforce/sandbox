---
status: active
owner: chief-khaliq
updated: 2026-07-31
repos: [sage, nightcto, cloud, relay, chief]
---
# Sage + NightCTO distributed Factory program

**Goal:** Sage issue #217 lands production-real through a running Factory, with
exhaustive executable feature maps for Sage and production NightCTO, and Sage
issues closed only against verified feature proof.

**Now:** Ownership requested by `sage-nightcto-factory-map-20260731`, which
relays it as Khaliq's explicit direction. Chief has **not** confirmed that
directly with Khaliq and is holding the program at map-and-record until he
does. The worker's concrete claims verify: both worktrees exist on their stated
branches, `sage#217` and `sage#216` are open. Chief cannot acknowledge over
Relay — it has no `agent-relay` MCP tools this session, so the worker's request
for acknowledgement and checkpoints is unanswerable until that is fixed.

**Next:** Get Khaliq's direct confirmation of the topology direction and of
Chief's ownership, then record readiness criteria. Nothing dispatches before
that; the worker was explicit that continuous autonomous execution waits on
Chief recording direction/readiness, which matches the merge gate.

## Priority and dependency map

Ordered by what unblocks the most. Dependencies point at what must land first.

| # | Item | Depends on | State |
|---|---|---|---|
| 1 | RelayAuth D1 capacity recovery (gated #2857) | Khaliq's explicit grant | Blocking. No Relayfile provider writeback, so no Linear checkpoints or fresh scoped credentials. |
| 2 | Hosted Factory contract actually configured | 1 | `cloud-factory-brain` has empty `inputValues`/`inputSpecs` — no `repoByLabel`, no `defaultRepo`. Hosted dispatch has been riding on Chief's removed hardcoded defaults. |
| 3 | Sage + NightCTO gated workloads | 2 | Config shape depends on which contract home applies (below). |
| 4 | Mac mini execution nodes | 2, 3 | Registration, capability-aware claiming, leases/heartbeats, artifact return. |
| 5 | NightCTO test baseline | — | Independent; several package-local Vitest configs treat no-test-files as fatal, so "tests pass" is not yet a provable gate. Fix before it gates anything. |
| 6 | Sage #217 through Factory | 1–4 | The program's outcome. |
| 7 | sage-cloud boundary extraction | 6 | Sequence last; extracting a runtime under an unproven Factory adds risk. |

## Contract homes — correction the worker needs

Factory has two execution modes with two different contract homes, and the
program spans both:

- **Hosted Cloud Factory** (what Chief dispatches through) reads the deployed
  brain's spec, workspace-scoped: `spec.capabilities.factoryBrain.triage`
  carries `repoByLabel`, `defaultRepo`, `defaultRecipe`, `maxImplementers`,
  `harness`. It does not read `factory.config.json`.
- **Local Factory loop** reads `factory.config.json` at the repo root, as
  `hoopsheet`, `factory`, and `pear*` do.

So "define Sage and NightCTO factory configs" resolves differently depending on
whether those workloads run hosted or on the Mac mini nodes. The Mac mini fleet
described in the brief is a *third* shape — registered execution nodes claiming
from a Cloud queue — and which contract governs them is undecided.

## Constraints Chief holds

- `mergePolicy: never`, terminal state `human-review`. No automated merge or
  release.
- Issue closure requires source + tests + feature-map/critical-path evidence.
- One control plane. Integrate with the existing Cloud Factory and AR-448 work;
  do not stand up a second.
- A claim belongs to the work unit and a dispatch gate fails closed — the
  AR-448 duplicate lesson applies directly to a fleet with more claimants.

## History

- 2026-07-31 — `sage-nightcto-factory-map-20260731` requested Chief ownership
  of the program and relayed the distributed-Factory topology (Cloud as durable
  control plane, Mac minis as registered execution nodes). Chief recorded the
  map and is holding for Khaliq's direct confirmation. Canonical feature audit
  run `68486810c6ddac406efb94a1`. Sage baseline: build/typecheck pass, 1127
  tests pass, 5 skipped. NightCTO baseline: build passes, tests fail on
  no-test-files-fatal Vitest configs.
