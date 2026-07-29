---
status: active
tldr: "July's GTM metrics agent is safe on origin with its PR open; cmo is seated and onboarding scout."
card: "GTM Department"
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

**Now:** the July work (GTM metrics agent: daily collectors, D1 history,
dashboard, digest, deploy-on-merge CI) is **safe on origin** —
`feat/gtm-metrics-agent` pushed 2026-07-29 (tip b3bcec4; the only-copy risk
is retired). The cmo resident is seated and respawned on pinned opus;
scout reports to it.

**Next:** cmo opens the PR to main (merge gated on chief — merging
activates the Cloudflare deploy), onboards scout (first assignment: land
scout's uncommitted crew work), then the two GTM campaigns as scout
campaigns. Open question: why the first cmo session went silent on an
urgent brief — transcript review pending.

## History
- 2026-07-29 — Seeded at Will's request. Working tree clean; the unpushed
  branch is the risk item.
