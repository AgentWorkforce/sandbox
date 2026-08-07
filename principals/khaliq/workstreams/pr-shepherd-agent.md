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
