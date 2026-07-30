---
name: digest
description: Write today's journal entry — sweep the repos for the last day's activity and update touched workstreams. Use when asked to "run the digest", "journal today", or as an end-of-day wrap; also designed to run headless on a schedule.
---

# /digest

1. **Resolve the brain:** read `chief.config.json`; every journal, memory, and
   workstream path below is relative to its `brainRoot`.
2. **Window:** since the newest `<brainRoot>/journal/daily/` entry; default
   trailing 24h.
3. **Sweep:** `git log main --since --date=short` across the sibling repos
   (map in `../CLAUDE.md`), merged PRs via `gh` when fast, `senses/` if
   mounted. Skip silent repos.
4. **Write `<brainRoot>/journal/daily/YYYY-MM-DD.md`** in the CLAUDE.md format
   (frontmatter `date`/`repos`/`tags`; Shipped / Learned / Decided /
   In flight; omit empty sections). One entry per day — extend today's file if
   it exists.
5. **Update touched workstreams:** History line + `updated`; adjust Now/Next
   where reality moved.
6. **Flag surprises** — red CI, stalled PRs, unexpected activity — into
   `<brainRoot>/memory/open-threads.md` and mention them in the reply.
7. Fridays and month-ends: also write the missing `<brainRoot>/journal/weekly/`
   or `<brainRoot>/journal/monthly/` rollup.
