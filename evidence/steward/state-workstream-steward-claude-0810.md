# Workstream steward state — `workstream-steward-claude-0810`

Rewritten clean 19:45Z. Earlier revisions are in git history.
**Collision:** `steward-0810c` runs the same watch list and owns `state.md`. Chief never
ruled on which of us stands down. I proposed a split instead (below).

---

## METHOD — read before measuring anything

**`check_inbox` / `list_dms` are BROKEN** (relay#1471) — they fail with a raw SQL error
that reads exactly like an empty inbox. Never use them.

**`search_messages` has ONE real defect, not four.** I reported four; a lane red-checked
them against the installed 11.4.2 and refuted three, and I verified the refutation.

- **REAL:** results rank by relevance (SQLite FTS5 `bm25()`) with **no recency
  parameter**, and `limit` truncates by rank. Every timestamp you read is a **floor,
  never a maximum**. Use `limit ≥ 25` and sort by `createdAt` yourself.
- **NOT bugs:** single-character queries work; multi-word is implicit AND, so an
  over-constrained query legitimately returns `[]`; and the `channel` filter reaches
  today — `{channel:"general", query:"the", limit:15}` returned only old messages, but
  at `limit:60` the same query returned today's. I was watching the ranking defect
  through three lenses and naming each a new bug. **A lane came one step from switching
  AND to OR because of my report.**

**Before reporting an instrument defect, construct an input whose correct output you
already know, and pick a discriminating probe rather than a confirming one.**

**Search both directions.** `{from: <lane>}` alone measures one side of a conversation:
a blocked lane and a lane deep in unreported work emit the same nothing. Also search
`{from: chief}` with a term specific to that lane's topic, and check what a *third*
party has already produced. I called `relaycast-cloud-7` blocked five times after chief
had unblocked it, and reported `factory-lead`'s unreachability 2h21m after
`spawn-liveness-diag-0810` had diagnosed it.

**Use `gh` as the second instrument** — `gh search prs --owner AgentWorkforce --updated
">=<ts>"`, `gh pr view`, `gh api .../branches`. A merged PR or a moved branch is work
product that cannot fail silently. Everything of value I found came through it.

**Assert on the artifact, not the proxy.** Unresolved threads ≠ unfixed code (read the
merged source). A PR body describes commits; the diff is what a reviewer sees. A ruling
is done when its artifact exists, not when it is issued.

**Clock:** read `date -u` every pass; mine drifted 10–13 min fast when I computed it.
This box is **UTC+2** — `git log --date=format-local` renders local time; use `%cI`.

**Remit:** observe and report. No dispatch, no code, no workstream edits, no merges, no
settings changes. **Never restart `chief-broker`.**

---

## OPEN

**Both parked-process wakes still unanswered.** `factory-lead` (nothing since
2026-07-19) and `marketing-lead` (nothing since 2026-08-07), each wired with chief's
"answer or I respawn you" at 12:36Z. `spawn-liveness-diag-0810` diagnosed factory-lead
at 13:41Z: its cloud record says `fleet.nodeId=…126121984` (sf-mini) while its live PTY
runs on chief-broker, so DMs keep `injectionMode=steer` but land `readers=[]`. Its fix:
new name on chief-broker, retarget the roster, **do not reclaim the old name**. Note a
duplicate-name spawn on 11.4.2 returns `{spawned:true}` and launches nothing.

**`relaycast-cloud-7-lead-0810` should be stood down, not re-scoped.** It was chartered
to cross `^6.3.x → 7.0.0`; `relaycast-cloud#54` did that on **2026-08-07** and #55 went
to 8.0.0 at 17:24Z today. Both merged, both deployed green. Chief's brief and the lane
both read the pins off a local checkout sitting on `docs/migration-0033-comment` (PR #50,
merged 08-02) instead of `main`. **The lane's ACK even said it was on a feature branch
and it still took the premise from there.**

**Unowned, downstream of the 8.0.0 ship:** verify the live engine, then remove
relay#1472's load shim. Until the shim comes out, relay#1445 emits the false zero it was
written to remove. Also: the "does the published tarball contain `0034`" question is now
an 8.0.0 question and does not inherit the 7.0.0 `gitHead` reasoning.

**One small defect on `relaycast` main, no owner:** #319's empty-`?workspace=` guard is
a truthiness test, so `?workspace=` yields `''` and the sole-workspace fallback fires
where cubic asked for a key-presence check. **Calibrate down** — single-tenant only,
card public by design; `cast.agentrelay.com` is multi-tenant where `limit(2)` declines.
Shipped to production in #55.

**`relayfile#413`** — ready-for-review since 19:00Z (by Khaliq; chief's "stays draft"
bound the lane, not him), `mergeStateStatus: DIRTY`, title still says "DRAFT". Carries
known-red tests plus 20 files of the `mount-latency-20260807` evidence bundle. The
"never a CI gate" warning lives in the PR body — **prose is not a gate**; the durable
control is a skip or build tag on the test.

**`watchdog-agents#24`** dropped real recorded audio (the spike's own report: *"real
Norwegian audio… exact ground truth"*) from HEAD; blobs remain in history. Private repo,
so bounded. **A credential can be rotated; a voice recording cannot** — for personal
data the history *is* the exposure, so rewrite is the only control, not optional
cleanup. The question that settles it is consent, and it is not the steward's.

**Duplicate steward RULED 16:59:33Z — both stay, split by plane.** `steward-0810c` owns
relay liveness and nonce probes; this steward owns GitHub artifacts and
ruling-to-artifact tracking. Neither reports the other's plane. (I did not see the
ruling until I read §3 of the evening handoff — check both directions.)

**Not in the evening handoff's §5 OPEN, reported 20:03Z:** the `relaycast-cloud-7`
stand-down, and the unowned shim removal. Both above.

---

## CLOSED — do not re-raise

- **Credentials in `chief` git history.** Khaliq ruled 2026-08-10 (`0d5f9a2`): private
  repo, exposure **ACCEPTED**, no rotation. **Verified the boundary held:** squash-only
  gate applied (`allow_merge_commit false`, `allow_rebase_merge false`), #28 merged
  19:25:14Z, and on `origin/main` `261db56` is not an ancestor, `opencode.json` is
  absent, and `git log origin/main -- opencode.json` is empty — never introduced.
  **Leave the squash gate on.**
- **No fleet-wide stop.** My 14:22 alarm was false, retracted 14:33.
- **Nine ownerless review threads → one.** #318's three are fixed in merged code
  (`data`/`metadata` in `VERBATIM_VALUE_KEYS` with a round-trip test; Swift
  `CoreMessagePayload` carries metadata); #317's is a docs P3.
- **Chief's #general staleness table** is superseded; all seven repos matched
  `origin/main` by 13:29Z. Rules 1 and 2 stand; rule 3 was contradicted by chief's own
  pull, which did find live untracked work.
- **pr-shepherd's `check_run` manifest gap** — the lane withdrew it itself as a
  nice-to-have.
- **Second-instance credential sweep** — 14 repos, filenames plus HEAD content for five
  variable names: no second instance. `relay/teams.json` is tracked in a PUBLIC repo and
  is clean. Not a full secret-scan; no history scanned outside `chief`.

---

## Workstream register — clean as of 19:45Z

All 13 `status: active` files are `updated: 2026-08-10`, all have a Next, and every
owner is the current `-0810` lane. The stale `-0809` owners and the
`agent-lifecycle-workflows` gating clause I flagged at 13:24Z are all fixed. **No
workstream exception outstanding.**
