---
status: active
tldr: "Reviving as the org cockpit; triage found origin healthy and the old code reusable as foundations rather than a rewrite."
card: "Org Cockpit"
owner: chief-app
updated: 2026-07-29
repos: [chief-app]
---
# chief-app — native clients, unparked under cpo

**Goal:** the org cockpit, three-pane layout (Will, refined 2026-07-30):
**left** = org chart + Projects tabs (the localhost:4780 tool productized;
clicking a project opens its leads' terminals); **middle** = always-on
chat with chief as the primary interface (chief likely headless — a chat
participant, not an attached PTY; the pivot's `headless-chief.ts` is
prior art); **right** = attach terminals pear-style, splitting 2/3/4
panes with tabs as views open. Underneath, the original framing stands:
chief-pushed visuals, no-typing routing ("direct me to the CPO"), fleet
grid. Strictly a client of the chief brain and the relay, never a second
brain.

**Now:** unparked by Will as a cpo-tree project
(Will → chief → cpo → chief-app); resident owner being seated. Inherited
state: M0–M2 shipped; ~41 uncommitted changes on main (the headless pivot).

**Next:** owner's bootstrap triage — inventory the 41 changes, recommend
commit-to-branch / harvest / discard → DONE to cpo, which decides
disposition and (with its marquee-vs-chief-app direction memo) the build
plan.

## History
- 2026-07-29 — History-rewrite scare closed out: no action needed — no
  npm-cache reachable from any origin ref. Produced a standing three-tier
  git-hygiene rule (ignore always safe, untrack disruptive-but-recoverable,
  rewrite irreversible/needs owner sign-off); repo added an ignore for
  generated agent-runtime artifacts under it.
- 2026-07-29 — Unparked at Will's request after one day parked; the
  disposition decision became the new owner's first triage instead of a
  Will decision.
