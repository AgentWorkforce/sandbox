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

One Chief runs resident on this repo's broker (`agent-relay node up` starts
both; `teams.json` autoSpawn). Three ways in:

- **Attach (primary):** `agent-relay node agent attach chief --mode drive` —
  Chief's live TUI, type as in any Claude session. Inbound relay messages
  queue while you drive and flush when you detach (`Ctrl+]`).
- **DM from anywhere:** any registered agent or session in the workspace can
  DM `chief`; it answers from its brain.
- **Maintenance shell:** a bare `claude` session here edits the repo but is
  **not** Chief — don't hold Chief conversations in it while the resident is
  online; two writers corrupt continuity.
