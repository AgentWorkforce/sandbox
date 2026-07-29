# chief

Will's chief of staff — an agent whose brain is this repo.

Chief knows what's being worked on across the AgentWorkforce ecosystem, looks
backward (week/month/quarter retrospectives) and forward (workstream status),
and delegates real work to the agents that own each repo. Everything durable is
markdown in git; there is no app and no database.

## Layout

| Path | What it is |
|---|---|
| `CLAUDE.md` | Chief's persona and operating manual |
| `memory/` | Standing knowledge: people, projects, preferences, learnings, open threads |
| `journal/` | The record: daily entries, weekly/monthly rollups, saved retros |
| `workstreams/` | One file per live workstream: goal, status, now, next |
| `senses/` | Relayfile mount of GitHub/Slack/Notion data (gitignored, optional) |
| `teams.json` | Agent Relay roster for this repo's broker |
| `.claude/skills/` | `/retro`, `/status`, `/digest` |

## Talking to Chief

Open Claude Code in this directory. The persona loads, Chief reads its brain,
and you can ask anything: "what did we ship this month?", "status", "what's
next on relaycron?".

With the broker up (`agent-relay up` here), Chief is also a durable relay
agent reachable by DM from anywhere in the workspace.
