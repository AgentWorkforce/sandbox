---
status: active
tldr: "Adaptive channel-membership rules go into the c2a protocol itself, with best practices and a periodic burn-informed review."
card: "Channel Governance"
owner: chief
updated: 2026-07-30
repos: [c2a, chief]
---
# channel governance — adaptive rules in c2a

**Goal:** agents aren't in channels they don't need. Will (2026-07-30,
via the voice — its #general flooding was the trigger): **adaptive rules
in the c2a protocol** (github.com/AgentWorkforce/c2a, "Chat 2 Agents
Protocol") governing channel membership — explicitly NOT hard caps and
NOT passive dashboards/alerts — plus documented best practices for
creating/using channels, plus a **periodic review** cadence (mechanism
open; burn-data-informed is the natural candidate) to catch drift.

**Now:** the fleet restart has landed; c2a recon not yet started.

**Next:** (1) recon the c2a repo — what the protocol
currently says about channels/membership; (2) proposal draft: protocol
additions (membership criteria, join/leave semantics, broadcast scoping
so voice-class agents stop drowning in #general), org conventions, and
the review cadence design; (3) ownership call — c2a spec changes sit in
the relay/protocol family (Relay Product Owner or a c2a seat), org
conventions are chief's, the review may extend the watchdog/groom
pattern with burn data.

## History
- 2026-07-30 — Opened from Will's ask through the voice — the voice/brain
  loop's first workstream.
