# Principals

One directory per principal. A principal's directory is their brain and is the
only place their Chief may write:

| Directory | Principal | Resident agent |
|---|---|---|
| `khaliq/` | Khaliq Gant | `chief-khaliq` (staged in `chief.config.khaliq.json`; regenerate the local config to adopt) |
| `will/` | Will Washburn | `chief` today; renames to `chief-will` (+ its voice to `voice-will`) at the org-workspace join boundary |

**Naming convention:** principal-scoped seats are `<role>-<principal>`
(`chief-will`, `chief-khaliq`, `voice-will`); org and department seats stay
role-named (`cpo`, `relay`, …). Both chiefs join the same org workspace and
coordinate as peers by DM.

`chief.config.json` names exactly one active `brainRoot`. A Chief reads other
principals' directories for shared context and never writes them.

Each brain holds `memory/`, `journal/`, and `workstreams/`. Paths in
`CLAUDE.md`, the skills, and the scripts are all resolved relative to
`brainRoot`, so a brain can move between layouts without touching tooling.
