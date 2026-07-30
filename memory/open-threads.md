# Open threads

- **Fleet liveness watchdog is live — v1 alert-only, tiered passive-first.**
  T1 (every 10 min, zero-token): trips only when a resident has unread-stale
  messages addressed to it AND lastSeen predates them (idle + empty inbox
  never trips). T2: targeted ping-ACK to the suspect only. T3: alerts chief
  with the evidence chain (kickstart still manual). Built after two resident
  sessions went alive-but-unresponsive with green broker health and zero
  pending deliveries (cmo ignored an urgent brief ~50 min; relay sat on
  three unread orders ~75 min) — both were idle-sleeping, not spinning;
  delivery had simply stopped waking the session. Durable fix candidate
  filed with relay: broker-native session/responsiveness heartbeat surfaced
  in `node agent list` + health, and "delivered but never processed" as a
  first-class state in the wake-on-delivery design.

- **SEV-1: broker restarts can come up deaf-but-green — the watchdog's
  first catch.** 3 of 7 nodes restarting in one wave (burn, cloud, cpo) lost
  hosted→broker inbound delivery entirely — messages visible in Relaycast,
  0 pending at the broker, green health, idle PTYs, 2–4h deaf until the
  watchdog's T3 sweep paged chief. Suspect: hosted delivery session/cursor
  never re-binds to the restarted broker (relaycast delivery/cursor
  territory); broker health claiming a live link it lacks is a second
  defect. Filed via relay's issue batch. **Standing rule: every restart's
  verification includes an inbound-delivery proof** (test DM → non-empty
  read), not just health checks. Cloud's own unprocessed D1 decisions/orders
  re-deliver via its recovery, independent of this gap.

