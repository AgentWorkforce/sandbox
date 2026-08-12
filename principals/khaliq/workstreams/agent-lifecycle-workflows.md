---
status: active
owner: lifecycle-workflows-lead-0811
reports_to: chief
updated: 2026-08-11
repos: [relayflows, agents, workforce, factory, chief]
---
# Agent lifecycle & chore workflows — Nabis point 2

**Status: DISPATCHED 2026-08-10.** `lifecycle-workflows-lead-0810` is the first
lead this workstream has actually had; the 2026-08-09 name never sent a message.
Gap 2 is in flight via `lifecycle-gap2-dag-0810` (codex).

**Goal:** Hand Julian a **template pack** assembled from parts we already ship,
so he composes his own feature-lifecycle and chore workflows instead of building
an engine.

**Source of truth:**
`/Users/khaliqgant/Projects/AgentWorkforce/sales/nabis/julian-fann/agent-lifecycle-workflows-spec.md`
(87 lines, read it before planning anything). **The path this file used to cite —
a `~/.agentworkforce/workforce/sessions/customer-dev-…/mount/` session dir — does
not exist on this machine.** `lifecycle-workflows-lead-0810` found the live copy
on 2026-08-10. **The SOC-2 workstream still cites the same dead directory for its
own plan.** Confidentiality applies as it does to the SOC-2 epic — the customer
belongs in `sales`, not in `factory`, `relay`, `relayauth` or `relayflows`, which
are public.

**This is Julian's point 2.** Point 1 is [[soc2-agent-traceability]], the
identity, credentials and isolation substrate. **This workstream runs on top of
that one and must not re-solve it.** His words, 7 Aug 2026: *"Feature lifecycle
workflows including planning, execution, and review (quality, security,
CRE/preq). Chore workflows would also be great."*

**The constraint that shapes everything**, also his: *"I don't feel comfortable
running with pickup agents able to run anything without approval."* Every lane
runs under a scoped identity, a sandbox policy, and a **human approval gate**
before it can act.

## Why this is assembly, not invention

Four blocks already ship:

- **relayflows** (`@relayflows/core`) — the lifecycle DAG engine. Steps declare
  `dependsOn` and per-step `verification`; a lead coordinates specialists over
  Relay via `onRelay()` and `@agent-relay/sdk/communicate`.
- **workforce** — the proactive persona runtime. A persona plus an `agent.ts`
  with `defineAgent({ schedules, triggers, onEvent })`, and **the same artifact
  deploys local or cloud**.
- **agents** — the copy-from templates: `review`, `cloud-team-implementer`,
  `cloud-team-reviewer`, `repo-hygiene`, `hn-monitor`, `neon-monitor`,
  `proactive-agent-builder`.
- **factory** — the turnkey reference lifecycle if he does not want to
  hand-author a DAG.

Trigger surfaces are already contracted:
`AgentEvent.type ∈ { cron.tick | relayfile.changed | relaycast.message | <provider>.<verb> }`.
**Feature lifecycles are change-triggered; chore workflows are
schedule-triggered**, and one persona can carry both blocks — `neon-monitor`
already does.

## The shape

**Feature lifecycle** — a change-triggered DAG: `plan → execute → review → gate
→ merge/writeback`, where review fans out in parallel into **quality, security,
CRE and preq** lanes and back into one gate node. `cloud-team-implementer` is
execute; `cloud-team-reviewer` and `review` are review lanes, each in its own
sandbox.

**Chore workflow** — schedule-triggered: `sweep → per-chore execute → review →
gate → one PR per chore`. **The review half exists** (`repo-hygiene`, codex,
`sandboxMode: 'read-only'`); the execution half is the gap.

## Four honest gaps

| # | Gap | Owner |
|---|---|---|
| 1 | **Chore *execution*** — a scheduled workflow plus a fix-mode agent that opens PRs for bumps, renames and cleanup. We only *review* chores today. | relayflows + agents |
| 2 | **Reference feature-lifecycle template** as one runnable DAG wiring the review personas together. The pieces exist unassembled. | relayflows |
| 3 | **Approval-gate node** as a reusable relayflows primitive that blocks on point 1's scoped-identity human approval. | relayflows + chief |
| 4 | **CRE / preq review lanes** — define and implement once Julian specifies them. | agents |

**Gap 3 is where the two workstreams meet.** The gate is the *"cannot run without
approval"* guarantee, and it depends on the SSO-bound principal that
[[soc2-agent-traceability]] is building. **Do not start gap 3 before Hole 1
lands** — an approval gate that trusts a forgeable sponsor approves nothing.

## Four questions for Julian — question 1 is RESOLVED BY RULING

