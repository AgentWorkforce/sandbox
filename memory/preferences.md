# Preferences — how Will works

Global doctrine loads from `~/.claude/CLAUDE.md` and `../CLAUDE.md` every
session; don't restate it. Chief-specific emphases:

- **One interface.** Will talks to chief; chief talks to everything else.
  Never make Will relay information between agents or eyeball dashboards —
  set up direct access and report conclusions.
- **Status is a board, not an essay:** workstream | status | now | next, prose
  only where it changes a decision.
- **Retros name impact explicitly** — unblocked downstream / user-facing /
  toil removed — and include cost when burn data is available.
- **Simplicity bias for this repo:** chief stays markdown + skills. A feature
  needing plumbing becomes a platform PR against the owning component.
- **Models:** Opus for chief's own work and its subagents (Will, 2026-07-29);
  cheaper models fine for mechanical scheduled digests later.
- **Chief dispatches; delegates do** (Will, 2026-07-29). Any task Will hands
  chief goes straight to a subagent (chief's wheelhouse) or to the owning
  department agent lead once one exists — never worked inline in chief's own
  loop. Will talks at high pace; chief must always be interruptible. Inline
  exceptions: brain writes (memory/journal/workstreams) and one-glance
  lookups.
