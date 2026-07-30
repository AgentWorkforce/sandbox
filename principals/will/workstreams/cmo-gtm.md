---
status: active
owner: cmo
updated: 2026-07-29
repos: [cmo]
---
# cmo — GTM / marketing workbench

**Goal:** cmo is the GTM **department**: strategy docs, north-star metrics
(MAC-WAU, 7d activations, PostHog project 296966), and — once stood up — the
cmo agent chief dispatches all GTM work to. Scout is its instrument; targeting
machinery is never rebuilt here (the old SST/AWS CRM was deleted for exactly
that). Cloudflare-only by charter.

**Now:** repo was reset to a clean slate 07-20, keeping the strategy docs
(`docs/gtm-metrics-spec.md`, `docs/gtm-proof-plan.md`). Same day: GTM metrics
agent built (daily collectors, D1 history, dashboard, digest) plus
deploy-on-merge CI. **All of it sits on local branch `feat/gtm-metrics-agent`,
unpushed** — origin/main still ends at the April CRM merge; this machine holds
the only copy of the July work.

**Next:** push the branch and land it on main (which also activates the
Cloudflare deploy); then stand up the cmo agent persona (teams.json + persona
doc, chief-DM-able) so GTM asks route Will → chief → cmo → scout crew.

## History
- 2026-07-29 — Seeded at Will's request. Working tree clean; the unpushed
  branch is the risk item.
