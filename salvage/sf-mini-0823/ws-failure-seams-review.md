# REVIEW — composed integration `3271bd48` (agent-box live-session migration)

Reviewer: abx-seams-review (independent, unpaired)
Target: `origin/integration/agentbox-compose-0822` @ `3271bd48`
Method: read the composed diff and the shared contract; probe the lane seams
for cross-lane defects only; treat interior lane behaviour as owned by
`abx-seams-oc`.

## Preconditions — state of play

- **Contract file `/tmp/ws-failure-seams-contract.md` never appeared** in this
  reviewer's environment (nor `/tmp/ws-failure-seams-status.md`, nor the
  `/tmp/agentbox-compose-review.FNqlj3` worktree). The paired reader
  (`abx-seams-oc`) is running but its log is 2 lines and has been idle for
  the whole session. Nothing to review from it — this review is therefore
  independent of, not paired against, the OC agent's output.
- Composed revision confirmed present at
  `origin/integration/agentbox-compose-0822 @ 3271bd48b`: merges
  `lane/agentbox-sync-turn-0822` on top of the earlier
  `lane/agentbox-cutover-0822` merge, both against `lane/agentbox-transcript-0822`.
- No harness registration token available in this session, so the DM to
  `agentbox-review-codex-0823` cannot be sent from here. This document
  is the durable channel; treat it as the review.

## Verdict

**REJECT** — three concrete correctness defects at the seams. Two are
narrow enough to fix in this composed branch; one (portable-journal
verification gate) is a contract-shape issue that must be resolved before
`§4.4` can be trusted on the downgrade path. Also: this composition ships
components + tests only. There is **no wiring** — no adapter binds the
`PrewarmDriver` port to `box-manager.ts`, no `MigrationStore`,
`TurnAdmissionController`, `DestinationVerifier`, or `*Deps` implementations
exist outside tests. The "definition of done" (§6) is not close.

## Seam findings — cross-lane correctness

### S1. `SyncSealFailedError` escapes the orchestrator instead of aborting  [BUG]

`packages/web/lib/agent-box-migration/sync.ts:117-130` documents
`SyncSealFailedError` as "treat it exactly like an `unreadable` verdict —
abort to source". `packages/web/lib/agent-box-migration/orchestrator.ts:436`
calls `sealAndConverge` **outside** the try/catch in `finishDrain`
(`orchestrator.ts:447-466`). If the source cannot be sealed:

1. `SyncSealFailedError` propagates out of `finishDrain` back through
   `pollDraining` / `forceDrain` to the caller.
2. Row stays in `draining` with `admissionStopped: true`. Source is frozen
   (turns refused) with no state transition and no rollback.
3. Next poll re-enters `pollDraining`, boundary is still complete, calls
   `finishDrain` again → same throw. Livelock until an operator runs
   `abort()`.

The contract's stated contract is not enforced by the sole writer. Wrap
`sealAndConverge` in the same try/catch pattern that `relocate` uses:
`SyncSealFailedError` → `rollbackToSource` + `writeTransitionOrAcceptRace("draining","aborted", { abortReason })`.

RED-first test: mock `SyncConverger.sealAndConverge` to throw
`SyncSealFailedError`; expect the row to end in `aborted` with
`admissionStopped=false` and `prewarm.release` called. Add to
`orchestrator.test.ts` alongside the existing `finishDrain` cases.

### S2. `pollSyncing`↔`abort` race can leave source with admission stopped [BUG]

`orchestrator.ts:345-365`. In `pollSyncing`, `turnAdmission.stopAdmitting`
is called BEFORE the CAS write that persists `admissionStopped: true`. If a
concurrent `abort()` (which reads the row's *pre-stop* value of
`admissionStopped=false`, `orchestrator.ts:531-539`) wins the CAS to
`aborted`:

- pollSyncing's `stopAdmitting` has already run against
  `TurnAdmissionController`.
- pollSyncing's `writeTransition` CAS fails (StaleTransitionError, thrown
  because this is not a `writeTransitionOrAcceptRace` path).
- `abort()`'s `rollbackToSource(record)` sees `record.admissionStopped=false`
  and skips `resumeAdmitting`.
- Source is admission-stopped indefinitely. Migration row says `aborted`.
  Operator sees "aborted, source safe" — source is not.

The single-writer rule is not the same as single-process; two concurrent
poll invocations for the same migration are exactly what
`transition`'s CAS was documented to defend against (`orchestrator.ts:122-127`).
This case is missed by the current implementation. Two acceptable fixes:

- Have `abort()` always call `resumeAdmitting` (idempotent per the port
  doc) rather than gate on `record.admissionStopped`.
