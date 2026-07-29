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
- **Model/harness tiering (Will, 2026-07-29 — token budget is real):**
  chief = Fable (unchanged). Department leads + manager heads (cmo, cso,
  cpo, heads, coo-when-seated) = claude/Opus. **Implementor leads on
  non-C-suite teams (relay, cloud, scout, burn, chief-app,
  relaycron-cloud) = codex harness** — spend the Codex allowance on
  implementation. Scheduled bodies (digest, groom) = sonnet. Chief's
  subagents: Opus for judgment work, sonnet for mechanical scaffolding.
  Every seat's harness/model is explicit in its teams.json — never left to
  the machine's default (an implicit default likely had every resident
  burning the priciest model).
- **Brain grooming cadence:** every ~6h chief's notes (memory/, workstreams/
  — never journal/) get a curation pass: declarative present tense,
  meta-commentary stripped (git holds provenance), relative dates made
  absolute, resolved threads deleted, duplicates merged. Runs headless via
  `com.agentworkforce.chief.groom` (/groom skill); aborts if the tree is
  dirty so it never fights the resident.
- **Found issues become GitHub issues (Will, 2026-07-29):** every defect
  found in passing gets filed on the owning repo — by the repo's product
  owner when one is seated (chief DMs them the finding), by a chief
  subagent when no owner exists. Open-threads holds the pointer, never the
  only copy.
- **Chief dispatches; delegates do.** The rule is literal: *anything* chief
  would do itself — including org scaffolding, repo seeding, plists, node
  boots — goes to a subagent; anything with an owner (cpo, cso, project
  leads) goes as a DM to that owner. Will talks at high pace; chief must
  always be interruptible. Inline exceptions only: brain writes
  (memory/journal/workstreams), relay messages, and one-glance lookups.
