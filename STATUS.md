# Status — 2026-08-10, overnight

## 1. Awaiting you

### Ready to merge — needs your approval only

Branch protection requires a human review; I cannot satisfy it. Both are fully
vetted by the standard you set for #1464.

| PR | Title | State | CI |
|---|---|---|---|
| **relay#1445** | Report unbounded node load as unmeasured | 0 unresolved · `BLOCKED`/`REVIEW_REQUIRED` · `b044376b` = remote HEAD | **11/11 green** — CI, E2E Tests, Fleet E2E, Node.js Compatibility, Package Validation, Relay Evals, Security Scan, Test, Large File Check, both formatters |
| **relay#1444** | Stop a cleared enrollment reporting as a failure | 0 unresolved · `BLOCKED`/`REVIEW_REQUIRED` · `f02a0108` = remote HEAD | **11/11 green** — same set plus Stress Tests |

Both are small, self-contained fixes whose behaviour CI actually exercises. I
merge the moment `reviewDecision` clears.

### Decisions only you can make

1. **`factory#223` — design ruling.** I stopped the PR. The lead has posted the
   public design-stop artifact: <https://github.com/AgentWorkforce/factory/pull/223#issuecomment-5235315856>
   — state table, CAS-gated completion rule, both P1s with reproduced evidence,
   and **the seam: declarative intake/discovery can split with activation
   disabled, but the current claim/state-store/orchestrator execution cannot ship
   as-is.** That sentence is your split-or-hold decision. Details in §3.
2. **`cloud#2963` / `cloud#2981`** — a `cloud` merge fires a full SST production
   deploy. Held for your explicit nod even at 0 unresolved.
3. **`relayfile-coordination-lead-0809` is holding four decisions for you.** It
   said everything it could do without your authority is done. I asked it to
   restate them as four one-liners; it has not answered and may be dead.

---

## 2. Landed tonight

**`cloud#2963` MERGED** — squash `52ebc1d8a1`, **into `codex/2945-warm-provisioning`, not `main`.** No deploy fired; this is a stacked PR.

**I had this PR badly wrong and the lane corrected me.** I told it the diff was
"~1,586 insertions across `packages/web`" and that CI skipping every test job
implied a path-filter gap. Both false:

- **`#2963` is stacked.** Its base is `codex/2945-warm-provisioning` at
  `26c126d5`, not `main`. The real delta is **6 files, +976/-18**, all under
  `dev-stack/fleet-node-bootstrap/` plus one docs spec. **Zero `packages/web`
  files.** The web files I quoted exist only in the combined stack diff against
  `main` — I read the wrong diff and briefed from it.
- **`packages/web` is correctly mapped** in `ci.yml` (`code_checks` 58-70,
  `next_build` 76-89, `phase0` 94-101). CI skipped because it correctly diffed the
  stacked base and saw no web files. There is no web path-filter gap.

**Vetted locally by exit code**, since CI tested nothing:
`npm run typecheck` exit 0 · 9 changed web suites **171 passed / 0 failed** ·
`fleet-node-liveness.test.mjs` exit 0, 6 passed · `restart.test.sh` exit 0, 6
passed · `guard.test.sh` exit 0, 17 passed · `web build` exit 0 (120/120 static
pages) · OpenNext-CF build exit 0, emitted `.open-next/worker.js`.

The last thread was the errexit P2. I read the script rather than the reply:
`set -uo pipefail` is sufficient there because **there are no standalone
assertions** — `assert_grep`/`assert_dir`/`assert_eq` all route failure through
`bad()`, the `cloud enroll` negative check exits 1 directly, `grep -c` feeds
`assert_eq`, and the final gate is `[ "$FAIL" -eq 0 ] || exit 1`. Adding `-e`
would have been the riskier change.

**A real CI defect did come out of it — a different one than I guessed.** Filed
as **cloud#2982**: `Detect changed areas` has no `^dev-stack/` pattern, so a PR
touching only `dev-stack/**` greens CI without running its own `.mjs`/`.sh` tests.
The registry audit is TypeScript-only and cannot catch it. **A test nobody runs
reads as coverage**, which is worse than no test.


**`cloud#2981` MERGED** — squash `d936b9e6d4`, *bump `@relayauth/*` to 0.2.28*.
Merged on your explicit clearance of the SST deploy. **`Deploy` is running on
`main` now** — that is the production deploy, expected and authorised.

