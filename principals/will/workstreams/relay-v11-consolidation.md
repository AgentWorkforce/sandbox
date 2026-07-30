---
status: active
owner: relay
updated: 2026-07-29
repos: [relay]
---
# relay — v11 consolidation

**Goal:** the v10/v11 architectural pushes (node providers, AI-SDK native
runtime, fleet) settle into a stable, verified product.

**Now:** last-30-day commit mix is overwhelmingly corrective (42 fix(cli),
28 fix(broker), 17 fix(relay-feature-guardian) vs 13 feat) — deliberate
hardening. The feature-guardian relayflow verifies a 124-feature manifest
tier-by-tier into #relay-health.

**Next:** complete the gating/soak work in `plans/001-adopt-ai-sdk-harnesses.md`
(P1, HIGH risk — v11.0.0 shipped the capability; the plan's contract/soak
gates are not marked complete).

## History
- 2026-07-29 — Backfill note: v10.0.0 node providers (07-13), v10.2.0 PTY
  correctness, v10.5.0 drive-mode delivery fix, v11.0.0 native runtime
  (07-21), v11.2.0 rooms (07-25). Stray: local checkout 87 behind main with
  small uncommitted fixes matching the unreleased changelog; relay-broker
  repo is a Feb-superseded husk with an abandoned telemetry diff (hardcoded
  PostHog key, reads legacy ~/.agent-relay/) — archive candidate.
- 2026-07-29 (digest) — Telemetry identity-leak fix cluster (clear
  inherited/cloud identity out of child env when telemetry is opted out)
  still in flight on `claude/posthog-events-mapping-9gl0p7`; CLI version
  bump + pinning test added this morning, not yet merged to main.
