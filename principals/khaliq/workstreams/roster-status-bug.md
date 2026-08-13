---
status: active
owner: roster-status-bug-0812
reports_to: chief
updated: 2026-08-12
repos: [relay, relaycast-cloud]
---

**Goal:** the fleet roster's `status` field (offline/active) should reflect
real process liveness. Tonight it repeatedly lied in both directions —
chief had to fall back to direct SSH/process checks dozens of times
because the field couldn't be trusted, a real operational cost across the
whole session.

## 2026-08-12 12:24Z — root cause confirmed, PR in progress

Dispatched on chief's own laptop (not a remote fleet node — deliberately,
per Khaliq's instruction) after the pattern recurred all night.

**Root cause:** Relaycast intentionally marks every via-node agent offline
when the node-control provider disconnects. Reconnect can only reactivate
live workers by replaying `inventory.sync`. But production's
`fleet_inventory` was initialized **empty**, and successful `agent.register`
calls only ever populated a separate `FleetDeliveryBook` — never
`fleet_inventory`. So a genuinely live agent can sit marked offline
indefinitely after any provider reconnect; node heartbeat/`activeAgents`
can look healthy while individual live rows stay offline. Busy agents
sometimes self-heal via a later auth event; idle ones don't — exactly
matching the "flips between offline/active seemingly at random" pattern
observed repeatedly tonight.

**Fix**: after a node-registered worker actually launches (both the HTTP
and `action.invoke` paths), retain its authoritative identity in
`fleet_inventory` and immediately publish `inventory.sync`. Implemented on
a clean feature branch. Full broker lib suite: 913 passed, 0 failed, 4
ignored; scoped clippy/fmt clean. Related: relay#1462 (blackholed
node-control WS detection) is complementary but not sufficient alone —
fixes a different half of the reconnect problem.

**Not merged or deployed. Chief to review the diff directly before this
goes anywhere near production**, same standard applied to every other PR
tonight.

## 2026-08-12 12:57Z — PR opened and reviewed, genuinely solid

[`relay#1494`](https://github.com/AgentWorkforce/relay/pull/1494)
(361+/16-, 4 files, head `ac333710b`). Chief read the full diff. Verified:
`record_fleet_inventory_agent` only fires after a worker successfully
launches (post-spawn); `resolve_fleet_agent_token_identity` actively
**rejects identity mismatches** rather than trusting the caller, tested
both ways; `publish_fleet_inventory_snapshot` changed from lossy
`try_send()` to reliable `.send().await`, backed by a real test that fills
the channel and asserts the publish blocks-then-delivers instead of
silently dropping; every failure path degrades to "log a warning, let the
spawn continue" — the fix cannot newly block a spawn if something goes
wrong. Correctly scoped `relay` as sole owner (relaycast-cloud is only
engine-composition, no cloud change needed). Correctly declined to
force-reset a shared production node-control socket just to exercise the
recovery path live — used targeted regression tests instead.

All CI green except Cubic's own review still finishing; `mergeStateStatus:
BLOCKED` is the standard human-review gate, not a failure.
`relay#1462` (blackholed-socket detection) is complementary, not a
substitute — it detects the disconnect sooner, this fix is what actually
restores the inventory afterward.

## Next

1. ~~Review the actual PR diff once opened.~~ Done — see above.
2. Hold merge/deploy for explicit Khaliq authorization, same as the other
   two PRs tonight (relay#1491, cloud#3001).