It went from 2 unanswered P1s + a failing test to clean, and the lane fixed both
for the right reasons rather than silencing them:

- **Migration admission.** Admitted `0007_attestation_ledger` at pinned SHA-256
  `d5861942…4563b6` — **and caught that the 0.2.28 bundle also ships
  `0008_identity_lineage`**, admitting its digest too, because the same
  fail-closed guard would otherwise have blocked the deploy anyway. The reviewer
  named one migration; the lane checked the bundle and found two. The originally
  failing test was **not edited**.
- **Worker bundle marker.** Verified in source, not from the reply:
  `packages/relayauth/src/worker.ts` reads `bundled @relayauth/server: 0.2.28` on
  the branch versus `0.2.26` on `main`, so SST sees handler-source drift and
  actually redeploys an existing stage. Without it the merge would have deployed
  nothing while appearing to succeed.

**Deploy completed: success.** The production deploy from this merge finished
clean.

**One post-merge failure, pre-existing and not caused by this merge:**
`Build Relay Sandbox Image` failed on `main` at `d936b9e6` — and has failed on
**every `main` run since 2026-07-31, eight for eight**:

```
failed to push ghcr.io/agentworkforce/relay-sandbox:d936b9e6…
denied: permission_denied: write_package
```

The GHCR token this workflow uses cannot write the package, so **the relay
sandbox image has not been rebuilt on `main` for ten days.** Nothing surfaced it
because the workflow only runs post-merge, where a red result has no audience —
the same shape as `#2963`'s skipped jobs: a check that exists but gates nothing.
Two secondary errors in the same build for whoever owns it: `/bin/sh: 1: codex:
not found` and `Failed to change directory to /version`.

**This needs a credential decision from you, so I did not dispatch it** — fixing
it means choosing a token scope, and guessing at that is how a permissions
problem becomes a secrets problem.

**CI was real evidence here, unlike `#2963`:** the `CI` run on `712b62ed` shows
**19 jobs success, 1 correctly skipped** (`Unit Tests (relaycast)`, untouched by
the diff) — including `Registered Tests (package suites)`, the job that was
failing, plus `Typecheck`, `Unit Tests (web)`, `Next.js build` and
`OpenNext-CF build`.


**`factory#225` MERGED** — squash `40f9be5ec4`, `main` CI green.
*Fall back to direct GitHub API when the Relayfile projection cannot answer.*

Both remaining threads were P1s already fixed and answered but never resolved by
the filing bot. I read both fixes in the source at head `91add5f1` before
resolving:

- **Private-repo 404 read as absence** — `GithubIssueLookup` is now three-outcome.
  A separate cached unauthenticated repo-level GET confirms visibility; an
  issue-level 404 only becomes `not-found` when that check returned a
  confirmed-public repo. 403/429 map to `indeterminate`, so an exhausted 60/hr
  unauthenticated budget cannot masquerade as absence.
- **Qualified selectors validated against only `repos.default`** — now validated
  against the union of `default`, `byLabel`, `byProject`, `keywordRules`, routed
  through the *same* `resolveGithubIssueRepoCandidates` canonicalization every
  route uses. Three prior rounds each found a different normalization gap in the
  hand-rolled comparison it replaced.

Blast radius stated before merging: source-only, no config, no secrets. `Publish`
is `workflow_dispatch`-only, so nothing published.

---

## 2y. `relaycast#307` MERGED — and the release chain I gave you was wrong

Squash `7121d04bd0` into `main`. Gates verified at `747c609b` = remote HEAD:
`CLEAN`, 0 unresolved, `CI: success`, `Preview Deploy` correctly skipped.

**The important part is not the merge — it is what the lane found.**

**The compatibility layer was already published.** It landed as `relaycast#308` /
`41bb8bcd`, and npm reports that exact `gitHead` for `@relaycast/engine`, `types`
and `a2a` at **7.0.0**. `#307` branched from a 6.3.2-era commit and **its runtime
and migration were superseded and dropped during the rebase.** What merged is
three files: one conformance test and two trajectory artifacts, +184/-1.

