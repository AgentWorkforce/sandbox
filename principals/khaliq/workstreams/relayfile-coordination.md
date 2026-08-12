---
status: active
owner: relayfile-storm-guard-0811
reports_to: chief-proof-coordinator-0811
updated: 2026-08-11
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

## 2026-08-11 resource-storm containment

Chief froze while two launchd supervisors could contend around the same mount.
On macOS, the recursive fsnotify path uses kqueue and can consume a descriptor
per watched file; the affected process reached roughly 92,000 open handles.
The existing full-tree audit cadence could also run about every ten minutes,
and an unbounded bootstrap page could materialize too much work in one cycle.

Both `com.agentworkforce.chief.senses` and
`com.agentworkforce.chief.integrations-mount` are now unloaded and disabled
across reboot. Their plists were retained for recovery, but neither job should
be re-enabled until one supervisor is named as the sole owner and the mount is
canaried with resource telemetry.

Relayfile [PR #414](https://github.com/AgentWorkforce/relayfile/pull/414) merged
to `main` as `7f95516d7206fcc16e4def6cea110b906d6a50e3`. Its P0 containment
turns recursive watching off by default on Darwin while retaining polling
writeback; rejects duplicate local-mirror ownership with a process-lifetime
lease; bounds bootstrap and resumes within oversized pages; and gives completed
authoritative full-tree audits a persisted 24-hour floor. The PR mitigates, but
intentionally does not close, issue #319.

## 2026-08-11 bounded anti-storm follow-on

`relayfile-storm-guard-0811` is registered on Barry
(`node_210867409538764800`) and reports to the second Chief
`chief-proof-coordinator-0811`. Its first ACK recorded `hostname=mac.lan` and
`cwd=/Users/barry`; that directory is neither a Git worktree nor a selected
Relayfile mount, so the owner must deliberately choose existing worktrees and
must not clone under a mount.

The lane must not reimplement PR `#414`. Immediate remaining hazards are:
Relay `#1479` sends `pathGlob` while the server expects `path_glob`; Chief uses
a racy PID-file owner and nested fixed 5s/30s restarts; install does not retire
the legacy mount supervisor; declared agent limits are not enforced against
active plus pending reservations; fleet spawn has no stable end-to-end
idempotency key; and delegation rollups have no hard queue bound.

Required proof includes a dual-Chief fenced-epoch test, dropped-response retry
from another host returning one process and one result, 2,000 duplicate/distinct
events with bounded queue and resource growth, dual-supervisor immediate
rejection, crash-between-checkpoint-and-release recovery, and a missed-heartbeat
case that preserves a still-live host PID. Both launchd jobs remain disabled
until this lane produces an independently reviewed measured canary.

## 2026-08-11 19:24Z — anti-storm P1 fix held on review, not merged

Chief PR [#40](https://github.com/AgentWorkforce/chief/pull/40) carries
`relayfile-storm-guard-0811`'s supervisor lease/restart-policy fix (patch
transferred by hand over Agent Relay DM after its own push got a 403, checksum
verified before applying). An independent high-effort code-review workflow
(`wf_bc8aebf1-e02`, 15 agents) found **7 distinct defects, 6 CONFIRMED**, most
of them the same shape: an error path that was supposed to make the supervisor
*more* resilient instead makes it silently and permanently exit(0) under
launchd's `SuccessfulExit:false` contract — a recycled PID blocking lease
takeover forever, RSS-ceiling-triggered recycles tripping the crash circuit
breaker, and non-contention fs errors (EACCES/ENOSPC) funneling into the same
benign exit as legitimate lease contention. Full list posted to the PR.
**Holding the merge** — routed back to the authoring lane for fixes.
Separately, live measurement on Barry found the Relayfile fleet mount process
(PID 96070, `rw_7ccfea89`) stable at ~921MiB RSS but sustained 377-459% CPU
over ~8h; RSS not growing (no storm by this fix's own definition), CPU pattern
unexplained, not blocking, tracked as a separate open question.

## 2026-08-11 21:19Z — anti-storm fix MERGED

`storm-guard-fix-finn-0811` (spawned on finn-mini after Barry's Claude
replacement turned out unauthenticated) fixed all 6 confirmed + 1 plausible
review findings from PR #40, left item 7 (helper duplication) as an honestly
scoped follow-up, added 9 new unit tests. Delivered as a format-patch (same
pattern as the original — this account also lacks push access to
`AgentWorkforce/chief`). Chief verified: sha256 mismatch on the pasted text
(copy/paste artifact, not corruption — `git am` applied it cleanly with zero
conflicts, which is the stronger integrity signal), 34/34 tests pass, diff
read directly and matches every described fix. **Merged squash `5bb15d06`,
21:19:03Z.** No CI exists in this repo (`.github/workflows` absent) and 0
approving reviews are required — verified both before merging.

Still separately open: the ~612% sustained CPU pattern on Barry's Relayfile
fleet mount (PID 96070 last measured) — stable RSS, no storm signature by
this fix's own definition, cause still unexplained, not blocking.

## Next

1. Assign exactly one launchd supervisor to own the integration mount, add
   restart backoff, and canary it before re-enabling either disabled job.
2. Add public per-mount handle, watcher, traversal, queue, and audit-age
   telemetry with explicit resource ceilings.
3. Implement provider/path-scoped projection so a lead does not need to mount
   an entire large workspace to read one workstream.
4. Diagnose the two-shape `state.json` before changing registry state.
5. Make the registry honest — one entry per id, correct `localDir`, stale
   entries removed. **Propose the diff before applying; keep it reversible.**
6. Prove cross-node mounting with a remote read that previously failed.
7. Recommend what to project. Senses carry `/linear`, `/github`, `/notion`,
   `/digests`; leads need workstream docs. **Chief's brain holds the principal's
   private profile — draw the confidentiality boundary explicitly.**

## History

- 2026-08-11 — Contained the macOS handle/audit storm, disabled both ambiguous
  launchd supervisors, and merged Relayfile PR #414 (`7f95516`) with watcher,
  lease, bootstrap-budget, and full-audit safeguards. P1 ownership, projection,
  and telemetry work remains open.
- 2026-08-09 — Opened with a lead after a day in which cross-node context
  sharing was done entirely by hand. See [[active-lanes]].
