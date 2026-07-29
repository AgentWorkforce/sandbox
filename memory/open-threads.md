# Open threads

- **YC F26 decision due by 08-28** — applications submitted ~07-26 (YC on
  time, a16z Speedrun off-cycle for SR008). Watch for responses; see
  [fundraise-yc-a16z].

- **Interview-prep facts to settle — only Will can fill** (was the YC-app
  blanks list; application fields are moot now that both are submitted, these
  are what an interviewer will probe): one ARR figure for Tailwind
  ("eight-figure" vs "~$7M" — drafts conflict, and the submitted application
  used one of them); the "agents" metric definition (active vs created in
  window); money in bank + monthly spend (runway).

- **Credential rotation batch (2026-07-29) — rotate together, then fix the
  platform leak:** (1) `RELAY_BROKER_API_KEY` (`br_…`) — leaked into the
  07-29 transcript via a raw `env` dump. (2) The chief workspace key
  (`rk_live_…`) and chief agent token (`at_live_…`) — both embedded in the
  broker/claude process argv (world-readable via `ps`) and printed in
  plaintext by `agent-relay node up` into `~/Library/Logs/chief-node.log`;
  both landed in the 07-29 restart-verification transcript. Rotating alone is
  insufficient — the next boot re-leaks the new values. **Platform fix needed
  in relay:** pass workspace key/agent token via env or file instead of
  `--mcp-config` argv, and redact key values from node/broker logs. File as a
  relay issue. This also subsumes the July-review `rk_live_` rotation item
  below; see [learnings] for the no-raw-env rule.

- **relayfile Gate 3: DONE** (signed GREEN 2026-06-20, DO state byte-intact —
  `relayfile-cloud/docs/decisions/2026-06-20-gate3-sign.md`). `senses/` can
  mount hosted `file.agentrelay.com`. Open tails: `api.relayfile.dev` compat
  domain still bound (migration-plan steps 6–7), SST `home: "aws"` not yet
  flipped to cloudflare (Stream H), and `relayfile-cloud/CLAUDE.md:13` stale —
  still says "in progress"; fix it.
- **July-review credential sweep:** the July usage review also found
  PostHog/Cloudflare/Neon creds in prompt history and recommended rotation.
  Verify that happened; the workspace-key part is folded into the rotation
  batch above.
- **relaycron-cloud repo:** zero commits — an empty placeholder (unlike the
  real relayfile-cloud/relayhistory-cloud extractions). Use as the extraction
  target or delete when [relaycron-migration] starts.
- **chief-app:** 41 uncommitted changes on main (headless-chief pivot).
  Decide commit / harvest / archive. Parked 2026-07-29; this repo supersedes it.
- **burn macOS updater may be dead on arrival:** the in-app updater ships
  against `macos-v*` release tags but no such tag exists as of 07-29. Verify
  the release flow before the next menubar update.
- **cloud PR #2857 (RelayAuth D1 dormant rebuild) may be stuck:** branch
  `agent/2857-relayauth-d1-rebuild-dormant` took 7 rapid "fix(relayauth)"
  commits from two bot identities (kjgbot, Miya) between 07-28 22:19 and
  07-29 03:15 — reads like a CI gate failing repeatedly, not steady
  progress. Still unmerged as of the 07-29 digest. Check PR status/CI before
  assuming it lands on its own; unrelated to [aws-teardown]'s scope despite
  same repo.
