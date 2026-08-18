# Skip — Deterministic Orchestrator Harness (v1 spec)

**Status:** draft for build · **Authors:** Khaliq + Will · **Date:** 2026-08-13
**Repo:** this repo (`chief`), being renamed **Skip**.
**Origin:** Marko Ladika intel call (2026-08-13) + Khaliq/Will decision ("Skip is a harness").

> Internal engineering doc. Engine language is fine here — never customer-facing as-is.

---

## 1. What this is — and what changes
Skip is the rename + **hardening of Chief's front door into a deterministic harness.**

Chief today already implements the right *flow* (`README.md`):
```
Human intent on a surface → Chief → Cloud Factory → agent work in GitHub
                                 ↓ checkpoints back to the source surface
```
…and already owns the right pieces: the Factory dispatch contract (`scripts/lib/factory-contract.mjs`), a delegation ledger (`scripts/lib/delegation-ledger.mjs`), senses/intake (`scripts/chief-senses.mjs`), a supervisor guard (`scripts/lib/supervisor-guard.mjs`), a durable Markdown brain (`principals/<slug>`), a roster (`teams.json`), and an org chart view (`tools/orgchart`). No agent merges without explicit human approval — already true.

**What "Skip is a harness" changes:** today the front door is an **LLM persona** — `chief-khaliq` + the `CLAUDE.md` operating manual ("You are Chief… coordinate the right specialized agents"). That is precisely the *native-Claude-orchestration-that-leaks* problem: told to "coordinate," it reasons, drifts, and can start doing the work. **Skip replaces the LLM front door with a deterministic state machine + pure-code dispatcher.** The LLM keeps a job, but a narrow one (see the pocket, §3).

