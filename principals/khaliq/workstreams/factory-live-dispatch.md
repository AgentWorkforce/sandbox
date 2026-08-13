---
status: active
owner: chief
updated: 2026-08-11
repos: [factory, cloud, relay, relayfile]
---
# Factory live dispatch

**2026-08-11 19:12Z — `factory#232` MERGED by Khaliq (18:05:56Z, `18a9e86`),
superseding the "draft, untouched" line below. Chief then merged `factory#234`
(19:11:54Z, `5971ab4`, rebase), a mechanical reconciliation PR: the
`@agent-relay/factory@0.1.58` publish workflow (run `31523445478`) had already
succeeded — npm publish and git tag both landed — but its final push to `main`
failed on branch protection. `#234`'s commit carries an identical tree/parent to
the already-tagged release commit, so merging only reconciles `main` to match
what npm already serves; it does not trigger a new publish. Verified before
merging: CI 7/7 green, `mergeStateStatus: CLEAN`, repo requires 0 approving
reviews. Within tonight's PR-shepherding scope.**

**2026-08-11: replacement Chief `chief-barry-codex-0811-1440` completed and
pushed the first bounded `factory#230` implementation slice on
`codex/factory-230-generation-cas` at
`0024c6b0cf32595d19b9c24b8e6f8d73375fdd63`.** The slice adds atomic
`markRunning`, generation-fenced renewal, one-shot durable completion CAS,
get/clear operations, persisted generation parsing, and cross-process file-lock
coverage across both state stores. Focused proofs passed 2/2, the full file
suite passed 21/21, build passed, and `git diff --check` passed. The remote SHA
byte-matched. Draft [Factory PR #232](https://github.com/AgentWorkforce/factory/pull/232)
now carries the exact head for review. No merge, activation flip, deploy, or
publish was performed. Remaining issue scope is Factory lifecycle wiring/local
claim-map integration and pending-spawn recovery.

**2026-08-10: `factory#225` merged (`40f9be5ec4`) and `factory#223` merged (`67a5a57b4a`) as Khaliq's Option A split — routed-PR intake and discovery only, activation disabled, execution half removed rather than flagged off. Lifecycle design is tracked in `factory#230`.**


**2026-08-12 07:47Z — root cause confirmed for tonight's dispatch stall.**
`factory-dispatch-fix-finn-0812` traced it to Relayfile, not Factory: the
mounted `/github` projection for workspace `rw_7ccfea89` is stale and cannot
refresh. `state.json` shows last successful reconcile
`2026-08-11T15:04:47Z`, `stale=true`, repeated `HTTP 401 'Token has expired'`
minting delegated Relayfile credentials. Both `relayfile status` and an
explicit `relayfile pull --provider github --reason ...` fail the same way.
Concrete proof: projected `relay#1399` reads updated 2026-07-30 while GitHub
shows `2026-08-11T21:21:43Z`; GitHub carries 29 open `factory-ready` issues,
several newer than the mount's last good reconcile. Factory's own health
check only verifies `/github/repos` is *mounted*, not fresh, so it reports
healthy against an empty/stale effective queue — same "liveness field lies"
shape as everything else tonight, just one layer down in Relayfile instead of
Factory.

**2026-08-12 08:32Z — four silent finn-mini lanes respawned.** Nudged
five lanes at 07:54Z with a respawn warning; ~40min later finn-mini showed
them all near-0% CPU (genuinely stuck, not just quiet). Respawned four as v2:
`factory-236-finish-v2-0812`, `webhook-queue-incident-lead-v2-0812`,
`lifecycle-workflows-lead-v2-0812`, `cloud-fleet-proof-owner-v2-0812` — all
confirmed alive via real CPU within seconds of dispatch (not trusting
`spawned:true` alone). The fifth, `relay-1488-fix-finn-0812`, was re-briefed
in place rather than respawned (see relay#1488 note below) since direct
verification showed its actual assigned fixes had genuinely landed — only
newer unresolved review threads needed addressing, not a restart.

**relay#1488 verified, not merged — 2 new unresolved threads on current
HEAD.** Both originally-assigned bugs (broker-wide-stall in `api.rs`,
resize-ownership bypass in `fleet.rs`) are genuinely fixed at
`7fd9f514dbfe58b79156341409b11b8c699bdce9` — read the actual diff, matches
the described fixes, all CI green. But a third-party "all green, ready to
merge" comment from `miyaontherelay` (22:33Z, before today's fixes) turned
out to be stale: 2 substantive threads are unresolved on the *current* HEAD —
CodeRabbit Major/heavy-lift on `api.rs:770` (writer may return Err after
frame admission instead of cancelling/reporting accepted), Cubic P2 on
`maintenance.rs:50` (resize-ownership release ordering vs. session-removal
guard). Re-briefed `relay-1488-fix-finn-0812` with both. Standing lesson held:
external "green"/"ready" claims still need a fresh review-thread check
against the exact HEAD before merge.

**sf-mini broker rollout — unconfirmed, possibly crash-looping.** As of
08:30Z the broker process pair on sf-mini has cycled through 4+ distinct PID
pairs over ~20 minutes, each only seconds old. `identity-debug.txt`
(freshest write) shows correct identity resolution (`agent_name='sf-mini'`
matches `requested='sf-mini'`) and `crash-insights.json` has zero recorded
crashes, so this may be intentional rapid iteration by `fleet-attach-impl-0811`
rather than an actual crash loop — but that lane has not replied to two direct
pings since 08:13Z. Given ambiguity on a production node, holding off further
unilateral action; if still unanswered next sweep, escalating to Khaliq for a
rollback decision rather than acting alone.

**Escalation path (not yet actionable without a human/org credential
action):** reauthorize the Relayfile delegated credential for
`rw_7ccfea89`, restart/rebind its `/github` mount, rerun the GitHub provider
refresh/backfill, verify projected `relay#1399` matches GitHub, then force a
Factory rescan. Separately, the pre-existing GitHub App webhook delivery halt
since 2026-08-03 is a likely upstream cause of the provider going stale in
the first place — that needs GitHub org/admin restoration plus a replay,
same root-cause family the P0 webhook-queue incident lead is independently
chasing (DMs with `webhook-queue-lead-0811`). Asked the lead to check
whether Relayfile exposes a non-interactive reauth path before treating this
as fully blocked on Khaliq.

**2026-08-12 08:03-08:12Z — worked the credential layer directly on chief's
laptop, found a deeper server-side blocker.** `factory-dispatch-fix-finn-0812`
confirmed no agent-runnable self-reauth path exists from finn-mini (no cached
token, no `auth refresh` command, provider reconnect needs human OAuth). But
chief's own laptop already had a valid Agent Relay Cloud session
(`agent-relay cloud session --json`, access token good to 18:18Z), and
`relayfile status rw_7ccfea89` diagnosed the actual local fault: **"auth:
agent-relay session unavailable"/"daemon predates last login - restart the
daemon."** Ran `relayfile restart rw_7ccfea89 --foreground`: it successfully
minted fresh delegated credentials (verified via `~/.relayfile/delegated/`
shard files — new access tokens landed seconds after restart, previous shard's
tokens had expired 2026-08-11T21:5xZ). Confirmed via `lsof -p <pid>` it was
correctly scoped to `chief/.integrations`, not a stray/wrong workspace
(a plain `relayfile status rw_7ccfea89` run *without* the daemon lock
separately resolved to an unrelated old `pear` workspace — a live,
reproduced instance of the registry-ambiguity defect already tracked in
`relayfile-coordination.md`, but not what the running daemon was actually
using).

**So the 401/credential layer is fixed — but the actual pull still fails, one
layer deeper.** `relayfile pull --workspace rw_7ccfea89 --provider github`
now fails differently: `error: refresh github: Post
"https://file.agentrelay.com/v1/workspaces/rw_7ccfea89/sync/refresh": context
deadline exceeded`. Reproduced twice, both a clean 30.0s client timeout — the
backend endpoint itself is hanging, not rejecting. relay#1399's local
projection is still stale at `2026-07-30T21:00:08Z` vs GitHub's real
`2026-08-11T21:21:43Z` (title also missing GitHub's now-added `[factory]`
prefix). This is now a `file.agentrelay.com` backend problem, not a
client-side credential problem — flagged to `relayfile-backend-fix-lead-0812`
(already investigating the Daytona 404 on the same backend) to check whether
`/v1/workspaces/{id}/sync/refresh` is the same failing code path in both
incidents.

**Goal:** A ready human-owned Linear issue safely dispatches a Cloud Factory
recipe that creates agent-owned GitHub work and reports checkpoints to Linear.

**Now, measured 2026-08-07 — the contract is healthy and the pipe is dry.**
`npm run factory:status` is green: contract resolved, `issueSource: github`,
readiness label `factory-ready`, hosted brain `cloud-factory-brain` active,
`mergePolicy: never`. Nine repos routed. And nothing is flowing.

**21 open `factory-ready` issues across five repos; only 4 can ever dispatch.**
The safety gate requires *both* `requireLabel: factory-ready` and
`requireTitlePrefix: "[factory]"`. Seventeen carry the label and no prefix, so
they sit in a queue that structurally cannot drain — cloud ×5, relay ×6,
factory ×6, some since 2026-07-20. The label is the visible signal and the
prefix is the silent one, which is why nobody noticed.

Eligible today: `cloud#2935`, `relay#1433`, `chief#19`, `internal-agents#48` —
all created 08-05, none touched since 08-06, and no Factory-authored PR exists
in any routed repo. So the last two days produced zero runs.

**Factory dispatch is hosted today — the Cloud brain spawns agents through
workspace-scoped Relaycast spawn — but it is NOT blocked on a missing node
capability.** Chief asserted that it was, and Khaliq falsified it the same day.

`factory/src/triage/schema.ts:6` declares
`capability: z.enum(['spawn:codex', 'spawn:claude', 'workflow:run'])` — three
acceptable values, not one requirement. `workflow:run` is specific to the
**workflow role** and additionally demands `--workflow <path>`
(`src/cli/fleet.ts:543`); it is the relayflow case. **Every live node already
advertises `spawn:claude` and `spawn:codex`**, and repo access comes from
`clonePath` on the agent spec, not from a node tag.

So "0 of 402 nodes advertise `workflow:run`" is true and irrelevant — Chief
measured a real number and drew a wrong conclusion from it. The Sage program's
activation gate 2 is *Sage-specific* (it names the Sage and NightCTO repo tags);
conflating that gate with a general distribution blocker was the error.

**What actually stands between Factory and distributed execution is filesystem
access, not capability.** A placed agent needs the repo, and remote nodes do not
carry it — proven the hard way on 2026-08-07 when a lead placed on `barry` had no
access to its own brief. The answer is the Relayfile mount, which is already in
production (sf-mini runs a peer-mode mount today) and whose operating skill
landed the same day as skills#94.

**Next:** two independent moves, neither started, both needing Khaliq's word
because each starts real work. (1) Add the `[factory]` prefix to the 17 inert
issues, which begins dispatching genuine backlog. (2) Prove one distributed
Factory run end to end. The capability is already there; what needs proving is
that a placed agent can reach the repo — via the Relayfile mount, not a clone.
Sage's activation gate 2 is separate and Sage-specific.

## History

- 2026-08-11 — A replacement Chief on `barry` took direct ownership after the
  inactive `factory-230-lead-0811` was released, pushed the generation/token +
  CAS StateStore slice at `0024c6b`, opened draft Factory PR #232, and left
  activation and rollout untouched for review.
- 2026-08-07 — Audited the live pipeline for the first time since 07-30 and
  found the eligible/inert split (4 of 21). Also asserted, wrongly, that no node
  could host a Factory workload; Khaliq falsified it the same day and the Now
  above carries the correction. The workstream's previous Next was written
  against the RelayAuth D1 blocker, resolved days earlier and unnoticed here —
  the same stale-blocker failure recorded in `memory/learnings.md`. Two
  independent instances of carrying a dead premise, in one workstream, in one
  day.

- 2026-07-30 — The state this workstream reported as its Now until the 08-07
  audit: hosted brain active and dispatching; PR #2871 deployed the current-only
  Fleet roster, the strict `[factory]` plus readiness gate, real deployed-user
  ownership, stale-run quarantine and hosted heartbeat; PR #2873 deployed
  workspace-scoped Relaycast spawning with deterministic invocation
  reconciliation; AR-448 launched three agents and completed with merge
  disabled. AR-445/446/447 and the schedule-lifecycle task were prepared and
  held behind the RelayAuth D1 incident, which has since resolved.
- 2026-07-30 — Cloud PR #2873 corrected the live dispatch transport from raw
  action invocation (which rejects workspace keys) to the supported
  workspace-scoped agent spawn API. It preserves Factory's deterministic ID
  while persisting the provider invocation ID used for reconciliation.
- 2026-07-30 — Production proof passed: Cloud Factory reported online with a
  fresh heartbeat; AR-448 spawned three agents, applied its writeback, and
  completed successfully. Merge policy remained `never`.
- 2026-07-30 — Cloud PR #2871 merged and deployed. Fleet now reports two
  current nodes while hiding 308 historical/offline records by default.
- 2026-07-30 — Root-caused the misleading Cloud Factory status: hosted sweeps
  emitted run/failure activity but no `instance.heartbeat`, so the dashboard
  correctly showed a fresh check-in beside a stale/offline liveness status.
  The same investigation found dispatch used a placeholder owner because the
  orchestrator and emitter disagreed on the deployed-user field name.
- 2026-07-30 — Added a strict dispatch contract: Linear remains the human
  queue; only issues with `[factory]` plus `factory`/`factory-ready` can cross
  into agent-owned GitHub work. Existing pre-contract pending records are
  quarantined before the corrected owner can launch them.
- 2026-07-30 — Doctor shows `liveInstance: false`: `AgentWorkforce cross-repo`
  offline since 07-24, `factory` stopped since 07-23. Dispatch is blocked on
  instance availability, ahead of the persona and flag work.

- 2026-07-30 — Agreed on Linear as the human plane, GitHub as the agent plane,
  and Cloud Factory as the only task bridge.
