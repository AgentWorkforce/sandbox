---
status: active
owner: relaycast
updated: 2026-07-29
repos: [relaycast, relaycast-cloud]
---
# relaycast — delivery hardening & open surface

**Goal:** close out the silent-delivery-loss era and land the open engine
surfaces (directory, cloud MCP tools, auth enforcement).

**Now:** 16 releases in 30 days, hardening mode (v6.0.1–6.3.0: sequences,
cursor negotiation, sweep redrive, fail-fast handlers, presence-only
disconnect, per-person telemetry identity). In flight: provider-attach
arbitration (branch codex/pr263-review-fixes), Swift AgentStatus decode for
hosted lifecycle statuses.

**Next:** merge the arbitration branch; then triage the long-open PRs:
**#295 unified queryable team directory (a2a)** — feeds
[agent-org-primitives] — #135/#130 cloud MCP tools, **#102 relayauth JWT
verification + scope enforcement (open since ~March)**, and relaycast-cloud
#8 (retire the legacy gateway strangler).

## History
- 2026-07-29 — Backfilled from engine mining: fleet delivery RFC → v5.0.0
  (Jun), multi-provider nodes v6.0.0 (Jul), relaycast-cloud on Cloudflare
  with AWS removed (Jun).
