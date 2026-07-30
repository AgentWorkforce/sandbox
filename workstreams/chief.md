---
status: active
tldr: "The chief-of-staff brain is live and resident with the org built out under it; its senses (GitHub, email) wait on provisioning fixes."
card: "Chief of Staff"
owner: chief
updated: 2026-07-29
repos: [chief]
---
# Chief — the chief-of-staff agent

**Chief is two organs since 2026-07-30:** the **voice** (Sonnet roster
agent, talks to Will, never decides — charter in `docs/voice.md` +
`.claude/skills/voice-talk/`) and the **brain** (Fable resident, this
seat, orchestrates and writes). Voice reads the brain's files; brain
never delegates decisions down to it.

**Goal:** Will talks only to chief; chief knows past (retros), present
(workstreams), and future (next steps) across the whole ecosystem, and
delegates real work to repo agents over Agent Relay.

**Now:** Phase 2 in progress. Phase 1 shipped (brain scaffolded:
persona, memory, journal backfilled Dec 2025–Jul 2026, workstreams,
/retro /status /digest). Broker is up in this repo and chief runs as a
resident relay agent — registered, posting to #general, DM-able.

**Next:** finish Phase 2 — (1) `senses/` mount of the GitHub org tree from
hosted relayfile (Gate 3 done; blocked on Will's OAuth, see below);
(2) scheduled daily /digest: an interim launchd job already exists
(`com.agentworkforce.chief.digest`, 17:30 daily, headless sonnet) — replace
it with the relaycron message transport once that lands (dogfood relaycron;
the launchd job is the bridge, not the destination).

**Senses leg is blocked on Will:** no Relayfile-backed workspace exists —
chief-dev is messaging-only. Unblock is a ~3-min browser task: `relayfile
login --provision-messaging-only`, then
`relayfile integration connect github|slack|notion`. A worker stands by to
mount and verify once unblocked. Scoping: senses belong to the consuming
department, one relayfile workspace each (also the workaround for the
one-mount-per-workspace limit). **Chief's
mount = the GitHub org tree** (`/github/repos/AgentWorkforce`) for digest
senses. **#research-market went to cso** — see [cso-research]. The
multi-allowlist brief becomes a relayfile CLI issue (expose repeated
`--remote-path` / `--local-layout`).

## History
- 2026-07-29 — Orgchart dashboard shipped (`tools/orgchart/`, localhost:4780):
  live org tree, attach-in-terminal launcher, Projects overview reading tldr
  and curated card labels straight from `workstreams/*.md` frontmatter.
- 2026-07-29 — Chief came online as a durable relay agent for the first time:
  session-start ritual from files alone, readiness posted to #general,
  resident on DMs.
- 2026-07-29 — Repo restarted app-less, superseding chief-app (parked with
  M0–M2 shipped and a headless pivot uncommitted). Design: markdown brain
  here, mechanics as platform PRs (see agent-org-primitives).
