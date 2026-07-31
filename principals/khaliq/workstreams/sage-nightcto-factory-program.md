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

**Now:** Implementation is complete and inert. The canonical feature audit ran
clean for both repos, Cloud dynamic routing regressions pass, and #217/#218
carry no dispatch recipe gate, so nothing can fire. Activation waits on the two
gates below. Ownership was requested by an agent relaying Khaliq's direction and
later reported as directly confirmed — Chief records that with provenance intact
rather than as direct confirmation, and the ingestion scope stays gated on
Khaliq's own word. Chief has had no outbound Relay channel for this entire
program: no `agent-relay` MCP tools resolved in this session, so every ACK,
decision, and correction below reached the worker only if Khaliq relayed it.

**Next:** Deploy the checked-in `cloud-factory-brain` persona and read the spec
back non-empty, then enrol one node advertising `workflow:run` plus the Sage and
NightCTO repo tags — the two activation gates below. Separately, Khaliq still
owes a direct word on the Slack/Granola ingestion scope and a decision on which
AR-448 PR survives; neither blocks the gates, but ingestion cannot start without
the first and fleet identity should not be finalized without the second.

## Priority and dependency map

Ordered by what unblocks the most. Dependencies point at what must land first.

| # | Item | Depends on | State |
|---|---|---|---|
| 1 | RelayAuth D1 capacity recovery (gated #2857) | Khaliq's explicit grant | Blocking. No Relayfile provider writeback, so no Linear checkpoints or fresh scoped credentials. |
| 2 | Hosted Factory contract actually configured | 1 | `cloud-factory-brain` has empty `inputValues`/`inputSpecs` — no `repoByLabel`, no `defaultRepo`. Hosted dispatch has been riding on Chief's removed hardcoded defaults. |
| 3 | Sage + NightCTO gated workloads | 2 | Config shape depends on which contract home applies (below). |
| 4 | Mac mini execution nodes | 2, 3 | Two nodes online (`sf-mini` 11.1.1, `chief` 11.2.0), both advertising `spawn:codex`/`spawn:claude`, neither yet advertising repo tags or `workflow:run`. Remaining blocker is deploying and enrolling a node with the real config — **not** central `clonePaths`, see the correction below. |
| 5 | NightCTO test baseline | — | **Resolved 2026-07-31.** Opened the program failing on no-test-files-fatal Vitest configs; now 909 tests pass with 2 live-PostgreSQL skips and strict build/typecheck/featuremap/test/E2E green. "Tests pass" is a usable gate again. |
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

### Correction: empty central `clonePaths` is by design

Chief called `clonePaths: {}` (orchestrator lines 431, 474) a placement blocker.
That was wrong, and the implementation agent's correction is the better
reasoning. Placement is node-local: Cloud sends the *resolved repo* on
`workflow:run`/spawn, and each eligible Mac owns its own `factory.node.json`
`clonePaths` while advertising `repo:<owner/name>` plus `workflow:run`. No host
name participates in routing, which is what makes the workers interchangeable.

A central `clonePaths` map would be Cloud restating each machine's filesystem
layout — the same duplicated-authority mistake as Chief's old `work.factory`
block, one layer up. Empty is correct.

Reported verification: the real `@agent-relay/factory/node` definition imported
against generated Sage/NightCTO mappings, resolving tags `[factory,
workspace:rw_test, repo:AgentWorkforce/sage, repo:AgentWorkforce/nightcto]` and
capabilities `spawn:claude`, `spawn:codex`, `workflow:run`. Chief confirmed the
`"./node"` export exists in `factory` `origin/main` `package.json:53` and that
the P13 node-definition work is present, but did not reproduce the mapping run.

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

## Chief's decisions (2026-07-31)

Recorded so they exist when the channel opens. Sequencing and tracking are
Chief's to call; authority and data access are not.

**Sequencing — confirmed as the table above.** The two Cloud-side blockers
(RelayAuth capacity, the empty deployed spec) gate everything downstream, so
audits and contract authoring are the only items that can proceed in parallel
today. Both are preparation and neither dispatches.

**#217 stays a separate issue from the product-insights program. Decided.** It
is a runtime and persona migration; insights are a capability built on top of
it. The brief itself requires insights to integrate with #217's canonical
persona/runtime rather than recreate an HTTP delegate — which makes #217 a
*dependency* of insights, not the same unit of work. Folding them together
would make #217 uncloseable on its own evidence and produce one mega-issue that
never satisfies the source + tests + feature-proof closure rule.

**Sage Cloud boundary — the line is endorsed, the extraction is deferred.** The
proposed split is sound and matches how `relayfile-cloud` and
`relayhistory-cloud` were carved out: `sage-cloud` owns the Sage product
runtime (worker, queues, DO/KV or DB, schedules/crons, migrations/ops), shared
`cloud` retains auth/workspaces, Relayfile/Nango connections, and
fleet/control-plane contracts. What Chief will not do is start the extraction
now. Moving a production runtime while the Factory meant to build it is
unproven, RelayAuth is at its D1 ceiling, and workspace identity resolution is
unsettled inverts the risk order. It stays item 7, after #217 proves the path.

**Not Chief's to decide, and still open:** program ownership on relayed
authority, the Slack/Granola ingestion scope, and which AR-448 PR lineage
survives. All three need Khaliq directly.

## Constraints Chief holds

- `mergePolicy: never`, terminal state `human-review`. No automated merge or
  release.
- Issue closure requires source + tests + feature-map/critical-path evidence.
- One control plane. Integrate with the existing Cloud Factory and AR-448 work;
  do not stand up a second.
- A claim belongs to the work unit and a dispatch gate fails closed — the
  AR-448 duplicate lesson applies directly to a fleet with more claimants.

## Activation gates

Implementation is complete and inert. Chief holds activation until **both**:

1. The checked-in `cloud-factory-brain` persona is deployed and read back — the
   spec must be non-empty on the deployment, not merely committed. This is the
   long-standing item 2 blocker, now the primary one.
2. A node advertises `workflow:run` plus the Sage and NightCTO repo tags.

Then, and separately, the Cloud-backed dry-run workspace join must succeed
before real dispatch. `#217`/`#218` carry no dispatch recipe gate, so they stay
inert on their own — the gates above are what turn the program on, and
`mergePolicy: never` with terminal `human-review` survives activation.

## History

- 2026-07-31 — Final implementation checkpoint recorded. Canonical feature
  audit run `68486810c6ddac406efb94a1` completed 24/24 steps with 0 failures.
  **Sage:** 15 categories, 100 features; strict build/typecheck/featuremap/test/
  E2E green; 1,168 tests pass with 5 pre-existing skips; guardian 41/41;
  Factory validate-only passes for both #217 and #218. **NightCTO:** 13
  categories, 63 features; strict gates green; 909 tests pass with 2 live
  PostgreSQL skips; guardian 40/40; 54 deterministic feature records pass, 7
  live SKIP, 2 MANUAL; a pre-existing infra/gcp audit carries 19 findings not
  owned by this program. **Cloud dynamic routing regression:** typecheck green,
  148 focused tests, 83 persona tests, 3 replaceable-node config tests; the
  GitHub repo comes from the event, Linear mapping is runtime input, and
  node-local clone maps plus repo tags keep the Mac minis interchangeable.
  Nothing deployed, restarted, dispatched, merged, released, scheduled, or
  live-posted.

- 2026-07-31 — The implementation agent reports that Khaliq's controlling task
  explicitly authorizes Chief ownership and Sage ingestion of all Slack content
  the installed app can access plus Granola call data, with Cloud as the durable
  control plane and interchangeable Mac mini workers. **Chief records this with
  its provenance intact and does not mark it directly confirmed.** The report
  arrives through the same agent whose authority is the open question; an agent
  asserting a confirmation is not the confirmation. Writing "Khaliq directly
  confirmed" into the brain on that basis would launder relayed authority into
  settled fact, and a future session would read it as licence to build
  collectors against org-wide Slack and call recordings. The claim is very
  likely true. That is not the standard for this scope. One line from Khaliq in
  any channel he uses directly clears it.
  Verified in the same checkpoint: sage#80, #121, #156, #157 closed
  `NOT_PLANNED` at 11:11Z — the honest reason for stale and misplaced work
  rather than `COMPLETED` — and #157's content was rehomed as relay#1414
  (Slack Block Kit onboarding controls), open, rather than dropped. Nothing
  deployed, restarted, dispatched, merged, released, or D1-cleaned.

- 2026-07-31 — Chief ACKs the implementation checkpoint. Verified independently:
  Sage #218 exists, OPEN, carrying `program:sage-product-insights` and nothing
  else — correctly *not* `factory-ready`, so the ingestion scope stays gated
  while the tracking issue exists. Closures of #189, #82, and #84 each cite a
  merged PR plus named current-state artifacts (#189 → PR #190 with the
  `tool-discipline.public-repo-deep-look` eval; #82 → PR #210 with `npm run
  evals`, `evals:provider`, `evals:compare`, and `sage-evals.yml`), which meets
  the source + evidence closure rule. Sequencing and the sage-cloud boundary
  stand as decided above; no correction needed.
  Outstanding caution: "Cloud dynamic routing typechecks" is not "deployed and
  proven". The Cloud-backed dry-run workspace-join failure is still open, and
  until it resolves, placement remains unverified at runtime regardless of what
  compiles.

- 2026-07-31 — `sage-nightcto-factory-map-20260731` requested Chief ownership
  of the program and relayed the distributed-Factory topology (Cloud as durable
  control plane, Mac minis as registered execution nodes). Chief recorded the
  map and is holding for Khaliq's direct confirmation. Canonical feature audit
  run `68486810c6ddac406efb94a1`. Sage baseline: build/typecheck pass, 1127
  tests pass, 5 skipped. NightCTO baseline: build passes, tests fail on
  no-test-files-fatal Vitest configs.
