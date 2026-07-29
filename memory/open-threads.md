# Open threads

- **relayauth D1 at capacity — LIVE PROD CONDITION (2026-07-29, escalated
  to cloud):** the 10 GiB ceiling is hit again (July-22 recurrence); token
  mints flap on the 5-min GC cadence, dragging workspace
  creation/relayfile provisioning with them. Legibility fix: relayauth
  PR #70 (typed 503 + Retry-After, CI green) awaiting cloud's adversarial
  review + chief merge confirm; tracking issue relayauth#71. Durable fix:
  cloud#2801 / archive-to-R2 — cloud resident owns the plan, execution
  gated. Will's relayfile retries succeed only in post-GC-tick windows
  until then. See [learnings] for the standing capacity rule.

- **Principal senses: email + Granola (Will, 2026-07-29)** — chief gets
  read-only access to Will's email and Granola (meeting recordings/recaps +
  self-notes). Email path: relayfile Gmail provider (confirmed in catalog)
  → after provisioning heals, `relayfile integration connect gmail` OAuth →
  scoped mount in a second chief relayfile workspace (first slot = GitHub
  tree). **Granola: resolved 2026-07-29 — zero build needed.** First-party
  adapter ships (`@relayfile/adapter-granola`, catalog entry `granola`,
  Nango 5-min sync, notes + full transcripts + calendar/attendees into
  `/granola/notes/**` with by-day indexes). **Gate: Granola API keys need
  Business/Enterprise** — Will decides plan-upgrade vs the free-tier
  fallback (official `granola-mcp`, OAuth, 30-day window, pull-only, no
  dogfood). Setup when gated-through: Granola Settings → Connectors → API
  key (Personal-notes scope), `relayfile integration connect granola`,
  mount. Phase 2 (push, not just read): workforce persona on the
  file.created trigger DMs chief summaries — needs a cloud deploy.
  Privacy rule now in CLAUDE.md §6: transcripts/attendee text never enter
  the tracked brain.

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

- **Credential rotation batch — DEFERRED by Will 2026-07-29** (revisit when
  relay's secrets platform fix lands, or on any sign of misuse; the leaked
  values remain live until then). Rotate together, then fix the platform
  leak: (1) `RELAY_BROKER_API_KEY` (`br_…`) — leaked into the
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
- **Workspace-deletion cascade bug (2026-07-29, in cloud's queue):**
  `deleteWorkspaceCascade` (workspace-deletion.ts:75) never deletes the
  Relaycast side — every cloud-API deletion strands a live Relaycast
  workspace + valid rk_live_ key with no registry row. Fix order matters:
  Relaycast DELETE first (registry row is the key's only store). Cleanup
  2026-07-29 deleted the 7 diagnostic workspaces both-sides; the cso
  orphan below is the un-deletable example. Related CLI leak
  (`workspace active` prints the key in error output) is in relay's
  secrets-fix scope; chief-dev key exposure count grows.
- **Orphaned auto-provisioned workspace `208248743547961344` (2026-07-29):**
  cso's first `agent-relay node up` silently created a fresh workspace
  instead of joining the active one — the officer came up unreachable until
  chief's `workspace-key.json` was seeded into cso's state dir and the node
  rebooted. Cleanup: delete the orphan workspace (holds one stale cso
  registration). Relay issue candidate: first boot in a new repo should
  join the account's active workspace (or require an explicit choice),
  never silently mint a new one.
- **relayfile CLI gaps — FILED** (2026-07-29): `login --no-open` broken →
  relayfile#378; single `--remote-path` / no `--local-layout` →
  relayfile#379. Watch for fixes; #379 unblocks multi-subtree senses
  mounts without one-workspace-per-mount.

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
