# Open threads

- **Fleet liveness watchdog runs tiered and alert-only (v1).** T1 (every
  10 min, zero-token): trips only when a resident has unread-stale messages
  addressed to it AND lastSeen predates them (idle + empty inbox never
  trips). T2: targeted ping-ACK to the suspect only. T3: alerts chief with
  the evidence chain (kickstart still manual). Guards against residents
  going alive-but-unresponsive with green broker health and zero pending
  deliveries — delivery simply stops waking the session. Durable fix
  (broker-native session/responsiveness heartbeat in `node agent list` +
  health, and "delivered but never processed" as a first-class
  wake-on-delivery state) is filed with relay, not yet built.

- **Broker restarts can leave nodes alive-but-deaf, not frozen.** Hosted→
  broker inbound delivery can die on restart while everything looks healthy
  — messages visible in Relaycast, 0 pending at the broker, green health,
  idle PTYs; the session is alive but never gets woken. Kickstarts do not
  durably cure it — a node can refreeze immediately after recovery; some
  nodes rebind on restart, some never do. Suspected cause: hosted delivery's
  session/cursor doesn't re-bind to the restarted broker (relaycast
  delivery/cursor territory); broker health falsely reporting a live link is
  a second defect. **Pull works while push is dead** — the confirmed
  workaround is drive-attach nudges instructing sessions to check_inbox and
  a 15-min pull cadence (session-scoped — lost on respawn until the
  platform fix lands). Filed: **relay#1386** + **#1387** (session-liveness).
  **ROOT-CAUSED 2026-07-30 — deterministic repro (36/36), four composing
  defects, posted on #1386:** dead sockets never superseded (NodeDO); the
  new broker's one-shot node.register swallows a 409
  provider_instance_conflict (35s liveness window = the restart
  roulette); **permanent agent-row poisoning** (provider_name='default' —
  why kickstarts never cured burn; prod may hold poisoned rows needing a
  DATA repair, not just code); hosted cursor negotiation silently
  unimplemented. Owner: Relay Product Owner, RFC-first, after the release
  package. The repro also found **--workspace-key not honored** (cloud
  session follow-user scope silently re-homes brokers to prod) — filed
  separately as a prod-safety bug.
  **Standing rules: restart verification requires an inbound-delivery
  proof (test DM → non-empty readers or backlog-referencing outbound);
  the 15-min pull cadences are RETIRED (token furnace) — watchdog-
  triggered nudges are the workaround until the fix.**

- **relayauth D1 is at capacity — live prod condition, structurally
  unwinnable by GC alone.** The protected 14–90-day audit band grows
  monotonically, so garbage collection can't keep pace (a policy problem,
  not a throughput one). **Khaliq owns the durable fix** (the #2857
  dormant-rebuild branch + #2847); cloud stood down from implementing its
  own archive-to-R2 and does post-analysis on #2857 for Khaliq instead.
  relayauth#70 (merged) types the capacity error but stays inert in prod
  until cloud's D1 adapter exports `StorageCapacityExhaustedError` (a small
  cloud PR riding the same release train). Cloud's queued PRs
  (#2864/#2865/#2869) are green-lit on green CI. An emergency bounded sweep
  is pre-authorized contingent on CF creds (GC-mode check first; comment
  intent on #2857 before executing). **Blocker on Will: all Cloudflare
  creds on this machine are dead** — `wrangler login` needs re-auth for
  telemetry and mitigation (PostHog MCP OAuth is a secondary, optional
  fix). Until mitigated, Will's relayfile retries flap on the 5-min GC
  windows. Branch `agent/2857-relayauth-d1-rebuild-dormant` gets frequent
  bot commits (kjgbot, Miya) — check PR/CI status rather than assuming it's
  converging on its own. See [learnings] for the capacity rule.

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

- **cso watchlist is empty, blocked on relayfile provisioning.** See
  [cso-research] for the seed plan and [relayfile-cutover-tails] for the
  provisioning-500 fix now owned by the relayfile lead. Interim: DM fresh
  finds to cso directly.

- **YC F26 decision due by 08-28** — applications submitted ~07-26 (YC on
  time, a16z Speedrun off-cycle for SR008). Watch for responses; see
  [fundraise-yc-a16z].

- **Interview-prep facts only Will can settle** — what an interviewer will
  probe: one ARR figure for Tailwind ("eight-figure" vs "~$7M" — drafts
  conflict, and the submitted application used one of them); the "agents"
  metric definition (active vs. created in window); money in bank + monthly
  spend (runway).

- **Credential exposure — split disposition under the updated key policy.**
  The chief workspace key (`rk_live_…`) and agent token (`at_live_…`) —
  exposed via broker/claude process argv, `agent-relay node up` plaintext
  into `~/Library/Logs/chief-node.log`, and transcripts — are **not an
  incident** under current policy (see [preferences]): periodic workspace
  refresh applies, not emergency rotation. Still open, as genuinely
  privileged secrets: (1) `RELAY_BROKER_API_KEY` (`br_…`) — leaked into a
  transcript via a raw `env` dump, not yet rotated. (2) The cloud access
  token (`cld_at_…`) — `agent-relay cloud session --json` prints it in
  plaintext (landed in the senses-mount worker's transcript); rotate via
  `agent-relay cloud login --force`. Rotating alone is insufficient while
  `cloud session --json` keeps printing it — the next session re-leaks it.
  **Platform fix still needed in relay:** redact `RELAY_BROKER_API_KEY` from
  any log/dump path, and redact the token in `cloud session --json` (or
  gate behind an explicit flag). File as a relay issue. See [learnings] for
  the no-raw-env rule.

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

- **Khaliq's team joining the workspace (2026-07-30):** runbook ready at
  `docs/onboarding-khaliq.md` (commands live-verified, sharp edges
  #1378/#1386/#1388/#1393 documented — the #1393 `workspace switch` step
  is load-bearing). Will's part: send Khaliq the file + workspace key via
  a private channel; tell chief when his first seat boots so it joins the
  chart + watchdog. First two-human workspace when it lands.
