---
status: active
owner: sandbox-lead-0823
reports_to: chief
updated: 2026-08-23T10:55Z
repos: [sandbox, sandbox-router]
---

**Seat handoff 2026-08-23T10:38Z.** sandbox-lead-0823 on sf-mini took the seat
from sandbox-lead-0822 (broker-declared unreachable — see the discriminating
result below). The 0822 seat's uncommitted brain edits and its unpushed
`lane/sandbox-router-workstream-0822` (5 commits, no remote ref) are preserved
as a secret gist under kjgbot at
https://gist.github.com/kjgbot/2616e234aa4264edbbf142f379ed70cf. **This file
itself lives on locally as an untracked working-tree artifact on sf-mini** —
kjgbot has `pull:true, push:false` on `AgentWorkforce/chief`, so brain
commits are blocked on my identity; every edit here reaches durability only
via that gist plus chief-successor-0823's push path. Reported to
chief-successor-0823.

**sf-mini broker attachability — discriminating test result (2026-08-23).** The
broker's "restarted, PTY table wiped" hypothesis for the ten heartbeated-but-
unattachable agents on sf-mini is **wrong**: the broker (pid 82063) started
2026-08-20 23:08Z and is older than every named agent. Its persisted
`~/.agentworkforce/relay/sf-mini-node/state/state-sf-mini.json` still lists
all 11 heartbeat names — including the three broker reported as 404 — each
with a live pid parented to the broker, and each with its `agent-relay mcp`
child still alive at the OS level. Attach 404 correlates with agent age
(sandbox-lead-0822 at 1d 2h and the two 0822 agents at ~14h all 404;
sandbox-lead-0823 at 2 min works). Root cause is inside the broker's attach
handler, not process-tree loss. No restart action taken — the wedged agents
may still hold unrecoverable work.

## PR state snapshot 2026-08-23T10:55Z (world moved on)

Since sandbox-lead-0822's snapshot (2026-08-22 morning), most of the PRs it
tracked have merged. Current open state on both repos is small:

