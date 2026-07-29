# Open threads

- **cso watchlist is empty (2026-07-29); seed corpus = #research-market** —
  mounts into **cso's own** `senses/` (own relayfile workspace; senses
  belong to the consuming department, which also keeps chief's one-mount
  slot for the GitHub tree). **Blocker moved off Will 2026-07-29:**
  `relayfile login --provision-messaging-only` fails server-side — `http
  500: Failed to create workspace` from agentrelay.com/cloud; diagnosis
  subagent dispatched (suspect: handler on torn-down cloud/AWS infra).
  After the fix: Will's OAuth (~3 min) → mount → cso sweeps → dossiers.
  Interim habit: DM fresh finds to cso directly.

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
  both landed in the 07-29 restart-verification transcript. (3) The cloud
  access token (`cld_at_…`) — `agent-relay cloud session --json` prints it in
  plaintext; it landed in the senses-mount worker's 07-29 transcript
  (rotate: `agent-relay cloud login --force`). Rotating alone is
  insufficient — the next boot re-leaks the new values. **Platform fix needed
  in relay:** pass workspace key/agent token via env or file instead of
  `--mcp-config` argv, redact key values from node/broker logs, and redact
  the token in `cloud session --json` (or gate behind an explicit flag).
  File as a relay issue. This also subsumes the July-review `rk_live_`
  rotation item below; see [learnings] for the no-raw-env rule.
- **Orphaned auto-provisioned workspace `208248743547961344` (2026-07-29):**
  cso's first `agent-relay node up` silently created a fresh workspace
  instead of joining the active one — the officer came up unreachable until
  chief's `workspace-key.json` was seeded into cso's state dir and the node
  rebooted. Cleanup: delete the orphan workspace (holds one stale cso
  registration). Relay issue candidate: first boot in a new repo should
  join the account's active workspace (or require an explicit choice),
  never silently mint a new one.
- **relayfile CLI gaps (senses-mount worker, 2026-07-29) — file as relayfile
  issues:** (1) `relayfile login --no-open` broken end-to-end — forwards
  `--no-open` to `agent-relay cloud login`, which doesn't have the option
  (agent-relay 11.2.0); headless/CI login impossible. (2) Multi-subtree
  mounts unreachable from the shipped CLI — `mount` takes a single
  `--remote-path`, rejects `--local-layout`; the README's repeated-flag
  syntax belongs to the unshipped `relayfile-mount` daemon binary. Expose
  repeated `--remote-path` / `--local-layout=scoped` (or `--paths-file`)
  through the CLI.

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
- **burn macOS updater dead on arrival → now the factory's first work unit**
  (2026-07-29): the in-app updater (PR #495) ships against `macos-v*` tags
  that don't exist. Owned by the burn project owner via [burn-factory];
  parks at the publish gate pending cpo green-light.
- **cloud PR #2857 (RelayAuth D1 dormant rebuild) may be stuck:** branch
  `agent/2857-relayauth-d1-rebuild-dormant` took 7 rapid "fix(relayauth)"
  commits from two bot identities (kjgbot, Miya) between 07-28 22:19 and
  07-29 03:15 — reads like a CI gate failing repeatedly, not steady
  progress. Still unmerged as of the 07-29 digest. Check PR status/CI before
  assuming it lands on its own; unrelated to [aws-teardown]'s scope despite
  same repo.
