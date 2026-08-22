---
status: active
owner: sandbox-lead
reports_to: chief
updated: 2026-08-22
repos: [sandbox, sandbox-router]
---

Goal: two shipping surfaces. `AgentWorkforce/sandbox` is the multi-provider
adapter set (Daytona, E2B, Micro Sandbox, Agent37, Modal, Vercel, AgentCore,
Freestyle). `AgentWorkforce/sandbox-router` is the process manifest / router
that decides which adapter serves a request and preserves continuity across
provider boundaries. Both are pre-1.0 and dogfooded against our own fleet
before any commercial lane opens — see [[project_dogfood_before_commercial]].

## Lead identity and continuity

Current lead: **sandbox-lead-0822** on sf-mini,
`~/Projects/AgentWorkforce/.lanes/sandbox-lead`, sole writer to that worktree
(clean off `origin/main` of `sandbox`). Predecessor `sandbox-lead-0821` ran
~11h before going deaf to DMs and having its cwd deleted underneath it —
[[feedback_handover_announce]] applies to any seat handover here.

Continuity rule for this seat: every ruling, finding and open question lands
in this file (or on the PR/issue), never only in Chief's DMs. Shelf life for
an agent identity on this fleet is 1–5 hours in the worst case; do not depend
on your own memory surviving.

## State of the two repos as of 2026-08-22 morning

### `AgentWorkforce/sandbox`

Merged overnight by Khaliq: #11 Agent37, #12 E2B, #14 Daytona
recover-exec-after-restart, #17 structured capability modes, #18 Daytona SDK
bump. `origin/main` head: `288b767`.

| PR | State | Notes |
|---|---|---|
| #10 Micro Sandbox | MERGEABLE/CLEAN, 0 unresolved threads | Concurrent-writer corruption from two nights ago has been repaired by sandbox10-micro-conflict-0821; ready for Khaliq to merge. |
| #15 Modal | CLEAN | Rebase owned by sandbox-rebase-3-0822 (chief-broker). |
| #16 Vercel | CONFLICTING | Rebase owned by sandbox-rebase-3-0822. `git merge-tree` shows zero real conflicts; 3 commits behind. |
| #19 AgentCore | CONFLICTING | Same as #16. |
| #20 | CLEAN | Post-merge thread cleanup for #14 + #17. |
| #22 Freestyle | CLEAN | freestyle-adapter-0822. |
| #23 | CLEAN | lifecycle-verify-0822 — Daytona live smoke cleanup no longer fails on its own delete race. |

**Capability-modes defect class to watch on #15/#16/#19:** #17 introduced
structured capability modes alongside the boolean flags. A clean `git`
three-way merge on a rebase can still leave an adapter declaring capabilities
the OLD way while `main` now expects the new form. This is a real semantic
defect, not a merge artifact. Verify after sandbox-rebase-3-0822 lands each
rebase — see [[reference_sandbox_economics_doc]] for the four-provider
economics context that motivates the modes.

### `AgentWorkforce/sandbox-router`