## 2. Thesis this encodes
- **Native orchestration leaks.** An LLM told to lead drifts into doing the work and needs constant task-checking. A deterministic harness with **no code-editing tools** structurally cannot. (Marko's peer confirmation: his LLM lead became a bottleneck; fix was a pure-code dispatcher.)
- **We ride the frontier (Will's point).** The **coding agents stay in Factory** and stay pluggable (Claude Code / Codex / opencode). Skip **must not reimplement the inner loop** — `factory-contract.mjs` already enforces the right instinct: *"Chief does not define what makes work dispatchable. Factory does… Read the owning component's config; do not restate it."* Keep that discipline. It's the load-bearing constraint.
- **Moat = the behavior, not the harness label.** Deterministic delegation that doesn't leak + multiplayer resume + durable context. Harnesses commoditize; this doesn't.

## 3. Design principles
1. **Deterministic spine, one dynamic pocket.** Open-ended LLM reasoning only at the **planning/intake gate** (turn a raw human intent/issue into a well-formed, dispatchable WorkItem). Everything after is pure code.
2. **The front door has no code tools.** Structural boundary, not a prompt. Skip routes, gates, records, escalates — never edits.
3. **Coding agents stay in Factory, pluggable.** Swapping harness is a Factory concern; Skip's dispatch contract is harness-agnostic by construction.
4. **State is externalized, durable, and observed at the source.** WorkItem + delegation state survive a killed session; any human/agent resumes from it (this is the multiplayer/resume moat — chief already values "a new session can resume without chat history"). A deterministic state machine is deterministic only if its inputs are trustworthy: read dispatched-agent progress from the agent's terminal, never infer it from control-plane metadata.
5. **Determinism is a dial.** High-ambiguity intent opens the planning pocket; a defined ticket clamps straight to dispatch. Agents contact each other only to *approve*, never free-form negotiate (Marko's 10-hour-waste lesson).

## 4. Component map (spec → real modules in this repo)
| Spec role | Today in `chief` | Skip delta |
|---|---|---|
| **Intake / triggers** | `scripts/chief-senses.mjs` (Relayfile senses on surfaces) | normalize intent → `WorkItem`; this feeds the pocket |
| **Planning gate (the LLM pocket)** | today the whole `chief-khaliq` persona reasons | **shrink** the LLM to *only* draft→specified: produce spec + acceptance criteria + domain + cross-domain flags, then stop |
| **Dispatcher** | `factory-control.mjs` (`dispatch-workspace-task`, `promote-issue`, `create-task`) + `factory-contract.mjs` | make dispatch **pure code** off WorkItem state; no LLM "decides" to dispatch |
| **Coding-agent runtime** | **Cloud Factory** (external, pluggable) | unchanged — do NOT reimplement; keep contract-only coupling |
| **Delegation / state ledger** | `delegation-ledger.mjs` (+ identity, rollup) | promote to the WorkItem state store; see the relay gap in §7 |
| **Progress / liveness read** | inferred from status fields and artifact timestamps | before judging a lane, attach read-only to its terminal (`agent-relay node agent attach <name> --node <node-name> --mode view`); **render** the terminal to a screen before deriving machine-readable evidence — see below |
| **Concurrency / single-writer guard** | `supervisor-guard.mjs` | enforce one active transition per WorkItem (deterministic, no races) — *verify current behavior* |
| **Durable context** | Markdown brain `principals/<slug>` | per-domain agent memory lives here (disposable workers inherit it) |
| **Roster / domains** | `teams.json` (per-machine copy of `teams.<principal>.json`) | source of the domain-scoped agent set the dispatcher routes to |
| **Board / observability** | `tools/orgchart` | read-only WorkItem board + resume view |
| **Human gate (merge/approval)** | Relaycast checkpoints; "no agent merges without approval" | unchanged — keep as the merge gate |

## 5. WorkItem state machine (align to the Factory contract)
`Draft → Specified → Dispatched → Building → InReview → ChangesRequested⟲ → Approved → Merged → Verified` · `Blocked` raises a human flag from any node.

Only **Draft → Specified** uses the LLM (the pocket). States map onto the existing Factory contract surface: `issueSource` (github label / `linear.states`) represents Dispatched→Building→InReview; the human approval already gates Merged. Don't invent a parallel state world — the `factory-contract.mjs` docstring already warns against exactly that reimplementation.

**Building → InReview requires an attach-read of the agent terminal** showing a review-ready artifact or outcome. The same attach-read is required before releasing or replacing a lane, or recording it as stalled or complete; attach is optional otherwise, not a polling loop and never a way to drive the agent. No transition or lane judgment may fire from an unverified signal. `IDLE` does not mean failed: a completed harness returns to its prompt and waits forever, so idle can be success and only the terminal contents distinguish "finished, waiting" from "hung, useless."

Do **not** treat `lastSeen`/heartbeat, agent `idle` state, process uptime, registration/agent listings, node `handlersLive`, node `online` status, spawn `pending`/timeout output, DM send receipts, or artifact `updatedAt` as progress evidence. Each has been observed to disagree with actual work or delivery state (2026-08-17/18); they may trigger an attach-read, never substitute for one.

### 5.1 How the attach-read is performed

**Use the fleet-native path.** `--node <node-name>` is the canonical authenticated
fleet-node terminal attach and works for physical *and* Daytona/cloud nodes.
`--ssh-host` is a fallback that requires inbound SSH to the host, which cloud
nodes and Factory sandboxes do not have — a spec that prescribes it excludes
exactly the agents most likely to need observing. Verified 2026-08-18: `--node`
performs both view and drive against a physical node with no SSH in the path.

**Render the terminal; do not strip escapes from the byte stream.** Coding
harnesses draw full-screen TUIs, so the transcript is a sequence of
cursor-addressed writes, not the screen. Deleting ANSI sequences with a regex
leaves overwritten text, repainted frames and status lines interleaved in
emission order, which reads as plausible but reconstructs a screen the operator
never saw — and a machine judgment taken from it is unsound. Feed the bytes
through a terminal emulator and read the resulting screen buffer. Regex
stripping is acceptable only for a human eyeballing a tail, never as the input
to a state transition.

### 5.2 When the attach-read cannot be performed

The attach-read is a gate, and a gate that cannot fail open takes hostages. An
attach can be genuinely impossible: the agent process has exited, its node is
offline, or the terminal transport itself has failed (`Node '<x>' is not
reachable`, or a `1011` close with `terminal transport could not reconnect` —
relay#1571). A rule requiring the read before *any* judgment would, in those
cases, forbid releasing or replacing a lane precisely when recovery is most
needed.

So: when an attach-read is attempted and **cannot** be completed, the transition
is still permitted, provided the record states **which** attach path was tried,
**what** it returned verbatim, and **which** secondary evidence the judgment
rests on instead. The unavailability is recorded as a first-class fact, not
silently downgraded to "no progress". A lane may never be judged **complete** on
secondary evidence alone — only released, replaced, or flagged blocked, since
those are recoverable and a false "complete" is not.

## 6. Non-goals
- Skip does **not** edit code, run shells, or own the agent turn-loop.
- Skip does **not** reimplement Factory's dispatchability rules or the coding harness.
- Skip does **not** let agents free-form negotiate.
- Skip does **not** restate config another component owns (roster/workspace/Factory contract) — a rule this repo already enforces.

## 7. Open decisions / real dependencies (for Khaliq + Will)
1. **The delegation-identity gap is a real blocker to clean state.** `delegation-ledger.mjs` documents that relay CLI 11.2.0 can't stamp worker identity at spawn (`spawn` has no metadata param; `register_agent` discards metadata; no `update_agent`). The ledger is the *interim* store. **Decision:** land the relay-repo change (carry `metadata` through `spawn`, or persist `register_agent` metadata) so WorkItem↔worker binding is first-class — or accept the ledger as the source of truth for v1.
2. **State store:** promote `delegation-ledger` to the queryable WorkItem store, or add a small DB? (Board + resume want queries; ledger is file-JSON today.)
3. **Scope of the pocket:** does the planning LLM also self-staff the team for high-ambiguity intent, or only spec defined work? v1 = spec only; human writes/approves.
4. **Retry/escalation:** max Building→InReview attempts before a human flag (propose N=3).
5. **Observation cadence/cost:** attach is interactive and expensive. v1 requires it at judgment boundaries, not continuously; decide whether those reads are operator-triggered, event-triggered, or run on a bounded cadence without becoming an agent-driving turn-loop. Two costs are now known and should inform the choice: the read needs a terminal emulator to render (§5.1), and the transport is not reliable enough to assume success (§5.2, relay#1571).
6. **Rename mechanics:** `chief`→`skip` touches package name, `com.agentworkforce.chief.*` launchd labels, `chief.sh`, `factory.<principal>.config.json`, docs. Sequence the rename so running deployments (`cloud:deploy:khaliq`) don't break mid-migration — chief already has a migration-window discipline (`config:migrate`); reuse it.

## 8. v1 scope — the delta from today's chief (build this)
1. **Shrink the front door:** confine `chief-khaliq`'s LLM to the Draft→Specified pocket; strip any path where it can act on/dispatch/edit work directly.
2. **Make dispatch pure code:** WorkItem state → `factory-control` dispatch, no LLM in the loop after Specified.
3. **Externalize WorkItem state** on top of `delegation-ledger` + `supervisor-guard` (single-writer transitions).
4. **Board + resume:** `orgchart` shows WorkItems; killing the session resumes from state.
5. Keep the existing human-approval merge gate and Factory/GitHub flow unchanged.

**Deferred to v2:** self-staffing, memory decay/graph, multi-principal, provider rate-switch, relay-metadata identity (unless it's the v1 blocker per §7.1).

## 9. v1 success criteria (these prove the theses)
- [ ] A human intent reaches a merged PR with **zero LLM decisions after Specified** and **zero agent-to-agent free-form messages**.
- [ ] The front door **provably has no code/dispatch-executing tools** — it can only produce a spec and hand off.
- [ ] A dispatched WorkItem **survives a killed Chief/Skip session** and resumes from externalized state.
- [ ] After an ANSI-stripped attach-read, a completed-but-`idle` lane is **recorded complete — not stalled, released, or replaced** — and any Building→InReview transition cites the observed terminal evidence.
- [ ] Swapping the Factory coding harness **requires no change in Skip** (contract-only coupling holds).
