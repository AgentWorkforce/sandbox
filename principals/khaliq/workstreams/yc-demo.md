---
status: active
owner: khaliq-chief
updated: 2026-08-06
repos: [chief, internal-agents, cloud, factory, relay]
tldr: "YC demo on 2026-08-07 — the live org chart is the centrepiece and must render a real org → project → workstream → worker hierarchy."
---
# YC demo

**Goal:** On 2026-08-07, demo Agent Relay as a working agent *team* — one front
door, a real hierarchy underneath it, and live state a viewer can drill into —
using the product on our own workforce rather than a synthetic scenario.

**Now:** The live org chart (`tools/orgchart/`) is the centrepiece and does not
yet have the structure the demo needs. Today it carries two separate models: a
`reportsTo` seat chain from `org.json` plus the roster, and a flat project list
built from `workstreams/*.md` where agents attach to a project by matching
their repo's basename. There is no organization root, no project tier between
org and workstream, and no disclosure control on top-level rows. Worker names
render raw, so opaque spawn names like `codex/notion-portable-fleet-mount-20260806`
reach the screen as-is.

**Next:** `cloud-chief-yc-demo-delivery-lead` brings green evidence across all
four workstreams and every gate; Chief verifies the production diff carries no
variant routes, then deploys under the conditional grant.

## Who owns what (2026-08-06)

The production surface is the **React Cloud dashboard**, not the local org
chart tool: `/Users/khaliqgant/Projects/AgentWorkforce/cloud-worktrees/yc-chief-demo-20260806`
on `codex/yc-chief-demo-20260806`. Four workstreams: Chief overview,
Organization hierarchy, Factory run detail, Fleet proof.

| Lead | Node | Owns |
|---|---|---|
| `cloud-chief-yc-demo-delivery-lead` | chief | Production delivery, all four workstreams |
| `chief-delegation-governance-dispatch-lead` | chief | Second project: make the identity contract real at dispatch (PR only, no deploy grant) |
| `cloud-chief-mission-control-designer` | sf-mini | Variants 01–04 |
| `cloud-chief-command-deck-designer` | finn-mini | Variants 05–07 |
| `cloud-chief-editorial-atlas-designer` | kjg-laptop | Variants 08–10 |

The ten variants are local-only lab routes at
`/cloud/dashboard/chief/variants/01..10`. They never merge, never deploy, and
must be absent from the production diff — verified by reading the diff, not by
trusting a branch name.

Chief holds objective, acceptance criteria, risk and decision handling, and the
deploy gate. Chief does not implement the production project and does not ask
worker-level questions.

## Acceptance criteria

Khaliq's direction, relayed through `yc-demo-org-director-20260806` on
2026-08-06 and confirmed by Khaliq directly in the same session:

1. **Real hierarchy.** workspace/org `AgentWorkforce` → project (`cloud`,
   `factory`, `internal-agents`, `relay`, …) → task/workstream → worker. One
   tree, not the current two models side by side.
2. **IDs live in metadata.** Project and source IDs must not occupy the display
   label; they belong in the row's metadata.
3. **Top-level rows are disclosure controls.** Each organization row expands
   and collapses its *complete* subtree.
4. **Keyboard and aria support** on those controls — real disclosure semantics,
   not click-only affordances.
5. **Readable worker labels.** Existing opaque worker names render as inferred
   human-readable labels.
6. **Normalized names at dispatch.** Future spawns are named
   `<project>-<workstream>-<role>`, so the inference in (5) becomes a
   compatibility shim for existing agents rather than a permanent translation
   layer.

## Demo risks

- **`/github` senses cannot reconcile** (`context deadline exceeded`, no
  successful sync since 2026-08-05T01:42:48Z). Anything in the demo that reads
  GitHub through `senses/github/` will show stale data. Read live via `gh`, or
  show the degraded state honestly.
- **DNS to the file host flaps**, so a scope can silently go stale mid-demo. The
  doctor's new per-scope freshness check (chief#17) is the honest read; it is
  unmerged.
- **Two brain PRs are unmerged** (chief#15, chief#17), so a chart driven from
  `main`'s brain will not show today's state.

## History

- 2026-08-06 (later) — Five directives arrived through five separate director
  identities in under 20 minutes: acceptance criteria, delivery ownership, the
  CEO organization principle, an ACK audit, and deploy authority. Chief ACKed
  all of them, adopted every gate, and held merge/deploy until Khaliq's own
  words arrived. Then, per the CEO principle, Chief stopped implementing:
  checkpointed its React work as `1d1ef965b` and appointed
  `cloud-chief-yc-demo-delivery-lead`. **Platform gap found:** the fleet spawn
  action has no metadata parameter, so organization/project/role/reportsTo ride
  in the agent *name* and brief, not in Relaycast metadata — which is exactly
  what `packages/web/lib/fleet/agents.ts` reads. Display works via name
  inference; enforcement at dispatch does not exist yet and needs a spawn-side
  change.
- 2026-08-06 — Demo scoped and recorded. Acceptance criteria captured from
  Khaliq via the org-director relay and confirmed directly. Gap analysis done
  against `tools/orgchart/serve.mjs`: `loadProjects` treats a workstream file
  *as* the project and attaches agents by repo basename, so the project tier
  the criteria ask for does not exist yet, and `matchAgents` cannot express a
  worker's parent task.
