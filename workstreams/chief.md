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

**Senses leg is blocked on Will** (senses-mount worker report, 07-29): no
Relayfile-backed workspace exists — chief-dev is messaging-only. Unblock is a
~3-min browser task: `relayfile login --provision-messaging-only`, then
`relayfile integration connect github|slack|notion`. Worker standing by to
mount and verify. Scoping decision (chief, 07-29, revised same day): the
shipped CLI takes a single `--remote-path`, so mount one tight subtree — and
the first subtree is now the **#research-market Slack channel** (Will: years
of shared products/links, the cso watchlist seed corpus), not the GitHub
tree. Worker resolves the exact `/slack/...` path. The multi-allowlist brief
becomes a relayfile CLI issue (expose repeated `--remote-path` /
`--local-layout`). Once mounted: sweep channel history → dedupe links →
batch-DM targets to cso for dossiers; ongoing intake = mount + scheduled
sweep once relaycron transport lands.

## History
- 2026-07-29 — Chief came online as a durable relay agent for the first time:
  session-start ritual from files alone, readiness posted to #general,
  resident on DMs.
- 2026-07-29 — Repo restarted app-less, superseding chief-app (parked with
  M0–M2 shipped and a headless pivot uncommitted). Design: markdown brain
  here, mechanics as platform PRs (see agent-org-primitives).