So the four-step chain I carried all night — merge, publish, bump, deploy — was
never real. **The actual gap is that `relaycast-cloud` pins `^6.3.x`, a full major
behind an engine that already ships the fix.** Removing `relay#1472`'s shim means
upgrading relaycast-cloud across the major, validating, deploying via SST and
verifying the live engine. **No relaycast publish is required.**

**The migration** (`0034_node_load_reporting.sql`, already on main and published):
adds `load_reported INTEGER NOT NULL DEFAULT 0` to `nodes` and `node_providers`,
and corrects broker aggregates to `max_agents=0` when any provider is unbounded.
Historic rows all get `load_reported=false`; none backfilled true. **Forward-safe
yes. Reversible no** — there is no down migration, and dropping columns on
SQLite/D1 requires a table rebuild.

**One precision the lane volunteered rather than papering over:** the raw `load`
cell remains `NOT NULL` and *is* `0` when `load_reported=false`. The authoritative
value is the **pair `(0, false)`** — zero alone never means unknown, public reads
return `null`, and placement treats it as unknown. So "never coerced to `0`" is
satisfied by **provenance, not nullable storage**. It said plainly that if the
requirement meant the literal thing, 7.0.0 would need a new nullable migration.

Evidence: conformance 60/60, fleet wire 25/25, omitted+null persistence 2/2,
migration rehearsal exit 0, CI `31368333191` success. Read/write paths grepped
and named individually. **No path collision with `#319`.**

## 2z. `factory#223` MERGED — squash `67a5a57b4a`, into `main`

*"Add routed-PR intake and discovery (activation disabled)"* — the Option A split
you ruled on. All five gates verified at `f823d15c`, confirmed as remote HEAD:
`CLEAN`, **0 unresolved**, `CI: success` with all five jobs green plus both
reviewers.

**The split is stronger than "the feature is flagged off."** I pushed back when the
lane resolved the two P1 threads, because "disabled" and "unreachable" are
different claims and only the second licenses closing a thread — and the lease P1
lives in shared claim machinery that issue-created babysitters use today. Its
answer, which I then verified myself:

- **The effective diff against merge-base `33cda427` for `src/ports/state.ts`,
  both state stores, and `src/orchestrator/factory.ts` is EMPTY.** Exit 0.
- `completeRoutedPrBabysitter`, `#issueBabysitterClaims`,
  `markRoutedPrBabysitterRunning` and `releaseBabysitterBestEffort` **do not exist
  anywhere in the shipped tree.** They entered in `e73a082`/`fd3769d` and were
  removed in `f823d15`.
- What ships is **nine files**: config schema, the new
  `src/github/routed-pr-babysitter.*`, README, and feature manifests.

So the P1s are unreachable **because the code they describe is absent**, not
because a flag hides it. That is the difference between a split and a mute switch.

`ROUTED_PR_BABYSITTER_ACTIVATION_ENABLED = false` is a named constant at
`routed-pr-babysitter.ts:12`, with `routed-pr-babysitter.test.ts:44` asserting it
false — a test pinning the flag beats the flag alone.

**`factory#230`** carries the lifecycle design: the governing invariant, the full
`(T,F,R,E)` state table, and the two reachable-and-forbidden states. No labels, so
it will not auto-dispatch.

## 2a. `cloud#2946` MERGED — squash `639ec90c9d`, into `main`. **Deploy: success.**

*"fix(cloud-agents): detach Daytona box provisioning"*, +1586/-55 across 25 files,
head `43a1e6bf` confirmed as remote HEAD. **The four-day-old P1 was real and is
fixed.**

**What it was:** `warm-context.ts` awaited `sandbox.getUserHomeDir()`
unconditionally before returning the context; the first `state` check lives later
in `warm-step-runner.ts`. In the pinned `@daytonaio/sdk@0.180.0` that call is
`infoApi.getUserHomeDir()` → `GET /user-home-dir` on
`toolboxProxyUrl + sandbox.id`, with **no SDK state guard and no retry**. So a
`STARTING` sandbox returned 503, the queue's three retries were consumed on a call
that could not yet succeed, and **the ten-minute polling loop this PR exists to
build never ran on a genuine cold start.** It would have passed every test and
failed in production.

**The fix, read in source rather than from the reply** (`warm-context.ts:44-51`):

