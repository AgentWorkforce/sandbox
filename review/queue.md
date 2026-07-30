# Review queue — items needing Will

One entry per item. Items enter ONLY through the chain (lead → head →
department → chief) after the team has fully processed them — an entry
means "the org has done everything it can; your call changes what happens
next." Chief is the sole writer; verdicts arrive as dashboard clicks
(relayed to chief as DMs) or in conversation, and chief executes + marks
cleared. Statuses: pending → cleared(approved | rejected | answered).

## RQ-1: Cloudflare re-auth (unblock)
- status: pending
- date: 2026-07-29
- from: cloud → chief (live prod incident)
- ask: run `wrangler login` (browser, ~2 min) — every CF credential on
  this machine is dead.
- why-you: only you can OAuth.
- on-done: unblocks D1 fill telemetry + the pre-authorized emergency
  sweep for the relayauth capacity incident; also PostHog MCP OAuth as an
  optional second.

## RQ-2: GitHub integration reconnect on rw_7ccfea89 (unblock)
- status: pending
- date: 2026-07-29
- from: burn → cpo → chief
- ask: repair/reconnect the GitHub relayfile integration on the "Default"
  Relay workspace (~3 min browser).
- why-you: workspace owner; agent identities are forbidden from SDK
  reconnect.
- on-done: burn's factory issue-discovery loop goes live — label an issue
  `factory` and it runs to a reviewed PR.

## RQ-3: relayfile provisioning retry (unblock)
- status: pending
- date: 2026-07-29
- from: cso/senses-mount → chief
- ask: `relayfile login --provision-messaging-only` then
  `relayfile integration connect slack` (retry on 500 — it flaps in
  ~5-min windows until the D1 capacity fix).
- why-you: browser OAuth.
- on-done: cso's watchlist seeds from #research-market; chief's GitHub
  senses follow; gmail/granola connects become possible.

## RQ-4: Granola plan tier (decision)
- status: pending
- date: 2026-07-29
- from: chief (granola-senses research)
- ask: upgrade Granola to Business (API keys → full transcript pipeline +
  push phase) or stay free-tier (MCP fallback: 30-day window, pull-only,
  no dogfood)?
- recommendation: upgrade if cost is tolerable — meetings/self-notes are
  chief's biggest blind spot and the push phase only exists on that path.

## RQ-5: Interview-prep facts (input)
- status: pending
- date: 2026-07-29
- from: coo workstream (YC decision due by 08-28)
- ask: three facts only you hold — the Tailwind ARR figure that shipped
  in the application ("eight-figure" vs "~$7M"), the "agents" metric
  definition (active vs created), runway (bank + monthly spend).
- on-done: answers land in coo's interview-prep file, not chief's brain.
