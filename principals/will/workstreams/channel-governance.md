---
status: active
tldr: "Adaptive channel-membership rules go into the c2a protocol itself, with best practices and a periodic burn-informed review."
card: "Channel Governance"
owner: chief
updated: 2026-08-02
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

**Now:** hard rule is in force ahead of the protocol work
(Will, 2026-08-02): voice-class agents are @mention-only in channels;
#general is reserved for truly company-wide notices only (system incidents,
policy changes, org-wide ask/decision); routine project or repo updates must be in
dedicated narrow-membership workstream channels. This is not advisory: if you are
about to post project-specific detail, move it off #general first.

If a workstream has no suitable channel, create one before posting routine status
there.

Recorded in preferences and now elevated from "interim" to active operating
behavior until c2a recon lands the protocol-native mechanism.

**Next:** (1) recon the c2a repo — what the protocol
currently says about channels/membership; (2) proposal draft: protocol
additions (membership criteria, join/leave semantics, broadcast scoping
so voice-class agents stop drowning in #general), org conventions, and
the review cadence design — **design requirement from
head-of-ecosystem (2026-08-02): scoping must preserve a path for a
finding to reach seats whose relevance nobody predicted.** The
2026-08-02 cross-department #general thread was noise by the new rule
AND produced the day's best corrections (the 422 finding, the
.commit.oid discriminator, two same-hour retractions) — from exactly
the seats a narrow channel would not have invited. Naive scoping fixes
the noise and removes the correction path; the proposal must do both; (3) ownership call — c2a spec changes sit in
the relay/protocol family (Relay Product Owner or a c2a seat), org
conventions are chief's, the review may extend the watchdog/groom
pattern with burn data.

## History
- 2026-07-30 — Opened from Will's ask through the voice — the voice/brain
  loop's first workstream.
