---
status: done
tldr: "Removed from the active org; repo persists as a donor archive for chief-app's live-pane protocol."
card: "Live-Pane Terminal"
owner: cpo
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

**Now:** done — removed from the active org, superseded by chief-app's
cockpit. The feasibility spike completed (GhosttyKit embedding proof +
architecture spike handoff pushed to a private origin remote); repo
persists as a donor archive.

**Next:** none. cpo's direction memo may recommend harvesting the
file-described live-pane protocol into chief-app as its tile/side-pane
primitive.

## History
- 2026-07-29 — Removed from the active org (Will): chart row dropped,
  repo persists as a donor archive.
- 2026-07-29 — Wind-down artifacts made durable: GhosttyKit proof + spike
  handoff pushed to a private origin remote (previously local-disk-only).
  Attach-fork question resolved: same-machine attach is SDK consumption of
  relay's existing local-node broker API, no new SDK work; a cheap
  `cfg.command`-as-relay-attach-CLI experiment could pull the 3-5 day
  estimate toward its floor. Spun out a three-tier git-hygiene rule
  (ignore/untrack/rewrite by risk) adopted as a repo convention.
- 2026-07-29 — Commissioned by Will (terminal + live markdown sidecar,
  profiles/color schemes per window, per-agent panes). Brief locked same
  hour; agent online and ACK-pending on the spike.
