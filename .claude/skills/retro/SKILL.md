---
name: retro
description: Look back over a week, month, quarter, or custom range and synthesize what shipped, what was impactful, and what was learned. Use when asked "what did we do this week/month/quarter", "recap", "retro", or "what's been impactful".
---

# /retro [week|month|quarter|since <date>]

1. **Resolve the brain:** read `chief.config.json`; every journal, memory, and
   workstream path below is relative to its `brainRoot`.
2. **Resolve the range.** Default: trailing 7 days. `month`/`quarter` mean
   trailing 30/90 days unless a calendar period is named.
3. **Journal first.** Read `<brainRoot>/journal/daily/` entries in range, rollups covering
   it, and any `journal/retros/` overlapping it. The journal is the curated
   record — primary source.
4. **Cross-check reality.** Fan out read-only subagents per repo cluster
   (map in `../CLAUDE.md`): `git log main --since --until --date=short`, tags
   for releases, merged PRs via `gh` when fast. Ranges ≤2 weeks: one sweep, no
   fan-out. Anything in git but missing from the journal is a journal gap —
   include it and say so.
5. **Optional signals** when present: `senses/` (PR/Linear context),
   burn (token/cost totals).
6. **Synthesize, in order:**
   - **Shipped** — by cluster; month-grouped for quarters.
   - **Impact** — top items; each names its kind (unblocked downstream /
     user-facing / toil removed) and why.
   - **Learned** — candidate entries for `memory/learnings.md`; propose them.
   - **Missed / parked** — honest list.
7. **Offer to save** to `<brainRoot>/journal/retros/<start>--<end>.md`, and write any
   weekly/monthly rollup a passed period boundary is missing.
