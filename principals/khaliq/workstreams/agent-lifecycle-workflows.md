---
status: active
owner: lifecycle-workflows-lead-0810
updated: 2026-08-10
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
