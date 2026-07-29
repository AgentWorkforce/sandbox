---
status: active
tldr: "Extraction into relaycron-cloud is underway with Phase 0 done; the schedule-to-DM transport lands in the new home."
card: "Scheduler Migration"
owner: relaycron-cloud
updated: 2026-07-29
repos: [relaycron-cloud, cloud, relaycron]
---
# relaycron migration

**Goal:** relaycron's hosted deployment layer gets a home outside the dying
`cloud` SST repo, plus a relay-message transport so schedules can target
agents directly.

**Now:** corrected picture (2026-07-29 mining) — nothing "moved" and nothing
forked. The standalone `relaycron` repo is the **published library**
(`@relaycron/{types,server,sdk}`), frozen at v0.1.3 (2026-05-12) because all
evolution since lives in the deployment layer: `cloud/packages/relaycron`
(private `relaycron-cloud` package) consumes `^0.1.3` as npm deps and adds
the Cloudflare layer — `relaycron-api`/`relaycron-sweep` Workers,
scheduler-do Durable Object, D1 schema, sweeps, alerts. Consumers on main:
proactive-runtime-worker, web sweep routes, the public schedules API;
dynamic one-shot schedules and managed cloud schedules landed July.

**Next:** owner seated 2026-07-29 (Will: the migration "needs an agent
owner in relaycron-cloud… work with cpo") — resident project owner in
`relaycron-cloud` under cpo. Bootstrap brief: migration spike →
docs/migration-plan.md (deployment-layer inventory in cloud, extraction
sequence per relayfile-cloud precedent, binding rewires, transport designed
into the target architecture), no code moves until cpo green-lights. The
relay-message transport lands in the new home, not bolted onto cloud —
see [agent-org-primitives].

## History
- 2026-07-29 — Named a workstream by Will. Mining corrected the story:
  migration = extracting the deployment layer, not reviving the library.
  Housekeeping: `relaycron-cloud` on disk has zero commits (empty
  placeholder — use as the extraction target or delete); `relaycron`'s
  feat/initial-scaffold carries a four-month-cold dirty SST experiment
  (2026-03-26) — safe to discard.
