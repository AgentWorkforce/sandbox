---
status: active
tldr: "The hosted migration has been done since June; three small tails remain — a stale doc line, the compat domain, the home flag."
owner: relayfile
updated: 2026-07-29
repos: [relayfile, relayfile-cloud, relayauth]
---
# relayfile — post-Gate-3 tails

**Goal:** finish the hosted migration completely: one domain, one cloud, no
stale docs.

**Now:** Gate 3 signed GREEN 2026-06-20 and prod has run as normal
infrastructure since. Three tails open:
1. `api.relayfile.dev` compat domain still bound in prod
   (`infra/relayfile.ts:58` — migration-plan steps 6–7: repoint, retire).
2. `sst.config.ts` still `home: "aws"` — Stream H flip to cloudflare (the
   guarded migration path landed in PR #106; the value never flipped).
3. `relayfile-cloud/CLAUDE.md:13` stale — still says "Gate 3, prod: in
   progress"; misleads every reader.

**Next:** fix the stale CLAUDE.md line (one-line PR), then schedule the
domain retirement and home flip.

## History
- 2026-07-29 — Status established from decision doc
  2026-06-20-gate3-sign.md during chief's backfill. July engine work:
  concurrent-edit merge semantics (#370–#377) proven across two machines —
  relevant to multi-agent shared state later.
