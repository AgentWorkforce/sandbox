---
status: active
owner: marquee
updated: 2026-07-29
repos: [marquee]
---
# marquee — terminal app with a live markdown pane

**Goal:** Will's side project: a Ghostty-based terminal app where each
window pairs a real PTY with a live-rendered markdown pane (agent name
header + self-updated recap/status). The file is the window identity —
nearest `marquee.md` or explicit arg; frontmatter sets title, theme, autorun
cmd, pane side. Primary use: agent-relay residents self-authoring their
pane; degrades to any shell + hand-edited file.

**Now:** commissioned and seated 2026-07-29. Repo live (`../marquee`:
locked brief in docs/brief.md, operating manual, roster), resident lead
online via launchd, first-boot workspace seeding recipe applied cleanly.
Feasibility spike dispatched: verify libghostty's current embedding story
from primary sources, fallback table if immature, pane-rendering choice,
v1 build plan → docs/architecture.md.

**Next:** review the spike's architecture.md, green-light or redirect the
v1 build plan. Reporting line: project lead under chief — no product/eng
C-level seated; marquee is the first candidate instrument if one ever is.
Name chosen: marquee (alternates offered: playbill, callsheet, chyron).

## History
- 2026-07-29 — Commissioned by Will (terminal + live markdown sidecar,
  profiles/color schemes per window, per-agent panes). Brief locked same
  hour; agent online and ACK-pending on the spike.
