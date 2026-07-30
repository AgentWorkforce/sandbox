# Learnings — expensive lessons as operating rules

Distilled from six months of session history
(`~/.claude/docs/claude-usage-review-2026-07.md`).

- **Process overhead is the enemy.** ~Half of everything Will typed was
  nudging, PR mechanics, comment triage, release bookkeeping. Chief exists to
  absorb that layer. A task repeated twice gets promoted to a skill in
  `../skills` the same day.
- **Gate before the PR, not after.** Rebase on fresh main + typecheck + test +
  self-review before `gh pr create`. Post-hoc firefighting (90+ merge-conflict
  prompts; eight on one PR in a day) cost more than any other habit.
- **Never debug through a prod cron with a human as the message bus.** The
  Slack-threading saga: two weeks, ~16 screenshot round trips. Cross-service
  bugs start with a sub-minute local repro plus direct log/telemetry access.
- **Stabilize upstream, then integrate once.** The engine migration was redone
  across v5.0.1→.5 with a full revert, by integrating against a moving
  dependency.
- **Sessions are disposable workers; files are the state.** Mega-sessions
  decayed into "it's been a few days and I'm lost". The plans/NNN.md +
  PR-per-issue factory was the most effective mode; journal + workstreams
  generalize it.
- **Locked one-page brief before spawning a team.** Mid-flight creative
  reversals (art direction, launch video ×3) cost days of agent-hours for want
  of ten minutes of brief.
- **Verify releases and deploys by observing.** "Merged" ≠ "deployed". Semver
  by policy (release-train), not vibes — one regretted major shipped on vibes.
- **Runtime-spawning tests never run on the dev machine.** Fork-bombed the Mac
  twice. Fakes locally; real runtimes in CI/sandboxes only.
- **Secrets never enter prompts or tracked files.** Live keys in prompt history
  forced rotations. Env vars only; any pasted secret gets flagged for rotation.
  Never dump raw `env` — a length-based redaction filter missed
  `RELAY_BROKER_API_KEY` (`br_` + 32 chars = 35, under the cutoff) and leaked
  it into a transcript. Grep for the specific variables you need, or filter by
  key name, never by value length.
- **Never `git add -A` in the chief repo.** Headless cron bodies (groom,
  digest) edit brain files concurrently with the resident; a blanket `add
  -A` sweeps their mid-flight edits into unrelated commits (the "Pilot go"
  commit once silently absorbed a groom pass). Stage explicit paths, always.
- **Start chief's node from launchd, never from a Claude Code session.** Claude
  Code stamps `CLAUDE_CODE_CHILD_SESSION=1` into every Bash-spawned subprocess;
  `agent-relay node up` passes its env through the broker into chief's PTY, so
  chief sees the marker and silently stops saving transcripts. The plist
  (`com.agentworkforce.chief.node`) has a clean env, so the symptom never
  appears on that path — any clean-env launch works (e.g. `npm run chief`
  from Will's own terminal); the hazard is specifically Claude-Code-spawned
  envs. `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` overrides the symptom, but
  the launch path is the real fix. The job exits 1 if a manually started
  broker already holds the project — `agent-relay down` first, then
  `launchctl kickstart -k gui/$UID/com.agentworkforce.chief.node`. The marker
  cannot be checked from inside a session (`printenv
  CLAUDE_CODE_CHILD_SESSION` in the Bash tool always shows `1`, since Claude
  Code stamps every subprocess) — verify persistence by watching the
  session's `.jsonl` under `~/.claude/projects/...` grow.
- **relayauth D1 capacity is a standing failure mode, not a one-off bug.**
  The 90-day retention band doesn't fit D1's 10 GiB ceiling. Until
  archive-to-R2 (or equivalent) lands, treat any auth mint-flapping as a
  DB-fill check first, not a fresh diagnosis. Runbook:
  `cloud/docs/runbooks/relayauth-d1-retention-gc.md`; tracking cloud#2801.
- **Never bundle additions into a mid-build subagent task.** Twice in one
  day (2026-07-30) a "while you're in the file" addition arrived after the
  worker finished and silently missed the build. Queue follow-ups as fresh
  tasks after DONE; verify the live artifact for each addition separately.