```ts
const DAYTONA_DEFAULT_HOME_DIR = "/home/daytona";
const sandboxStarted = sandbox?.state?.trim().toLowerCase() === "started";
  ? (await sandbox.getUserHomeDir?.()) ?? DAYTONA_DEFAULT_HOME_DIR
  : DAYTONA_DEFAULT_HOME_DIR
```

The toolbox call happens only when `STARTED`, and falls back even then. Plus 19
lines of regression test in `warm-step-processor.test.ts`. Two files, +30/-1 —
surgical.

**I also audited the invariant myself** rather than trusting that it had been:
grepped `warm-context.ts`, `warm-step-runner.ts`, `warm-step-processor.ts` and
`warm-route.ts` for other toolbox-backed `sandbox.*` calls. `getUserHomeDir` at
`warm-context.ts:50` is the only one, now gated. No siblings left ungated — the
failure mode that gave `factory#223` five rounds does not apply here.

**CI was real evidence:** 17 jobs success including Typecheck, Unit Tests (web),
Next.js build, OpenNext-CF build, Registered Tests and Phase 0; 3 correctly
skipped as untouched areas.

## Earlier — how `#2946` was found

Merging `#2963` surfaced this: its base was never `main`. The stack's PR to `main`
is **`cloud#2946`** — *"fix(cloud-agents): detach Daytona box provisioning"* — now
at head `52ebc1d8`, **+1586/-55 across 25 files**. That is the figure I wrongly
attributed to `#2963`; it belongs here. **This is the PR that deploys to
production**, and it was on neither the register nor your review list.

`CLEAN`, and **CI here is real evidence**: 17 jobs success including Typecheck,
Unit Tests (web), Next.js build, OpenNext-CF build, Registered Tests and Phase 0;
3 correctly skipped as untouched areas.

**One thing blocks it — a P1 filed 2026-08-06 that has never been answered.** Four
days, no reply, no fix, at `warm-step-processor.ts:121`:

> When detached creation returns `STARTING`, `buildWarmStepContext` awaits
> `sandbox.getUserHomeDir()` before the executor can inspect `sandbox.state`. That
> lookup is toolbox-backed and unavailable while a Daytona sandbox is
> provisioning, so **a real cold start returns 503 and consumes the queue's three
> retries instead of following the intended 15-second polling loop for up to ten
> minutes.**

If it holds, the ten-minute polling loop this PR exists to build **never runs on a
genuine cold start** — it passes tests and fails in production. Dispatched
`cloud-2946-warmstep-0810` to establish reachability from source, then fix or
rebut, with the invariant named first and every other call in the warm path
checked against it.

## 3. `factory#223` — stopped, needs your ruling

**Five review rounds, each a correct local fix that opened its neighbour:**

```
regex over-correction → missing #fleet.release → release aborts cleanup
                                              → retained-but-unfenced
```

The lead audited the lifecycle instead of patching a sixth time and asked whether
to build a full phase/CAS model. **I said no.** That is a concurrency redesign of
Factory's claim machinery landing unreviewed at 02:40 in the subsystem whose whole
job is preventing duplicate dispatch. Fails open → duplicate babysitting; fails
closed → stranded work. Not my call on your behalf.

**Both open P1s are real:**

**(a) Lease-expiry completion** — `in-memory-state-store.ts:705`, cubic
confidence 9. I had *two* leads rebut this and I was wrong both times; my argument
answered the post-re-admission case, not the one filed. The lead settled it by
execution, exit 0:

- `claimId` fencing only protects **after a replacement claim is minted**. Before
  that, lease expiry is just a timestamp — neither store changes status or
  `claimId` automatically, and `complete` does not check `leaseUntilMs`.
- The agent-exit path **completes before it triggers a sweep**.
- Lease is 15 min; the renewal sweep runs every 15 s but selects **routed-open-pr**
  claims. **Issue-created claims use a different owner and are not selected**, so
  they routinely outlive the lease.
- Completion is retained 30 days. Routed work is re-admitted on revision change;
  **issue-created completion suppresses re-admission for the whole period.**

**(b) Retained-but-unfenced** — `factory.ts:10910`, cubic confidence 8. A
babysitter whose release fails after losing its PR-work claim stays in
`record.agents` with no `#issueBabysitterClaims` fence, so it can still exit with
a completion reason and advance the issue to Human Review.

