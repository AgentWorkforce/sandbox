---
status: done
owner: chief-khaliq-successor-20260806
updated: 2026-08-06
repos: [cloud, relaycast, chief]
---

# YC demo org chart

Goal: a live org chart that truthfully shows Khaliq's agent workforce — who
reports to whom, what is actually running, and on which machine — good enough to
put in front of YC. **The demo happened on 2026-08-06 and is over.**

## Now

Done. Khaliq demoed variant 07 from `http://localhost:3100/cloud/dashboard/chief/variants/07`,
served by an immutable production release under launchd with `KeepAlive`.

All four Next items closed on the day:

1. **Status dots** — landed at `fae1f7fe2`, derived per-row from `lastSeen` age
   with a legend. Verified in Chromium: 27 of 27 rows carried a dot.
2. **Subordinates under leads** — landed in the same commit, from real
   `reportsTo` data. `Marketing Lead → X Reply Radar + Positioning Agent` is the
   true instance; unseated repo nodes are excluded rather than dressed as agents.
3. **:3100 serving correct content** — a content-asserting health check now runs
   every 10s and requires 200, ≥50 KB, `Khaliq Gant`, a real agent row,
   reporting-line text and a collapsed hierarchy control. The 23,178-byte hollow
   page now fails it by design.
4. **Runbook and kill-test** — delivered with measured numbers: SIGKILL recovery
   **10.898s**, promotion **9.513s**. Lives at
   `~/Library/Application Support/AgentWorkforce/yc-demo-3100/RUNBOOK.md`.

Late additions Khaliq made on the day, both shipped: proactive agents shown
distinctly from dispatched ones, and the roster tightened to genuinely-live
agents on a new `:4781` feed, leaving `:4780` untouched as the backup.

## Next

Nothing. Successor work moved to `cloud-org-appointments.md` and the deferred
polish below is unowned and unscheduled.

## Deferred past the demo, on purpose

Spacing polish, emoji beyond the role glyph, editorial cuts, the eligible-backlog
panel (21 `factory-ready` issues across 5 repos, live via `gh`), type scale,
proactive-agent differentiation, and the port of 07 to the hosted Organization
panel.

## What is true about the page today

Working: humanised names, principal at the root, real `reportsTo` lines, table
layout with aligned columns, node attribution joined from the roster, View and
Drive with a functioning attach, the tree collapsing on first paint, honest
provenance labels ("reported", "at capture", "last seen unavailable").

The title defect is fixed — `"Chief of Staff"` went from 77 occurrences to 1.

## Hard-won facts, so nobody re-derives them

- **The demo URL and the edit loop must stay separate processes.** For hours one
  process served both, so every edit took the demo offline. Splitting :3100 and
  :3101 is the fix; do not merge them back.
- **A production build is a snapshot, not a finish line.** Waiting for the design
  to be "done" meant it was never built, because requests kept arriving.
- **`CHIEF_LOCAL_ORGCHART_URL=http://127.0.0.1:4780` is mandatory** for any
  production build. Without it `NODE_ENV=production` resolves the local origin to
  null: Drive 503s on every row and the principal, reporting lines, projects and
  node data all vanish. The service comes up successfully and useless.
- **Node attribution lives in the relay roster, not in `/api/runtime`.** That feed
  has no node field at all. Join `metadata.fleet.nodeId` against the fleet node
  list. `chief-khaliq` maps to `chief`.
- **Every liveness flag over-reports.** `status: active`, `live: true` and
  `currentState` all report agents that are provably dead. Only `lastSeen` is a
  measurement. Ping an agent and watch whether `lastSeen` advances — that is the
  only reliable probe.

## History

### 2026-08-06

- Khaliq chose variant 07 and later decided to demo it directly from :3100.
- Scope frozen after I thrashed the lane's priority queue with ~15 re-ordered
  instruction messages in two hours, which prevented convergence.
- Split :3100 (demo, supervised) from :3101 (iteration) after the demo URL went
  down repeatedly during edits.
- Discovered the roster cannot be cleaned: 312 of 347 active rows have no
  `nodeId`, and both release and permanent delete return a pending invocation
  that never completes.
- `sweepStaleAgents` found dormant with zero callers since the Cloudflare
  migration dropped its timer. relaycast #306 restores it.
- Retracted my own proposal to filter on missing `nodeId` — 37 live agents,
  including Khaliq's production automation, carry none.
