---
status: active
owner: chief
updated: 2026-07-29
repos: [relaycron, cloud, relaycron-cloud]
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

**Next:** extract `cloud/packages/relaycron` + `infra/relaycron.ts` into its
own repo following the relayfile-cloud pattern (infra/README names
worker-cluster extraction as the stated direction), rewire the two service
bindings, then add the relay-message transport ("at 9am, DM chief") — see
[agent-org-primitives].

## History
- 2026-07-29 — Named a workstream by Will. Mining corrected the story:
  migration = extracting the deployment layer, not reviving the library.
  Housekeeping: `relaycron-cloud` on disk has zero commits (empty
  placeholder — use as the extraction target or delete); `relaycron`'s
  feat/initial-scaffold carries a four-month-cold dirty SST experiment
  (2026-03-26) — safe to discard.
