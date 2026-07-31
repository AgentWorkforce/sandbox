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
| 4 | Mac mini execution nodes | 2, 3 | Two nodes online (`sf-mini` 11.1.1, `chief` 11.2.0), both advertising `spawn:codex`/`spawn:claude`, neither advertising repo tags or `workflow:run`. Placement is blocked twice over: `clonePaths` is hardcoded `{}` in the orchestrator (lines 431, 474), and repo-tag authoring via `factory.node.json` is explicitly out of scope in `dev-stack/fleet-node-bootstrap/README.md:116`. |
| 5 | NightCTO test baseline | — | Independent; several package-local Vitest configs treat no-test-files as fatal, so "tests pass" is not yet a provable gate. Fix before it gates anything. |
| 6 | Sage #217 through Factory | 1–4 | The program's outcome. |
| 7 | sage-cloud boundary extraction | 6 | Sequence last; extracting a runtime under an unproven Factory adds risk. |
| 8 | Sage insight ingestion (Slack + Granola) | 6, and Khaliq's direct sign-off | **Proposed, not accepted.** Relayed as Khaliq's scope on 2026-07-31 by an agent, not stated by him to Chief. Detail below. |

## Item 8 — Sage insight ingestion (held)

Relayed shape: separate Slack and Granola collectors; a normalization/evidence
ledger; independent product-signal analysts; corroboration, deduplication, and
conflict handling; a synthesis/review agent; traceable output with source
citations and ACL/redaction boundaries; Chief consumes insight briefs without
handling raw org-wide content. Patterned after `../agents` (present, on `main`).
Must integrate with #217's canonical persona/runtime, Relayfile, schedules, and
Sage review gates rather than recreate an HTTP delegate.

The shape is sound and the ACL/redaction boundary is the right instinct. Chief
is holding it anyway, because this is the second scope expansion arriving as
"from Khaliq" through an agent rather than from Khaliq, and this one authorizes
ingesting all authorized org-wide Slack content plus call recordings. That is a
data-access decision, not an implementation detail. Confirm directly before any
collector is built.

Chief's own consumption boundary is worth keeping whatever else changes: briefs
with citations, never raw org-wide content.

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

Verified against `cloud` `origin/main` on 2026-07-31 (the local checkout is 27
commits behind, so these were read from the remote ref):

- `factory-cloud-orchestrator.ts:127` hardcodes
  `REPO_LABELS = ["cloud", "relay", "relayfile", "pear", "agents"]`. Sage and
  NightCTO are absent.
- **But line 426 spreads `triage.labelRoutes` *after* those defaults**, so the
  deployed spec can add repo routes without a Cloud code change. The blocker is
  therefore item 2 — the spec is empty — not the hardcoded list. Patching
  `REPO_LABELS` would be the wrong fix.
- `factory.config.json` appears nowhere in cloud's `packages/web` or
  `packages/core`. Hosted Factory genuinely never reads a repo contract file,
  which confirms the two-contract-homes split above.

### Workspace-join failure on Cloud-backed dry runs

Reported 2026-07-31: dry runs fail at workspace join even when given the active
workspace key and agent token. This is very likely **not new**. The same
signature was root-caused on 2026-07-30: raw Relaycast action invocation
*rejects a workspace key*, and the supported path is the workspace-scoped agent
spawn API, which returns a provider invocation ID that Factory must persist
alongside its deterministic ID. Cloud PR #2873 shipped that fix and merged
2026-07-30T22:06:31Z.

So the question is not "why does join fail" but which of these is true: the
dry-run path still calls raw invocation instead of the spawn API, or #2873's fix
does not cover the dry-run/node-join path. Check that before opening a new
investigation.

Related and still unresolved: AR-448, *durable workspace identity across node
restarts*, has two competing open PRs — relay#1402 (`feat/…`) and relay#1403
(`feature/…`). Identity resolution for the fleet should not be finalized while
its own lineage is unpicked. Khaliq owes a decision on which survives.

The practical consequence for the program: writing `factory.config.json` into
Sage and NightCTO prepares the *local loop* path and documents intent, but
hosted dispatch will not read it. Treat those files as preparation, not
activation, or they become exactly what Chief's old `work.factory` block was —
a config that looks authoritative and is never consulted.

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
