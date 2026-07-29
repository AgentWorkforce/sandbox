---
status: active
owner: chief
updated: 2026-07-29
repos: [chief]
---
# Chief — the chief-of-staff agent

**Goal:** Will talks only to chief; chief knows past (retros), present
(workstreams), and future (next steps) across the whole ecosystem, and
delegates real work to repo agents over Agent Relay.

**Now:** Phase 1 shipped 2026-07-29 — brain scaffolded (persona, memory,
journal backfilled Dec 2025–Jul 2026, workstreams, /retro /status /digest),
purely interactive.

**Next:** Phase 2 — broker up in this repo (`teams.json` autoSpawn), chief as
a durable relay agent DM-able from anywhere; `senses/` mount of
GitHub/Slack/Notion from hosted relayfile (Gate 3 is done); scheduled daily
/digest (launchd until relaycron has a message transport).

## History
- 2026-07-29 — Repo restarted app-less, superseding chief-app (parked with
  M0–M2 shipped and a headless pivot uncommitted). Design: markdown brain
  here, mechanics as platform PRs (see agent-org-primitives).
