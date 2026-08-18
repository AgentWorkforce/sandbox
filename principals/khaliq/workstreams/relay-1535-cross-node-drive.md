---
status: active
owner: chief
updated: 2026-08-16
repos: [relay, relaycast-cloud, cloud]
---

# Cross-node `--mode drive`

**Goal.** Prove cross-node `--mode drive` end to end and support multiple
concurrent drivers, across all three owning repos, to review-ready PRs with
`mergePolicy: never`.

## 2026-08-16 evening — DoD 2 PROVEN, and four platform defects found underneath it

**Multi-player driving works.** `relaycast-cloud#63` merged (`cb41f59`) and deployed
(18:09:08Z), and the proof ran against the deployed contract:

- **Step 0** — propagation confirmed by testing the contract itself rather than the workflow
  badge: drive+drive admitted, passthrough+drive fenced with the real 409 text.
- **Arm 1 PASS** — two concurrent drivers on one agent, distinct nonces, observed
  **recipient-side through an independent process running the older 11.6.7 binary**.
- **Arm 2 PASS** — a passthrough attach alongside an active drive is refused. The exact half
  Khaliq blocked the PR over, exercised live rather than trusted from a unit test.
- **Arm 3 UNATTRIBUTED** — cohort manual-mode restore fails reproducibly, but the verifier's
  only headless detach is SIGINT, which may itself be an abnormal exit. It refused to
  attribute rather than guess. Settled by a code read of `attach-drive.ts`, not another run.

Single-driver drive was proven earlier the same day against **released `agent-relay@11.6.9`**,
with released 11.6.7's 6/6 `[object Object]` failure as the must-not-fire control.

### The four defects found underneath, each with an owning layer

| issue | what | owner |
|---|---|---|
| `relay#1537` | a drive session's terminal session is never released on clean detach — every drive attach costs that agent ~10 minutes, and the next attempt re-arms the fence | relaycast-cloud |
| `relay#1539` | a live agent is permanently unroutable via `--node` when missing from the broker's `fleet_inventory`; the workers insert is unconditional while both inventory writes sit behind `fleet_registration.take()` | relay-broker |
| `relay#1541` | every DM returns `recipient_unresolved` workspace-wide while channel posts work — isolates to recipient resolution, not messaging | relaycast |
| `relay#1542` | `registerOrRotate` is a race: concurrent callers both `get()+rotateToken()`, the later wins, the earlier holds a dead token | relaycast SDK |

**`#1537` is exposed, not introduced** — `#1536` touched only client code, and it reproduces
on released 11.6.7 where drive never establishes a session at all.

### Next

1. PR for Arm 3; owner decided by the `attach-drive.ts` SIGINT-handler code read.
2. Atomic fix for `#1542` — **atomic, not retried**. A retry loop narrows the window and
   leaves the defect.
3. `relaycast-cloud#64` (the `#1537` fix) carries four unresolved threads, two reviewers
   independently finding its abnormal-drop grace never restores the lifetime on a successful
   resume — the defect inverted rather than removed.
4. Daytona (`relay#1538`): snapshot rebuild at 11.6.9, then the attach proof inside one
   sandbox lifetime. A fresh sandbox currently boots `agent-relay@11.4.1`, below both
   thresholds, so it is unattachable by construction.

## 2026-08-17 02:00Z — inventory for a fresh session

Everything below is open and unmerged. **Khaliq owns every merge gate.**

### PRs awaiting the merge gate

| PR | state | what it is |
|---|---|---|
| `relay#1547` | **12/12 green, review-ready** | the `worker_timeout` drive flap Khaliq screenshotted. Three-layer fix, isolated must-fire proven red-then-green |
| `relay#1546` | **2 CI failures** | broker refuses to rotate a live worker's token on impersonation paths. `E2E` hangs after full output — probe-hang suspected, lane `relay-1546-probe-0817` diagnosing |
| `relay#1543` | green CI, 1 review thread | withheld fleet acks tied to `PendingDelivery` lifetime — structural, not five patches |
| `relaycast#332` | CLEAN | dual-slot token grace; makes the `registerOrRotate` race harmless rather than serialised |
| `relaycast-cloud#64` | CLEAN | releases the terminal session on client close; closes `relay#1537` **and** `relaycast-cloud#65` |

### Issues filed tonight, all with owners

`relay#1537` (session never released on clean detach — **exposed, not introduced**), `#1539` (live agent unroutable when missing from `fleet_inventory`; **one unconditional writer vs two conditional ones**), `#1541` (workspace-wide DM `recipient_unresolved`), `#1542` (`registerOrRotate` race), `#1544` (drive flap), `#1545` (broker re-registers live workers), `#1548` (view attach goes silent when its target disappears while drive emits a code), `#1549` (**bot-authored commits silently suppress CI and CD — three instances, none reported**), `cloud#3055` (429 surfaced as a JSON parse error), `cloud#3056` (snapshot rebuild never deploys itself).

### Proven, with recipient-side evidence

- Cross-node **view** and **drive** between physical nodes, against released `agent-relay@11.6.9`.
- **Multi-player driving** — two concurrent drivers, distinct nonces, observed through an independent process on an *older* binary; passthrough refusal exercised live.
- **Cross-node attach into a JIT Daytona sandbox** — Q1–Q4 pass, sandbox provisioned on demand at `relay-broker/11.6.9`.

### Open questions that are Khaliq's, not engineering's

1. **`/ensure` reuses any online physical node with spare capacity**, so the documented JIT entry point ~never provisions a Daytona sandbox. Is that the intended model?
2. **No operator with `cli:auth` can tear down a fleet-provisioned sandbox.** Provisioning without teardown is half an interface under a create-and-destroy model.
3. `relay#1539`'s design question, still unanswered: derive inventory membership from the live workers map, or keep two maps with an enforced invariant? **A fix that adds an eleventh guarded call site leaves the same defect.**

