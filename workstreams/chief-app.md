---
status: active
tldr: "Reviving as the org cockpit; triage found origin healthy and the old code reusable as foundations rather than a rewrite."
card: "Org Cockpit"
owner: chief-app
updated: 2026-07-29
repos: [chief-app]
---
# chief-app — native clients, unparked under cpo

**Goal:** the org cockpit (Will): "this conversation, but with
the ability for chief to show visuals in side panes, and drop me into the
conversations I need to be in without typing — 'direct me to the CPO' in a
side pane while chief is always right there; or a 4x4 pane of everyone
working." Chief conversation as the spine; chief-pushed side-pane visuals;
no-typing routing into any resident's session; grid of the whole fleet.
Strictly a client of the chief brain and the relay, never a second brain.

**Now:** unparked by Will as a cpo-tree project
(Will → chief → cpo → chief-app); resident owner being seated. Inherited
state: M0–M2 shipped; ~41 uncommitted changes on main (the headless pivot).

**Next:** owner's bootstrap triage — inventory the 41 changes, recommend
commit-to-branch / harvest / discard → DONE to cpo, which decides
disposition and (with its marquee-vs-chief-app direction memo) the build
plan. This resolves the former open-thread "chief-app: decide commit /
harvest / archive".

## History
- 2026-07-29 — History-rewrite scare closed out: no action needed — no
  npm-cache reachable from any origin ref. Produced a standing three-tier
  git-hygiene rule (ignore always safe, untrack disruptive-but-recoverable,
  rewrite irreversible/needs owner sign-off); repo added an ignore for
  generated agent-runtime artifacts under it.
- 2026-07-29 — Unparked at Will's request after one day parked; the
  disposition decision became the new owner's first triage instead of a
  Will decision.