- Reverse the ordering in `pollSyncing`: attempt the CAS first with the
  intended effect, then run `stopAdmitting` only after a successful
  transition. This flips the failure mode to "admission not yet stopped
  but state says draining", which is a *strictly* safer error (source is
  still authoritative and can still take a turn) than "admission stopped
  with no rollback path".

RED-first test: harness a fake `MigrationStore` whose CAS is scripted to
succeed on the `abort` call and fail on the concurrent pollSyncing call
(both racing the same `syncing` row). Expect final state: `aborted` AND
`TurnAdmissionController.resumeAdmitting` called exactly once.

### S3. Portable-journal fidelity cannot pass the §4.4 verification gate [DESIGN GAP]

`transcript.ts:329-361` + `orchestrator.ts:489-506`.

On the forced-drain path, `relocate` returns
`fidelity: "portable-journal"` and
`expectedTurnCount: journal.expectedTurnCount` (the source-side journal's
turn count). Later, `pollVerifying` compares that expected count against
`deps.reportTurnCountFromDestination(handle)` — which asks the destination
harness how many completed turns it has.

The destination on this path did NOT receive the transcript. It received
a `contextPrompt` first-turn brief via `deps.deliverPortableJournal`. When
the destination reports its own turn count, it will be 0 (nothing has
happened yet) or 1 (after answering the brief). It cannot equal the
source's journal count (`3` in the current tests). The transcript
verification then fails, the deadline expires, and the migration aborts —
by construction — every time the drain is forced.

The unit tests in `transcript.test.ts` hide this because the mock
`reportTurnCountFromDestination` is scripted to return the expected value.
That mock is not achievable in production without either:

- a special "how many turns did the resume brief cover?" report from the
  destination harness (not evident anywhere in the diff), OR
- redefining `expectedTurnCount` on the portable-journal path to be
  something the destination can actually reach (typically 1 after the brief
  turn), which changes the contract semantic.

This is a real cross-lane seam defect. Either:
- Change `TranscriptVerification` semantics: the check on the
  portable-journal path is "brief accepted, one turn observed", not a
  transcript-turn-count match. Codify this in `contract.ts` §6 and gate
  `verifyAtDestination` on `fidelity`.
- Or add a `TranscriptVerification.mode` field so the gate can compute the
  right predicate.

Either fix must land before the composed branch can claim §4.4 works on the
downgrade path. Right now the contract's own §4.4 gate is unfalsifiable in
mocks and impossible in production for `portable-journal`.

RED-first test: production-realistic `reportTurnCountFromDestination`
returning `1` (post-brief) with `expectedTurnCount: 3` (from journal); assert
current behaviour ends `aborted` for a forced drain; then land the fix and
assert `active`.

## Seam concerns — likely non-defects, worth flagging

### C1. `sync.ts` in-memory `syncingSinceMs` is not durable across restarts

`sync.ts:181, 244-253`. The `syncingSinceMs` clock lives in a per-process
`Map`. On orchestrator restart during `syncing`, the clock resets and the
`admissionDeadlineMs` (default 60s) livelock guard restarts. On repeated
restarts (which the Cloudflare/Worker environment makes cheap), the drain
never admits. Contract doesn't require this to be persisted, but if the
orchestrator ships on any surface where processes recycle every N minutes,
this will manifest. Either persist `enteredSyncingAt` on `MigrationRow` (a
contract change) or seed it from `MigrationRow.updatedAt` on the syncing
transition.

### C2. `pollDraining` has no auto-force

Comment at `orchestrator.ts:376-378` says the deadline is deliberately
not handled by the poll loop — force is an operator action. Consequence: a
draining migration with no operator surface will sit in `draining` past its
deadline until manually aborted or forced. Confirm the operator path
(HTTP/CLI) exists in the wiring layer (which isn't in this diff — see
"Not-wired" below). Not a defect within this branch, just an unowned
prerequisite.

### C3. `workingTreeDigestMatches` reads its own writes

`orchestrator.ts:648-653` computes `manifestSha256 === manifestSha256` on
values written into the row when the verdict was `converged`. This is a
sanity check, not an independent verification. The comment acknowledges
this. Fine as documented; call out to future readers that §4.4 has three
independent checks and one defensive re-check.

### C4. Turn-boundary parser re-reads full transcript per poll

`transcript.ts:64-82`. For a large transcript this is fine at the current
poll cadence, but note the O(bytes) cost per `pollDraining` tick. If poll
cadence rises or transcripts grow, add an offset-parametrised variant.

