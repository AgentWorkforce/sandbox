---
id: skip-deterministic-harness
kind: workstream
status: active
owner: skip-deterministic-harness-lead-0814
reports_to: chief
updated: 2026-08-14T15:10:58Z
repos:
  - chief
  - agent-assistant
  - factory
  - relayflows
  - ricky
  - relay
  - relayfile
---

# Skip deterministic harness

## Goal

Turn Chief into Skip: a Relayfile-native, mostly deterministic harness that
keeps every workstream moving by supervising accountable leads and delegating
all execution to agents underneath it.

Skip never implements. It acknowledges human requests, creates durable work,
routes that work deterministically, watches every active workstream on a
schedule, activates quiet leads, and performs fenced low-context handoffs when
a lead must rotate.

## Accountable shape

`skip-deterministic-harness-lead-0814` is the accountable workstream lead and
reports to the bootstrap coordinator. Skip itself is a custom deterministic
resident, not an OpenCode agent. OpenCode on
`opencode/deepseek-v4-flash-free` is isolated to a bounded ambiguity pocket.
The lead is forbidden to implement; it delegates bounded tracks and verifies
their evidence:

- routing and harness reuse audit
- workstream supervision and recovery audit
- native communication protocol audit

The first plan-only dogfood sweep surfaced `APPOINT_LEAD` for the temporary
bootstrap ownership. That finding caused this appointment; it was not
suppressed or waived.

## Now — 2026-08-14

- The workstream is formally registered and active.
- The Chief operating doctrine is confirmed as product behavior: one
  accountable lead per workstream; leads delegate; silence is a failure signal;
  the coordinator loops over leads and never implements.
- Agent Assistant is now a runtime dependency: `@agent-assistant/proactive`
  supplies bounded all-settled fan-out, and `@agent-assistant/harness` supplies
  the tool-denied pure OpenCode runner used only for ambiguous intent
  decomposition. The profile names that selected bridge and the resident passes
  its model and timeout; reasoning effort is not configurable through this
  bridge.
- Pi informs bounded turns, event streaming, steering, and context transforms.
- eve informs filesystem-first agent definitions, subagents, channels,
  schedules, durable execution, and sandbox isolation.
- The runnable resident composes a five-minute storage-neutral workstream sweep
  with a deterministic agent per stable conversation thread. Workstreams and
  threads use independent bounded queues, deadlines, and wake fan-out so one
  cannot gate the other.
- SQLite WAL stores action claims, generation fences, receipts, thread claims,
  compact thread state, one-message-to-many-intent records, and evidence. Crash
  recovery reuses the first durable proposal instead of calling the pocket a
  second time. The local mailbox before a thread claim remains volatile.
- Conservative pure-code intent preclassification is connected before the
  ambiguity pocket; ambiguous pronouns, coupled requests, and unknown
  workstreams still fail closed to the pocket.
- Every pending intent now enters an independently leased durable outbox.
  Structured WorkItems route to Factory, Factory's Relayflow registry, Ricky,
  or a read-only investigation lead. Questions and authority-free actions route
  to the accountable workstream lead. Audit mode writes the exact Relayfile
  action; active mode requires confirmed delivery plus its exact five-minute
  follow-up. Staged audit entries remain promotable after restart.
- Relayfile envelopes, local fsynced dogfood persistence, an Agent Relay
  delivery adapter, stable resident identity, human-only SDK ingress, and
  projection-uncertainty fencing are implemented and tested. Explicit active
  mode durably reserves SDK intake before conversational ACK and replays until
  a thread agent admits it. Default audit mode disables external ingress. A
  durable uncertain-delivery reconciler remains open.
- Strict `skip_result` messages are accepted only from the accountable agent
  after confirmed delegation. Result evidence updates one intent atomically;
  independently leased partial and final replies return to the exact origin
  message/thread. Stable result and reply IDs make replays idempotent.
- Current dogfood sees 25 active workstreams, plans 25 actions with zero
  deferred, and continues sweeping while conversation threads run. A local
  two-question message was accepted with `Checking.` and durably decomposed
  into two independent pending intents.
- Human surface copy defaults to `Checking.`, `Working.`, `Choose.`, `Blocked.`,
  and `Done.` Detail is added only when it is actionable.
- Audit checkpoints now promote to active mode without deleting deferred
  ordering, and Markdown H1 titles remain available to exact-title
  conversation routing instead of being replaced by filename IDs.
- The fenced five-minute follow-up store, pre-delivery durable reservation,
  delivery confirmation, and resident consumer are wired behind the explicit
  active-mode plus `SKIP_LIVE_RELAY=1` gate. A crash after projection cannot
  erase the conservative check. Default audit mode remains shadow-only.
  Concrete work evidence or a complete blocker contract closes a scheduled
  check. Silence can trigger activation, never replacement by itself.
- A full product eval harness now reuses Agent Assistant's compiler, run record,
  artifact, and CI-summary substrate. Fifty-eight human-authored offline cases
  cover deterministic routing, multitasking, thread isolation, workstream
  supervision, five-minute follow-ups, crash recovery, plain communication, and
  multi-intent reply readiness.
- Validation is green: 192/192 Skip tests, 58/58 offline product evals, and
  334/334 full repository tests, plus config, Factory, Cloud, syntax, bundle,
  and workflow validation.

## Next

1. Rotate exposed local Relay credentials, then dogfood the opt-in active Relay
   delivery and five-minute follow-up path. Do not reuse the exposed keys.
2. Define an authoritative target and policy for ownerless `APPOINT_LEAD`;
   active mode intentionally excludes it until then.
3. Add automatic recovery only after snapshot, generation fence,
   unique-successor, and atomic owner-rebind proofs exist.

## Guardrails

- No self-execution route exists.
- Silence alone can activate or probe a lead; it cannot replace one.
- Blocked is not idle only when it has an owner, blocker, resume trigger, and
  next check.
- Context rotation and crash recovery use the same fenced handoff protocol,
  but remain distinct reasons in the audit log.
- Factory owns repo-mutation lifecycle and dispatchability.
- Factory's Relayflow registry owns workflow trigger dispatch. Ricky prepares a
  missing workflow artifact; it is not a second workflow runtime.
- Investigation agents are read-only. Any recommended mutation becomes a new
  implementation WorkItem.
- No agent merges without explicit human approval.

## Evidence

- Harness spec: `docs/skip-spec-v1.md`
- Communication spec: `docs/skip-communication-v1.md`
- Runtime profile: `skip.config.json`
- Deterministic router: `scripts/lib/skip-router.mjs`
- Supervision planner: `scripts/lib/skip-supervisor.mjs`
- Claimed active-management core: `scripts/lib/skip-action-executor.mjs`
- Dogfood sweep: `scripts/skip-control.mjs`
- Resident/composite runtime: `scripts/skip-resident.mjs`,
  `scripts/lib/skip-runtime-composite.mjs`
- Per-thread agents and durable intent core:
  `scripts/lib/skip-thread-agent-manager.mjs`,
  `scripts/lib/skip-thread-activation-core.mjs`,
  `scripts/lib/skip-intent-ledger.mjs`
- Durable intent routing/dispatch: `scripts/lib/skip-intent-routing.mjs`,
  `scripts/lib/skip-intent-dispatch-resident.mjs`
- Durable SDK admission/results/replies: `scripts/lib/skip-ingress-store.mjs`,
  `scripts/lib/skip-human-ingress.mjs`,
  `scripts/lib/skip-agent-result-ingress.mjs`,
  `scripts/lib/skip-reply-resident.mjs`
- Product evals: `evals/`, `scripts/evals/`
