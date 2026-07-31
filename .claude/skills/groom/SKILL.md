---
name: groom
description: Brain grooming pass — curate memory/ and workstreams/ so a fresh reader sees only what IS. Strips journey narration, merges duplicates, drops resolved threads. Use when asked to "groom the brain", "clean up memory", or as a scheduled headless pass.
---

# /groom — brain grooming pass

Curate chief's standing notes so a fresh reader sees only what IS.

Scope (resolve `brainRoot` from `chief.config.json` first): the brainRoot's
`memory/*.md` and `workstreams/*.md`. NEVER its `journal/` (append-only
history) and never files outside the chief repo.

1. If `git status` shows uncommitted changes under memory/ or workstreams/,
   exit immediately without touching anything — the resident is mid-write;
   the next cycle catches up.
2. Read every file in scope. Rewrite for a reader with zero context:
   - Declarative present tense: describe current state, never how it got
     here. Git history holds provenance.
   - Strip meta-commentary: "(added today)", "re-emphasized same day",
     "revised twice", "(2026-07-29 restart)" and similar journey narration.
   - Convert relative dates ("today", "this morning", "same day") to
     absolute dates; drop dates that don't change behavior.
   - Merge duplicates; delete resolved or obsolete open-threads entirely —
     a resolved thread is removed, not annotated as resolved.
   - Workstream `## History` sections are dated logs — keep them, but keep
     frontmatter `updated` accurate and Now/Next clean, current, and short.
   - Shorter is better. Accuracy beats completeness.
3. Commit with a plain one-line message describing what was groomed. If
   nothing needed change, commit nothing and exit.
