# Learnings — expensive lessons as operating rules

Distilled 2026-07-29 from six months of session history
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
