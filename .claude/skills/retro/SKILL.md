---
name: retro
description: Look back over a week, month, quarter, or custom range and synthesize what shipped, what was impactful, and what was learned. Use when asked "what did we do this week/month/quarter", "recap", "retro", or "what's been impactful".
---

# /retro [week|month|quarter|since <date>]

1. **Resolve the range.** Default: trailing 7 days. `month`/`quarter` mean
   trailing 30/90 days unless a calendar period is named.
2. **Journal first.** Read `journal/daily/` entries in range, rollups covering
   it, and any `journal/retros/` overlapping it. The journal is the curated
   record — primary source.
3. **Cross-check reality.** Fan out read-only subagents per repo cluster
   (map in `../CLAUDE.md`): `git log main --since --until --date=short`, tags
   for releases, merged PRs via `gh` when fast. Ranges ≤2 weeks: one sweep, no
   fan-out. Anything in git but missing from the journal is a journal gap —
   include it and say so.
4. **Optional signals** when present: `senses/` (PR/Slack/Notion context),
   burn (token/cost totals).
5. **Synthesize, in order:**
   - **Shipped** — by cluster; month-grouped for quarters.
   - **Impact** — top items; each names its kind (unblocked downstream /
     user-facing / toil removed) and why.
   - **Learned** — candidate entries for `memory/learnings.md`; propose them.
   - **Missed / parked** — honest list.
6. **Offer to save** to `journal/retros/<start>--<end>.md`, and write any
   weekly/monthly rollup a passed period boundary is missing.