1. ~~**Define CRE and preq**~~ — **CLOSED 2026-08-10 by Khaliq: *"he just wants
   templates so let's take best guess for him."*** The terms appear **nowhere**
   in any artifact we hold except our own spec — verified by a search across four
   session mounts, the `sales` repo and every transcript, with the instrument
   checked against a control term. They trace to one sentence on **7 Aug**, and
   **no 7 Aug transcript exists on this machine**; Khaliq supplied the original
   message directly. **Chief's best guess, to be built as swappable defaults:**
   **CRE = Customer Reliability Engineering** (SLO and error-budget impact, blast
   radius, rollback plan, monitoring and alerting coverage, runbook); **preq =
   prerequisites** (migrations and their ordering, feature flags, dependency
   versions and deploy order, required config and secrets, docs, recorded
   sign-offs). Second candidate, unresolved: a compliance/regulatory review paired
   with a pre-qualification checklist. **Build the checklist as a config file so
   Julian's correction is one file, not a redesign** — a wrong-but-specific
   default gets corrected in one sentence; an empty placeholder gets ignored.
   **Also settled by the source: he asked for three review dimensions, not four**
   — *"review (quality, security, CRE/preq)"*.
2. Which repos and orgs the chore sweep runs against, and which maintenance
   classes he most wants automated first.
3. Approval model: per-PR human click, or a scoped auto-approve policy. Ties
   directly to point 1's SSO-bound principal.
4. Local-first or cloud-first for the pilot. A self-hosted regulated posture may
   push local.

## Next

1. **Gap 2 in flight** — the reference feature-lifecycle DAG, with CRE and preq
   as config-driven lanes carrying Chief's best-guess defaults and a visible
   note that the semantics are inferred and expected to be replaced. Judge it by
   exit codes and the artifact, never by a status line.
2. **Gap 3: design now, deliver after Chief's SSO principal threading.** The gate
   control-flow already exists — reviewer-preset agents resolved just-in-time,
   fails closed. **Do not build a gate engine; bind an approver to the gate that
   is already there.** Its dependency is only half-satisfied: Hole 1 gave us
   OIDC-bound *sponsors*, and this gate needs an authenticated *approver*.
3. **Prove or refute the approval-decision bypass — rated PLAUSIBLE, not
   executed.** The decision is a regex over the reviewer's stdout
   (`/REVIEW_DECISION:\s*(APPROVE|REJECT)/`, last match wins) with the
   specialist's own output embedded verbatim in the reviewer's prompt. Existing
   PTY-echo defenses filter one literal template string, which is a string-shape
   guard, not authentication. **This is now directly load-bearing**: Julian led
   with *"I don't feel comfortable running with pickup agents able to run
   anything without approval."* **A gate that blocks control-flow and a gate that
   authenticates its approver are two different things**, and only the second is
   what he asked for.
4. **Gap 1 last** — chore workflows, the only piece needing a genuinely new
   agent. His own wording puts it second: *"would also be great."*
5. Repair the remaining doc defects: `proactive-agent-builder` is a **workforce**
   persona (`packages/personas-core/personas/proactive-agent-builder.json`), not
   an `agents` template. The spec has this right; this file copied it wrong.

## History

- 2026-08-07 — Recorded as a future workstream on Khaliq's instruction, for
  pick-up when ready. Not dispatched, nothing built.

---

# Obligation lifecycle — c2a#3 + relay#1474

Lane `c2a-lead-0811`, overnight run 2026-08-11. Durable state; DMs do not
survive a restart.

## Settled and not to be re-opened

**An obligation is discharged when the SENDER — the obligating author, or its
named discharge delegate — confirms it was answered.** Not on read, not on a
timer, not on the recipient's belief that it replied.

Khaliq issued twelve rulings on c2a#3 (third comment on the issue) after an
independent red-team broke the original design. Those rulings are the
specification. The most load-bearing:

- **F1** — the presence of the `obligation` object creates the obligation.
  `policy` means "you were addressed" and nothing more. Making `must_respond`
  the trigger opens a never-expiring obligation on every DM.
- **F3** — "no new signal" is withdrawn. The spec's own own-message reaction
  line told a conformant host to read a *recipient's* ✅ as "already handled":
  the read-receipt bug in a costume. Rewritten.
- **F3b** — an obligation names a `dischargeDelegate` at creation, defaulting
  to the author's coordinator. Short-lived authors cannot emit `done`.
- **F5** — additive schema required: `createdAt`, recipient identity, a
  reaction event shape, a *named* authoritative log, a retention floor.

## Delivered

- **c2a PR #4** (`spec/obligation-lifecycle`) rewritten from the pre-ruling
  shape to the ruled one, +235/-6 on the README that is the entire spec. All
  twelve rulings verified against the text line by line. **Not merged.**
  Two defects found and fixed during verification (`e4c0af2`): `declined`/
  `blocked` said "escalate at the next return" (ruling says immediately); and
  `unclear` paused the ladder with no resume condition, so one reaction could
  mute an obligation permanently — reopening for `unclear` the hole the ruling
  closed for `declined`.
  **c2a has no CI at all.** No `.github/workflows`. The only checks are
  CodeRabbit and cubic. An empty `gh run list` here is absence, not a pass.
- **relay PR #1476** — conformance fixture, test-only, gated behind
  `RELAY_OBLIGATION_CONFORMANCE=1`. CI green by `--branch` (7 runs), which
  proves only that it is correctly gated OFF. **Not merged.**
