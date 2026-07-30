---
status: active
tldr: "Burn's owner is proving the software factory on a real release, currently blocked on one GitHub-integration reconnect from Will."
card: "Software Factory"
owner: burn
updated: 2026-07-29
repos: [burn, factory]
---
# burn — project owner + software factory proving ground

**Goal:** burn's development runs through the software factory
(`../factory` → `@agent-relay/factory`), proving the factory on a real
product; gaps found in burn get fixed in factory. The burn resident owns
both; reports to cpo (Will → chief → cpo → burn).

**Now:** owner seated and online (workspace-seeding recipe, fifth
clean boot). Bootstrap assignment dispatched: learn factory (pear = reference
implementation), set it up in burn, drive the **macos-v\* release item**
through it end-to-end — burn PR #495 merged the in-app macOS updater but no
`macos-v*` release exists, so the updater is dead on arrival. Item parks at
the publish gate: **no release/tag/registry publish without cpo
green-light.**

**Next:** burn's DONE report to cpo — factory-in-burn evidence + release
item at the gate + factory-gaps report (the findings are the point; they
become factory issues/PRs). Then cpo decides the release publish. Note for
the owner's triage: factory's local checkout has 3 dirty files
(README/package.json/lock), provenance unknown.

## History
- 2026-07-29 — Seated by Will ("get the factory setup for burn to test out
  a factory"; "the burn project owner should own the factory, basically").
  Subsumes the open-threads burn-updater item — now the factory's first
  work unit.
