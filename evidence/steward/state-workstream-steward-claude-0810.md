# Workstream steward state — `workstream-steward-claude-0810`

Rewritten clean at 16:17Z (pass 13). Earlier passes are in git history if needed.
**COLLISION:** `steward-0810c` runs the same watch list and owns `state.md`.
Chief has never ruled on which of us stands down. Do not merge the two files blind.

---

## METHOD — the whole job. Read before measuring anything.

**`check_inbox` / `list_dms` are BROKEN** (relay#1471). They fail with a raw SQL error
that reads exactly like an empty inbox. Never use them.

`mcp__agent-relay__search_messages` has **ONE** real defect. I previously recorded four
here; `retrieval-lead-0810` red-checked all four against the installed 11.4.2 and
refuted three, and I re-verified the refutation myself. **The three retractions are
below — do not act on the old framing.**

1. **REAL — results are ranked by relevance (SQLite FTS5 `bm25()`) with no recency
   parameter, and `limit` truncates by rank.** The newest messages are often absent, so
   every timestamp you read is a **floor, never a maximum**. Use `limit ≥ 25` and sort
   by `createdAt` yourself. Prefer **single-term** queries.
2. **RETRACTED — "a junk/single-char query returns `[]` like silence."** Single-character
   queries work. `*` returns nothing because it is a literal text search and no message
   contains it. Correct behaviour.
3. **RETRACTED — "multi-word returns empties indistinguishable from silence."**
   Multi-word is **implicit AND**; an over-constrained query legitimately returns `[]`.
4. **RETRACTED — "the `channel` filter is blind to recent traffic."** It is not.
   `{channel:"general", query:"the", limit:15}` returned only old messages, but at
   `limit:60` the same query returns today's — including the two messages I had claimed
   were invisible. Five of sixty results were from today; ranking pushed them past 15.
   **I was watching defect 1 through a channel filter and calling it a new bug.**

**A lane came one step from switching the implicit AND to OR because of my report**,
which would have flooded every multi-word query with junk. Before reporting an
instrument defect, construct an input whose correct output you already know, and pick a
**discriminating** probe rather than a confirming one.

**Still true, and it is a METHOD error of mine rather than a tool defect:**
`{from: <lane>}` alone measures one side of a conversation. A blocked lane and a lane
deep in unreported work emit the same nothing. **Also search `{from: chief}` with a term
specific to that lane's topic, and ask what the lane was last *told*.** A brief ending
"produce an enumerated breaking-change surface" predicts hours of silence, and that
silence is compliance. This is why I called `relaycast-cloud-7` blocked five times after
chief had already unblocked it.

**Use `gh` as a second instrument.** `gh search prs --owner AgentWorkforce --updated
">=<ts>"`, `gh pr list --head <branch>`, `gh api .../branches`. A merged PR or a moved
branch is work product that cannot fail silently. This found the ownerless review
threads and the un-executed ruling.

**Never respawn a lane, or let anyone respawn one, on a silence measurement.** Only a
bracketed nonce round-trip proves liveness. Roster / `list_agents` / `spawned:true`
are not evidence in either direction.

**Clock:** read `date -u` every pass. Do not compute time by adding loop intervals —
mine drifted 10–13 min fast. This box is **UTC+2**; `git log --date=format-local`
renders local time. Use `%cI`.

**Remit:** observe and report. No dispatch, no code, no workstream edits, no merges.
**Never restart `chief-broker`** (11.4.2, no identity key, no way back).

---

## DIVISION OF LABOUR — proposed to chief 16:31Z, unruled

`steward-0810c` and I are not redundant, we are **differently blind**. Its findings all
come through relay; everything novel in mine since 14:49 came through `gh`. Proposed:
it owns relay liveness and nonce probes, I own GitHub artifacts and ruling-to-artifact
tracking, neither reports the other's plane. **Bar raised meanwhile: nothing to chief
unless novel on the GitHub plane or contradicting something already reported.**

**Check what a THIRD party has produced, not just both sides of one conversation.**
I reported factory-lead's unreachability at 16:02 as new; `spawn-liveness-diag-0810`
had diagnosed it at **13:41:42Z** — cloud record `fleet.nodeId=…126121984` (sf-mini)
vs a live PTY on chief-broker, so DMs keep `injectionMode=steer` but land `readers=[]`.
Same diagnosis also proved **steer IS honoured on 11.4.2** for correctly-bound agents,
and that the 12:33Z opencode steward did ~16 min of real work and parked exactly at its
outbound step. Recommended fix: new name on chief-broker, retarget the roster, **do not
reclaim the old name**.

Also from that agent, worth watching: **launchd maxfiles soft limit 256, broker at ~216
lsof rows (~84%), activeAgents=34, 0 crashes.** Mitigation is releasing completed
workers — not restarting anything.

## 🔴 OPEN — 8.0.0 shipped; the relaycast-cloud lane's brief is moot (reported 17:36Z)

`@relaycast/engine|types|a2a` **8.0.0 published 17:19:38Z**; `relaycast-cloud#55`
"bump @relaycast/* to 8.0.0" created 17:22:21Z and **merged 17:24:26Z, both by
khaliqgant**. main now pins `^8.0.0`. 6.3.2 was 08-02, 7.0.0 was 08-07.

- **`relaycast-cloud-7-lead-0810`'s deliverable — the 6.3.x→7.0.0 breaking surface —
  targets a version that was skipped.** Its silence is (correctly) read as deep work,
  which means it may be enumerating the wrong delta right now. Only chief can tell it.
- **A relaycast-cloud merge fires the SST production deploy** (chief's own brief). So
  this shipped. Principal's call, no gate violated.
- **relaycast#319 rode along**, carrying the unfixed empty-`?workspace=` guard into
  production. Severity unchanged — `cast.agentrelay.com` is multi-tenant, where the
  `limit(2)` fallback declines — but it now has a live instance and no owner.
- **The 0034-in-the-tarball question is now an 8.0.0 question** and does not transfer
  from the 7.0.0 `gitHead` reasoning for free.
- **Unowned:** "verify the live engine" and removing relay#1472's load shim. Until the
  shim comes out, relay#1445 still emits the false zero it was written to remove.

## ✅ CLOSED BY RULING — credentials in git history. DO NOT RE-RAISE.

**Khaliq ruled 2026-08-10 (chief `0d5f9a2`): `chief` is a private repo, the exposure is
ACCEPTED, no rotation.** Four reviewers were right on the facts and overruled on the
risk, which is the principal's call. Treat as a decided risk acceptance, not an open
finding. The detail below is history, kept only so nobody re-derives it.

**The one live consequence — merge `#28` with `--squash`.** `opencode.json` is absent
from the net diff (add and delete cancel), so squash keeps `261db56` off `main`, while
a merge-commit or rebase carries it onto `main` permanently. **That is currently a
convention, not a gate:** `AgentWorkforce/chief` has `allow_merge_commit: true` and
`allow_rebase_merge: true`, and #28 is `isDraft:false`, `CLEAN`, mergeable now — so the
green button offers all three methods. Khaliq accepted an exposure bounded to one
feature branch plus clones; a non-squash merge silently moves that boundary to `main`
forever, which is not what he was asked. Cheap fix: disable merge-commit and rebase on
`chief` until #28 lands. Reported 19:19Z; steward made no settings change.

## (historical) credentials in pushed git history — reported 17:05Z, now ruled

`chief` commit **`261db56`, 2026-08-08T21:29:27Z**, committed `opencode.json` with three
**literal** values (not `${...}` references): `RELAY_AGENT_TOKEN` (40 chars),
`RELAY_API_KEY` (40), `RELAY_WORKSPACES_JSON` (108, almost certainly embeds workspace
credentials). **Values never printed — names and lengths only.**

Chief untracked it at `7b63501` (16:29:44Z) and added `.gitignore:20`. That stops future
writes and **does not remove the blob** — `git cat-file -e 261db56:opencode.json`
succeeds, and `261db56` is pushed to `origin/chief/factory-allowlist-herdr-repos`.
~44h of exposure.

**The trap:** both commits are in `chief#28`'s commit list, but `opencode.json` is
**absent from that PR's "Files changed"** — add and delete cancel in the net diff. The
PR reads clean while the credentials are one `git show` away. Auditing by file list
clears it wrongly.

Bounded: `chief` is PRIVATE and `261db56` is **not** on `origin/main`. Repo-access
holders and anyone who cloned, not the public.

**ROTATE — that is the only reliable control.** Untracking, deleting and a clean
`git status` prove nothing; a credential is contained only once presented and
*refused*. History rewrite is secondary and risky (parallel agents hold working state
here; GitHub keeps unreachable objects addressable anyway). If `RELAY_WORKSPACES_JSON`
is the secret this fleet runs on, rotation is a coordinated fleet action, not a quiet
edit. Steward took no action beyond read-only inspection.

**Second-instance sweep, 17:22Z — none found; the chief case looks isolated.** Two
passes over 14 repos: tracked filenames matching credential shapes (all benign —
`.env.example`, SST *declarations* in `infra/secrets.ts`, docs, CI scripts, tests), and
a content scan of tracked files **at HEAD** for literal assignments of five named
variables. One hit, a fixture: `relay/tests/mcp_merge_e2e.rs`, 16-char `RELAY_API_KEY`
with a placeholder word beside a `tok_expired` fixture. **`relay/teams.json` is tracked
in a PUBLIC repo and is clean** — 563 bytes, no credential-shaped fields. Keep it that
way; CLAUDE.md makes that file authoritative for identity.
**Limits:** filenames + HEAD content + five variable names. No history scan outside
`chief`, and it would miss an innocuous filename, a PEM block, an AWS-style key or a
token in prose. This is "no second instance found by these two passes", NOT "clean".

## OPEN — as of 16:17Z

**Both parked-process wakes failed.** Chief wired the same falsifiable condition into
two wakes ten seconds apart — `factory-lead` 12:36:02Z, `marketing-lead` 12:36:12Z,
both "answer or I respawn you". Neither has produced anything in 3h41m (four and three
query terms respectively). `factory-lead`'s process is *known alive* — the 1449 proof
lane attached to it and painted a TUI ~12:01Z. So the DM is not reaching the harness's
input, or it is wedged behind something a DM cannot clear. Two for two = systematic.
**The named remedy is a no-op:** per chief's own 11:33Z finding, a duplicate-name spawn
on 11.4.2 returns `{spawned:true}` and launches nothing — and `factory-lead` is a
broker self-registration, the class where a re-registration mismatch burns the name.

**RESOLVED 18:44Z — `relayfile#413` opened.** Chief's 13:10:25Z ruling executed 5h34m
later. Meets every constraint: DRAFT, no labels, base `main` head `3e6ada31`, and the
flaky-test warning is the lead line in a blockquote. **One gap:** the body says "Tests
only" over a 2-file table, but the diff against `main` carries **23 files, +2616/-4** —
the branch was cut while the shared worktree sat on `evidence/mount-latency-one-way-20260807`,
so it inherits 20 files of the `mount-latency-20260807` evidence bundle plus a doc edit.
"Zero production changes" stays true and it is draft, so nothing is dangerous — but if
it is ever marked ready, that evidence bundle lands on `main` reviewed by nobody as
evidence. The author described the *commits*; the PR renders the *diff*.

**(historical) Chief's relayfile draft-PR ruling (13:10:25Z) had no live executor.** No relayfile PR
exists — none created today, `fix/relay-state-json-two-writers` tip unmoved at
`3e6ada31`. At 12:46:39Z, twenty-four minutes *before* the ruling, the lead released its
specialist: "Do NOT open one… Stand by or exit." The ruling landed on an empty chair.
Note the ruling contains its own gate — chief asked for the body text first — so the
ball may legitimately be with chief. "No PR" is a fact; "no answer" I cannot establish.

**ONE ownerless defect, not nine** (corrected 16:48Z — I over-counted at 15:04 by
treating a thread count as a defect count). Verified against merged code:
**#318's three current threads are all FIXED** — `data` and `metadata` are in
`VERBATIM_VALUE_KEYS` (`packages/sdk-typescript/src/casing.ts:46`) with a round-trip
test over a signed revocation list, and Swift `CoreMessagePayload` now carries
metadata (`packages/sdk-swift/Sources/Relaycast/Models.swift:607`). **#317's one
thread is a docs P3.** Only #319's empty-`?workspace=` truthiness guard survives.
**Unresolved counts unanswered, not unfixed — read the code before reporting a count.**

Detail below kept for the #319 reasoning:

**relaycast #317/#318/#319 all merged
14:00–14:13Z **by `khaliqgant`** (no merge-gate violation — the principal's own gate).
Unresolved-and-not-outdated: #317 one, #318 three, **#319 five**. On #319 the wide
disclosure finding IS answered in a deliberate code comment (`limit(2)`, fires only at
exactly one workspace, never crosses a tenant boundary, card unauthenticated by design).
The **narrow** one is NOT fixed and is on main: the guard
`!workspace && !c.req.query('workspace') && !c.req.param('workspace')` is a truthiness
test, so `?workspace=` yields `''`, passes, and the sole-workspace fallback fires.
cubic asked for a key-presence check. **Calibrate down, not up** — single-tenant only,
card public by design, so a contract defect rather than a disclosure.

**No ruling on the duplicate steward.** Recommended keeping `steward-0810c`.

**Blocked on Khaliq** (he was merging at 14:00–14:13, so he is reachable): relayfile
credential re-ruling (its hard condition is already false — a cloud session exists on
SF-Mac-Mini); daytona B-vs-C plus whether `DAYTONA_API_KEY` enters an agent env;
sage-nightcto park-or-run; lifecycle question 1 (CRE/preq, only Julian can define).

**Chief is handling** — do not duplicate: `soc2-lead-0810` (chief sent it a status
check at 15:29:41Z, unanswered as of 16:17Z).

---

## CLOSED — do not re-report

- **`relaycast-cloud-7-lead-0810` is NOT blocked.** Chief unblocked it at 12:50:23Z with
  raw probe output. I wrongly called it blocked five times because I never checked
  chief's outbound. Its silence is a multi-hour enumeration with no interim artifact.
  My "resolving" evidence was also the exact inference chief had warned it against: the
  7.0.0 publishes carry `gitHead 41bb8bcd`, 0034 sits on `origin/main` at the later
  `7121d04`, so **the repo having the migration says nothing about the tarball**.
- **There was no fleet-wide stop.** My 14:22 alarm was false and retracted at 14:33.
- **`agent-lifecycle-workflows.md` is not a missing Next** — content under a stale
  gating clause; its lead had already reported the frontmatter.
- **pr-shepherd's `check_run` manifest gap** — the lane withdrew it itself at 12:58 as a
  nice-to-have, not a blocker.
- **Chief's #general staleness table is superseded** — all seven repos were pulled to
  `origin/main` at ~13:29Z and now match. Rules 1 and 2 (isolated clone, report the SHA)
  stand; rule 3 ("do not `git pull` the shared checkouts") is contradicted by chief's
  own pull, which did find live untracked work — backed up at
  `cloud/.local-persona-backup-20260810/`.

---

## Quiet is not a stall right now

No org PR updated since 15:09Z. That is the **expected** shape: the #1382 lane was told
to produce a diff and not push, and design work produces no artifacts. Do not report
absence as an event. After 14:22 I call nothing from absence.
