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
- **relaycron-cloud repo:** zero commits — an empty placeholder (unlike the
  real relayfile-cloud/relayhistory-cloud extractions). Use as the extraction
  target or delete when [relaycron-migration] starts.
- **chief-app:** 41 uncommitted changes on main (headless-chief pivot).
  Decide commit / harvest / archive. Parked 2026-07-29; this repo supersedes it.
- **burn macOS updater may be dead on arrival:** the in-app updater ships
  against `macos-v*` release tags but no such tag exists as of 07-29. Verify
  the release flow before the next menubar update.
