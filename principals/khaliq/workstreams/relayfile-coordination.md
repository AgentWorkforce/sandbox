---
status: active
owner: relayfile-coordination-lead-0810
updated: 2026-08-10
repos: [relayfile, chief, relay]
---
# Relayfile coordination — shared repo files and context across nodes

**Goal:** an agent on any fleet node reads shared repo files and workstream
context through Relayfile, instead of Chief pasting file contents into DMs.

## Why this was opened — 2026-08-09, on Khaliq's instruction

**Chief spent a full day hand-pasting files because agents on other machines are
blind to anything not on their own disk.** Two leads reported themselves blocked
by exactly that: `sage-nightcto-lead` on `sf-mini` could not find its workstream
doc, and `herdr-lead-0809` on `barry` was told to ask Chief for content. **That
is a coordination failure with the product built to solve it** — the stated
differentiator is that the agent reads files regardless of upstream protocol,
mounting the live tree rather than cloning.

## Three verified defects

**1. The workspace registry contradicts itself.** `~/.relayfile/workspaces.json`
on Khaliq's laptop has ~20 entries. **`rw_7ccfea89` appears three times** with
different `localDir` — one `chief/.integrations`, one `None`. Six stale
`relayfile-*` entries point at `api.relayfile.dev`, several with `localDir:
None`.

**2. `barry` is configured against a dead server.** It names `relay-dev-collab`
at `http://100.89.219.17:8299`; **`curl` from `barry` returns HTTP 000** and the
mount dir has been empty since **2026-08-04**. The local `relayfile-server` on
`:18299` listens but answers `000` on `/health` and `/v1/workspaces`.

**3. `state.json` emits two shapes.** Consecutive reads alternate between one
carrying the `github` provider with `lastEventAt` frozen at
`2026-08-03T07:26:26Z`, and one **omitting the provider entirely with a fresh
advancing timestamp**. **Chief misreported "the feed moved" twice** off single
reads before anchoring on the provider entry. `bootstrap.phase` has read
`bootstrapping` for **~51 hours** with `filesSynced: 11919`.

**Hypothesis to test, not assume:** the duplicate `rw_7ccfea89` entries explain
the two-shape `state.json`. "Unrelated" is a real result.

## The coordination target

**`rw_7ccfea89` is served by `https://file.agentrelay.com`** — hosted, not a
local port. Cross-node sharing means remote agents mounting that, not reaching
this laptop.

**Definition of done for the sharing work: a specialist on a remote node reads a
file it demonstrably could not read before.** A config that looks correct is not
evidence.

## Standing hazard

**`com.agentworkforce.chief.integrations-mount` is the only thing serving the
chief mount.** Chief unloaded it on 2026-08-09 believing `chief-senses` was the
real supervisor; **the mount died within 2.5 minutes and had to be restored.**
`chief-senses`' relayfile holds **zero** open handles under `.integrations`.
Never restart it without telling Chief first.

## Next

1. Diagnose the two-shape `state.json` before changing anything.
2. Make the registry honest — one entry per id, correct `localDir`, stale
   entries removed. **Propose the diff before applying; keep it reversible.**
3. Prove cross-node mounting with a remote read that previously failed.
4. Recommend what to project. Senses carry `/linear`, `/github`, `/notion`,
   `/digests`; leads need workstream docs. **Chief's brain holds the principal's
   private profile — draw the confidentiality boundary explicitly.**

## History

- 2026-08-09 — Opened with a lead after a day in which cross-node context
  sharing was done entirely by hand. See [[active-lanes]].
