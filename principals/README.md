# Principals

One directory per principal. A principal's directory is their brain and is the
only place their Chief may write:

| Directory | Principal | Resident agent |
|---|---|---|
| `khaliq/` | Khaliq Gant | `khaliq-chief` (active, see `chief.config.json`) |
| `will/` | Will Washburn | not configured in this repo |

`chief.config.json` names exactly one active `brainRoot`. A Chief reads other
principals' directories for shared context and never writes them.

Each brain holds `memory/`, `journal/`, and `workstreams/`. Paths in
`CLAUDE.md`, the skills, and the scripts are all resolved relative to
`brainRoot`, so a brain can move between layouts without touching tooling.

`will/` moved here from the repo root on 2026-07-30, when the repo gained the
profile-aware layout. If Will's Chief runs from this repo, its `brainRoot` must
point at `principals/will`; nothing else references the old root paths.
