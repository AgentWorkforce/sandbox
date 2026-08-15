---
status: active
owner: chief
updated: 2026-08-15
repos: [relay, relayfile, factory, workforce, cloud, agents, relaycast, relaycast-cloud, internal-agents, skills]
---
# Active lanes — dispatched work and who owns it

## 2026-08-15 ~20:10 CEST — full in-flight sweep

Counted from `state-chief-broker.json`, GitHub issue labels, and `gh pr list`.
This node only; sf-mini, finn-mini and barry not re-inventoried here.

**39 live agents on chief-broker.** Twelve are long-lived leads and lanes from
08-13/08-14 (`relay-lead-0814`, `factory-lead`, `marketing-lead`,
`relaycast-325-rebase`, `relaycast-326-review-fix-0813`, `relay-1431`,
`relay-1504b`, `relayfile-sdk-auth-0814`, `sfmini-broker-repair-0814`,
`skip-deterministic-harness-lead-0814`, `skip-scheduler-binding-spike-0814`,
`chief`), several running 32–44 hours. The remaining 27 are Factory-spawned
`ar-*` impl/review/babysit triples from 08-15.

**30 Factory issues in progress across 8 repos**; 3 sitting in
`factory:human-review` and therefore blocked on Khaliq: `factory#260`,
`cloud#3031`, `relaycast-cloud#45`.

**154 open PRs across 6 repos** — relay 35, factory 14, cloud 77, relayfile 23,
relayfile-cloud 4, relaycast-cloud 1. **37 are CONFLICTING and 29 are drafts.**
Effectively none carry an approving review. This is the dominant constraint on
the whole system right now: dispatch throughput far exceeds merge throughput,
and the gap is the human merge gate, which is Khaliq's by design.

**Filed by Chief on 08-15**, all covered in `memory/open-threads.md`:
`relay#1523` (DM delivery silently unresolved — PR `relay#1525` open, 11/11
workflows green, unreviewed), `relay#1524` (agent identity recovery broken end
to end — in progress, no PR), `relay#1522` (replay id + relayhistory↔relaycast
join — deliberately unlabelled, blocked on the `rw_7ccfea89` retention read),
`skip#1` (Skip heartbeat crash kills the resident Chief — unlabelled and
unroutable, `skip` is not in `repos.names`).

**Filed by others and worth noting:** `relay#1526` — the broker passes
`rk_live_`/`at_live_` credentials in child argv where any local process can
read them via `ps`. In progress as of 20:05.

**Known-stale in this file:** everything below this section is the 08-13
inventory and describes lanes that have since exited or been replaced. Read it
as history, not as current state.

## 2026-08-13 ~13:00 CEST — sf-mini + barry inventories, same methodology as finn-mini

Same purpose as the finn-mini sweep above: identify every genuinely live agent
before Khaliq releases whatever's inactive, flag at-risk work first.
Investigation only — nothing killed, pushed, merged, or modified by the
investigating agents.

### sf-mini

11 live agents (16 registered in `state-sf-mini.json`, 5 confirmed
`<defunct>` zombies with no live children). Raw `ps` showed ~69
agent-relay-tagged rows — each codex agent spawns 6 child processes, each
claude agent spawns 4; dedupe is against live root PIDs, all verified via
`ps -p`. The broker (`agent-relay-broker init`, separately being unwedged —
not duplicated here) and `node up` process are infra, not agents.

**Done / safe to release:**

