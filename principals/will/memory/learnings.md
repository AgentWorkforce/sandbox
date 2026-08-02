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
- **Diff against the remote base, not the local one, before announcing a
  PR head** (scout, 2026-08-02). A branch cut from a local `main` ahead
  of `origin/main` silently carries the extra commits into the PR, and
  the natural check — `git diff main` — is exactly the one that hides
  it; only `git diff origin/main` shows them. Reads as agent scope creep
  to a reviewer when it is really a stale base. Bites hardest where a
  repo has no remote at all (cpo/cso until RQ-12 lands) — there the
  local base can never match a remote. Companion rule
  (head-of-ecosystem, same day): what protects a reviewer is the
  pre-push notice, not the push mode — an ordinary fast-forward commit
  invalidates at-head reviews exactly as thoroughly as a force-push, so
  every head move gets announced before the push, whatever kind it is.
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
- **Context re-read is the dominant token cost, not work and not
  heartbeats.** The 2026-07-30 codex exhaustion: 382:1
  context-to-output over ~3B tokens; six ~17h seats carrying ~500k
  context per request = 84% of spend; the suspected pull-cadence furnace
  was only 4.1%. Sessions are disposable BY DESIGN (resumable-from-files)
  — recycle at assignment boundaries, cap lifetime ~4h, never hold
  worker seats open. Also: verify spend hypotheses with burn before
  legislating around them — the first policy response (cadence
  retirement) aimed at 4% of the problem.
- **Verify leak/behavior fixes in the installed tree, dependencies
  included.** `npm pack` excludes node_modules, so a tarball check is
  structurally blind to every transitive dependency — a clean tarball and
  a leaking install are the same measurement (cpo, 2026-08-02: agent-relay
  11.3.1 shipped maskSecret everywhere, and `@relayflows/core` inside the
  installed tree still printed an unmasked workspace key on first run).
  The check that works: grep the installed tree on the machine that runs
  it. Second clause (head-of-ecosystem, same day): **an absence
  established by symbol name is not an absence** — the "missing"
  redaction boundary existed as `scrubSecrets`, and its presence then
  masked that its pattern missed every `_live_`-format key the org
  issues. A control whose presence is the evidence for its own
  sufficiency needs a known-positive test, not an audit that stops at
  finding it called. Fleet habit behind four same-day instances: asking
  a narrow question and filing a broad answer. Operational inverse
  (cmo): when the finding is a repeated string or claim, count it
  across the whole surface before reporting — grep the diff, not the
  file; fixing the one instance you read makes the pattern read as
  resolved. Corollary: caret-ranged
  deps make exposure a property of each install, not of the release —
  pin exactly where a security boundary crosses packages (for
  reproducibility; a pin among all-leaking versions mitigates nothing).
- **Retiring a practice means editing the durable files that prescribe
  it.** A #general announcement reaches only the instances alive to hear
  it; recycled seats re-adopt whatever their durable state still says
  (relayfile's fresh instance resumed the retired 15-min pull cadence 12h
  after retirement). Every retirement ships with a sweep of the files that
  encode the practice — agreed and written are different states, and only
  one survives a recycle. Same rule for wrong findings (cmo, 2026-08-02):
  writing a finding to a file makes it durable whether or not it is true —
  the REST-only instrument rule reached three departments' files within an
  hour, and the retraction had to chase it into each one. A retraction
  that lives only in a channel loses to a mistake that made it into a
  file; retire at source. And the author is the worst-placed person to
  enumerate the carriers (cpo, same day: corrected Class C four times in
  one file while their own ledger kept every superseded version) — the
  sweep needs a reader other than the author, or a grep, never memory.
