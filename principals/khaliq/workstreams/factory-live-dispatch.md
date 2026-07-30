---
status: active
owner: khaliq-chief
updated: 2026-07-30
repos: [cloud, relay, relayfile]
---
# Factory live dispatch

**Goal:** A ready human-owned Linear issue safely dispatches a Cloud Factory
recipe that creates agent-owned GitHub work and reports checkpoints to Linear.

**Now:** Hosted Factory orchestration and a reversible production flag exist in
Cloud. A deployable Linear-triggered Factory brain persona and live canary are
the remaining activation steps.

**Next:** Bring a Factory instance back online first — both registered
instances are offline/stopped — then deploy the Factory brain persona, enable
the production flag, and dispatch a labeled `[factory]` canary with merge
disabled.

## History

- 2026-07-30 — Doctor shows `liveInstance: false`: `AgentWorkforce cross-repo`
  offline since 07-24, `factory` stopped since 07-23. Dispatch is blocked on
  instance availability, ahead of the persona and flag work.

- 2026-07-30 — Agreed on Linear as the human plane, GitHub as the agent plane,
  and Cloud Factory as the only task bridge.
