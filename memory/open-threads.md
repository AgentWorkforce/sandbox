# Open threads

- **relayfile Gate 3: DONE** (signed GREEN 2026-06-20, DO state byte-intact —
  `relayfile-cloud/docs/decisions/2026-06-20-gate3-sign.md`). `senses/` can
  mount hosted `file.agentrelay.com`. Open tails: `api.relayfile.dev` compat
  domain still bound (migration-plan steps 6–7), SST `home: "aws"` not yet
  flipped to cloudflare (Stream H), and `relayfile-cloud/CLAUDE.md:13` stale —
  still says "in progress"; fix it.
- **rk_live_ key rotation:** the July usage review found a live workspace key
  (plus PostHog/Cloudflare/Neon creds) in prompt history and recommended
  rotation. Verify it actually happened.
- **relaycron-cloud repo:** detached HEAD, no origin/main. Decide revive vs
  delete when the relaycron migration workstream starts.
- **chief-app:** 41 uncommitted changes on main (headless-chief pivot).
  Decide commit / harvest / archive. Parked 2026-07-29; this repo supersedes it.