- **relay#1475** filed — the PTY turn signal is self-declared `inferred`.
- Corrections posted to relay#1474 (superseded design) and relay#1471.

## C2A cleanup checkpoint — 2026-08-11 15:48 CEST

`c2a#4` remains open under the explicit DO-NOT-MERGE contract. GitHub shows
CodeRabbit and cubic green, but five substantive spec gaps remain documented in
review threads: obligationId regression, edit/delete schema, escalation
resolution, silent drop, and `tool_mailbox`. No fixes were pushed because the
lane was holding for Khaliq's spec ruling. `c2a-lead-0811b` had been waiting 92
minutes with zero pending messages and was released. The durable issue and this
section are the handoff; do not respawn merely to rediscover the gaps.

## The deliverable was NOT achieved

The negative test — delivered, injected, READ, unanswered, must still return —
was never observed firing or not firing. Arms A–D fail on a PRECONDITION:
message delivery to a spawned worker does not work in this environment. The
broker spawned by `BrokerHarness` never registers as a live delivery node.
Confirmed environmental, not fixture-caused, by reproducing against the
pre-existing `mcp-injection.test.ts`.

Two things *were* observed: one arm passes on live data proving **a reaction
cannot name the recipient it discharges** (F2 as an executable test, goes red
when the substrate gains the field); and the control guard **refused** to
report green off a precondition failure.

## Three walls in front of the conformance assertion

1. **No honest model-turn signal.** The broker emits `turn.started`/
   `turn.settled` from stdout busy/idle and labels them `fidelities:
   ["inferred"]` against `"exact"` for other activities
   (`worker_events.rs:377-379`). It publishes to the hosted stream, not to
   local `getAgentEventHistory`, so a broker integration test cannot reach it.
2. **Arm D is unassertable, not merely unimplemented.** Read state is auto-set
   on *both* runtimes — `mark_delivery_read_ack` fires off the worker's
   `delivery_ack`. The independent variable cannot be varied.
3. **The arms cannot all live in one repo.** `relaycast` has no model in it, so
   "the recipient took a model turn" is unassertable there by construction;
   `relay` is the only place a model exists.

## Blocking questions put to Chief, unanswered as of 2026-08-11 ~00:00 Oslo

1. Does conformance evidence run on the default PTY path or the native harness?
2. Is `relaycast` in scope? The spec now *requires* a named authoritative log,
   and that host is relaycast — a broker-side shadow store would duplicate the
   log the spec just mandated.
3. **The largest: no agent hierarchy exists as data anywhere.** Exhaustive grep
   across relaycast engine and types for supervisor/coordinator/parent/
   spawned_by/manager/reports_to returns zero. F3b's delegate default and the
   ladder's "recipient's coordinator" have nothing to resolve against, so every
   short-lived-author obligation falls straight to the human tier and the
   delegate rung is decorative. This inverts the ruling's own intent. It is a
   missing product entity, not a schema tweak.
4. Is a working test-environment delivery path someone's lane?

## Landmines for whoever picks this up

- **Retention silently discharges obligations today.** `pruneExpired`
  (`relaycast packages/engine/src/engine/retention.ts:125-294`) deletes messages
  age-based and cascades to reactions; the hosted default is documented as 30
  days. The spec says an obligation never expires.
- **Reaction removal is a hard DELETE** (`reaction.ts:94-102`), so "discharge is
  monotonic" is not expressible from the reactions table as it stands.
- **The reactions unique index** `(messageId, agentId, emoji)` blocks one actor
  discharging for two recipients on the same event. The index must change, not
  just gain a column.
- **`crates/broker/src/scheduler.rs` is dead code** — only `mod` declaration and
  its own tests reference it. Copy its `now`-as-parameter shape; do not believe
  it does a job. The real hook is the 500ms sweep in `runtime/maintenance.rs`,
  whose semantics are the opposite of what boomerang needs: it drops a delivery
  the moment the worker acks.
- **relaycast's test harness is the good substrate** — real Hono app over real
  HTTP, migrations applied to in-memory SQLite, and `pruneExpired` already takes
  an explicit `now`. Arms C and D need no fake-timer tricks there.

## relay#1471 root cause — found, not my lane

`listConversations`, `relaycast packages/engine/src/engine/dm.ts:432-519`. The
first query selects every DM conversation the agent has ever been in with **no
LIMIT** (`dm.ts:433-448`), then feeds four `inArray(...)` queries; Drizzle
expands each to one bound parameter per element, blowing D1's ceiling. The
error in #1471 is the first of those four (`dm.ts:457-465`). Separately,
`message.dm.list` advertises a `limit` parameter that is never destructured and
never forwarded (`packages/mcp/src/tools/messaging.ts:127,134-136`) — the
obvious workaround is itself silently broken.

**Trap:** engine tests run on in-memory better-sqlite3, whose parameter ceiling
is far above D1's. A regression test will pass locally while the hosted path
still fails. It must assert on parameter count or chunk boundaries.
