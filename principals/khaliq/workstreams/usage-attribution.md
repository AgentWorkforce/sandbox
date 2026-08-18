---
status: active
owner: relaycast-usage-attribution-0818
reports_to: chief
updated: 2026-08-18
repos: [relaycast, relaycast-cloud, relay, cloud]
---
# Usage attribution — we cannot tell who to charge

Goal: be able to answer "which workspaces are external customers, and how much
does each consume" without reading agent names by hand.

## Now — 2026-08-18

Khaliq asked who the heavy users are and whether we should start charging.
**We cannot answer, and the reason is that it was never recorded.**

The worker `relaycast-cloud-api` serves **~188 req/s — roughly 16 million
requests a day** — spread across Oslo (78.8), Dulles (35.3), Tel Aviv (30.1),
Phoenix (27.1), San Jose (10.5) and Boston (6.7).

Total messages written platform-wide in the same 24 hours: **~1,500.**

**Three orders of magnitude apart.** Requests are overwhelmingly not message
writes — they are reads, polling, presence, heartbeats and websocket traffic.
Any claim about "heavy users" built on message volume describes ~0.01% of the
traffic that would drive a bill.

What is known: the *message* workload is almost entirely ours — `rw_7ccfea89`
(the workspace Chief runs in) plus `relay-wf-*` workflow workspaces. What is
**not** known: who generates the 16M requests. Dulles, Phoenix, San Jose and
Boston are consistent with our own Daytona sandboxes, but consistent-with is
not evidence, and **Tel Aviv at 30 req/s is unaccounted for.** Cloudflare
routes to the colo nearest the client, so those are distinct network origins.

**The gap: request traffic has no attribution at all.** D1 records messages,
agents and workspaces; it records nothing about who made a request. And no
workspace carries provenance — a CI smoke run, a relayflow bootstrap, a
customer signup and a developer probe all produce an identical `relay-<8 hex>`
row.

## Next

- **Request-level attribution** — the worker should attribute each request to a
  workspace or token. This is the thing that would answer the question; nothing
  else does.
- **Provenance at creation** — what created a workspace and from where, designed
  so the real callers can actually populate it. A field nobody sets is worse
  than no field: it reads as coverage.
- **Internal vs external classification** — our traffic dominates everything, so
  an unfiltered "top consumers" list is actively misleading.
- **Not billing.** Metering, pricing and invoicing are downstream of decisions
  Khaliq has not made. Mark the seam and stop.

Backfill honesty: the 41,320 existing workspaces cannot be retroactively
attributed with certainty. Name patterns and agent names support *inference*
only, and an inference must never be recorded as fact.

## History

### 2026-08-18 — a correction worth keeping
Chief first answered "who are the heavy users" from all-time message volume per
workspace and concluded they were all internal. Khaliq challenged it: requests
were arriving from Tel Aviv and Dulles. The challenge was right. The two
measurements differ by ~10,000x and describe different things, and the honest
answer was "we do not know" rather than a conclusion drawn from the only data
that happened to be queryable.
