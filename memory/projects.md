# Projects — durable facts

Repo topology: `../CLAUDE.md` (authoritative, don't duplicate). Live workstream
state: `workstreams/`. This file holds product-level facts that outlive any one
workstream.

- **Agent Relay** is the product: messaging/orchestration for coding agents
  ("Slack for agents"). Pre-launch — no back-compat obligations; data-breaking
  changes acceptable when stated.
- **chief (this repo)** restarts the chief-of-staff effort app-less. chief-app
  proved the persona and brain conventions but drifted into building Mac/iOS
  clients; unparked under cpo as a native-client project ([chief-app]),
  strictly a client of this brain, never a second brain. Brain = markdown in
  git; mechanics belong in platform components, never here.
- **Platform primitives chief depends on** (each is a PR against the owning
  repo, not tubing in this one):
  1. **wake-on-delivery** (relay/relaycast) — spawn a registered-but-offline
     agent on its home node when a durable delivery lands. Keystone: makes
     "wake the team" = "send a message". Currently messages queue 1h then
     dead-letter, and channel-mention triggers can spawn but DMs fire nothing.
  2. **agent directory over MCP** (relaycast) — FTS directory + capability
     routing exist server-side and auto-populate from metadata.skills; not
     exposed as MCP tools yet. `teams.json` needs a description/skills field.
  3. **relaycron message transport** — "at 9am, DM chief" as a schedule target;
     composes with wake-on-delivery to make any agent proactive.
- **relayfile is senses, not brain — and senses belong to the consuming
  department:** each department repo mounts its own domain data under its
  own `senses/` via its own relayfile workspace (which is also the
  workaround for the one-mount-per-workspace limit). Chief's slot stays
  reserved for cross-repo digest senses (GitHub org tree). Conclusions stay
  in local markdown; mounts scoped tight with `--remote-path`.
- **Topology fact:** one broker per repo (broker cwd fixed at launch; node id
  hashes cwd). Chief's broker lives here; each repo team gets its own.
- **GTM pair:** `scout` (Relay Scout, developer CRM — crew agents research and
  draft, a human sends every message) is the reference implementation;
  `cmo` (GTM workbench — metrics agent + strategy docs) points at it. cmo's
  old SST/AWS CRM was deleted 2026-07-20 as a duplicate of scout; recover
  from pre-reset git history if ever needed.
- **Org hierarchy:** Will → chief → C-level department agents, each with its
  own repo/broker; instruments live under departments. Seated so far:
  **cmo** (GTM lead; scout is its instrument — both targeting motions,
  OSS-dev engagement and affiliate/paid-promo targets on X/LinkedIn, are
  scout campaigns, never rebuilt in cmo), **coo** (business operations —
  investor/accelerator applications first; mandate YC + a16z Speedrun; named
  coo rather than cto since "cto implies technical"), **cso** (Chief
  Strategy Officer — market research & competitive intel: watchlist
  dossiers, competitor deep-dives via the `competitor-deep-dive` skill,
  partnership scoring handed to cmo; never outreach, never executes
  third-party code locally), and **cpo** (Chief Product Officer — product
  direction memos in `direction/`; two manager agents share the cpo
  repo/roster under it: **head-of-ecosystem** runs the Agent Relay
  ecosystem projects — chief-app, burn (which also owns `../factory`),
  relaycron-cloud, mobile, relayfile, parked marquee — and
  **head-of-experiments** runs
  non-OSS-core side projects — notesnumber (inside `../ladd`) and
  hoopsheet (`../hoopsheet`; both inherit the parent conventions).
  File-ownership partition in the cpo repo: `direction/` = cpo alone;
  `ecosystem/` and `experiments/` = each head alone. The **relay core
  product seat is "Relay Product Owner" under head-of-ecosystem** (Will,
  2026-07-29 — moved from chief-direct; cloud remains chief-direct
  through the teardown). Chief dispatches to department leads; chief's
  own subagents cover only what has no department yet.
