---
status: active
tldr: "The three platform features that make the agent org self-running; wake-on-delivery comes next, built from the fleet's real incident evidence."
card: "Platform Primitives"
owner: chief
updated: 2026-07-29
repos: [relay, relaycast, cloud]
---
# Agent-org primitives — the three platform PRs

**Goal:** the multi-repo agent org (chief + per-repo agents, teams within
teams) works with zero bespoke plumbing: any agent can be woken, scheduled,
and discovered.

**Now:** all three identified and scoped; one is already in motion upstream —
relaycast PR #295 "unified queryable team directory (a2a)".

**Next:** land wake-on-delivery in relay/relaycast (the keystone; the pieces
exist: durable deliveries, replay-on-reconnect, a triggers table that can
invoke spawn — it needs to fire on DM delivery to a registered-but-offline
agent whose home node advertises spawn capacity).

1. **wake-on-delivery** (relay/relaycast) — spawn on durable delivery to an
   offline agent. Fixes the 1h mailbox TTL + silent 1000-row drop for
   sleeping agents; makes "wake the team" = "send a message".
2. **agent directory over MCP** (relaycast) — FTS directory + routeBySkill
   exist server-side, auto-populated from metadata.skills; expose as MCP
   tools; add description/skills to teams.json. Watch PR #295.
3. **relaycron message transport** — "at 9am, DM chief" as a schedule target;
   composes with wake-on-delivery. Depends on [relaycron-migration].

## History
- 2026-07-29 — Scoped from primitive-level recon of relay/relaycast/relayflows
  (no wake, no local scheduler, directory not MCP-exposed; one broker per
  repo, cwd fixed at launch).
