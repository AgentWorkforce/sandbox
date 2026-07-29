---
name: status
description: Forward-looking status board — read workstreams/, verify freshness against the repos, report where everything stands. Use when asked "status", "where do things stand", "what are we working on", or about a specific workstream.
---

# /status [workstream]

1. Read every `workstreams/*.md` (or just the named one). Order: active,
   blocked, parked; done only on request.
2. **Verify before reporting.** Any file with `updated` older than 7 days —
   or all of them when a fresh look is asked for — gets checked against
   reality: branches, open/merged PRs, recent main commits. Parallel read-only
   subagents when several need checking.
3. **Report as a board:** workstream | status | now | next | updated. Prose
   only where something changed or a decision is needed. Blocked items name
   the blocker.
4. **Write back what you learned:** refresh Now/Next/`updated` and add a
   History line in each touched file.
5. **Flag orphans:** significant repo activity with no workstream file →
   propose one; a workstream that's actually finished → propose marking done.
