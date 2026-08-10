---
status: active
owner: lifecycle-workflows-lead-0810
updated: 2026-08-10
repos: [relayflows, agents, workforce, factory, chief]
---
# Agent lifecycle & chore workflows — Nabis point 2

**Status: QUEUED. Not dispatched. Recorded now so it is picked up when ready
rather than rediscovered.**

**Goal:** Hand Julian a **template pack** assembled from parts we already ship,
so he composes his own feature-lifecycle and chore workflows instead of building
an engine.

**Source of truth:**
`~/.agentworkforce/workforce/sessions/customer-dev-msjgxbkb-71491b9d/mount/nabis/julian-fann/agent-lifecycle-workflows-spec.md`
(87 lines, read it before planning anything). Confidentiality applies as it does
to the SOC-2 epic — the customer belongs in `sales`, not in `factory`, `relay`,
`relayauth` or `relayflows`, which are public.

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

## Four questions for Julian — the first blocks real work

1. **Define CRE and preq** — his exact gates, inputs, and pass/fail criteria.
   These are his internal terms and **everything downstream keys off them.**
   Treat as pluggable review lanes until he says otherwise.
2. Which repos and orgs the chore sweep runs against, and which maintenance
   classes he most wants automated first.
3. Approval model: per-PR human click, or a scoped auto-approve policy. Ties
   directly to point 1's SSO-bound principal.
4. Local-first or cloud-first for the pilot. A self-hosted regulated posture may
   push local.

## Next

**Nothing until picked up.** When it is:

1. Get answers to question 1 — CRE and preq — before designing the review fan-out.
2. Build gap 2 first, since it is assembly of existing personas and proves the
   shape.
3. Hold gap 3 until Hole 1 lands in [[soc2-agent-traceability]].
4. Gap 1 last; it is the only piece that needs a genuinely new agent.

## History

- 2026-08-07 — Recorded as a future workstream on Khaliq's instruction, for
  pick-up when ready. Not dispatched, nothing built.
