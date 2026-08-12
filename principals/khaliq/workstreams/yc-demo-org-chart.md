---
status: done
owner: orgchart-dashboard-lead-0811
updated: 2026-08-11
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

## 2026-08-11 Resurrection — orgchart-dashboard-lead-0811

**Dashboard restored 10:31Z.** URL: http://localhost:3100/cloud/dashboard/chief/variants/07

**Root cause of 7753+ crash loops:** launchd plist `WorkingDirectory` pointed to
`cloud-worktrees/yc-chief-variants-aggregate/packages/web` — a worktree that was
cleaned up after the demo. LaunchD sets the working directory before executing
`runtime-prod.sh`; a missing directory causes an immediate failure. Since
`KeepAlive=true` and `ThrottleInterval=5`, it retried every 5s for 7753+ attempts.

**The immutable release was fully intact.** Release `296ddc806` at
`~/Library/Application Support/AgentWorkforce/yc-demo-3100/releases/` had:
- `packages/web/.next` — complete Next.js build ✓
- `node_modules/next/dist/bin/next` ✓
- `current` symlink pointing correctly to it ✓

`runtime-prod.sh` handles its own `cd` into the release; the plist's
`WorkingDirectory` only needs to be a directory that exists.

**Fix applied:**
1. `service.sh stop` (bootout)
2. Changed plist `WorkingDirectory` from the dead worktree to
   `~/Library/Application Support/AgentWorkforce/yc-demo-3100` (the service's
   own stable directory — always exists)
3. `plutil -lint` confirmed plist valid
4. `service.sh start` (bootstrap)
5. Service came up in ~8s. First curl: 200/171KB.

**Final health check:**
```
UP checked_at=2026-08-11T10:31:57Z http=200 bytes=166958 principal=Khaliq_Gant
agent_rows=6 reports_refs=280 collapsed_controls=8
url=http://localhost:3100/cloud/dashboard/chief/variants/07
```
All bars green.

**Dependency :4780** was alive throughout — not a factor.

**Fast-follow (unowned, unscheduled):** The dashboard shows Aug 6 snapshot data
(6 agents). Showing tonight's real org (delivery-lead, soc2-program-lead,
agent-coordination-lead sub-lead structure) would require a new build + promote
via `promote-head.sh` from a new `yc-chief-variants-aggregate` worktree.
No worktree currently exists for that; would need to be created first.

**Cleanup checkpoint, 2026-08-11 15:48 CEST:** the dashboard remained the
verified completed deliverable. `orgchart-dashboard-lead-0811` had been idle as
instructed for 150 minutes with no pending messages and was released; the
fast-follow remains deliberately unowned.
