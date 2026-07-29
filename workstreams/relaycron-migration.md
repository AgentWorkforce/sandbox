---
status: active
owner: chief
updated: 2026-07-29
repos: [relaycron, cloud, relaycron-cloud]
---
# relaycron migration

**Goal:** relaycron (D1 + Durable Object alarms scheduler, already
Cloudflare-native) gets a home outside the dying `cloud` SST repo, plus a
relay-message transport so schedules can target agents directly.

**Now:** the live copy is `cloud/packages/relaycron` (fired by SchedulerDO
alarms + a CF cron fallback, reachable via `agent-relay cloud schedule`); the
standalone `relaycron` repo is frozen at 2026-05-30; `relaycron-cloud` is a
detached-HEAD husk with no origin/main.

**Next:** decide the destination repo (revive `relaycron`, adopt
`relaycron-cloud`, or fold into relaycast-cloud), then move deploy out of
`cloud`. The message transport rides on top once moved (see
[agent-org-primitives]).

## History
- 2026-07-29 — Named a workstream by Will ("one of our workstreams will be
  migrating relaycron once we're up and running"). It's a repo/deploy
  migration, not a rewrite. Precedent worth keeping: agent-gateway registers
  a cron that POSTs /internal/cron/tick to wake a proactive agent.
