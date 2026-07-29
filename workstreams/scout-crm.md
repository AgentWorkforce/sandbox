---
status: active
tldr: "Scout is landing its uncommitted crew work under cmo's direction before the two GTM discovery campaigns spin up."
card: "Developer CRM"
owner: scout
updated: 2026-07-29
repos: [scout]
---
# scout — developer CRM (Relay Scout)

**Goal:** the operating system for open-source growth: discover developers
from public ecosystems, persist them as CRM records with provenance, advance
them through the relationship funnel (system owns awareness stages, human owns
`contacted` onward), surface a daily attention queue, crew-drafted outreach —
a human sends every message. Dogfoods Agent Relay: all LLM work runs in crew
agents on a fleet node; the app holds no model keys.

**Now:** main is current with origin — PR #15 "durable Relay CRM actions"
merged 07-27, after the mid-July fleet-node stabilization run (#11–#12,
Relay 10.6). Sitting uncommitted on main: 9 modified files (~194 insertions)
across crew actions/orchestrator/spawn plus their tests. Worktrees open for
`identity-enrichment` and `fleet-serve-command-refs`.

**Next:** move the uncommitted crew changes onto a branch and land them; then
the worktree branches (identity-enrichment first). On deck after that: the two
GTM campaigns scout serves under cmo — (1) OSS-dev engagement targets on
X/LinkedIn, (2) affiliate/paid-promo collab targets on X — needing an X
discovery source (README's planned discovery agent) and LinkedIn as net-new
(prior art: pre-reset cmo `linkedin-enrichment` branch).

## History
- 2026-07-29 — Seeded at Will's request. Architecture: CF Worker (Hono) +
  ScoutOrchestrator DO + Neon, nightly cron; deterministic pipeline feeds the
  crew; scout is the reference implementation cmo's charter points at.
