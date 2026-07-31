---
status: active
tldr: "The hosted migration has been done since June; three small tails remain — a stale doc line, the compat domain, the home flag."
card: "File-Sync Tails"
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

**Next:** the relayfile lead seat is live (2026-07-30, approved by Will —
codex, under head-of-ecosystem) and inherits these tails plus
relayfile#378/#379, the #380 companion verification, the hoopsheet
admin-route question, and the provisioning-500 CLI UX. First: clean-main
working discipline (checkout was 150 behind on a dead branch), then the
stale CLAUDE.md one-liner, then domain retirement + home flip scheduling.

## History
- 2026-07-29 — Status established from decision doc
  2026-06-20-gate3-sign.md during chief's backfill. July engine work:
  concurrent-edit merge semantics (#370–#377) proven across two machines —
  relevant to multi-agent shared state later.
