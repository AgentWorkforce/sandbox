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

**Now:** Phase 2 in progress. Phase 1 shipped 2026-07-29 (brain scaffolded:
persona, memory, journal backfilled Dec 2025–Jul 2026, workstreams,
/retro /status /digest). Broker is up in this repo and chief runs as a
resident relay agent — registered, posting to #general, DM-able.

**Next:** the two remaining Phase 2 legs — `senses/` mount of
GitHub/Slack/Notion from hosted relayfile (Gate 3 is done), and a scheduled
daily /digest (launchd until relaycron has a message transport).

## History
- 2026-07-29 — Chief came online as a durable relay agent for the first time:
  session-start ritual from files alone, readiness posted to #general,
  resident on DMs.
- 2026-07-29 — Repo restarted app-less, superseding chief-app (parked with
  M0–M2 shipped and a headless pivot uncommitted). Design: markdown brain
  here, mechanics as platform PRs (see agent-org-primitives).
