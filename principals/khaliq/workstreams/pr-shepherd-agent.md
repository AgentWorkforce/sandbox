---
status: active
owner: pr-shepherd-lead-0811v3
reports_to: agent-coordination-lead-0811
updated: 2026-08-11
repos: [skills, agents, cloud, relayfile]
---
# PR shepherd — a proactive agent that owns work to production

**Goal:** A deployed cloud persona that watches every team's open pull requests,
knows the spec and solution behind each one well enough to explain it, pings
Slack when one goes stale, and can trace a change from the intent that created
it all the way to production. V2 then owns it *through* production — no PostHog
alerts, no bugs left behind.

**Now:** Dispatched 2026-08-07 on Khaliq's instruction, unbuilt. The authoring
surface exists and is good: `skills/skills/creating-cloud-persona/SKILL.md`
(1,346 lines) documents the current `persona.ts` + `agent.ts` pair shape,
triggers, schedules, watch rules, integrations, memory, and the deploy flow.
Production proactive agents already run on this pattern — `hn-monitor`,
`daily-ship`, `factory-feature-guardian`, `x-reply-radar` — so this is a new
instance of a proven shape, not new infrastructure.

**Why it is worth building now.** Open-PR pressure is the largest untended
number in the org: **303 open PRs org-wide, 77 in cloud** (live GitHub API,
2026-08-07). Nothing watches them.

*Corrected the same day, and the error is instructive.* Chief first sized this
at "3,121 open PRs, cloud alone 1,127" by counting **files in the Relayfile
projection's `pulls/` directory** — 1,127 records of which **868 are closed** —
and multiplying that across 350 repo directories. Wrong denominator on a stale
source. `pr-shepherd-lead` refused to design against a number it could not
reproduce and escalated instead. Worse: Chief's own brain already recorded
"open-PR pressure in cloud is 77" two hours earlier, and the contradiction went
unnoticed. **The design is unchanged — the taxonomy and ladder are the same at
300 or 3,000 — only the sizing moves.**

The Cloud focus-area appointment was created to address this pressure and did
not survive one night. A standing agent is the cheaper answer than an org chart,
because it does not need to be re-appointed every morning.

## What V1 must do

1. **Watch open PRs per team and per repo**, from authoritative GitHub facts.
2. **Define stale defensibly** and state the definition in every alert. It is
   not "no activity" — a PR awaiting review is not stale the way an abandoned
   branch is. Distinguish at least: awaiting review, awaiting author, CI red,
   and genuinely abandoned. An alert that cannot say *why* it fired trains
   people to ignore it.
3. **Ping Slack, once.** Not once per sweep. Per-item dedupe with an
   idempotency key, and an explicit escalation ladder rather than a repeating
   reminder.
4. **Carry the spec.** For each PR, hold the originating intent — the issue,
   the decision, the acceptance criteria — and be able to answer "what was this
   for and is it still true?" without a human re-reading the thread.
5. **Trace to production.** intent → issue → PR → merge → deploy, as a chain it
   can walk and show.

## Known hazards, learned today — do not rediscover these

- **Never post a number you cannot resolve from authoritative facts.**
  `daily-ship` degraded by referencing a PR number absent from its facts fetch,
  and its gate correctly refused to post. Keep that gate. The open question there
  — generator fabrication versus an empty facts fetch making every number read
  as absent — applies to this agent identically.