### C5. `verifyAtDestination` on native path relies on destination re-parse

Fine, but note: `expectedTurnCount` on native is
`boundary.completedTurnCount` from the source's own parser. If the
destination's harness has a different notion of "completed turn" (a bump
one version away, per §5's warning), the gate goes red for an entirely
successful migration. This is the same risk the slug-derivation code
mitigates with an explicit "pinned to a harness version" note — deserves
the same pin here.

## What is NOT in this composed branch

- **No adapter** binding `CloudAgentBoxWarmPort` (contract seam) to the
  shipped `box/box-manager.ts` warm pipeline. `prewarm.ts` is the driver
  over the port; the actual bridge into the real warm queue is missing.
- **No `MigrationStore` implementation.** The `transition` CAS is the
  single-writer rule's enforcement — with no store there is no enforcement.
- **No `TurnAdmissionController` implementation.** Contract §1 documents
  who is supposed to expose this; there is no repo-wide "stop admitting new
  turns for cloud agent X" primitive. `orchestrator.ts:81-96` calls out
  the search that came up empty. New surface, unspecified.
- **No `DestinationVerifier` implementation.** `harnessAlive` /
  `brokerRegistered` have no concrete probes.
- **No `*Deps` (`SyncConvergerDeps.exec/resolveMounts/flushSource`,
  `TranscriptRelocatorDeps.*`) implementations.** All lane-internal ports.
- **No HTTP / cron / DO surface** that drives the polls. `MigrationOrchestrator`
  is a class that never gets constructed anywhere in this diff.

Grep confirms this: `git grep -l "MigrationOrchestrator|createSyncConverger|createTranscriptRelocator" 3271bd48`
returns ONLY the source and test files for those factories. No caller.

Consequence for Khaliq's Q4 (is there any end-to-end proof?): **no, not
even a plumbed-through call site**. The five PRs compose to a well-typed
component set with strong unit tests and zero live-fire evidence.

## Recommended merge order

1. **#3121 (design)** and **#3123 (contract)** — already clean.
2. Fix S1 and S2 on top of the composed branch, land as a small
   "compose-fixes" commit (not a lane rewrite). S1 is a two-line move; S2
   is either a one-line change in `abort()` or a re-ordering in
   `pollSyncing`.
3. Reach a decision on S3 (contract change vs new field on
   `TranscriptVerification`), amend contract, then land the amended
   `#3126` (transcript) — currently marked DRAFT, which is correct.
4. Only then land **#3125 (sync)** and **#3127 (cut-over)**.
5. **Do NOT merge before the wiring layer exists.** The composed branch is
   safe to sit as an integration branch, not to fast-forward `main` onto.
   Add a follow-up (owned by integration lead) that ships the adapters
   above and a single end-to-end fixture ("migrate a running Claude Code
   session between two Daytona sandboxes across a turn boundary") before
   any of these merge.

## Signals that the composition itself IS coherent

Where the lanes agree, they agree well:

- `MIGRATION_TRANSITIONS` (contract.ts:61) matches the doc table
  (`spec §1`) exactly. Only orchestrator writes state.
- `evaluateTurnBoundary` is a single function in `transcript.ts`
  and re-exported via `TranscriptRelocator.evaluateTurnBoundary`.
  Orchestrator consumes only the interface method
  (`orchestrator.ts:384, 414`) — no second tail-parse anywhere.
- `convergenceAllowsCutover(v) === (v === "converged")` is enforced at
  the sole gate (`orchestrator.ts:437`); no `forced` escape hatch exists
  in `ConvergenceVerdict`.
- Forced drain forbids `native` fidelity in code
  (`transcript.ts:341-361`), not by convention.
- `sealAndConverge` refuses on `outbox_needs_attention` and `ephemeral_paths_present`
  (per `sync-convergence.md §4`) rather than downgrading.
- Cursor-plus-hash convergence (not hash-only) matches the "hash was true,
  conclusion was wrong" argument (`sync-convergence.md §2`).

The seams that were meant to hold, hold. The defects are all in orchestration
edges the contract doesn't type-enforce — precisely the class Khaliq asked
for extra scrutiny on.

## Deliverable posture

- Not sent as DM: reviewer harness lacks an agent token; MCP
  `mcp__agent-relay__*` tools are not surfaced in this session and
  `agent-relay agent register` requires an existing token to rotate. This
  file is the review of record.
- Not written to `/tmp/ws-failure-seams-status.md`: that file is owned by
  the paired OC agent, which has not produced it. Writing there would
  usurp the OC lane. Wrote to `/tmp/ws-failure-seams-review.md` (this
  file) instead.
