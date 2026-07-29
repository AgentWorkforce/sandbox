# Projects — durable facts

Repo topology: `../CLAUDE.md` (authoritative, don't duplicate). Live workstream
state: `workstreams/`. This file holds product-level facts that outlive any one
workstream.

- **Agent Relay** is the product: messaging/orchestration for coding agents
  ("Slack for agents"). Pre-launch — no back-compat obligations; data-breaking
  changes acceptable when stated.
- **chief (this repo)** restarts the chief-of-staff effort app-less. chief-app
  proved the persona and brain conventions but drifted into building Mac/iOS
  clients; parked deliberately 2026-07-29. Brain = markdown in git; mechanics
  belong in platform components, never here.
- **Platform primitives chief depends on** (each is a PR against the owning
  repo, not tubing in this one):
  1. **wake-on-delivery** (relay/relaycast) — spawn a registered-but-offline
     agent on its home node when a durable delivery lands. Keystone: makes
     "wake the team" = "send a message". Today messages queue 1h then
     dead-letter, and channel-mention triggers can spawn but DMs fire nothing.
  2. **agent directory over MCP** (relaycast) — FTS directory + capability
     routing exist server-side and auto-populate from metadata.skills; not
     exposed as MCP tools yet. `teams.json` needs a description/skills field.
  3. **relaycron message transport** — "at 9am, DM chief" as a schedule target;
     composes with wake-on-delivery to make any agent proactive.
- **relayfile is chief's senses, not its brain**: GitHub PRs, Slack, Notion
  projected as files under `senses/`; conclusions stay in local markdown.
  Mounts scoped tight with `--remote-path` allowlists.
- **Topology fact:** one broker per repo (broker cwd fixed at launch; node id
  hashes cwd). Chief's broker lives here; each repo team gets its own.
- **GTM pair:** `scout` (Relay Scout, developer CRM — crew agents research and
  draft, a human sends every message) is the reference implementation;
  `cmo` (GTM workbench — metrics agent + strategy docs) points at it. cmo's
  old SST/AWS CRM was deleted 2026-07-20 as a duplicate of scout; recover
  from pre-reset git history if ever needed.
- **Org hierarchy (confirmed 2026-07-29):** Will → chief → C-level department
  agents, each with its own repo/broker; instruments live under departments.
  Seated so far: **cmo** (GTM lead; scout is its instrument — both targeting
  motions, OSS-dev engagement and affiliate/paid-promo targets on X/LinkedIn,
  are scout campaigns, never rebuilt in cmo) and **coo** (business
  operations — investor/accelerator applications first; mandate YC + a16z
  Speedrun; renamed from cto 2026-07-29 because "cto implies technical").
  Chief dispatches to department leads; chief's own subagents cover only
  what has no department yet.