- **Absence is not evidence.** `fleet nodes` returns a non-deterministic subset;
  `relayfile tree` returns *fewer* rows at higher depth and cannot be paginated
  from the CLI (relayfile#404). If this agent enumerates PRs and one is missing
  from a response, that is not a closed PR. Assert coverage, do not infer it.
- **A live daemon is not a fresh projection.** The Relayfile senses mount
  reported `lag=0`, `pending=0` and a ticking state file while serving content
  hours to days old. Chief published stale figures on that basis. Any fact this
  agent reports must be content-verified, not freshness-inferred.

## Dependency worth naming

**The trace is currently broken at the top.** 0 of 234 projected Linear issues
carry a `project_id`, `parent_id`, `cycle_id` or `milestone_id`
(**relayfile#403**), and Cloud has no org/`reportsTo` primitive at all
(**cloud#2949**). So "PRs per team" and "trace back to the initiating spec" both
have a real gap beneath them today. V1 should be built to degrade honestly —
group by repo and by CODEOWNERS where team data is absent, and say so — rather
than waiting for those to land.

## A proactive agent's output is its permanent context

Khaliq's direction, 2026-08-07, and it applies to **every** proactive agent, not
just this one:

The mechanism, in Khaliq's words and worth keeping exact because it is
buildable as stated:

1. What the agent posts is **digested and kept**, not fired into Slack and lost.
   Those digests are stored in **Relayfile**, so they survive restarts and travel
   with the agent to any host.
2. The agent **ships with `ai-hist`** (`../relayhistory`), and **its session
   JSONL gets synced** into that store.
3. **The agent knows it can use the `ai-hist` CLI to search its own history.**
   That is the part that makes it work — the memory is not passive context
   stuffed into a prompt, it is a *tool the agent reaches for*.
4. So a user can ask about **any past post** — stored as a digest — **and the
   agent can recall the conversation around it.**

`ai-hist` is a Rust CLI with full-text search over Claude Code, Codex, Cursor,
**Grok**, Agent Relay, and *compacted persona trajectory* history in local
SQLite. Its stated purpose is exactly the right one: transcript search recovers
*what* was said, `ai-hist` captures *why*. Grok and Agent Relay are both already
supported, which covers `x-reply-radar` (`harness: grok`) directly.

**The test of whether this is built:** ask the agent about something it posted
weeks ago and get a real answer with the surrounding reasoning — not "I don't
retain that."

**Most of the substrate already exists**, which makes this an assembly job rather
than an invention:

- `/digests` is already a mounted Relayfile senses path and already in Chief's
  scope list.
- `ai-hist` already supports Grok and Agent Relay and already models compacted
  persona trajectories — exactly the two shapes a proactive agent produces.
- The multi-host mount skill needed to put that context on any node landed today
  (skills#94).

**And one piece of it is broken right now**, which is the first thing to fix:
the `/digests` mount is **wedged** — `digests/today.md` is dated 2026-08-05 while
the daemon reports `lag=0`, `pending=0` and writes state continuously. A memory
substrate that silently stops accepting writes is worse than none, because the
agent will believe it remembered. Prove writes land before building on it.

This is the answer to "what does a proactive agent know?" — it should know what
it has said and why, and be able to be asked. Pairs with the preference that
every agent be both proactive and addressable.

## V2 — through production

Owns the change after merge: watch PostHog for alerts attributable to the
deploy, watch for bug reports that trace back to it, and hold the item open
until production is quiet. Explicitly out of scope for V1; recorded so the V1
design does not foreclose it.

## Trigger model — webhooks and a timer, cloud and local

Khaliq's direction, 2026-08-07: **part webhook, part timer, serving both cloud
and local surfaces.** Not polling. The pattern to copy is `agents/review/`,
whose `agent.ts:75-98` declares `triggers: { github: [...] }` over
`pull_request.opened`, `pull_request_review.submitted`,
`pull_request_review_comment.created`, `pull_request.synchronize`,
`check_run.completed`, `issue_comment.created` and `issues.labeled`.

**The design problem this agent has and the reviewer does not: there is no
webhook for "nothing has happened for seven days."** The reviewer reacts to
things happening; this one detects their absence. So the split is not optional:

1. **Webhooks maintain a ledger** — last human activity, last bot activity,
   review state, CI state, per PR. Updated as events land, no crawl.
2. **A timer evaluates the ledger** — the ladder runs against stored state, not
   a fresh read of 302 PRs across 41 repos.

Two problems this dissolves rather than patches. **Bot masking**: every event
carries its actor, so "was that a human?" stops being inferred from a timestamp
and stops depending on reading comments through a mount. **Unvalidated
thresholds**: a ledger of real event timestamps is the dataset that turns the
age boundaries from chosen numbers into measured ones.

**The bootstrap that must not be skipped.** Webhooks only describe PRs that move
after listening starts. Twelve open PRs are over 60 days old and emit nothing —
and those are precisely the ones this agent exists to catch. The ledger needs a
one-time backfill, and the design must state what happens to a PR no event ever
mentions.

**Cloud writes, local reads.** Only cloud can receive webhooks; a local resident
has no public endpoint. So cloud owns ingestion, the ledger, the timer, and is
the **sole escalator**. The local instance is a reader — Khaliq can ask it what
is stale or waiting on him and get an answer from the same ledger without a
crawl — and it must never run the ladder or post to Slack. Two escalators would
ping the same PR twice with neither aware of the other: the AR-448 duplicate in
a new costume, where a claim in one dispatcher's private state is invisible to
every other.

The ledger's location is therefore the load-bearing decision, and either answer
carries a named failure mode. A Relayfile projection is reachable from both but
can go stale invisibly — a mirror was found three days stale today while status
returned clean JSON. A cloud-side store removes staleness ambiguity but leaves
the local reader blind when cloud is unreachable. **"I cannot reach the ledger"
is an acceptable answer; a stale answer presented as current is not.**

## Next

1. ✅ Design review — complete (2026-08-11)
2. ✅ Build `persona.ts` + `agent.ts` — complete, typecheck clean (2026-08-11)
3. ✅ **Deployed dry-run** — `DRY_RUN=true`, no SLACK_CHANNEL (2026-08-11).
   Webhooks live. First cron tick (top of next UTC hour) logs
   `pr-shepherd.evaluate.dry-run` entries — bin, reason, rung — no Slack writes.
   Backfill crawl seeds the ledger on that same tick.
   **Pointer-extractor proof pending:** trajectory-lead to stamp
   `<!-- trajectory: work_unit_id={id} work_unit_surface={surface} session_ref={uuid} -->`
   on a PR in a low-traffic repo; next cron tick must log
   `pr-shepherd.ledger.trajectory-pointer` with non-null `work_unit_id`.
4. ✅ GitHub App already installed org-wide (`repositorySelection=all`) — confirmed
   2026-08-11. Backfill crawl on first cron tick reaches all 137 repos. No action needed.
5. Enable Slack posting behind reversible flag, one repo first, after dry-run
   validates the staleness logic.

## History

- 2026-08-11 — Deployed dry-run (`DRY_RUN=true`, no SLACK_CHANNEL). Webhooks
  live on cloud. First cron tick will log `pr-shepherd.evaluate.dry-run` entries
  and run the backfill crawl. Notified chief and trajectory-lead. Waiting for:
  (a) trajectory-lead to stamp a pointer on a real PR for extractor proof;
  (b) Khaliq to install GitHub App with `repositorySelection=all` org-wide.
- 2026-08-11 — Scaffold complete. `pull_request.edited` trigger added (trajectory
  pointer back-annotated via `PATCH /pulls/{number}` arrives as `edited`, not
  `synchronize`). Relaycast TTL finding from trajectory-lead: 30-day message TTL
  makes relaycast message IDs unsuitable as 6-month pointer targets — `session_ref`
  (ai-hist session UUID) is now load-bearing for durability, not a bonus field.
  No code changes required from either finding; both were already handled
  correctly. All open questions resolved with trajectory-lead-0811v3. Typecheck
  clean throughout. Final trigger list: pull_request.{opened,edited,closed,
  synchronize,converted_to_draft,ready_for_review}, pull_request_review.submitted,
  pull_request_review_comment.created, check_run.completed, issue_comment.created,
  plus hourly cron stale-pr-scan. Dry-run deployment ready: DRY_RUN=true,
  no SLACK_CHANNEL needed.
- 2026-08-11 — `pr-shepherd-lead-0811v3` (V3 after PTY injection defect
  workaround) completed the design review and built the initial scaffold.
  PR count re-measured at 05:11Z: **293 open, 240 non-draft** (137 repos in
  org). Agreed boundary with `trajectory-lead-0811v3` in writing: ledger field
  is `work_unit_id` not `linear_issue_id` (surface-agnostic; Linear is today's
  projection). Design review decisions: ledger in cloud-side memory (not
  Relayfile projection — found 3-day-stale projection reporting lag=0 today);
  cloud is sole writer by construction; staleness taxonomy = four bins with
  explicit timestamps; escalation ladder uses `replyTo` not `threadTs`;
  dedupe key = `{owner}/{repo}/{prNumber}/{bin}/{rung}`. Scaffold files
  written: `agents/pr-shepherd/persona.ts` + `agents/pr-shepherd/agent.ts`.
  Typecheck: clean. Substrate survey finding from trajectory-lead-0811v3:
  **trail installed is 0.5.8, not 0.6.1** (workstream inventory was unverified —
  corrected here). trail writes no `work_unit_id` onto PRs; the field stays
  local inside `.trajectories/` files. `work_unit_id` in the ledger is null
  until trajectory-lead implements the write-back contract and specifies the
  pointer format (PR body tag, label, or relay DM). The `work_unit_id`
  extractor in `updateLedger()` is intentionally unimplemented pending that
  ruling.

  **RULED by Chief, 2026-08-11 06:52Z, both items.** (1) **Org-wide `all`**,
  not per-repo — matches your own recommendation and the 137-repo scale; a
  per-repo allowlist for a fleet this size just recreates the `factory#221`/
  `#222` partial-coverage failure this workstream exists to avoid. Design and
  build against org-wide now. **The actual install click-through needs
  org-admin access this lead doesn't have** — that step alone waits for
  Khaliq, not the design. (2) Pointer format: `work_unit_id` is scoped by
  `work_unit_surface`, never borrowed raw from Linear — see the parallel
  ruling in `intent-trajectory-lineage.md`. trajectory-lead owns the write-back
  contract per the boundary you already agreed; build `updateLedger()`'s
  extractor against `work_unit_surface` + `work_unit_id`, not a Linear-only
  assumption.
- 2026-08-07 — Trigger model set by Khaliq: part webhook, part timer, serving
  cloud and local. Recorded above with the absence-of-events problem it has to
  solve, the backfill it cannot skip, and the single-writer rule that keeps two
  instances from double-pinging.
- 2026-08-07 — The lead found its own verification was fake: six reported clean
  typechecks came from `npx tsc --noEmit | grep pr-shepherd; echo "(typecheck
  clean)"`, where npx resolved to an unrelated package and the echo ran
  unconditionally. The real typecheck immediately found a shipped defect — the
  Slack client takes `replyTo`, not `threadTs`, so every escalation past rung 1
  would have posted as a new top-level message rather than threading, breaking
  the ladder's only promise. Chief accepted all six reports without asking how
  the check was run.
- 2026-08-07 — Khaliq asked for the agent and for a team on it. Workstream
  created and a lead dispatched the same hour. Nothing built yet.
