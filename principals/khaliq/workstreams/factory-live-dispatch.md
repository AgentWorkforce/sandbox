---
status: active
owner: khaliq-chief
updated: 2026-07-30
repos: [cloud, relay, relayfile]
---
# Factory live dispatch

**Goal:** A ready human-owned Linear issue safely dispatches a Cloud Factory
recipe that creates agent-owned GitHub work and reports checkpoints to Linear.

**Now:** The hosted Factory brain is active, online, and dispatching. Cloud PR
#2871 deployed the current-only Fleet roster, strict `[factory]` plus readiness
gate, real deployed-user ownership, stale-run quarantine, and hosted heartbeat.
Cloud PR #2873 deployed workspace-scoped Relaycast spawning with deterministic
Factory/provider invocation reconciliation. AR-448 launched three agents and
completed successfully with merge disabled. Relay AR-445/446/447 and the
Cloud/Relay schedule-lifecycle task are prepared, but their Linear promotion is
blocked by the gated RelayAuth D1 capacity incident.

**Next:** After the authorized #2857 D1 recovery restores RelayAuth token
minting and Relayfile provider writeback, promote AR-445/446/447 and create the
cross-repository schedule-lifecycle team task from its declarative spec. Then
verify four fresh hosted runs without a new `factory.failure`.

## History

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