All open PRs MERGEABLE/CLEAN. #1 is the only one with genuinely unresolved
review threads (3 threads from `chatgpt-codex-connector` on
`src/process-manifest.ts`, two P1 and one P2). #2–#5 all show their threads
`isResolved:true` already (resolved via the cleanup PRs #7 + #8). Predecessor
assigned itself reviewer on all five at 21:31 last night and did not post a
single review — no `reviewDecision` on any of them.

| PR | Title | Threads |
|---|---|---|
| #1 | process-manifest v2 scaffold + continuity contract | **3 unresolved** — see below |
| #2 | dogfood-agent cost baseline | all resolved via #7 |
| #3 | Modal economics evidence | all resolved (P2s went outdated) |
| #4 | resilience primitives proposal | all resolved via #8 |
| #5 | Daytona delete-storm analysis | all resolved via #8 |
| #6 | resident-lead 400K replay not-run record | CLEAN, docs |
| #7 | #2 thread cleanup | CLEAN |
| #8 | #4 + #5 thread cleanup | CLEAN |
| #10 | supercharged demo MVP | owned by supercharged-demo-0822 (chief-broker) |

**Reviewer of record on #1–#5 is `kjgbot` (Khaliq's bot user).** My role is
to file the review (comments, requested-changes where warranted) — Khaliq
owns every merge gate.

## Unresolved review threads on sandbox-router #1

Three threads from `chatgpt-codex-connector` on `src/process-manifest.ts`:

- **line 1181, P1** — "Require a receipt for session-bound teardown." When a
  valid manifest has a `sessionId` but an empty `teardown.drains` array,
  `evaluateDestroyAuthorization` iterates over nothing and returns
  `{authorized:true}`, allowing a resumable session to be destroyed without
  the promised exact-session cloud receipt.
- **line 1211, P1** — "Authorize only an explicit passed registration." When
  the external registration checker returns malformed or newly added verdict
  data (missing verdict, `"timeout"`), the two negative checks are skipped
  and the unconditional return authorizes the identity. Fails open.
- **line 958, P2** — "Hash only the declared capability target fields."
  `expectedCapabilityTarget` accepts additional enumerable metadata; the
  fingerprinter hashes the whole object, so two logically identical targets
  can fingerprint differently and lose warm-match reuse.

My review will land these as review comments on the PR — I am not fixing them
myself, and I am not merging.

## Supervisees

Judge by artifact, not by DM.

- **supercharged-demo-0822** (chief-broker) — sandbox-router #10.
- **sandbox-rebase-3-0822** (chief-broker) — rebasing sandbox #15 / #16 / #19.
- **freestyle-adapter-0822** — sandbox #22 MERGEABLE/CLEAN.
- **lifecycle-verify-0822** — sandbox #23 MERGEABLE/CLEAN.
- **daytona-delete-storm-investigator-0821** — landed docs in sandbox-router #5.
- **mount-script-token-argv-fix-0821** — argv token leak fix; artifact TBD-checked.

## Two open judgement calls

### 1. Daytona auth is a daily cliff

The Daytona CLI stores a browser-obtained OAuth token with no static-key
alternative. Today's token expired 08:32 and was re-authenticated 10:21 by
Khaliq; the next expiry is **2026-08-23T10:21**. It is authenticated only on
the laptop node; on sf-mini (where this lead lives) it returns Unauthorized.
`daytona login` is browser-interactive, so no agent can rescue it.

**Rule for this seat until the escalation lands:** route any live Daytona
work to a laptop lane; do not spawn Daytona probes on sf-mini or chief-broker.
Broker has escalated the ask for a static `DAYTONA_API_KEY` (the CLI honours
one when set) to Khaliq.

### 2. Two Agent37 instances ran 48h past their benchmark

supercharged-demo-0822 found `4mrt16bu6v` and `h3v9wr5ya3` still running ~48h
past a benchmark completion, both tagged `ephemeral:true` by
sandbox-provider-comparison-0819. **Not deleting** — Khaliq's call, already
with him.

The lead question — what let this happen, and what would catch it next time
— is answered separately in [[project_ephemeral_leak_diagnosis_2026-08-22]]
(TODO in this seat's queue; will land as an addendum to this file if the
memory doesn't survive).

## Handoff section (keep this current)

If this file's `updated:` is more than ~4 hours old, assume the seat is deaf
or dead. Next lead should:

1. `gh pr list --repo AgentWorkforce/sandbox --state open` and same for
   sandbox-router. Compare against the tables above — what merged? what's new?
2. Re-run the `chatgpt-codex-connector` thread inventory on any PR still open.
3. Check whether sandbox-rebase-3-0822 finished the three rebases and whether
   the capability-modes verification landed on #15/#16/#19.
4. Check whether a `DAYTONA_API_KEY` has been added to
   `~/.agentworkforce/provider-creds/` on sf-mini; if yes, laptop routing
   becomes optional rather than required.
5. Check whether Khaliq ruled on `4mrt16bu6v` / `h3v9wr5ya3`.

DM `chief` on arrival (see [[reference_chief_identities]]) and write your
seat identity + timestamp into this section before touching anything else.
