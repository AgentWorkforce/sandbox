---
status: active
owner: cmo
updated: 2026-07-29
repos: [cmo]
---
# cmo — GTM / marketing workbench

**Goal:** the GTM workbench: metrics agent tracking the north-star numbers
(MAC-WAU, 7d activations, PostHog project 296966) plus the canonical GTM
strategy docs. Cloudflare-only by charter — the old SST/AWS prospecting CRM
was removed for exactly that reason (scout supersedes it).

**Now:** repo was reset to a clean slate 07-20, keeping the strategy docs
(`docs/gtm-metrics-spec.md`, `docs/gtm-proof-plan.md`). Same day: GTM metrics
agent built (daily collectors, D1 history, dashboard, digest) plus
deploy-on-merge CI. **All of it sits on local branch `feat/gtm-metrics-agent`,
unpushed** — origin/main still ends at the April CRM merge; this machine holds
the only copy of the July work.

**Next:** push the branch and land it on main (which also activates the
Cloudflare deploy); then verify the metrics agent's collectors against the
spec's PostHog event catalog.

## History
- 2026-07-29 — Seeded at Will's request. Working tree clean; the unpushed
  branch is the risk item.