- **relayauth D1 is at capacity — live prod condition.** Rolling brownout,
  hard-stuck: the protected 14–90-day audit band grows monotonically, so GC
  structurally cannot win (policy problem, not throughput). Ownership:
  **Khaliq owns the durable fix** (the #2857 dormant-rebuild branch + #2847);
  cloud stood down from implementing archive-to-R2 and now does
  post-analysis on #2857 for Khaliq, assessing whether the dormant rebuild
  solves the capacity math. relayauth#70 (merged, 6c339af) types the
  capacity error but is inert in prod until cloud's D1 adapter translates it
  into the exported `StorageCapacityExhaustedError` (small required cloud
  PR, rides the same release+pin train). Cloud queue PRs
  #2864/#2865/#2869 are green-lit on green CI. Emergency bounded sweep is
  pre-authorized contingent on CF creds (GC-mode check first; comment
  intent on #2857 before executing). **Blocker on Will: all Cloudflare
  creds on this machine are dead** (env + .env tokens rejected, wrangler
  OAuth invalid) — `wrangler login` re-auth needed for telemetry +
  mitigation; PostHog MCP OAuth optional second. Will's relayfile retries
  flap on the 5-min GC windows until mitigated. Branch
  `agent/2857-relayauth-d1-rebuild-dormant` took 7 rapid "fix(relayauth)"
  commits from two bot identities (kjgbot, Miya) over one overnight window —
  reads like a CI gate failing repeatedly rather than steady progress; check
  PR/CI status before assuming it lands on its own. See [learnings] for the
  capacity rule.

- **Principal senses: email + Granola.** Chief gets read-only access to
  Will's email and Granola (meeting recaps + self-notes). Email path:
  relayfile Gmail provider (confirmed in catalog) → once provisioning heals,
  `relayfile integration connect gmail` OAuth → scoped mount in a second
  chief relayfile workspace (first slot is the GitHub tree). **Granola needs
  no build** — a first-party adapter ships (`@relayfile/adapter-granola`,
  catalog entry `granola`, Nango 5-min sync, notes + full transcripts +
  calendar/attendees into `/granola/notes/**` with by-day indexes). **Gate:
  Granola API keys need Business/Enterprise** — Will decides plan-upgrade
  vs. the free-tier fallback (official `granola-mcp`, OAuth, 30-day window,
  pull-only, no dogfood). Setup once gated through: Granola Settings →
  Connectors → API key (Personal-notes scope), `relayfile integration
  connect granola`, mount. Phase 2 (push, not just read): a workforce
  persona on the file.created trigger DMs chief summaries — needs a cloud
  deploy. Privacy rule (CLAUDE.md §6): transcripts/attendee text never enter
  the tracked brain.

- **cso watchlist is empty; seed corpus = #research-market.** Mounts into
  **cso's own** `senses/` (its own relayfile workspace; senses belong to the
  consuming department, which also keeps chief's one-mount slot for the
  GitHub tree). **Blocked:** `relayfile login --provision-messaging-only`
  fails server-side — `http 500: Failed to create workspace` from
  agentrelay.com/cloud; diagnosis subagent dispatched (suspect: handler on
  torn-down cloud/AWS infra). After the fix: Will's OAuth (~3 min) → mount →
  cso sweeps → dossiers. Interim habit: DM fresh finds to cso directly.

- **YC F26 decision due by 08-28** — applications submitted ~07-26 (YC on
  time, a16z Speedrun off-cycle for SR008). Watch for responses; see
  [fundraise-yc-a16z].

- **Interview-prep facts only Will can settle** — what an interviewer will
  probe: one ARR figure for Tailwind ("eight-figure" vs "~$7M" — drafts
  conflict, and the submitted application used one of them); the "agents"
  metric definition (active vs. created in window); money in bank + monthly
  spend (runway).

- **Credential rotation batch — deferred by Will** (revisit when relay's
  secrets platform fix lands, or on any sign of misuse; the leaked values
  remain live until then). Rotate together, then fix the platform leak: (1)
  `RELAY_BROKER_API_KEY` (`br_…`) — leaked into a transcript via a raw `env`
  dump. (2) The chief workspace key (`rk_live_…`) and chief agent token
  (`at_live_…`) — both embedded in the broker/claude process argv
  (world-readable via `ps`) and printed in plaintext by `agent-relay node
  up` into `~/Library/Logs/chief-node.log`; both landed in a
  restart-verification transcript. (3) The cloud access token (`cld_at_…`) —
  `agent-relay cloud session --json` prints it in plaintext; it landed in
  the senses-mount worker's transcript (rotate: `agent-relay cloud login
  --force`). Rotating alone is insufficient — the next boot re-leaks the new
  values. **Platform fix needed in relay:** pass workspace key/agent token
  via env or file instead of `--mcp-config` argv, redact key values from
  node/broker logs, and redact the token in `cloud session --json` (or gate
  behind an explicit flag). File as a relay issue. The July usage review's
  PostHog/Cloudflare/Neon credential findings and its `rk_live_` rotation
  recommendation fold into this same batch — verify all of it together when
  rotating. See [learnings] for the no-raw-env rule.

- **Workspace-deletion cascade bug — in cloud's queue.**
  `deleteWorkspaceCascade` (workspace-deletion.ts:75) never deletes the
  Relaycast side — every cloud-API deletion strands a live Relaycast
  workspace + valid rk_live_ key with no registry row. Fix order matters:
  Relaycast DELETE first (registry row is the key's only store). The
  diagnostic workspaces created during cleanup were deleted both-sides; the
  cso orphan below is the un-deletable example. Related CLI leak
  (`workspace active` prints the key in error output) is in relay's
  secrets-fix scope.

- **Orphaned auto-provisioned workspace `208248743547961344`.** cso's first
  `agent-relay node up` silently created a fresh workspace instead of
  joining the active one — the officer came up unreachable until chief's
  `workspace-key.json` was seeded into cso's state dir and the node
  rebooted. Cleanup: delete the orphan workspace (holds one stale cso
  registration). Relay issue candidate: first boot in a new repo should join
  the account's active workspace (or require an explicit choice), never
  silently mint a new one.

- **relayfile CLI gaps — filed.** `login --no-open` broken →
  relayfile#378; single `--remote-path` / no `--local-layout` →
  relayfile#379. Watch for fixes; #379 unblocks multi-subtree senses mounts
  without one-workspace-per-mount.