**What I asked the lead to leave you:** the state table posted publicly on the PR
— the reachable `(tracked, fenced, released, exit-eligible)` combinations and
which may emit a completion reason — plus the lease evidence, plus **whether the
routed-PR intake widening is separable from the lifecycle defects.** That last
fact decides whether you split the PR or hold it.

Head `c661e9a1`, `CLEAN`, 2 unresolved, all CI jobs green. Nothing further pushed.

---

## 4. `relay#1464` — **A is PROVEN. This is ready for your review.**

Head `b046a7e2` (confirmed remote HEAD), **0 unresolved, 12/12 workflows green**,
`BLOCKED` only on `REVIEW_REQUIRED`.

### A — real AgentWorkforce persona: **PROVEN**

Run on an isolated broker `proof-a-isolated2-0810`; **the resident `chief-broker`
was not touched.** Real AgentWorkforce JSON persona `relay-pr1464-live-proof`.

- Nested invocation carried `workforcePersona`, `verifyReady=true`,
  `requireNodeRegistration=true`, and a nonce-bearing spawn brief.
- `{"name":"persona-a4-0810-2334","ready":true,"spawned":true}` at
  `03:33:57.715Z`.
- Persona DM'd the exact nonce `A1464-NONCE-20260810T0334Z-91F6C2` at `03:34:21Z`,
  observed `03:34:22.767Z` — **24 s after the ready payload.** Readiness alone was
  not counted.
- Cleanup verified by inspection: `workers={}`, pending `[]`, worker/mount
  processes EXIT 1, broker PID absent, port closed.

**The lane rejected its own first attempt**, and that detail matters more than the
pass. A preceding run with a generic persona returned `ready: true`, then wandered
and never returned its nonce within 120 s. It threw the run away rather than
report it. The successful run used a persona whose system prompt makes the nonce
DM its first action, driven by the **spawn-time brief, not a later steer**.

**So read the claim precisely: `ready: true` means the harness took the brief, not
that the agent will do the task.** That is exactly what this PR set out to
guarantee, and it is a real improvement over a 25-second timer — but it is not a
guarantee of useful work, and the rejected run is the evidence.

### B — 90-second deadline and cleanup: **PROVEN**

`verifyReady=true`, real supervised PTY, nested invocation held 93 s, failed with
exactly `spawn_readiness_timeout`, logged local release, lost its node binding,
left no process.

### C1 / C2 / roster-only: **PROVEN** (see the regression note below)

### Still open: **one COULD-NOT-TEST**

The genuine deregistration-**error** branch. Pre-unbinding was idempotently
accepted, and isolating only the test broker's cloud-control failure needs a
fault-injection hook or a local Relaycast test engine. **This is an honest gap,
not a manufactured pass** — the failure path that runs when fleet deregistration
itself errors has not been exercised live.

### The regression question, answered

- **C1** — ordinary spawns unaffected: branch ACK 526 ms vs `main` 652 ms,
  identical payload, both launched a real codex PTY.
- **C2** — same-name respawn: branch fails with exactly `spawn_agent_name_in_use`;
  **`main` returns `{spawned:true}` and launches nothing.** Same-name respawn on
  one broker never worked — `main` lies about it, the branch does not. My earlier
  warning that this "breaks handoff" was right that behaviour changed and wrong in
  direction.
- **Roster-only reclaim unaffected** — a pre-registered name with no live local
  worker spawns fine. The guard is local-worker/pending-only, so it **does not**
  compound the identity-key reclaim problem.

### Also fixed on this head

The cubic P3 asking for exact `invoke('spawn', {name, persona, capability:
'spawn:persona', target_node})` assertions in both nested-follow tests, mirroring
`IntegrationExpert`. 29/29 startup tests pass, thread resolved.

## 5. Blocked chains

```
relay#1464 (persona proof) → your review → merge → publish Fleet 11.5.0
                                                 → workforce#307 lockfile → green
```

**`workforce#307`** pins `@agent-relay/fleet ^11.5.0`, which does not exist. Two
lanes independently probed the *installed* 11.4.3 tarball:
`FLEET_DYNAMIC_SPAWN_DELEGATION` is absent, and workforce feature-probes that exact
marker at `persona-spawn.ts:238` and otherwise always throws. Pinning `^11.4.3`
would go green in minutes and **ship the capability inert** — I declined that
trade; it is your call, not mine.