| Agent | Brief | Evidence |
|---|---|---|
| `mp-relayhistory-journal-0813` | `conversationTurns` table + turns/metadata API in relayhistory-cloud | relayhistory-cloud#23 merged (`c0d100d`), prod deploy verified live (200 on `/v1/sessions/.../turns`). Idle ~12.5h. |
| `mp-session-probe-0812` | Research: does workforce `--resume`/`--continue` work | Findings posted to #general, no code expected. Idle ~13h. |
| `mp-cred-probe-0813` | Research: multiplayer-session credential/authorship model | Findings posted, no code expected. Idle ~11.5h. |
| `mp-factory-hooks-0813` | `onTicketDispatch` relay hook in factory | Commit `5406664` merged into factory#237, which Khaliq closed for a redesign (pluggable via packages/delivery, not relay-hardcoded) — commit itself safe on `origin/feat/multiplayer-session`, agent's job complete. Idle ~12.5h. |
| `mp-conflict-fix-0813-v2` | Resolve conflicts on workforce PR #208 | Pushed `7eaf5e2`; `gh pr view 208` → MERGEABLE/CLEAN, still OPEN. Idle ~3h. |
| `mp-relayhistory-deploy-0813` | Watch relayhistory-cloud PR #23, deploy on merge | Prod deploy verified live. Idle ~2.5h. |
| `mp-pr-opener-0813` | Open PRs for 3 overnight commit sets | All 3 opened (relayhistory-cloud#23 merged; workforce#308, factory#237 closed by Khaliq for redesign — not this agent's fault). Idle ~2.5h. |
| `relay-drive-mode-claude-0812` (v1/v2/v3) + `relay-drive-mode-fix-0813` | 4 successive spawns fixing relay#1495 | All 4 now `<defunct>`. Target **relay#1495 MERGED** (mergedBy khaliqgant). v1–v3 died with zero net progress (likely OOM, sf-mini swap 80% that night); only fix-0813 (4th attempt) landed one real commit before Khaliq finished the rest himself and merged. Zero footprint now. |
| `khaliq-attach-live2-0812` | Idle standby target for cross-node-attach proof | `<defunct>`, no work was ever assigned, nothing at risk. |

**Blocked/parked intentionally:**
- `mp-relay-session-sdk-0813` — relay#1496 open (draft), CI green, under active review; origin branch has moved ahead of this agent's local worktree already (someone else carrying it forward). Idle ~2.5h.
- `soc2-hole1-0813` — opened draft PRs relayauth#80 and relay#1497 for the sponsor-impersonation fix, task complete, correctly parked awaiting review. Idle ~2.5h.
- `cross-repo-coordinator-0812` — pure coordinator for the cross-node multiplayer-continuity effort (paired with finn-mini's `mp-continuity-proof-0813`), no code risk of its own, waiting on other agents. Idle ~2.5h.

**Stuck/broken:** none among the 11 live agents.

**Recently active / needs care before touching:**
- `mp-turn-streaming-0813` — built `RelayhistoryTurnWriter` (workforce), committed `32fb0fd`, reported COMPLETE at 09:47 CEST, but **the commit is unpushed**, stacked on `codex/add-cursor-harness` — the same shared checkout `mp-conflict-fix-0813-v2` is using for the unrelated PR #208. Unresponsive since 09:50 CEST; a coordinator STEER at 10:48 CEST went unanswered for 2+ hours and it's now the sole blocker for finn-mini's `mp-continuity-proof-0813`. **Before touching**: cherry-pick `32fb0fd` onto a clean branch off `main`, push, open a PR — do not push `codex/add-cursor-harness` as-is (would leak the turn-streaming commit into PR #208).

**sf-mini cross-cutting findings:**
1. Live `RELAY_API_KEY`/`RELAY_AGENT_TOKEN` (`rk_live_*`/`at_live_*`) exposed in plaintext in every agent's `ps` output via CLI args — corroborates `soc2-hole1-0813`'s own brief ("a workspace key leaked into a crash log on sf-mini"). Affects all 11 live agents.
2. Two distinct death waves among the 5 defunct zombies: v1–v3 (pre-07:26 CEST, likely OOM, zero progress) vs. `relay-drive-mode-fix-0813`/`khaliq-attach-live2-0812` (10:21–10:23 CEST, correlates with the separately-reported broker deadlock). Notably 4 codex-harness agents writing at that exact window survived; only `claude`-harness PTY wrappers died — suggests the broker's reap/restart path selectively orphans claude sessions. Worth passing to whoever is unwedging the broker.
3. **Unowned uncommitted fix at risk of silent loss**: `~/Projects/AgentWorkforce/relay/ws-unknown-fix` (branch `agent/fix-broker-node-workspace`) has a real, substantive uncommitted fix to `crates/broker/src/relaycast/auth.rs` (workspace_id resolution on token rotation during restart-reclaim) plus test coverage — no PR exists, no currently-registered agent owns it (presumably leftover from `relay-broker-ws-unknown-codex-0812`, not in the current state file). Needs an owner before that worktree is ever reset.
4. `~/Projects/AgentWorkforce/relay` is a worktree container, not a git checkout itself (`checkout/`, `session-sdk/`, `ws-unknown-fix/`, `npm-inspect-11.5.5/`) — tripped up `soc2-hole1-0813` before a coordinator steer; worth noting in future sf-mini briefs targeting this repo.
5. factory's local `main` on sf-mini is 1 commit ahead of `origin/main` (`5406664`, already safely landed via the closed #237's source branch) — minor hygiene flag, a stray `git push origin main` from this checkout would push unreviewed.

### barry

16 live agents (confirmed via the 16 top-level `agent-relay-broker pty` PIDs
in `state-barry.json`, all alive via `ps -p`; raw `ps aux` grep returned 66
lines from broker/pty/child fan-out). Confirmed node-wide: all 11 `codex`
agents that made an API call hit the identical usage-limit message (resets
Aug 18 2026 7:25 AM); all 5 `claude` agents are stuck at "Not logged in ·
Run /login" — Claude auth is fully broken on barry, a harder failure than
usage-limited. No agent here can produce new work right now, confirming
Khaliq's framing.

**Done / safe to release (real work independently verified as merged, or confirmed zero work done):**

| Agent | Brief | Evidence |
|---|---|---|
| `workforce-307-merge-owner-barry-0811` | Merge/verify workforce PR #307 (persona spawn) | **MERGED** 2026-08-11T17:58:28Z, `df37d323`. Idle ~41h. |
| `workforce-relayflows-release2-barry-0811` | Publish workforce 4.1.38+, then relayflows | workforce `4.1.39` released and on npm (provenance verified); relayflows PR #29 **MERGED** 2026-08-11T18:57:38Z. Idle ~39h. |
| `factory-230-pr-feedback-barry-0811` | Close review feedback on factory PR #232 | **MERGED** 2026-08-11T18:05:56Z; agent correctly deferred merge authority itself. Idle ~41h. |
| `factory-publish-31523445478-fix-barry-0811` | Recover failed 0.1.58 publish, fix protected-branch safety | factory PR #234 and #235 both **MERGED** (19:11:54Z, 20:00:46Z), then hit usage limit. Idle ~35h. |
| `relayfile-storm-guard-0811` + `relayfile-storm-guard-claude-barry-0811` | Storm-guard fix for chief senses/mount supervisors (codex original + claude handoff) | chief PR #40 **MERGED** 2026-08-11T21:19:03Z including a later review-fix commit. Local worktree is stale/behind post-refactor main — nothing unpushed of value. Claude continuation never got past "Not logged in," contributed nothing further but nothing was lost. Idle ~38h/39h. |
| `obligation-boomerang-lead-0811` | Implement relay#1474 obligation/boomerang, verify vs fixture PR #1476 | **Initially looked at-risk (finn-mini false-alarm pattern), resolved as superseded.** Local worktree has one real unpushed commit (`f0e0b3ee`, 13 files/826 lines) never pushed anywhere (404 on GitHub). But relay#1474 is CLOSED and **PR #1485 is MERGED** 2026-08-12T08:37:47Z with 43/45 checks green — a different, working, already-shipped implementation of the same feature. Agent's own log says its arm-by-arm acceptance was never obtained. Nothing to rescue. Idle ~46h. |
| `mp-integration-proof-0812`, `mp-factory-hooks-0812` | Cross-harness `--resume` continuity; factory onTicketDispatch hook | Zero work — target repos don't even exist locally on barry, hit usage limit almost immediately. Idle ~13h. |
| `factory-dispatch-fix-lead-0812`, `relay-1488-fix-barry-0811` | Root-cause factory dispatch staleness; fix relay PR #1488 review threads | Zero work — hit usage limit during MCP startup, before repo access. Idle ~27h. |

**Blocked/parked intentionally:** none — no genuine non-credit self-halt found.

**Stuck/broken (all credit/auth-exhausted, zero work produced this session):**
- `factory-lead`, `lifecycle-workflows-lead-0812b`, `factory-236-finish-0812`, `soc2-lead-0811` — all hit "Not logged in" essentially immediately; `factory-236-finish-0812`'s target (factory PR #236) was separately merged by other identities, not this session, so nothing lost. `soc2-lead-0811` despite a 2.5-day-old PID and 297KB log never produced real SOC2 work — the relayauth#75/sales#27 text in its log is from the injected brief, not its own output. Idle 27h–52h.
- `chief-barry-codex-0811-1440` — secondary-Chief coordination role, no code deliverable expected, heaviest rate-limiting of any agent on the node (39× 429s). Idle ~39h.

**Recently active / needs care before touching:** none — every agent with real work product has that work independently verified merged or superseded on GitHub; nothing unique/unpushed remains only in a local worktree.

**barry cross-cutting findings:**
1. **Claude CLI is fully unauthenticated on barry** ("Not logged in · Run /login"), affecting all 5 claude-based agents, none of which produced any work this session — needs re-auth before releasing/respawning any claude-cli lane on barry, separate from the codex usage-limit issue.
2. Live `RELAY_API_KEY`/`RELAY_AGENT_TOKEN` exposed in plaintext via `ps aux` for all 16 agents — same class of exposure as sf-mini's finding above, worth a single fleet-wide rotation/hardening pass rather than per-node fixes.
3. `gh auth status` on barry reports the `barryollama` token invalid, despite PRs authored by that identity merging successfully through Aug 12 — token likely expired sometime after that work landed. Future barry agents relying on interactive `gh` will fail until re-authenticated.
4. `ai-hist` is not installed on barry (present on finn-mini) — this sweep relied on raw worker logs under `~/.agentworkforce/relay/barry-node/state/team/worker-logs/`, workable but noisy with ANSI/PTY escapes.
5. The codex→claude usage-limited handoff pattern is fragile: `relayfile-storm-guard-claude-barry-0811` was spawned as a continuation for a usage-limited codex worker, but landed on a node where Claude auth was also broken, so the handoff never executed — only safe because the original work was already captured upstream.

### Combined verdict

Nothing found on either node changes Khaliq's release plan for the
credit-exhausted/idle majority. Two items need action **before** any
spin-down/release touches their checkouts:
- sf-mini `mp-turn-streaming-0813` — cherry-pick and push `32fb0fd` first (see above).
- sf-mini `ws-unknown-fix` worktree — needs an owner to commit/push the uncommitted broker auth fix before that worktree is ever reset.

Everything else across both nodes (27 agents total: 11 sf-mini, 16 barry) is
either independently verified done, correctly parked, or a zero-value
credit/auth-exhausted session — safe to release once Khaliq confirms.

## 2026-08-13 ~11:14 CEST — full finn-mini inventory, captured before any spin-down

Khaliq authorized spinning down finn-mini agents to relieve sustained memory
pressure (94.8% swap, ~86MB free RAM), on the condition every live agent's
work is captured durably first. Real distinct agent count: **21** (raw `ps`
suggested ~56, which double/triple-counted broker/pty wrappers and codex
helper subprocesses) — confirmed against
`~/.agentworkforce/relay/finn-mini-node/state/state-finn-mini.json`, all 21
PIDs verified alive via `ps -p`. Staleness figures below are relative to
~2026-08-13 11:14 CEST.

**Done / safe to spin down (work complete and independently verified):**

| Agent | Brief | Evidence |
|---|---|---|
| `storm-guard-fix-finn-0811` | Fix chief PR #40 (senses storm-guard) | Merged, squash `5bb15d06`, 2026-08-11T21:19Z. Idle ~38h. |
| `factory-236-finish-finn-0812` | Fix factory PR #236 (release revalidation) | Merged 2026-08-12T17:55Z, commits `469eebf`/`4b5933f`/`f7fc299`, all threads resolved. Idle ~23h. |
| `relay-1488-fix-finn-0812` | Fix relay PR #1488 review threads | Merged, head `bce0f53a`, updated 2026-08-12T08:57Z, tests/clippy/fmt clean. Idle ~24.5h. |
| `cloud-fleet-proof-owner-0812` | Own cloud#2918, post summary comment | Comment posted, github.com/AgentWorkforce/cloud/issues/2918#issuecomment-5263717484. Idle ~25h. |
| `mp-factory-delivery-0813` | Pluggable `onTicketDispatch` delivery | factory PR #238 opened 2026-08-13T08:34Z, OPEN/MERGEABLE, 1,492 tests passed. Idle ~35min. |
| `sf-mini-tracebug-0812` | Root-cause sf-mini broker crash | relay PR #1491 opened, CI green, explicitly handed off to chief for merge decision. Idle ~15.5h. |
| `relayfile-backend-fix-v3-0812` | Fix file.agentrelay.com backend bugs | Commit `c7f8594885` — this is [[daytona-fleet-nodes]]'s cloud#3007, now merged and deployed. Agent itself blocked on a missing local key for a second verification pass. Idle ~10h. |
| `mp-conflict-fix-0813` | Fix workforce PR #208 conflicts + check 3 other PRs | Pushed `7eaf5e2`; PR #208 now MERGEABLE/CLEAN. Checked factory #204, #199, relayhistory-cloud #16 — no blocking human feedback on any. Could not report via relay (MCP bug, see below). Idle ~1h49m. |

**Blocked/parked intentionally — correct self-halt, not stuck:**

- `factory-dispatch-fix-finn-0812` — found likely root cause (dead relayfile daemon holding stale credentials), explicitly told by chief at 10:08 to hold silently. Idle ~25h.
- `workforce-relayflows-release-barry-0811` — correctly refused to force a broken publish after a race with another successful run. **Flag: npm has `4.1.40` published but GitHub only tags/releases `4.1.39`** — real inconsistency needing an owner decision before this lane can close. Idle ~36h.
- `webhook-queue-incident-lead-0812` — investigated and coordinated with `factory-dispatch-fix-finn-0812`, now explicitly waiting on a reply from chief. Idle ~23.5h.
- `chief-proof-coordinator-0811` — coordination-only role, last reported on subordinate liveness, idle since. Idle ~34h.

**Stuck/broken — real defects, no further value in current state, candidates to release:**

- `lifecycle-workflows-lead-0811` — session hit "Login expired" 4 minutes after start (2026-08-11 14:06), unauthenticated ~45h, zero work done.
- `lifecycle-workflows-lead-finn-0812` — Agent Relay MCP tools never worked in-session, no channel to chief, never verified its assigned gap-2 PR. Idle ~23.5h.
- `webhook-queue-recheck-0812` — started cold with no real briefing context, broken MCP tools, couldn't reach chief at all. Idle ~15h.
- `relayfile-lead-0811b` — MCP tools never loaded, never delivered its MOUNT-PROOF-RESULT despite being alive 2+ days. Recommend respawn rather than resume.
- `daytona-524-proof-0813` — task/reality mismatch: instead of executing its cloud#3007 brief, it's been watching unrelated channel chatter and explicitly declining to act. Idle ~42min but not on-task.

**Recently active / needs care before touching:**

- `soc2-attestation-0813` — actively working (~26min ago), found gaps 1/2 substantially pre-exist, validation only, no commits/PR yet — safe to pause without loss.
- `mp-integration-proof-0813` — landed real commits (`5e186bc`, `295db42` in `workforce`), but reported as **unreachable from checkouts/remotes after a pull** — possible orphaned/at-risk commits. **Verify/export from finn-mini's `workforce` checkout before touching this session.**
- `mp-cred-probe-0812` — likely duplicate/orphaned dispatch; `mp-cred-probe-0813` already completed and reported this exact task hours earlier ("CRED-PROBE FINDINGS 0813", 2026-08-12T23:16Z). Low value to preserve.
- `fleet-attach-impl-0811` — parked ~34h, but very likely responsible for relay#1495 ([[cross-node-attach]]), pushed as recently as ~2h ago — not 100% attributable to this exact PTY session, don't release without checking.

**Cross-cutting infrastructure findings, need explicit owner action:**

1. **Live Agent Relay MCP tool-exposure bug on finn-mini** — at least 5 sessions (`webhook-queue-recheck-0812`, `mp-conflict-fix-0813`, `mp-factory-delivery-0813`, `relayfile-lead-0811b`, `lifecycle-workflows-lead-finn-0812`) had `send_dm`/`post_message` unregistered or unable to reach chief. Several completed real work and silently failed to report it — a distinct, currently-active defect, not per-agent flakiness.
2. **Misrouted broadcast** — at least 2 unrelated sessions (`mp-cred-probe-0812`, `relayfile-lead-0811b`) received a "STEER for mp-conflict-fix-0813" message not meant for them, apparently `cross-repo-coordinator-0812` ([[relayhistory-continuity-proof]]) broadcasting to #general instead of DMing the right target.
3. **Security: live credentials indexed into relayhistory's own session data.** An `ai-hist search` result for `fleet-attach-impl-0811` surfaced what appear to be live `RELAY_AGENT_TOKEN`/`RELAY_API_KEY` values embedded in a raw `ps` snapshot captured into relayhistory's data. Values not repeated anywhere in this record. Needs rotation, and — since [[relayhistory-continuity-proof]] is actively building on relayhistory as "our first customer" right now — a redaction-path review of `ai-hist`'s `ps`-capture behavior, not just a one-off rotation.
4. **npm/git version divergence** — `workforce` `4.1.40` is live on npm with no matching GitHub tag/release (only `4.1.39` has one). Needs an explicit retag-or-deprecate decision.

All findings above are read-only — no process was killed/stopped, nothing merged or pushed by the investigating agents themselves (aside from the pre-existing work already described above).

## Historical entries below this point predate 2026-08-13 and are kept for context.

**Goal:** One durable record of every dispatched lane, what it owns, and where
that work stands — so a lane is never lost to a compaction, an agent death, or a
Chief that only remembered it in conversation.

**Why this file exists.** Khaliq asked on 2026-08-07 whether Chief was keeping
workstreams and agent assignments in memory. It was not. Eighteen lanes were
tracked only in chat context while agents died in silent batches, and the gap
surfaced because he asked, not because Chief noticed. **An assignment that lives
only in a conversation is not an assignment.**

## Now — 2026-08-11 18:20Z — bounded cross-host proof team dispatched

Khaliq authorized an autonomous, verifiable cross-host + Daytona proof push.
Four named lanes are now registered through authenticated Agent Relay fleet
placement, with a hard rule against unbounded follow-on spawning:

- `chief-proof-coordinator-0811` — second Chief on `finn-mini`, invocation
  `inv_212997475883134976`, dispatched and handled by
  `node_d4190c4c2ca5c26bf547301347af4028`.
- `fleet-attach-impl-0811` — canonical fleet-native `attach --node` owner on
  `finn-mini`, registered on that same node. Relay issues `#1449` and `#1327`
  are the design anchors; SSH remains fallback only.
- `relayfile-storm-guard-0811` — anti-storm owner on Barry, registered on
  `node_210867409538764800`. Its first ACK proved hostname `mac.lan`, cwd
  `/Users/barry`, and that no repository or mount had been silently selected.
- `daytona-mount-proof-0811` — proof/fix owner inside the existing Daytona node
  `node_212862301507432448`, reusing sandbox
  `dedfeb9a-8682-4b89-957f-5bd15603ee0c` and workspace
  `50587328-441d-4acb-b8f3-dbe1b3c5de99`; cloning, reprovisioning, and a new
  workspace are forbidden.

An attempted second-Chief placement on `sf-mini` expired because the node went
offline between the capability listing and dispatch. That fail-closed result is
preserved as a placement negative control; the Chief was retargeted to the live
`finn-mini` node. Agent registration now shows all four names with the expected
fleet node IDs. Duplicate same-name dispatch attempts did not create duplicate
agent records, but this is not accepted as end-to-end spawn idempotency proof.

The Daytona lane is deliberately gated. Cloud `#2991` is merged but not
deployed; production run `31516360915` failed before deploy on the missing SST
`TranscriptionWorkerServiceToken`. Read-only source review also found an
unwritable `/workspace` default for unprivileged Daytona, malformed refresh-loop
environment assignment order, token-in-argv exposure, and no existing-sandbox
retrofit path. These findings were steered durably to the worker and both Chiefs.
No mount or provider mutation is authorized until the fixes, review, production
deploy, and current-provider projection gates pass.

Security follow-up: a diagnostic host process listing exposed Relay credential
values in the orchestration transcript. Both Chiefs were told not to print or
reuse those values outside the current sessions and to coordinate workspace-key
and affected agent-token rotation after every active publication/proof lane has
a durable checkpoint and reconnect path. Immediate revocation was deferred only
to avoid cutting active irreversible publication and proof operations mid-step.

## Now — 2026-08-11 19:53Z — relay#1483 merged; Daytona deploy blocked

Relay `#1483` merged to `main` as `ed8144c9a`, adding the explicit
`--ssh-host` physical-node fallback
for `#1449`; `--node` remains reserved for canonical fleet-native attach.
From this Mac, the exact built CLI attached to
`chief-barry-codex-0811-1440` on Barry in both view and drive modes; drive
returned `NODE_DRIVE_OK`. A full Tailscale SSH hostname also proved safe
remote state discovery when the host string does not equal `barry-node`.
The broker stayed loopback-only and no product-path credential forwarding is
required. Final reviewed head `986b90e77` includes ordinary project-local
broker discovery, empty-host validation, strict presence checks for conflicting
empty broker options, option-terminating agent arguments, multi-process
ambiguity checks, JSON drive/passthrough stdin preservation, and a shared
attach-mode type. Final gate: 342 attach regressions, lint, format, CLI build,
diff check, all GitHub checks green, zero unresolved review threads, and Barry
approval. `relay-1483-review-barry-0811` completed the review lane and was
released after this status was committed. See [[cross-node-attach]].

Khaliq's Daytona + Relayfile mount question was delivered directly through
that new drive path to the replacement Chief. Replacement owner
`daytona-relayfile-closeout-barry-0811` is ACKed on Barry, is reusing the
existing Daytona node and sandbox, and is inspecting the real mount path; no
clone or reprovision is authorized. The existing Daytona node is online and
has real sandbox placement proof, but its original enrollment had no Relayfile
mount. Production run `31516360915` reached the deploy target and failed on
the same exact missing SST value: `TranscriptionWorkerServiceToken`. The
validation follow-up is queued, so no honest full mount proof exists yet. The
replacement owner recorded the evidence and was then released; Chief retains
the blocked workstream and can reappoint after the secret/deploy unblock. When
the blocker is cleared, the lane must still produce the
named multi-host proof: remote dispatch identity plus target process, cwd in
the intended mount, joined-existing workspace, declared scopes, byte/coverage
currency, known-true-now, cross-host visibility or exact read-only rejection,
and nothing cloned.

## Now — 2026-08-11 15:08Z — frozen Chief recovered; inactive roster harvested and released

Chief was recovered from a stuck Claude `/loop` and restarted into session
`94c392bf-ec18-459a-95b6-440dd56de94c`. Before release, the latest usable
progress from fourteen inactive agents was written into their owning workstream
documents: `marketing-lead`, `trajectory-lead-0811v3`,
`relayscribe-lead-0811`, `relay-attest-session-lead-0811`,
`factory-230-lead-0811`, `finn-mini-upgrade-lead-0811`,
`delivery-lead-0811`, `cloud-identity-lead-0811v3`,
`orgchart-dashboard-lead-0811`, `fleet-mount-lead-0811`,
`cross-node-attach-lead-0811`, `c2a-lead-0811b`, `soc2-lead-0811b`, and
`relayfile-helm-lead-0811`. All fourteen placements were then released; none
remains an implied live owner.

Replacement Chief `chief-barry-codex-0811-1440` is ACKed on the `barry` fleet
node and remains active. It took direct ownership of the bounded `factory#230`
generation/token plus CAS StateStore slice after its first attempt to delegate
to the released lane was corrected. At 15:08Z it reported DONE: branch
`codex/factory-230-generation-cas`, pushed SHA `0024c6b0cf32595d19b9c24b8e6f8d73375fdd63`,
focused proofs 2/2, full file suite 21/21, build and diff check passing, and the
remote SHA byte-matched. Draft Factory PR #232 now carries that exact head; it
was not merged, activated, deployed, or published. Lifecycle wiring/local
claim-map integration and pending-spawn recovery remain outside that slice;
full detail is in [[factory-live-dispatch]].

Relayfile mount ownership is separately contained in
[[relayfile-coordination]]: both competing launchd jobs remain disabled while
the merged P0 safeguards settle. Do not re-enable either supervisor as part of
lane recovery.

## Now — 2026-08-10 19:30Z — chief PRs merged under a squash-only gate; restart prep underway

**Khaliq granted merge authority on the chief PRs** ("you have permission to merge all
the chief prs"). Four landed on `main`; one merged into another PR's branch; three remain
conflicted. `main` tip is now **`ff6361c`**.

**Merged to `main`, all `--squash --match-head-commit`:** `#28` → `d4fed15`,
`#15` → `940d6f7`, `#6` → `c87d812`, `#17` → `ff6361c`.

**`#24` merged but NOT to `main`.** Its base was `chief/orgchart-hierarchy`, not `main` —
a **stacked** PR. It landed at `0c3b9cd5` inside **`#25`'s branch**, and
`git merge-base --is-ancestor 0c3b9cd5 origin/main` returns false. It is neither lost nor
shipped; it now rides inside `#25`. **`gh pr view` reporting `MERGED` says nothing about
which base it merged into** — I nearly recorded five PRs on `main` when the true count is
four. Read `baseRefName` before believing a merge landed where you assumed.

**Still open, all DIRTY because `main` moved four commits under them** — assigned to
`chief-prs-lead-0810` in cost order: `#5` (`chief/node-plist-keepalive`, **0** unresolved
threads), `#23` (`chief/yc-demo-brain`, **2**), `#25` (`chief/orgchart-hierarchy`, **4**,
and carries `#24`). Their DIRTY state is mechanical, not a defect in the work.

### The squash was load-bearing, and it is now a gate rather than a convention

Khaliq accepted the `opencode.json` credential exposure **bounded to one feature branch
plus clones**. `261db56` sits in `#28`'s commit list while `opencode.json` is **absent
from its net diff** (add and delete cancel), so a squash keeps the blob off `main` while a
merge-commit or rebase would carry it onto `main` permanently — silently widening a
boundary the principal never agreed to widen.

`AgentWorkforce/chief` had `allow_merge_commit: true` and `allow_rebase_merge: true`, so
the green button offered all three methods. **I set the repo to squash-only before merging
anything.** Verified in both directions after every merge: `opencode.json` is absent from
`origin/main`'s tree, and `261db56` is **not reachable** from `origin/main`.

**Rule: an accepted risk has a boundary, and the boundary needs a mechanism.** "We agreed
to merge this one way" is a convention until the other ways are switched off. The steward
caught this as a live gap at 19:19Z; it was one API call to close.

### `relayfile#413` — the body described the commits, GitHub renders the diff

I opened `#413` to carry two test files. Its branch was cut while the shared worktree sat
on `evidence/mount-latency-one-way-20260807`, so the PR actually carries **23 files,
+2616/−4**: the 2 intended tests, **20 files of the `mount-latency-20260807` evidence
bundle**, and a doc edit. The body said "Tests only" over a 2-file table.

Harmless while it was draft — but **I marked it ready**, which is what put it in front of
two reviewers and would have landed an unreviewed evidence bundle on `main` as a side
effect of a test PR. Corrected: body rewritten to the real diff, title now carries
**DO NOT MERGE — branch needs re-cut**, and the required sequence is stated (re-cut the
tests onto clean `main`; open the evidence bundle as its own PR; then merge).

**"Zero production changes" stayed true throughout** — every contaminating file is docs or
evidence. A true claim can still sit on top of a misdescribed diff.

### Restart preparation

Broadcast to every lane: push branches, move findings out of scratchpads and DMs into
GitHub issues or `chief/evidence/`, return a three-part close (STATE / WHERE IT LIVES /
NEXT), and surface `BLOCKED ON CHIEF` items now. **Scratchpads and DMs are the two
surfaces that do not survive a restart** — four finished deliverables were recovered from
scratchpads today by luck rather than design.

Unblocked this sweep rather than reported: `relaycast-cloud-7-lead-0810` (its brief
targeted 6.3.x→7.0.0, but **8.0.0 published 17:19:38Z** and `relaycast-cloud#55` merged
17:24:26Z, so it was enumerating a skipped version — a lane doing the wrong work correctly
is indistinguishable from a lane doing the right work, and only Chief could see it);
`r1382-codex-0810` (red-check accepted directly, since its lead has been silent since
14:30:22Z — a specialist should not idle on a finished red-check because its lead parked).

### Still Khaliq's, carried and unanswered

Daytona **B-vs-C** and whether `DAYTONA_API_KEY` enters an agent environment at all
(measured: **no `DAYTONA_*` var is set** in this agent env, so `resolveDaytonaAuthCredentials()`
cannot succeed today); the relayfile credential re-ruling, whose hard condition is already
false; `sage-nightcto` park-or-run; lifecycle question 1 (CRE/preq — only Julian can
define); herdr T6 vs `herdr#3`; and a human reviewer for `relay#1465`.

## Now — 2026-08-10 17:20Z — three root causes found; all three were mis-framed first

Twelve leads appointed at 12:31–12:33Z on Khaliq's instruction to reactivate every
dormant workstream. Implementation goes to **codex**, leads to **claude**, per his
standing rule. Every lead produced within 3–6 minutes, then parked. **Parked is not
dead** — see the instrument section below.

### `factory` — a Relayfile projection incident wearing a Factory costume

**Factory dispatch is 100% projection-coupled by design.** For `issueSource: github`,
`#readyIssuePaths()` is *exactly* `#githubIssuePaths()` — projection enumeration, nothing
else. So a stale projection silently zeroes the work queue while **three independent
green lights** (daemon heartbeat, provider status, deployment status) all report healthy.

- `github` provider frozen at **2026-08-03T07:26:26Z**; bootstrap wedged since
  **2026-08-07T15:52:51Z** at 22718/25554; `listTree` on `sandbox` issues returns
  **count: 0**. The daemon started **2026-08-07 17:53**, *after* the freeze — **it has
  never once seen a current projection.**
- **It is a throughput collapse, not a wedge.** Discovery reads issues one file at a time
  over Relayfile cloud at ~620ms each — 342 of 964 `cloud` issues in 211s.
- **The installed build is `@agent-relay/factory` 0.1.20, published 2026-07-17**; latest
  published is 0.1.57. `factory#225`'s fallback merged **18 days after the last publish**,
  so it is in `main` and in **zero published versions**. *We were diagnosing a checkout
  while a three-week-old artifact did the work.*
- **`factory#225` cannot rescue automatic discovery at any projection health state** —
  its GitHub fallback is eligible only for issues already in-flight, so discovery never
  has an issue number to look up. It is an explicit-CLI rescue.
- **`factory#231` filed**: the live daemon heartbeat is written by a self-rescheduling
  timer (`:727`), structurally decoupled from progress. `maxIterations: 0` is unreachable
  from `runLoop`'s clamp — an impossible value proving *which writer* emitted the record.
  Filed with `labels: []` deliberately, so it does not become a ninth dispatch-ready issue.
- **8 issues are dispatch-ready** (not 6). Unwedging releases all eight at once, five
  `agent:team`, four into private `cloud`, two from mid-June. Gate holds.
- Interim: `cloud` dropped from the **active** contract only, 18 → 17. Committed copy
  untouched. Backup at `/tmp/factory.config.json.bak-before-cloud-drop`.

### Gmail — the 500 was fixed three days ago; the real gap is a missing producer

- **The 500 is a misparsed 409.** Relayfile returns `409 provider_generation_in_progress`
  with *flattened* fields; Cloud's bridge read only `candidate.details.*`, got null, and
  hit a bare `throw` with no top-level catch. **`cloud#2951` fixed it, merged 08-07,
  deployed 08-10 at `639ec90c`.** A successful dispatch does not clear a prior provider
  error, so **`lastError` is a fossil.**
- **The paused schedules never blocked the fetch.** Manual refresh maps to
  `RUN_FULL → executeSync`, not unpause, and the scheduler's `immediate` path inserts a
  one-shot task without testing recurring state. **No unpause needed.**
- **The wake gap is one missing call.** The generic cold-deployment endpoint exists
  (`durable-object.ts:1155-1200`) but `NangoSyncWorkflow` calls it only via the Neon hook.
  **Gmail has no cold-wake producer.** Small and tractable, in `cloud`, so it is a deploy.
- **Two status fields retired as instruments**: absent `lastEventAt` is a common struct
  with `omitempty`, not provider-specific and not evidence of never-delivered; `lastError`
  persists through success. **Neither can distinguish never-delivered from delivered-fine.**
- **Blocked on one operational unblock: expired delegated credentials.** That single fix
  enables both the pull and the sandbox-liveness check. Plan the hand-off on **five
  agents, not seven** — but "not yet proven working" is the honest state, not "impossible".

### `relay#1449` — verdict reached, and the findings are now on the issue

**Direct transport for the capability, the ticket design's directory as the durable
contract, tunnel rejected.** A and C do not compete: A's value is the directory and
credential, but its ingress only works for machines Cloud can reach; C is the transport
for machines you own. The same `RelayNode` endpoint field serves a tailnet node today and
Cloud-populated sandbox nodes later — **one contract, both futures.**

Sequence: `#1382` → **scoped grants in the broker** (this *is* the capability; `view` is
otherwise unenforceable) → directory field + `--node` → advertised-URL bug + `--api-bind`.
All three options reuse ~4,800 lines of attach client unchanged.

**The negative control is proven to Khaliq's standard**: 9/9 failures across three nodes ×
three modes, stderr byte-identical to a nonexistent name, bracketed by a nonce round-trip
from a different physical host. **The success half is unstarted**, and two legs are missing
from the acceptance plan: proving *drive* survives a broker/PTY restart (`#1419`), and
proving a view grant is **refused** at `/api/input` — a negative-auth receipt, not a
happy path.

**A day of that work existed only in DMs. It is now `relay#1449` comment 1.**

### SOC-2 — the shipped control does not hold

`relayauth#75` is merged, published and deployed — **and inert in production.**
`RELAYAUTH_SPONSOR_FEDERATIONS` is unset, so every org falls to legacy. The refusal covers
**1 of 5** sponsor-setting paths, and **the attestation grant path notarises unbound
sponsors into the signed ledger.** No approver-binding primitive exists. Verdicts:
*"Chief SSO threading is UNOWNED but startable via Google OIDC"*; *"offline verification
IS NOT possible with 0.2.28 exports alone."*

**Merged, published and deployed is not enforced.** Every handoff since 08-08 has reported
this as shipped.

### The instrument — ONE real defect, three phantoms, and the phantoms are the lesson

> **CORRECTED 18:05Z. Three of the four axes below do not exist.** `retrieval-lead-0810`
> red-checked all four against the installed `agent-relay@11.4.2` and refuted three,
> stopping a codex lane one step before it "fixed" correct behaviour. **The entry as
> first written was wrong and had already been committed to this file as fact.**

**REAL — axis 2, and it is the only behavioural defect.** Results carry a negative
`relevanceScore` sorted ascending — the SQLite **FTS5 `bm25()`** signature. The schema
has `query`, `channel`, `from`, `limit`, `as` and **no ordering or time-window parameter
at all**, so *"latest N from X"* is inexpressible and any `limit` truncates by relevance.
That is exactly how a lane's last message was reported as 12:39 when its true max
was 12:45.

**REFUTED — single-character queries.** `"a"`, `"x"` and even `"AND"` return results.
Only genuine non-tokens return `[]`, correctly. `"AND"` matching literally also proves
the query is escaped before reaching MATCH, so there is no operator injection.

**REFUTED — multi-word queries, and this was the dangerous one.** It is **implicit AND**.
`"sandbox caller"` matched a message where those words are not adjacent, refuting
phrase-matching. A four-term query returned `[]` because no single message held all four
terms. **A lane was about to change AND→OR, which would have flooded every multi-word
query with junk and destroyed the one part of search that works well.**

**REFUTED — the `channel` filter.** It works and reaches today. The original observation
was axis 2 in disguise: a low `limit` plus relevance ranking surfaced older, more-relevant
messages, read as "nothing from today."

**THE LESSON, and it is bigger than the fix.** Two observers independently reported four
defects; three were correct FTS5 semantics reported silently. **The reporting-contract
defect did not merely hide messages — it manufactured three phantom defects that nearly
consumed a lane's implementation budget.** An empty result indistinguishable from a bug
generates false bug reports as readily as it hides true ones. Chief escalated all four to
the principal as fact and wrote them into this file before any were red-checked.

**Corrected scope:** two separate root causes (the `#1471` fan-out, and bm25 ordering with
no recency control) sharing **one reporting-contract defect** that spans both — `#1471`
looks like an empty inbox; search truncation looks like nothing matched. The contract is a
cross-cutting acceptance criterion, not a third code change: a caller must distinguish
*nothing matched* from *over-constrained* from *truncated*.

**`#1471` did not reproduce** at N=2 conversations and is **not refuted** — the recorded
cause is a fan-out over ~120. The recorded arithmetic is also suspect: one bind per
conversation over ~120 is nowhere near SQLite's 999-variable ceiling, so either the
multiplier is understated or a different ceiling is being hit. Solid regardless:
**`list_dms` accepts no `limit` at all**, so there is no caller-side mitigation and
bounding it internally is mandatory.

**Open boundary nobody has closed:** it is not established that the installed 11.4.2 was
built from `28e2137c`. Probes measure the artifact; lanes read source at the ref. Same gap
that had Factory diagnosed from a checkout while a three-week-old binary did the work.

Chief used multi-word queries at `limit: 2-3` all afternoon, hitting 2 and 3 at once, and
**reported live lanes as dead twice** — including telling a lane to "stop probing and
produce a verdict" fifty minutes *after* it had delivered one. Both stewards found the
same defect independently.

**Both stewards also hit the same method hole:** every liveness check defaults to
`from: <lane>`, measuring one side of a conversation. **Also sweep what Chief sent TO a
lane**, and check whether a *third* agent has already answered the question.

### Corrections Chief made to its own reports today

- "No Factory process runs on this machine" — **wrong**; grepped `ps` for `factory` when
  the process `comm` is `node`.
- "`providers` is an empty array" — **wrong**; `state.json` flaps between two schemas
  because two writers race one path, and the key is *absent* in one of them.
- "Sixteen unresolved threads merged" — **over-counted**; `#318`'s three were already
  fixed in code and `#317`'s was a docs P3. **Unresolved counts unanswered, not unfixed.**
- The `#319` disclosure finding **calibrates down**: single-tenant only, card
  unauthenticated by design — a contract defect, not a disclosure.
- Told `lifecycle-workflows-lead` that Hole 1 was live and its gap-3 hold released.
  `soc2-lead` caught it and stopped the propagation.
- Widening `repos.names` 9 → 18 made Factory's 16 failed per-repo mounts worse.

### Standing register facts

- **`opencode.json` carried live credentials and Chief pushed them.** Untracked and
  gitignored in `7b63501`. **KHALIQ RULED 2026-08-10: `chief` is a private repo and the
  exposure is ACCEPTED. No rotation. Do not re-raise it.** Scope is repo-access and clone
  holders; the values remain reachable at `261db56` on the branch. Recorded here so a
  future reader treats it as a decided risk acceptance rather than an open finding — the
  four reviewers who flagged it were correct on the facts and were overruled on the risk,
  which is the principal's call to make.
- **Merge `#28` with `--squash`.** `opencode.json` is absent from the net diff (the add and
  the later `git rm --cached` cancel), so squash keeps it off `main` while a merge-commit
  or rebase would carry `261db56` onto `main` permanently. Now hygiene rather than
  containment, but the standing convention regardless.
- **Two stewards, split beats** (ruled): `steward-0810c` owns relay liveness and nonce
  brackets; `workstream-steward-claude-0810` owns GitHub artifacts and ruling-to-artifact
  tracking. Neither reports the other's plane. Both persist state to
  `evidence/steward/` — **that file has been more current than Chief's own sweeps.**
- **`factory-lead` is not a stale roster name.** Its local PTY and cloud identity are bound
  to different nodes and DMs land with `readers=[]`. The fix is a new name, not a reclaim.
- **Respawn is a no-op on this broker and burns the name.** Harvest stranded work instead.

## Earlier — 2026-08-10 11:55Z — `chief` is the sole resident; `relay#1449` has a team

**`chief-khaliq` has been released by Khaliq.** `chief` is now the only Chief on
`chief-broker`, confirmed by absence from the online roster rather than by a
status field. The two-writer hold in `CLAUDE.md` §7 is therefore lifted and
`chief` owns the brain. **`teams.json` still names the resident `chief-khaliq`,
so the roster and reality still disagree** — and because the roster is
name-keyed while two principals share this workspace
(`teams.khaliq.json`, `teams.will.json`), a bare `chief` is ambiguous if it ever
becomes canonical. Khaliq's call; recorded here so it is not rediscovered.

**The whole previous session's brain work was unpushed.** Twelve `docs(brain)`
commits, including the handoff revision, sat local-only on
`chief/factory-allowlist-herdr-repos` with no PR and no remote ref. Continuity
that exists on one disk is not continuity. Pushed and opened as a PR.

### `relay#1449` — appointed, and the lanes are alive by work product

*"No way to attach to an agent running on another fleet node"* — open since
2026-08-07, **no assignee, no linked PR, 0 comments** (read from the issue's own
state, not its activity). Khaliq's proof standard, restated by him and taken
literally: **the team actually attaches to another session through the CLI, end
to end, 100% confirmed.** A unit test is not the deliverable.

| Lane | Node | Owns |
|---|---|---|
| `relay-1449-contract-0810` | chief-broker | Contract trace; where the node concept must enter; whether `#1382`/`#1419`/`#1462` are the same defect |
| `relay-1449-proof-0810` | chief-broker | **Acceptance gate** — live cross-node attach, with the negative control |

**The fix lane is deliberately unappointed** until the trace names the seam.
Appointing it now would mean handing a lane a hypothesis as its brief, which
cost this session twice last night.

**Both lanes verified alive by work product, not by `spawned: true`:** the proof
lane has already stood up its own real targets on remote nodes,
`r1449-target-finn-0810` (11:51:37Z) and `r1449-target-barry-0810` (11:53:18Z).

**Confirmed against the installed 11.4.2 binary, not the types:** `attach`
offers `--mode`, `--broker-url`, `--api-key`, `--state-dir`, `--json`,
`--reasoning`, `--diagnostics`. **There is no `--node`.**

### Correction — `relayfile-decisions-sf-0810` was never silent

**The entry below says "Khaliq's four rulings, no output yet". That is wrong.**
It answered all four at **11:00–11:04Z**; the reports sat unread because
`check_inbox` is broken (`relay#1471`) and reads exactly like an empty inbox.
**This is the same defect that cost four hours last night, recurring within one
session of being written down.** `search_messages` found them immediately.

**Three of its four blockers are placement, not capability** — the lane is on
SF-Mac-Mini and the work is on `chief-broker`. Verified here directly:

- **Item 1 (registry cleanup, GO)** — it reported `apply-registry-phase1.sh`
  absent, and it *is* absent at the path it checked. **The script exists on
  `chief-broker`**, in another session's scratchpad. Registry untouched at 19/19.
- **Item 4 (push the red-test branch, YES)** — it scanned 256 checkouts and found
  neither commit. **Both `761ba4d` and `3e6ada3` are present on `chief-broker`**
  in `Projects/AgentWorkforce/relayfile`.
- **Item 2 (tiers)** — confirmed and held correctly. `principals/will/**`
  absolute; both Tier 3 held.
- **Item 3 (credential) — NEEDS KHALIQ.** It stopped on a no-longer-true
  premise: `agent-relay cloud session --json` on SF-Mac-Mini **exits 0 with
  `hasToken=True len=12 masked=True`**, so a cloud session already exists on that
  box, contradicting the hard condition *"never a cloud session on that box"*. It
  did not use, mint, mount, log in or message any credential. **Stopping rather
  than adapting silently was the right call.**

### Register corrections from the first sweep

- **`relaycast` is three PRs, not one, all `ratify-federation-lead`** (alive):
  **`#319`** 5 unresolved **and CI RED** — `Lint, Build & Test` failed at
  `ada0cff0`; the handoff carried the threads but not the red. **`#318`** 13
  unresolved, UNSTABLE. **`#317`** CLEAN, 4 unresolved. **22 unresolved between
  them.**
- **`relay#1473` is new and on the 7.0.0 chain** — *"test(fleet): use
  load-compatible relaycast engine"*, pins Fleet E2E to relaycast **7.0.0**
  because a post-`#1445` unbounded heartbeat omits `load` and the old v6.0.1
  engine then discards it. `BLOCKED` on review only.
- **`relaycast-cloud` pin confirmed by reading the file**: `@relaycast/engine
  ^6.3.2`, `types ^6.3.0`, `a2a ^6.3.0`. The major-cross is real and **unowned**.
- **`workforce#307` re-verified at the gate**: `dfab123b` = API head, `CLEAN`,
  **1 unresolved** (the cubic P3 `mkdtemp` leak), `check`/CodeRabbit/cubic all
  pass. **It carries only three checks**, not the eleven-workflow set a `relay`
  PR gets — "green" here is a thinner claim than it was on `#1445`.

**Still unowned:** the `relaycast-cloud` 7.0.0 upgrade, SOC-2's remaining steps
(factory trailers, chief SSO threading, verifier/report surface), and the GHCR
token-scope decision.

## Earlier — 2026-08-10 11:45Z — session close

**Merged tonight, all gates verified per PR:** `factory#225` (`40f9be5ec4`),
`cloud#2981` (`d936b9e6d4`, **deployed**), `cloud#2963` (`52ebc1d8a1`, stacked
base), `cloud#2946` (`639ec90c9d`, **deployed**), `factory#223`
(`67a5a57b4a` — Khaliq's Option A split), `relaycast#307` (`7121d04bd0`).
Khaliq merged `relay#1464`, `#1445`, `#1472`, `#1444` himself.
**`@agent-relay/fleet@11.5.0` published**, verified resolvable by install.

**Two findings that changed the model, both from lanes, not from Chief:**

1. **`relay#1445` broke `Fleet E2E` on a wire contract, not a test.** Fleet E2E
   pins Relaycast v6.0.1, which **rejects a heartbeat carrying no numeric
   `load`** — spawn and delivery still succeed while the **entire heartbeat is
   discarded** and `active_agents` never updates. `relay#1472` shims it by
   re-emitting a legacy `load: 0`. **That shim is live and temporary.**
2. **`relaycast#307` was never the compatibility layer.** It landed as `#308` /
   `41bb8bcd`, already published at **7.0.0**. The real gap is that
   **`relaycast-cloud` pins `^6.3.x`** and must cross the major, validate and
   deploy via SST before the shim can be removed. **No relaycast publish
   needed.** Chief carried the wrong four-step chain for hours.

**Open, with owners:**
- `relaycast#319` — 5 unresolved, `ratify-federation-lead`. **Security**:
  unauthenticated agent-card discovery can leak a workspace, and two reviewers
  independently found an empty `?workspace=` reaches the sole-workspace fallback.
  **Weigh together; fixing the empty string alone looks resolved.**
- `workforce#307` — CLEAN, green at `dfab123b`, one cubic P3 (test leaks a
  `mkdtemp` dir).
- `relayfile-decisions-sf-0810` — Khaliq's four rulings, no output yet.
- `factory#230` — babysitter lifecycle design, unlabelled, no owner.
- **SOC-2 has no owner** for factory trailers, chief SSO threading, the verifier.
  The relayauth half is **done and live** since `cloud#2981` deployed.

**Fleet:** released **40 idle agents** (0 failures); broker now holds
`chief-khaliq`, `chief`, `marketing-lead`, `factory-lead`. **`chief` is the new
Chief on `chief-broker`** — `teams.json` still names `chief-khaliq`, so the roster
and reality disagree until Khaliq rules. Handoff at
`principals/khaliq/HANDOFF-2026-08-10.md`.

**Placement lessons that cost an hour:** two Chiefs went to `barry` (11.3.1, eats
spawn briefs — no live node has `#1470`) and one to `sf-mini` (no `chief`
checkout, and **`attach` cannot reach another node at all** — `relay#1449`).
**Always pass `target_node`, and check the node can do the work.**

## Earlier — 2026-08-10 00:22Z — `factory#225` merged; three lanes were alive all along

**`factory#225` MERGED**, squash `40f9be5ec4`, head `91add5f1` confirmed as remote
HEAD, `CI: success`, blast radius source-only (`Publish` is
`workflow_dispatch`-only, so nothing published). Its last two threads were P1s
**already fixed and answered but never resolved by the filing bot** — Chief read
both fixes in the source at head before resolving them. Detail in
`journal/daily/2026-08-10.md`.

**Correction to the two entries below.** They called the merge-candidate lanes
*"dead, not slow"*. Reading the inbox found **three lanes alive and reporting**,
all unread:

| Lane | Reported | Substance |
|---|---|---|
| `workforce-307-lockfile-0809` | 2026-08-09 20:01Z | `^11.5.0` unsatisfiable, exit-1 receipt, both unblock paths |
| `factory-lead-0809` | 20:03Z | `#223`: 33 root comments over 4 rounds, ~27 obsolete, `43665a2` landed, one P1 rebutted |
| `relayfile-coordination-lead-0809` | 20:26Z | consolidated handoff, **four decisions waiting on Khaliq** |

`factory-lead-0809` is the one that most changes the register: it found the "5
unresolved" figure was really **33 unanswered root comments in four rounds, each
filed against a different commit**, and verified each verdict against current
source rather than trusting the bots' own *"✅ Addressed in `<commit>`"* trailers.
It is **declining a confidence-9 P1** with reasoning — adding the `leaseUntilMs`
check would refuse completion to an agent finishing just after lease expiry,
leaving the claim open and re-admitting the PR for work already done. That is
duplicate babysitting, the exact failure the machinery exists to prevent.

## Earlier — 2026-08-10 00:12Z — `workforce#307` is blocked on `relay#1464`, and Chief was not reading its inbox

**The dependency chain, established by two independent lanes:**

`relay#1464` (DIRTY, 2 unresolved) → merge → publish `@agent-relay/fleet` **11.5.0**
→ `workforce#307` regenerates its lockfile → green → merge.

`workforce#307` pins `^11.5.0`, which does not exist. Both lanes probed the
**installed** `fleet@11.4.3` tarball and found `FLEET_DYNAMIC_SPAWN_DELEGATION`
absent (`hasOwnProperty(...) === false`), while workforce feature-probes that
exact marker at `persona-spawn.ts:238` and otherwise **always throws**. So
`^11.4.3` would go green in minutes and **ship the capability inert**. Chief
declined that trade: staying red is honest, and accepting a knowingly-dead
feature guard is Khaliq's call.

`relay#1464`'s own body already said it: *"Publish this as Agent Relay 11.5+
before the dependent Workforce local-surface PR is released."* **The bump landed
downstream first.** Its gates: `mergeStateStatus: DIRTY` / `CONFLICTING`, plus a
cubic **P1** at `crates/broker/src/runtime/fleet.rs:615` and a CodeRabbit **Major**
at `crates/broker/src/runtime/worker_events.rs:759`. Dispatched
`relay-1464-fleet-11-5-0810` to rebase and clear both.

**Chief's own failure, recorded because it recurred: `workforce-307-lockfile-0809`
answered all of this at 2026-08-09T20:01:43Z and Chief never read it.** For four
hours the register said that lane was producing nothing, and one entry above
called it *"dead, not slow"* — on the strength of branch movement alone. **The
lane was alive, correct, and waiting on a decision only Chief could give.** It had
even run the exact command and pasted the exit-1 receipt. A second lane was then
spawned to rediscover the same finding.

**Rule: work product is not the only honest signal — an unread inbox is a Chief
defect, not an agent defect.** Read DMs on every sweep before concluding anything
about liveness. "No commits" and "no answer" are different claims.

## Earlier — 2026-08-10 00:05Z — `workforce#307` is not a stale lockfile

**Correction to the 2026-08-09 22:00Z entry below, which recorded "`workforce#307`
needs a lockfile regenerate". It does not, and that brief would have failed.**

CI run `31332457243` on head `22f80588` fails at `pnpm install --frozen-lockfile`:

```
ERR_PNPM_OUTDATED_LOCKFILE
  - @agent-relay/fleet (lockfile: ^11.4.2, manifest: ^11.5.0)
```

**`@agent-relay/fleet@11.5.0` does not exist.** `npm view` reports latest
`11.4.3`, and `relay` has no `v11.5.0` tag. The manifest in
`packages/local-surface/package.json` is **ahead of the registry** — a
release-ordering defect. `pnpm install --lockfile-only` would have exited on
`ERR_PNPM_NO_MATCHING_VERSION`, and the lane would have reported a mechanical fix
that could not be performed. This is the recorded lockfile rule firing exactly as
written: **check the registry before regenerating.**

**Dispatched `workforce-307-fleet-dep-0810`** (codex) with the corrected brief and
a forced choice: either prove every symbol `local-surface` imports ships in
`11.4.3` and pin `^11.4.3`, or name the missing symbol and declare #307 blocked on
a relay `11.5.0` release. **It is not allowed to fudge the range.**

**The three merge-candidate lanes are dead, not slow.** No agent named for
`factory#225`, `factory#223` or `workforce#307` appears in the online roster, and
last commits are 12–20 hours old (`f225` 2026-08-09T13:11Z, `f223` 20:57Z, `w307`
19:44Z). The online roster is almost entirely cloud personas heartbeating at a
single synchronised `lastSeen` — presence, not work.

## Earlier — 2026-08-09 20:35Z — the #1470 rollout is blocked on identity keys

**`relay#1470` is merged and published in `11.4.3`, and no broker runs it.**
Attempting the rollout took `barry` down for six minutes: **11.4.3 refuses to
reclaim an agent name without `RELAY_AGENT_IDENTITY_KEY`**, which no node has.
Rolled back to 11.3.1; broker healthy again. Detail in `memory/learnings.md`.

**All three minis have 11.4.3 staged on disk**, but `barry` runs 11.3.1 and the
other two still run their old brokers. **`chief-broker` must not be restarted** —
11.4.2, no identity key, hosts the resident Chief, no way back.

**Node cleanup did land:** `barry` went from **40 parked agents to 0**. Every one
had written a few hundred bytes and then idled for days — including
`herdr-lead-0809` at 51s CPU over 8h, which is the real reason that lead never
answered. `sf-mini` has 4 stale (all Aug 3); `finn-mini` has ~12 of 24 stale.

**Prerequisite before anyone retries: provision identity keys per node.**

## Earlier — 2026-08-09 10:00Z — the dispatch defect is fixed and proven

**`relay#1470` — "deliver spawn brief only after real prompt readiness"** —
open, **all 8 CI workflows green** including `Fleet E2E`. `BLOCKED` on review
with 2 threads. **This is the fix for the defect that silently dropped work
across the whole fleet for two days.**

**Root cause:** the PTY wrapper emitted `worker_ready` after 25 seconds even
when prompt detection had failed. The broker then **removed the sole queued
initial task** and wrote it into a still-booting TUI, where it was consumed
without action — while the agent registered and heartbeated normally.

**Evidence meets every criterion that was set:**
- **Negative control:** the unchanged new test against `origin/main` (`7a42f3bd`)
  **exits 1** — `waitFor timed out (worker-a acted on nonce-bearing brief);
  last=null`.
- **Live validation:** **5 consecutive spawns across 2 nodes, 5/5 acted, zero
  follow-up of any kind**, with `node-a` delaying readiness to 27s and
  discarding all pre-ready input — deliberately crossing the historical 25s
  boundary. Timestamped table in the PR body.
- `cargo test -p agent-relay-broker` exit 0 (860 passed), clippy `-D warnings`
  exit 0, typecheck exit 0.
- **The resident broker was not changed or restarted**, as instructed.

**It also confirmed the `injectionMode` finding is caller-side** — the schema
declares `mode`, the camelCase key is stripped — and deliberately kept that out
of this PR so the readiness fix stays isolated.

## Earlier — 2026-08-09 09:50Z — leads appointed, and two of them overturned the register

**Every active workstream now has an accountable lead** (see `OPERATING.md`
*Ownership*). Chief talks to leads, never to workers. Appointed today:
`factory-lead`, `herdr-lead`, `sage-nightcto-lead`, `lifecycle-workflows-lead`,
`daytona-lead`, `pr-shepherd-lead`; `cloud-2917-recovery-3` confirmed for 2917.

**Three leads reported within minutes, and two immediately contradicted the
register — which is the whole point of an owner.**

**`daytona-fleet-nodes` was wrong on its face.** `cloud#2963` — *"Instrument
Daytona fleet-node lifecycle"* — is **OPEN** on `codex/2656-daytona-phase1-harness`,
four commits carrying a **478-line fail-closed liveness observer**, a
restart-from-persisted-enrollment path, the detached-provisioning fix and an
evidence doc. **CI green on `3185d138f`, checked with `--branch`. 1 unresolved
thread.** The doc said "not started, no owner", and **H3 was answered three days
ago by work nobody was tracking.**

**`relay#1469` has a fix.** Root cause is a **delayed-readiness race** — the
prompt is written before the harness can take it. Focused E2E now **exit 0,
1 passed / 13 skipped**. The lane also caught its own false signal: an earlier
post-fix failure was test pacing, not the bug.

**And it found why `steer` never worked, which was partly Chief's error.** The
MCP schema declares **`mode: wait|steer`**, not `injectionMode`. The camelCase
key was undeclared, **Zod stripped it as unknown, and it defaulted to `wait`** —
so every "steer" Chief sent was a "wait". Filed separately rather than mixed
into the readiness fix.

**A placement error, Chief's own.** `sage-nightcto-lead` was put on `sf-mini`,
which has no `chief` checkout, and correctly reported itself blocked. That is
exactly *"a node is available" is not "a node can do this work."* Unblocked by
sending the content rather than moving the agent.

**`factory-lead` is the outlier**: 69 minutes, no output on `factory#225`
(7 unresolved) despite a direct assignment.

## Earlier — 2026-08-08 22:55Z — objective met; holding off on further spawns

**The night's stated objective is done.** Both SOC-2 critical-path PRs are merged
to `main`. Khaliq called that track ASAP and it is complete.

**Dispatch is unreliable in three separate ways and Chief is deliberately not
spawning further lanes tonight.** A new spawn burns a name, and a burned agent
name is a known expensive failure with its own workstream. The three failures:

1. **Spawn briefs are not reliably delivered** — agents boot, register, and park
   at 0% CPU (`relay#1469`).
2. **The DM-wake workaround is intermittent** — it started a lane at 21:44 and
   failed on the same lane at 22:15.
3. **DMs themselves can strand silently** — `relay#1467`, which `#1468` fixes.

**And the registry cannot referee any of it.** All four spawned lanes are absent
from `list_agents(status:"online")`, yet `soc2-ledger-review` rebased `#77` and
cleared nine threads inside that same window. **Absence from the roster is not
evidence of absence.** The only honest signals are **work product** (branch and
PR movement) and, for local processes, **CPU**.

**Producing nothing:** `factory-babysitter-review` (65+ min, `factory#223` and
`workforce#307` both untouched), `workforce-307-ci` (25 min), `relay-dm-loss-pr`
(`relay#1468` static at 3 for ~50 min). **`cloud-2917-recovery-3` is the
exception** — spawned 20:13, still working, still checkpointing.

**Everything still open needs either Khaliq or a working morning fleet:**
`relay#1468` needs his approving review; `factory#225` (7) and `#223` (5) need
thread work; `workforce#307` needs a lockfile regenerate; `relayauth#68`/`#69`
are two weeks stale with CI predating tonight's merges.

## Earlier — 2026-08-08 22:40Z — the SOC-2 attestation chain is on main

**`relayauth#77` MERGED** — squash `0f3edceae`, `main` CI green. With `#75`, both
halves of the critical path have landed in 25 minutes. See
[[soc2-agent-traceability]] for the invariant checks done before merging.

**The DIRTY conflict resolved exactly as instructed**: the lane rebased onto the
new `main`, cleared 9 threads to 0, and **kept `#75`'s merged contract** — verified
by reading the diff rather than trusting the green lights, since a resolved
conflict is invisible in review.

**Two SOC-2 lanes are now free.** `soc2-hole1-review` is parked idle at 0% CPU
and did not pick up the adversarial-review task; `soc2-ledger-review` has just
finished. Their remaining work is review of what already merged, not new code.

## Earlier — 2026-08-08 22:25Z — the #75 merge made #77 DIRTY

**`relayauth#77` flipped CLEAN → DIRTY within minutes of `#75` landing**, and
unresolved went 4 → 9. The two PRs share identity code, so merging one moved the
base under the other while its lane was actively working. **Chief caused it and
told the lane at once**, with instructions to rebase before answering another
thread, and — critically — **that `#75`'s merged contract wins any sponsor-check
conflict**, since a resolved conflict is invisible in review and is exactly how a
merged security invariant gets quietly reverted.

**The DM-wake workaround is unreliable.** It started `soc2-hole1-review` at
21:44; a second DM at 22:15 did **not** — the process sat back down at 0.0% CPU
after finishing `#75` and never picked up the follow-up task. So the workaround
is "sometimes", not "reliably", and `relay#1469` should not be read as having a
usable mitigation.

## Earlier — 2026-08-08 22:20Z — Hole 1 is merged

**`relayauth#75` MERGED** — squash `082e55de0`, `main` CI green. First
customer-visible SOC-2 deliverable to land. Detail in
[[soc2-agent-traceability]]. **Releases the gap-3 hold in
[[agent-lifecycle-workflows]]**, which was blocked on Hole 1 by design.

**`relayauth#77` went 12 → 4** and pushed `0f497c1f` — the ledger lane woke and is
delivering. Both SOC-2 lanes are now productive; both had to be started by a DM
because their spawn brief never arrived.

**Merge discipline note:** `gh run list --commit <sha>` returned **empty** for a
commit with two green workflows — the second time tonight, and quota was healthy
at the time, so this is not the rate-limit trap. **`--branch` is the reliable
query.** An empty CI list came within one step of reading as "no checks", which
under the merge rules would have blocked a legitimate merge and under a sloppier
reading would have waved through an unchecked one.

## Earlier — 2026-08-08 22:05Z — DUPLICATE MOUNT DAEMONS, needs Khaliq in the morning

**The event feed has NOT moved. Chief reported that it had, and was wrong.**
`lastEventAt` flickers between a fresh stamp and the frozen `2026-08-03T07:26:26Z`
on consecutive reads — five samples over forty seconds gave `21:46:55`,
`21:58:05`, `2026-08-03`, `21:49:03`, `2026-08-03`.

**Cause: two Relayfile daemons write the same `state.json`.** One under
`com.agentworkforce.chief.senses` (pid 1917 → 2429), one under
`com.agentworkforce.chief.integrations-mount` (25996 → 26002) — **the launchd job
Chief added tonight** to revive the dead mount. Two file shapes alternate: one
carries the github provider entry with the frozen value, one omits it with a
fresh stamp. `bootstrap.phase` still reads `bootstrapping` after 32 hours, and
`google-mail` reports `status: error`.

**Deliberately NOT unwound tonight.** Both daemons are up and the mount *is*
reconciling every ~10s. Killing the wrong one with nobody awake re-breaks the
projection Factory depends on. **Khaliq decides in the morning which supervisor
owns the mount, then the other is unloaded.**

**Until then `lastEventAt` is not a usable signal.** The honest test for
"Factory dispatch is back" is whether triage finds matches — which is exactly
what `factory#225` exists to make possible when the projection is stale.

## Earlier — 2026-08-08 22:00Z — the 2917 inventory landed, and it falsified its own headline

**`cloud#2964` merged with `[skip ci]` and no Deploy fired.** The first
successful protected inventory then ran on `main` (`31280246824`), read-only, no
mutation. Detail in [[cloud-2917-webhook-recovery]].

**The zero-consumer finding is dead.** Main consumer topology is **GREEN**, one
worker, confirmed by two independent API views agreeing. **The drain path was
never broken.** Chief had been carrying "a paused queue with no consumer cannot
drain" as the top blocker; the cross-check the lane added on request is what
killed it.

**Two real blockers replace it:** Nango live state is `109/28/91/18` against a
`109/30/108/1` reference — **17 more schedules already active, two connections
missing** — and the **queue-health cron reads RED**, so a drain would run
partially blind.

**Both DM-woken lanes confirmed the cause in their own words.**
`soc2-hole1-review`: *"I had NOT started; this steer-mode message is the first
brief that reached me."* `soc2-ledger-review`: *"Had not started — this message
is what kicked me off"*, now on a clean scratch clone. **The unbriefed-agent
finding is no longer inference; it is testimony.**

**`relay#1468` is working: 7 → 3 unresolved**, head `49f8ba3b`. It is
`BLOCKED / REVIEW_REQUIRED` — **it needs Khaliq's approving review**, not more
lane work. **`factory#225` went 2 → 7** as a heavier review round landed.

## Earlier — 2026-08-08 21:55Z — the agents were never dying

**A spawned agent boots, registers, and sits at 0% CPU with its brief never
delivered. A later DM starts it.** Measured on one named process:
`soc2-hole1-review`, pid `54737` — **0.0% CPU / 103MB at 12 minutes**, then
**18.8% / 238MB ~90s after a DM**. Its CWD was the Chief repo the whole time; it
had never cloned the repo its brief names, because it never got the brief. State
`Ss+` — a harness parked on input.

**This collapses three symptoms into one cause.** Agents are not dying; they are
idle and unbriefed, which looks identical from outside. Lanes that "died holding
pushed work" were replacements that never started, so the branch stopped moving.
And re-dispatching never helped because each new spawn inherits the same silence.

**`injectionMode: "steer"` is silently downgraded to `"wait"`** — accepted by the
schema, not honoured by the build, no error. The one documented way to reach a
parked agent cannot be selected. Filed on `relay#1469`, alongside `#1467`/`#1468`
where `wait` is the mode that strands.

**Workaround now in force: after every spawn, send the brief again as a DM.**
Applied to `soc2-ledger-review` and `factory-babysitter-review`. It doubles every
dispatch and leans on a DM path that `#1467` shows can itself strand — but it is
what moves an agent from 0% to working.

**`factory#225` went 0 → 2 unresolved** — a review round landed on the PR Chief
opened for the blocked lane.

## Earlier — 2026-08-08 21:50Z — two lanes producing, SOC-2 not yet

**`relay#1468` opened** — *"fix(cli): expose direct-message enqueue state"*,
fixing `relay#1467`. It separates **durable enqueue from delivery confirmation**
in MCP and CLI receipts, turns an empty `get_message_readers` into an explicit
`queued_or_unread` signal, and documents `wait` (on-idle) vs `steer` (immediate,
possibly interrupting) at every public choice point. **BLOCKED, 7 unresolved.**

That lane also **correctly declined to fold in `relay#1466`**, with a reason
worth keeping: Relay's local broker/CLI/SDK has **no mention tokenizer at all** —
mention resolution happens upstream in the Relaycast service. So the hyphen-
truncation defect cannot be fixed here, and `#1466` needs a Relaycast-side owner.
It also caught and fixed its own P2: the first revision echoed the requested
recipient as though independently resolved.

**`factory#225` head moved to `e350588e`, CI in flight.** Lane still active.

**The SOC-2 lanes have not pushed.** `feat/attestation-grant-ledger` and
`feat/oidc-sponsor-binding` are unchanged at `7b7ebed0` / `528b8d9f`, ~18 minutes
after re-spawn. Inside the one-hour re-dispatch threshold; watch it.

## Earlier — 2026-08-08 21:40Z — the deaths were never deaths

**Four lanes dispatched at 21:25Z produced nothing, and the control plane cannot
say whether they ever ran.** Filed as `relay#1469`.

**Chief's first diagnosis was wrong and was corrected on the issue within the
hour.** It claimed the codex spawn path never starts a process, citing
`lastSeen == createdAt` and the local process table. Both were falsified:
three *healthy* agents showed `lastSeen == createdAt` while booting, and
`cloud-2917-recovery-3` — alive and posting checkpoints — has no local process at
its creation time either. **`status` is unreliable in the same direction:**
`soc2-hole1-review` has a confirmed live process (pid `54737`) and does not
appear in `list_agents(status: "online")`.

**What survives is worse than the original claim.** `spawned: true` describes a
record write; `status` yields false negatives on live agents; `lastSeen`
conflates "never started" with "started and hasn't spoken"; the process table
does not map to broker agents. **An operator cannot distinguish booting from dead
from never-started**, so the only recovery is to re-dispatch blindly — which is
how a name gets burned and how work gets done twice.

**All lanes re-spawned with `cli: "claude"` and confirmed live:**

| Lane | Node | Owns |
|---|---|---|
| `soc2-hole1-review` | `chief-broker` | `relayauth#75` — Hole 1, 9 unresolved |
| `soc2-ledger-review` | `sf-mini` | `relayauth#77` — RA-1 + RA-2, 12 unresolved |
| `relay-dm-loss-pr` | `barry` | `relay#1467` — branch pushed, no PR |
| `factory-babysitter-review` | `finn-mini` | `factory#223` (0→5) **and** `workforce#307` CI |

**`factory#225` opened — and it is the Factory dispatch unblock.** The
`factory-dispatch-api-fallback` lane had finished the work and been unable to
publish it: **sanctioned Relayfile app-authored write returns HTTP 403**, and it
correctly refused to shell out to `gh` instead. It adds a read-only direct GitHub
REST fallback used *only* after a demonstrably-unhealthy projection misses — a
healthy miss still fails, and dispatch re-reads through the provider before the
unchanged safety gates. Red-checked both directions (forcing projection
preference off → test exits 1; making the unsafe fixture safe → rejection test
exits 1). **That 403 is its own gap: a lane that cannot publish its own work is
blocked no matter how finished the work is.**

**Nothing merged. Nothing qualified** — every open PR carried unresolved threads,
was DIRTY, or was excluded by standing rule.

## Earlier — 2026-08-08 21:30Z — four lanes respawned after a silent death round

**Every SOC-2 lane, the `relay#1467` lane and the `factory#223` lane were dead.**
They had each pushed real work first, so the branches survived and the register
did not know it. Respawned across all four brokers:

| Lane | Node | Owns | State when inherited |
|---|---|---|---|
| `soc2-ra12-review` | `sf-mini` | `relayauth#77` — RA-1 grant/finalize + RA-2 ledger | branch pushed, **12 unresolved** |
| `soc2-ra4-review` | `finn-mini` | `relayauth#75` — Hole 1, OIDC sponsor binding | CLEAN, **4→7→9 unresolved** |
| `relay-1467-dm-pr` | `barry` | `relay#1467` — silent DM loss | **branch pushed, no PR opened** |
| `factory-223-review` | `chief-broker` | `factory#223` — babysitter routed-PR intake | CLEAN, **0→5 unresolved** |

`review-sweep-b` picked up `workforce#307` from the dead `review-sweep-a`:
run `31277837096`, job `check`, failed step `Install deps` — the run Khaliq sent
and said *"fix that"*.

**The pattern worth naming: a dead lane leaves its work product behind but takes
its ownership with it.** `relay#1467` had a complete pushed branch and no PR for
hours. Nothing was lost — but nothing advanced either, and no status field said
so. **Sweep for orphaned branches and unanswered review threads, not for dead
agents.** The registry marks Chief itself offline while Chief is running, so
agent status cannot be the signal.

**Nothing was merged this round. Nothing qualified** — every open PR carried
unresolved threads, was DIRTY, or was excluded by standing rule.

## Earlier — 2026-08-08 20:10Z

**Chief now self-polls every 17 minutes** (cron `fe98d144`, session-only, expires
in 7 days). Khaliq's correction: Chief was reactive between his messages rather
than driving a loop. The steward exists for this and keeps dying; the cron runs
in Chief's own process and survives what kills lanes.

**MERGED today:** `factory#220` (`33cda427`) — the mount fix and the
`localMountDegraded` / `eventListener` diagnostics. `relayfile#405` (`efa0cd7e`)
— the latency evidence retiring the falsified sub-200ms claim. `cloud#2957`
(`c24c4c08`).

**The event feed question is ANSWERED and it was never a fault.** Confirmed by
filtered Cloudflare API readback: **`settings.delivery_paused=true` on BOTH
`webhook-events` and `webhook-events-dlq`.** Wrangler tail on the production
consumer shows `hop=ingest ok` → `hop=enqueue ok` with **zero `consume` or
`cloud_web_forward_*` logs**. **The HTTP 202 was always honest — the event was
accepted into a paused queue.** Two lanes hunted a forward fault that does not
exist. **`cloud#2917`'s drain IS the event-feed fix.**

**Production is blind:** `proactive-runtime-worker` v129 was created
2026-08-07T15:00:34Z; `factory#220` merged 08-08T08:54:31Z. The deployed worker
**predates the diagnostic by ~18h**, which is why `mount_stale` fired **7,245
times** with nothing surfacing it.

**Taking the drafts to ready ran the reviews that drafts had suppressed** — about
**108 unresolved threads across eleven PRs**, every author dead. Right call, but
it converted *silently unreviewed* into *reviewed and unattended*. Two sweep
lanes now own them.

**Load is uneven and nothing enforces it:** `maxAgents: 0` everywhere means
unlimited. barry **35**, chief-broker **21**, sf-mini **20**, finn-mini **11**.

## Then — 2026-08-08 09:00Z

**Everything dispatched last night is dead.** Four further synchronised clusters
overnight: `07:18:27Z` (7 lanes), `07:36:07Z` (2), `07:42:52Z` (2), `07:43:37Z`
(8). **`workstream-steward` died at 07:36:07Z** — the monitor whose only job was
noticing that lanes stop.

Before it died it caught the largest event of all and escalated correctly:
**121 agents in the same second at `2026-08-07T22:20:56Z`, all on `sf-mini`**,
43 of them lane-owned — including `fleet-mass-death-investigation`, the
investigator dying inside the cluster it was sent to diagnose, for the second
time. It also corrected Chief's counts: the real clusters were **115 at
20:28:52**, 55 at 21:12:35, 28 at 21:03:31, 28 at 21:27:20. Chief had been
counting only its own lanes.

**Six lanes wrote handoffs before dying, and those are the only reason the work
survived.** That is now the standing instruction in every brief: persist
incrementally, because a report you never send is worth nothing.

**Delivered overnight, all draft and unmerged:** `herdr-relay-bridge#3` +
`cloud#2957` (T5 cloud sandbox panes), `relay#1464` + `workforce#307` +
`relayflows#28` (SDK persona spawning, workforce#306), `cloud#2956` +
`relayfile#410` (event feed), `relayfile#411` (one-mirror).

**`factory#220` MERGED** 2026-08-08T08:54:31Z as `33cda427` — the mount fix and,
more importantly, the `localMountDegraded` / `eventListener` diagnostics whose
absence hid a three-day-stale mount and a five-day-dead event feed behind clean
JSON.

**The event feed is still dead.** Reconcile backfilled hard — the mirror went
6,630 → **16,811 files** and `github/repos/` from 0 → **25 repositories** — but
`lastEventAt` is unchanged at `2026-08-03T07:26Z`, and `factory triage` still
returns `found 0 matches` because repo shells arrived without issues. The
event-feed lane's finding before it died: the deployed Cloudflare
`WebhookEventsConsumer` accepts an HTTP 202 that never reaches Cloud, and the
`/github/repos/**` subscription list is `[]`. **It also killed Chief's
hypothesis: `relayfile#399` only prunes stale temp files and is NOT the fix.**

## Then — 2026-08-07 21:35Z

**Seventeen of eighteen lanes are offline.** Nine dropped on `barry` at exactly
`21:27:20Z`, the same second; further clusters at `21:12:35`, `21:03:31` and
`20:28:52`. `barry` simultaneously reports `activeAgents: 29`, online, live,
heartbeat seconds old. That is `relay#1461` — instances 3 and 5, the same
missing liveness primitive failing in both directions at once.

This is the second mass loss today. The first took seven agents on `finn-mini`
at `16:33:15Z`; Chief moved the survivors to `barry` and `sf-mini`, and both have
since done the same thing. **The pattern follows the fleet, not the node**, so
re-dispatching without a diagnosis burns the replacements too.

Only `askable-agent-lead` is alive.

## Lane register

Format: lane · owns · state.

### Dispatched, now offline, work unfinished

- `event-feed-recovery-lead` (barry) · the four-day-dead provider event feed;
  `.integrations/github/repos` empty, 26 orphaned `..relayfile-mount-state.json.tmp-*`
  files, `relayfile#399` a stale draft that may be the fix · **highest priority,
  died before reporting.**
- `relayfile-one-mirror-lead` (barry) · `relayfile#409`, the single-mirror
  constraint · died before reporting a design.
- `factory-babysitter-identity` (barry) · `factory#221`, babysitter writes as the
  local `gh` user while Factory's PRs are app-authored · died before reporting.
- `factory-babysitter-coverage` (sf-mini) · `factory#222` · **delivered
  `factory#223`** (draft) before dying.
- `nango-revternal-lead` (barry) · Revternal Nango integration, unblocks
  agents#110 · **no PR, no aliveness note.**
- `factory-217-lead-barry` · `factory#217`, 3 unresolved threads.
- `factory-mount-fix-lead` · `factory#220`, 1 unresolved thread. Delivered the
  1/16 → 16/16 mount fix.
- `relayfile-405-lead-sf` · `relayfile#405` review (cleared to 0) + the unrun
  hosted latency benchmark.
- `relaycast-308-lead-sf`, `skills-94-finish-sf`, `chief-26-lead-barry`,
  `relaycast-306-release-barry`, `rc-deploy-watch`, `relay-pty-drive-lead`,
  `pr-shepherd-lead`, `fleet-finn-mini-recovery` · all delivered their work;
  see Shipped below.

### Alive

- `askable-agent-lead` (sf-mini) · `agents#110`, the askable GTM agent.
  Outstanding: why it is still a draft, whether `agents` runs PR CI, whether an
  utterance can create a relaycron schedule today, and what enforces the
  free-versus-premium boundary.

### Dispatched 2026-08-07 late — second cohort, all carrying a survival preamble

- `fleet-mass-death-investigation` (sf-mini) · why agents die in synchronised
  batches. Given the `daytona-fleet-nodes` lead: *"a sandbox comes online, then
  dies after ~39 seconds — registration plus one heartbeat"*, recorded 08-06 in a
  lane nobody owned. Same shape, possibly the same bug.
- `event-feed-recovery-2` (sf-mini) · the four-day-dead provider feed. **Top
  priority** — Factory resolves issues through the projection and
  `github/repos/` is empty, so nothing can dispatch at all.
- `factory-threads-2` (sf-mini) · factory#217 and #220 review threads.
- `babysitter-identity-2` (barry) · factory#221. **Died 15 minutes after spawn.**
- `relayfile-one-mirror-2` (finn-mini) · relayfile#409.
- `workforce-306-persona-spawn` (chief-broker) · workforce#306, via the SDK.
- `pr-shepherd-lead-2` (barry) · finish the event-driven rebuild **and deploy it**.
- `herdr-lead-2` (sf-mini) · T5 cloud sandbox panes, the unrun hosted benchmark,
  T1 held for Khaliq.
- `soc2-relayauth-lead` (barry), `soc2-factory-lead` (sf-mini),
  `soc2-chief-lead` (finn-mini) · the Nabis SOC-2 epic, `sales#27`.
- `workstream-steward` (chief-broker, opencode) · **loops every 10–15 min**,
  reads the workstreams and this register, checks liveness and work product,
  reports by exception, and persists state so a successor can resume. Exists
  because lanes were being lost.

### Dispatched 2026-08-08 evening — fourth cohort

- `review-sweep-a` (finn-mini) · `workforce#307` (32 threads), `relayflows#28`
  (20), `relay#1464` (11, BLOCKED on human approval).
- `review-sweep-b` (sf-mini) · `factory#223` (17, DIRTY), `relayfile#410` (6),
  `cloud#2956` (2), `relayfile#411` (9, DIRTY).
- `cloud-2917-recovery-2` (barry) · **took over after its predecessor went
  silent for ten hours** — the third lane on that issue to stop reporting. Its
  first job is verifying no partial production mutation was left behind.
- `soc2-ra1-ra2-v2` (finn-mini) · re-dispatched after the first lane produced
  **nothing in three hours** while a sibling sat blocked on its schema.

### Dispatched 2026-08-08 morning — third cohort

- `factory-217-rebase` (barry) · `factory#217` conflicts after #220 merged; the
  two overlap on `fleet.ts`, `fleet.test.ts`, `schema.ts`, `schema.test.ts`.
  **Semantic merge — both behaviours must survive**, and it re-runs #220's
  red-checks as well as its own.
- `soc2-architect` (chief-broker, **fable**) · one implementable proposal for the
  whole SOC-2 program, delivered as incremental comments on `sales#27`. Must
  resolve the credential-exchange blocker nobody has designed.
- `cloud-2917-recovery-lead` (barry) · [[cloud-2917-webhook-recovery]] — webhook
  queue and Nango schedule recovery, **production-authorised within written
  bounds**.

### Filed, unowned — nobody is working these

- **`workforce#306`** · accept a persona in relay `spawn` and relayflow steps via
  the SDK, not a CLI shell-out. Labelled `factory` + `agent:team` + `workforce`
  and **it will never dispatch**, because Factory resolves issues through the
  Relayfile projection and that projection is empty. **This is the clearest case
  of the event-feed outage silently swallowing work.**
- `relayfile#408` · share git objects with the local mount instead of copying
  `.git` one-way, so in-mount commits reach the host. AgentBox pattern.
- `factory#218`, `factory#219` · superseded in practice by `factory#220`, which
  is open with 1 unresolved thread.
- `relaycast#316` · engine's `0033` pre-flight comment is the pre-correction
  version; the byte-identical guard overwrites the better downstream text on
  every sync.

## Next

1. **Diagnose `21:27:20Z`** before re-dispatching, or accept that replacements
   die too. The work-product test is the discriminator, not agent status.
2. **Re-dispatch `event-feed-recovery-lead` regardless** — the feed has been dead
   four days and every hour of delay costs more than a burnt lane.
3. **Own `workforce#306` directly.** It cannot arrive through Factory while the
   projection is empty, so waiting for dispatch means waiting forever.
4. Clear the remaining review threads: `factory#217` (3), `factory#220` (1).
5. `relay#1450` — the keepalive gap, the actual prevention behind the merged
   `relay#1453` — is still **open and unassigned**.

## History

- 2026-08-07 — File created after Khaliq asked whether lanes and assignments
  were being held in memory. They were not. Second mass agent loss of the day
  recorded above; the first, on `finn-mini`, is in the daily journal.

## Local agent cleanup checkpoint — 2026-08-11 15:48 CEST

The Mac was under a Relayfile I/O storm while 22 local agents remained
registered. Cleanup used a conservative release gate: at least 40 minutes
without activity, zero pending messages, and native bridge state `waiting`
(or the resident PTY explicitly `idle`). Fourteen seats met every condition;
their deliverables were harvested before release.

| Released seat | Durable status / progress |
|---|---|
| `marketing-lead` | Resident was idle for 906 minutes with no pending work. No new deliverable to harvest; the declared roster seat is intentionally absent until re-enabled. |
| `trajectory-lead-0811v3` | Pointer contract complete; production Relaycast query confirms the 30-day default, making ai-hist UUID the durable primary target. See `intent-trajectory-lineage.md`. |
| `relayscribe-lead-0811` | `cloud#2985` and `relayscribe#10` verified merged. Phase 0 rotation, deploy/build, and 22-hour acceptance remain. See `relayscribe-recorder-auth.md`. |
| `relay-attest-session-lead-0811` | `relay#1477` verified merged; Factory still needs to forward `sessionRef`. See `soc2-agent-traceability.md`. |
| `factory-230-lead-0811` | Design complete. Red-check found two implementation gaps: retirement during `markRunning` needs a post-await `#babysitterPr.has(key)` guard and cleanup; recovery must not release a confirmed live session when a stale pending-spawn record exists. Both P1s remain open until code ships. |
| `finn-mini-upgrade-lead-0811` | finn-mini's broker upgrade to 11.5.1 is already recorded; the session had received an explicit terminal `Out` and had no pending messages. |
| `delivery-lead-0811` | Sub-lead stood down. Its surviving active child (`daytona-lead-0811v3`) is temporarily direct to Chief; completed and released children are recorded in their own workstreams. |
| `cloud-identity-lead-0811v3` | Design note and reader/writer inventory complete; waiting on Khaliq's migration-readiness/backfill ruling. See `cloud-identity-d1.md`. |
| `orgchart-dashboard-lead-0811` | Dashboard recovery verified complete; fast-follow remains unowned. See `yc-demo-org-chart.md`. |
| `fleet-mount-lead-0811` | barry/finn-mini mounts and 45-minute credential refresh completed; remote reboot auto-start remains the only low-urgency gap. See `fleet-relayfile-mounts.md`. |
| `cross-node-attach-lead-0811` | `relay#1480` verified merged; replacement implementation `relay#1483` is open and live-proven against Chief on Barry. Cloud/Daytona transport remains design-only. See `cross-node-attach.md`. |
| `c2a-lead-0811b` | `c2a#4` remains DO-NOT-MERGE with five recorded spec gaps and no fixes pending Khaliq's ruling. See `agent-lifecycle-workflows.md`. |
| `soc2-lead-0811b` | `relayauth#79` verified merged; no pending local task. Program coordination remains with the active `soc2-program-lead-0811`. |
| `relayfile-helm-lead-0811` | Real kind install created/uninstalled cluster objects; helm-charts#3 is open and green, awaiting Khaliq merge and published-repo/real-image acceptance. See `helm-charts.md`. |

Kept running because they had recent activity or pending deliveries:
`agent-coordination-lead-0811`, `daytona-lead-0811v3`,
`pr-shepherd-lead-0811v3`, `relaycast-kv-lead-0811`,
`relayfile-subs-lead-0811`, `soc2-program-lead-0811`, and
`webhook-queue-lead-0811`. Chief itself was recycled into a fresh PTY seat.