### Standing constraints for any lane

Never `git stash` in a shared checkout. Do not restart a node. **Do not release or kill `verify-1535-fixtest-e-0816` (PID 55650, finn-mini)** — the frozen `#1539` reproduction. Confirm CI per workflow with `gh run list --branch`, never the rollup. Under load, re-run failures in isolation before trusting red or green.

## Now

Khaliq put `relay#1535` on Chief directly on 2026-08-16. Chief coordinates four
lanes across three repos; no lane reaches across a repo boundary without coming
back through Chief.

| Repo | PR | State | Lane |
|---|---|---|---|
| relay | `#1536` | open, **draft**, green, head `bdcb3d80` | `relay-1535-impl-sfmini-0816` (sf-mini) |
| relaycast-cloud | `#63` | open, two live blockers, head `6317302644` | `relaycast-cloud-1535-multidriver-0816b` |
| cloud | none | **no branch, no PR** | `cloud-1535-terminal-error-0816` / `-0816b` |
| — | — | independent verifier, DoD 1/2/5 | `relay-1535-verify-finn-0816b` (finn-mini) |

**Both blockers on `relaycast-cloud#63` are live at head — verified by reading
`6317302644`, not the commit the review was written against (`67712711e4`).**

1. *Passthrough exclusivity is not narrowed, it is gone.*
   `packages/relaycast/src/durable-objects/node.ts` 553-576 carries **no
   exclusivity check at all**; the `drive_in_use` guard was deleted wholesale
   and replaced with a comment block, so admission falls through for every
   mode. `#1535` authorizes concurrent *drive* sessions only. Required: drive +
   drive allowed, passthrough exclusive and mutually exclusive with drive. The
   PR's new test asserts the opposite contract and has to invert.
2. *The delivery-mode restore cohort is untouched.* The diff is four files, and
   a grep across the whole diff for `cohort` / `baseline` / `deliveryMode` /
   `restore` returns zero hits. The race: manual rev0 → driver 1 writes auto
   rev1 → driver 2 writes auto rev2 → driver 1 CAS restore misses → driver 2
   restores its prior auto value → the original manual mode is lost. Khaliq
   allowed this to land in `relay` instead if that is the owning layer; the
   lane owes a decision on which, with reasons.

**DoD 3 is currently satisfied in the wrong place.** The issue requires the
input-arbitration question answered *in writing before* the exclusivity `if` is
deleted. The `if` is already deleted and the decision exists only as a code
comment in `node.ts` 560-570 — arrival-order multiplexing into the shared PTY,
frames atomic, interleaving accepted at frame boundaries, no floor or token.
The specification is living inside the artifact it was meant to govern. Lane
told to post it to `relay#1535` as the record; Khaliq asked to confirm the
substance.

**`relay#1536` is green but still a draft.** A draft is not review-ready however
green it is. Its `[object Object]` finding was reproduced against the installed
**11.6.3** artifact while the fleet runs **11.6.7**, so it does not count as
live until re-checked.

## Next

1. Cloud lane returns a branch + PR URL or a named blocker (asked 2026-08-16
   12:5x, one-hour window). If neither arrives, replace it and tell Khaliq.
2. `relaycast-cloud#63`: both blockers fixed, each with a **must-fire /
   must-not-fire pair** — passthrough rejected next to a drive *and* drive+drive
   still admitted; the lost-manual-mode sequence reproduced *and* single-driver
   restore still correct.
3. `relay#1536` out of draft.
4. Verifier delivers DoD 1/2/5 on recipient-side evidence, with the
   harness-vs-node confound broken by a control arm.
5. Nothing merges. Khaliq owns every merge.

## Standards issued to every lane

- Evidence is **recipient-side** — a transcript or a screen. A sender-side
  receipt, an exit code, and a green workflow are each compatible with nothing
  having arrived.
- CI is confirmed per workflow with `gh run list --branch`, never the status
  rollup, which has read green over two failing workflows in this org.
- A single new passing test proves novelty, not correctness. Pairs or it goes
  back.
- Establish **which binary** is being measured before measuring; PATH and
  `~/.agentworkforce/relay/bin` have been different builds all week.
- Capture exit codes without a pipe; `head` and pipelines have manufactured
  phantom findings on this issue already.

## History

- **2026-08-16** — Chief took the issue on Khaliq's steer. Read both PR heads
  directly and confirmed both `#63` blockers unfixed and `#1536` still draft.
  Re-briefed all four lanes by DM. **Flagged lane sprawl: 20+ agents carry a
  `1535` name and two separate cloud lanes exist**, so Chief re-briefed the
  existing ones rather than spawning a twenty-third. Sprawl on one issue is a
  coordination cost, not capacity.
- **2026-08-16** — `#1536` reported all 11 workflows green on unchanged head
  `bdcb3d80`, branch-scoped, after a single approved Fleet E2E rerun. Chief
  accepted the evidence shape and asked the lane to say whether the original
  failure was environmental or intermittent, since those are different findings
  and an intermittent Fleet E2E will bite someone else later.
- **2026-08-16** — A worker under the impl lane violated the no-`git stash`
  rule on relaycast-cloud. The lane required the disclosure itself and corrected
  the PR body to drop an unsupported preexisting-control claim. Chief refused to
  accept "no loss" on the worker's assurance and required the worktree path plus
  `git worktree list` proving a lane-private tree, and `git stash list` empty to
  prove the pop drained.