---

## 6. Near-misses I did *not* merge

- **`relayauth#68`** (export `ApiKeyKind` storage type) — `CLEAN`, 0 unresolved, CI
  + SDK Contract Check green. But head is **2026-07-25**, so that CI predates
  `#75`, `#77` and the `0.2.28` publish. Green on a two-week-old base is not green
  against today's `main`. Needs a rebase, not a merge on stale evidence.
- **`agents#106`** — `CLEAN`, 0 unresolved, but **no workflow ran on `a193dcab` at
  all.** An absent check is not a passing check.

---

## 7. Lanes — who is actually alive

Evidence, not roster presence. Most "active" registry entries are cloud personas
on one synchronised heartbeat.

| Lane | State |
|---|---|
| `factory-223-lead-0810` | **Alive.** Took #223 from 3 unresolved to 1, produced the lifecycle audit, stopped on my ruling |
| `relay-1464-live-proof-0810` | **Alive.** Delivered C1/C2, now on A and B |
| `relay-1464-fleet-11-5-0810` | Completed and exited — rebased, cleared both threads, fixed the Node-24 failure |
| `workforce-307-fleet-dep-0810` | Correctly idle, monitoring npm for 11.5.x |
| `factory-lead-0809` | **Replaced.** Best triage of the night, then silent with three fixes unpushed |
| `cloud-2917-recovery-3` | Silent 16 h. Probed |
| `sage-nightcto-lead` | Silent 11 h. Probed |
| `daytona-lead` | Silent 7 h. Probed |
| `cloud-identity-d1-lead-0809` | Silent 6 h. Probed |
| `relayfile-coordination-lead-0809` | Silent 5.5 h — **holds your four decisions.** Probed |
| `pr-shepherd-lead` | Silent 3 days. Probed |
| `herdr-lead` | Silent 3 days. Probed; I will mark `herdr-fleet-surface` ownerless and put staffing to you rather than quietly reappointing |

---

## 8. Other standing facts

- **`cloud#2917`** — no new checkpoint in 16 h, **no production mutation**. Last
  verified: main queue 14,938 msgs / 250 MB paused, DLQ 373 paused with a consumer
  present, RelayAuth healthy, **queue-health cron readback RED**, Nango drifted
  (`109/28/91/18` live vs `109/30/108/1` reference — 17 more active than the wave
  plan assumed, two connections gone).
- **Event feed frozen at `2026-08-03T07:26:26Z`.** Intermittent empty reads have
  two proven causes, neither of them movement: a wrong jq selector (mine — the key
  is `provider`, not `id`) and the file being rewritten in place so a reader
  catches it truncated. Canonical read:
  `jq -r '.providers[]|select(.provider=="github")|.lastEventAt'`
- **`google-mail` senses provider is `error`** — "Provider refresh bridge rejected
  dispatch: HTTP 500".
- **`chief-broker` must not be restarted** — 11.4.2, no identity key, hosts the
  resident Chief, no way back.

---

## 9. Where I was wrong tonight

Recorded in `principals/khaliq/memory/learnings.md`.

1. **An unread inbox.** For four hours I reported `workforce#307`'s lane as
   producing nothing and wrote "dead, not slow" into the register — while its full
   answer, with the exit-1 receipt, sat unread from 20:01Z. I then spawned a second
   lane to rediscover it. *No commits* and *no answer* are different claims.
2. **I ordered a wrong rebuttal twice.** The lease P1 was valid; my counter-argument
   answered a neighbouring scenario. A wrong fix fails loudly; a wrong rebuttal
   closes the thread and fails silently.
3. **I handed a lane my hypothesis as its brief** on the `messaging` ReferenceError
   — "classic rebase conflict shape", plus a Node-24-specific framing. Both false:
   neither parent ever had a valid binding, and both Node legs failed identically.
   The lane checked and rejected it. Brief the symptom, ask for the diagnosis.
4. **I misdiagnosed `workforce#307`** as a stale lockfile. It is a release-ordering
   defect; my "regenerate the lockfile" brief would have died on
   `ERR_PNPM_NO_MATCHING_VERSION`.