**`AgentWorkforce/sandbox`** (2 open):
- **#27** `fix(mount): initial-sync idle watchdog killed healthy mounts at 60s`
  — MERGEABLE/CLEAN, all checks green, review filed by kjgbot 2026-08-23T10:53Z.
  Verified against diff: two-defect analysis holds (pin `--state-file` via
  `initialSyncStateFile` helper; raise idle default 60s→90s to match
  relayfile's own `defaultBootstrapIdleTimeout`). Open codex-bot P2
  (`/tmp/relayfile-mount-initial-sync-0.json` not scoped by mount identity)
  is narrow — not a current-production issue, worth a follow-up if
  parallel multi-mount lands. **This is the fix for the `mountRelayfile:
  true` HTTP 500 on `POST /api/v1/fleet/nodes/sandbox/ensure` — landing it
  DOES NOT unblock prod alone**; `cloud/packages/web` pins
  `@agent-relay/sandbox@0.1.2` (bug verbatim), so prod fix needs merge +
  publish + `/cloud` dep bump. Khaliq owns the merge gate.
- **#26** `[needs ruling] microsandbox follow-up fixes stranded by the #10
  squash merge` — CONFLICTING/DIRTY, awaiting Khaliq's ruling on three
  salvaged commits. Untouched by this seat.

**`AgentWorkforce/sandbox-router`** (1 open):
- **#15** `docs: propose sandbox-router -> cloud integration options` —
  MERGEABLE/CLEAN, owned by sandbox-substrate-lead-0823 (chief-broker) as
  Deliverable 2 of the substrate brief. Explicitly out of this seat's lane
  per broker's coordination directive; I do not touch it.

**Merged since 0822's snapshot** (sandbox): #19 AgentCore (17:46Z as
`515fb02` — matches the uncommitted 0822 note in the gist), #20 post-merge
review cleanup, #22 Freestyle, #23 Daytona lifecycle-verify, #24
mount-script token ingress, #25 attribution_tag + ephemeralUntil reaper.
Merged since 0822's snapshot (sandbox-router): #1, #2, #3, #6, #7, #8, #10
(supercharged demo), #11 (fleet-node attach end-to-end + two blocking-defect
docs — this is where sandbox#27 was isolated).

**Agent37 leaked instances `4mrt16bu6v` / `h3v9wr5ya3`**: confirmed reaped
2026-08-22T17:14Z per the 0822 seat's notes. The #25 reaper is the durable
prevention going forward. Closed thread.

**DAYTONA_API_KEY on sf-mini**: still absent as of 2026-08-23T10:55Z
(`~/.agentworkforce/provider-creds/` holds AGENT37_API_KEY, E2B_API_KEY,
FREESTYLE_API_KEY, MICROSANDBOX_API_KEY; no DAYTONA). Daytona-daily-cliff
rule from 0822 still applies: any live Daytona work must route to a laptop
lane. This blocks live-verification of sandbox#27 from sf-mini specifically.

---
## Original 0822 brief (retained for context)


**Cwd deletion 2026-08-22 ~17:00Z.** The `.lanes/sandbox-lead` worktree
was removed while this seat was suspended — same failure mode that killed
sandbox-lead-0821. Recovered with `git worktree add .../.lanes/sandbox-lead
--detach origin/main` at HEAD `7c8d0ac`. No writes were done from the
recovered directory before this notice; the seat is not silently
continuing from a mystery cwd. Root cause not investigated in this seat.

**Overnight merges (2026-08-22 10:38–12:57Z):** sandbox #20, #22 Freestyle,
#23 lifecycle-verify, #24 mount-script env-var token ingress (this is the
`mount-script-token-argv-fix-0821` artifact my earlier sweep couldn't find
— it landed under `mount-script`/`sandbox#21` naming), #25 the
attribution_tag + ephemeralUntil reaper (matches my
[[project_ephemeral_leak_diagnosis_2026-08-22]] proposal), and
sandbox-router #2/#3/#6/#7/#8. sandbox #15 Modal and #16 Vercel merged
earlier that morning.

**Agent37 leaked instances resolved.** `4mrt16bu6v` and `h3v9wr5ya3` both
return HTTP 404 to Agent37's hosting API as of 17:14Z — reaped in the
6h gap between shifts, presumably as #25 landed.

**sandbox #19 AgentCore merged 17:46Z as `515fb02`.** Khaliq authorised
this seat to mark it ready and merge (draft was the only blocker at
17:15Z; MERGEABLE/CLEAN, all 3 CI checks green, zero unresolved threads,
capability-modes correctly declared). Eighth adapter shipped.

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
| #15 Modal | CLEAN, rebase landed | Verified: declares structured `capabilityModes` in `src/modal/capabilities.ts`, `runtime.ts:73` wires `declaredCapabilityModes`, and 876-920 add explicit assertions cross-checking the declaration against actual behaviour. Capability-modes migration is correct. |
| #16 Vercel | CLEAN, rebase landed | Verified: declares structured `capabilityModes` in `src/vercel/capabilities.ts`; `filesystem` deliberately omitted (documented — it's per-instance configurable, resolves to `"unknown"`), and `runtime.ts:273` wires `declaredCapabilityModes = vercelCapabilityModes`. Capability-modes migration is correct. |
| #19 AgentCore | CONFLICTING | sandbox-rebase-3-0822 still working; last updated 2026-08-21T15:32. Capability-modes verification pending rebase completion. |
| #20 | CLEAN | Post-merge thread cleanup for #14 + #17. |
| #22 Freestyle | CLEAN | freestyle-adapter-0822. |
| #23 | CLEAN | lifecycle-verify-0822 — Daytona live smoke cleanup no longer fails on its own delete race. |

**Capability-modes state of the port (verified 2026-08-22):** #17 introduced
`SandboxCapabilityModes` alongside the boolean flags. The field is
`declaredCapabilityModes?: Partial<SandboxCapabilityModes>` on the runtime
interface, and the resolver defaults absent cells to `"unknown"`. It is
purely additive. Actual adopters:

- **Declared:** Modal (#15) via `modalCapabilityModes` + runtime assertions
  at 876-920; Vercel (#16) via `vercelCapabilityModes` (deliberately omits
  `filesystem` — per-instance configurable, documented).
- **Not declared:** every adapter merged to main before #17 (Daytona, E2B,
  Agent37, local) plus Freestyle (#22) and, as of this writing, AgentCore
  (#19, still CONFLICTING). Any consumer that reads them via the resolver
  sees five `"unknown"` cells — safe, just uninformative.

So the seat-brief "rebase left it in the old form" concern is a specific
worry about #15/#16/#19 branches where the pattern *was* already present
and might have been lost. Confirmed intact on #15 and #16. Still to verify
on #19. The broader story — every already-merged adapter also lacks the
declarations — is a migration opportunity, not a defect. Flagged on #22
review with a correction after I initially over-framed it. See
[[reference_sandbox_economics_doc]] for the economics context that
motivates the modes.

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

## Supervisees — judged by artifact

- **supercharged-demo-0822** — sandbox-router #10, +3,181 lines, MERGEABLE/CLEAN,
  updated 08:29. Massive scope for one PR; deferring my review pass until
  Khaliq has weighed in on scope (owned demo MVP, likely intentional). It also
  produced the ephemeral-instance find that fed [[project_ephemeral_leak_diagnosis_2026-08-22]] —
  that's a real defensive artifact, not just code.
- **sandbox-rebase-3-0822** — delivered on 2 of 3: #15 and #16 rebased CLEAN with
  the capability-modes conversion correct in both. #19 (AgentCore) still
  CONFLICTING — job is not finished.
- **freestyle-adapter-0822** — sandbox #22, +1,961 lines, MERGEABLE/CLEAN. Full
  adapter shipped; needs its own review pass, not blocking anything else.
- **lifecycle-verify-0822** — sandbox #23, 27 lines, MERGEABLE/CLEAN. Small,
  focused, addresses the Daytona live-smoke cleanup self-race. Textbook
  scoped fix.
- **daytona-delete-storm-investigator-0821** — sandbox-router #5 landed and
  passed my review pass; three chatgpt-codex-connector threads resolved via #8.
  Delivered.
- **mount-script-token-argv-fix-0821** — **no artifact located**. Searched
  branches, PRs and open branches across sandbox/relay/chief with patterns
  `mount|token|argv|0821`; nothing matches. Either the agent is dead, still
  scoping, or working under a branch name that doesn't include any of those
  tokens. Not DMing. Flag for Khaliq — see [[reference_chief_identities]] for
  routing.

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

**Diagnosis** (what let this happen, and what would catch it next time,
verified against `src/agent37/runtime.ts` at 2f82187):

- `ephemeral:true` was a caller-applied *metadata label*, not a lifecycle
  contract. Agent37 does nothing with labels beyond storing and returning
  them for `findAllByLabels`. There is no `ephemeralUntil` /
  `deadline` field on `LaunchOptions` a provider could act on either.
- Ownership is tracked only in-process (`private readonly ownership = new
  Map<string, boolean>` at line 482). When the launching process exits —
  crash, SIGKILL, normal script completion without a `finally` — the
  ownership record is gone and only the provider knows the instance exists.
- Agent37's lifetime is effectively `never-idle`: it runs until explicitly
  stopped, so nothing on the provider side reaps.
- The adapter is aware of a *sibling* failure mode: `POST /v1/instances` is
  synchronous, and aborting the request "neither stops the allocation nor
  yields the id needed to delete it, so the timeout would leak a billed
  orphan" (line 402). It refuses `createTimeoutSeconds` for that reason.
  What it does *not* protect against is the case that hit us — a successful
  launch followed by no destroy.
- The port comment at `src/agent37/runtime.ts:374` explicitly warns that
  sweeping on labels alone is unsafe: "labels are reused precisely so warm
  leases can be found by them, so a sweep could delete a healthy instance
  belonging to someone else." So a naïve `ephemeral:true` cron would be
  unsafe.
- Per [[feedback_script_not_agent_benchmarks]] the benchmark that launched
  these two instances is a cron'd script. If it exited before its cleanup
  path (crash or SIGKILL), no in-process handler fires. There is no
  out-of-process safety net today.

**What would catch it next time** (increasing investment):

1. **Ownership-tag + deadline metadata sweep.** Every launch already stamps
   an "opaque attribution tag" (port line 162). Have every ephemeral launch
   also stamp `ephemeralUntil: <ISO8601>`. A per-provider daily cron lists
   instances stamped by any known attribution tag with `ephemeralUntil` in
   the past and destroys them. The invariant "we stamped it, we said when
   to reap, past that date is safe to delete" side-steps the labels-are-
   reused warning because tag+timestamp is not the same as label. This is
   the smallest change that would have destroyed both `4mrt16bu6v` and
   `h3v9wr5ya3` within a day.
2. **First-class `ephemeralUntil` on `LaunchOptions`.** Push the deadline
   into the port so adapters can express it to providers that honour it
   (Modal's 24h ceiling is a natural fit; E2B has a lifetime bound too).
   The ones that cannot (Agent37 today) fall back to (1).
3. **Script-side `try { launch(); ... } finally { destroy(); }` wrapping
   in every benchmark.** Doesn't cover SIGKILL, but reduces the rate at
   which (1) has to catch things. Complementary, not a substitute.

The first is a two-file change on this seat's roadmap (`src/port.ts` to
add the metadata field, a new `scripts/reap-ephemeral.ts` per provider).
Not writing it in this session — Khaliq's ruling on the two live instances
is a prerequisite so the cron doesn't collide with his own recovery. When
the ruling lands, opening as sandbox#TBD.

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
