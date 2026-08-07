---
status: active
owner: khaliq-chief
updated: 2026-08-07
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
number in the org: **3,121 open PRs across 350 repos**, cloud alone carrying
1,127. Nothing watches them. The Cloud focus-area appointment was created to
address exactly this and did not survive one night. A standing agent is the
cheaper answer than an org chart, because it does not need to be re-appointed
every morning.

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

## V2 — through production

Owns the change after merge: watch PostHog for alerts attributable to the
deploy, watch for bug reports that trace back to it, and hold the item open
until production is quiet. Explicitly out of scope for V1; recorded so the V1
design does not foreclose it.

## Next

1. Design review before code: the staleness taxonomy, the escalation ladder,
   and the dedupe key. Those three decide whether anyone trusts the alerts.
2. Build the `persona.ts` + `agent.ts` pair against
   `skills/skills/creating-cloud-persona/SKILL.md`, shipping both files.
3. Prove it read-only against real PRs before it can post anything — a dry-run
   mode that prints what it *would* say.
4. Enable Slack posting behind a reversible flag, in one repo first, not all 350.

## History

- 2026-08-07 — Khaliq asked for the agent and for a team on it. Workstream
  created and a lead dispatched the same hour. Nothing built yet.
