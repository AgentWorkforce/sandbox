---
status: active
owner: khaliq-chief
updated: 2026-08-07
repos: [cloud, relay, relayfile]
---
# Factory live dispatch

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

**Factory does not distribute across fleet nodes, and this is not a config
flip.** Dispatch is hosted: the Cloud brain spawns agents through
workspace-scoped Relaycast spawn. The design for node-placed execution exists
(a node advertising `workflow:run` plus `repo:<owner/name>` tags, with
node-local `factory.node.json` clone paths), but measured live on 2026-08-07:
**0 of 402 node records advertise `workflow:run`**, and all three live nodes —
`finn-mini`, `chief-broker`, `barry` — carry the byte-identical default set
`spawn:claude/codex/gemini/opencode`, `release`, `relay:delivery-cursor-v1`,
with no repo tags. No node has ever served a custom node definition. This is
the same gate the Sage program has been waiting on.

**Second blocker for distribution, learned the hard way the same day:** remote
nodes do not carry the repos. A lead placed on `barry` had no access to its own
brief and needed 17KB hand-carried through three DMs. Distributed execution
needs the Relayfile mount on each node — see `herdr-fleet-surface.md` T7, which
delivered that skill — or clones on every host. Capability advertisement alone
is not enough.

**Next:** two independent moves, neither started, both needing Khaliq's word
because each starts real work. (1) Add the `[factory]` prefix to the 17 inert
issues, which begins dispatching genuine backlog. (2) Bring up **one** node with
a real node definition declaring `workflow:run` and two repo tags, and confirm
the control plane advertises them — that converts an untested design into a
measured yes/no and unblocks the Sage program's activation gate 2.

## History

- 2026-08-07 — Audited the live pipeline for the first time since 07-30. Found
  the eligible/inert split (4 of 21) and established that no node can host a
  Factory workload. The workstream's previous Next was written against the
  RelayAuth D1 blocker, which was resolved days earlier and had gone unnoticed
  here — the same stale-blocker failure recorded in `memory/learnings.md`.

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
