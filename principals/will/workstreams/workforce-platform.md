---
status: active
owner: workforce
updated: 2026-07-29
repos: [workforce, internal-agents]
---
# workforce — platform maturation

**Goal:** the agent platform's next layer: declarative trigger routing,
memory authoring SDK, and working through the advisor backlog.

**Now:** most active repo in the ecosystem (56 commits/30d, v4.1.37). July
shipped the warm fast path (26s → 2.5s cold, ~20ms warm) and the
contracts/kits split (events, compose, turn-kit, review-kit, local-surface).
An untracked `plans/` holds 13 advisor plans; branches advisor/001–002 are in
progress; codex/add-cursor-harness unmerged.

**Next:** the two design-shaped advisor plans matter most to chief:
**declarative trigger routing** and **memory authoring docs + SDK** (the
current semantic recall is unreliable enough that agents work around it with
time windows). `local-surface` (fleet-node bridge) is chief-relevant: it runs
proactive personas on a laptop — a possible chief Phase 3 body.

## History
- 2026-07-29 — Backfilled: deploy v1 (May), v4 authoring split (Jun),
  contracts split (Jul). internal-agents: reddit-monitor productionized,
  duet canary hardened, mount scopes narrowed everywhere;
  feat/x-reply-radar-thread-collapse unmerged.
