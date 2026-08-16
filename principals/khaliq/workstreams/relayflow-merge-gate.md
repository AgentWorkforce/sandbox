---
status: active
owner: khaliq
updated: 2026-08-16
repos:
  - AgentWorkforce/relay
---

# Relayflow as a merge gate

Goal: every essential relay feature is verified continuously and before merge, on any node, so a feature cannot break silently between releases.

## Now

The pieces exist and are not connected.

- **`workflows/verify-features.ts`** is the relayflow. It walks features tier by tier, records one structured result per check, and on failure raises a Slack alert, files a GitHub issue, attempts a fix on a branch and opens a draft PR with re-verified evidence. Its own header says it is "designed to run on a schedule (nightly or post-merge)".
- **`.agentworkforce/features/manifest.yaml` declares 194 features**, every one carrying both a `verify_tier` (1–6) and a `location:` pointing at the code that implements it. Tier spread: 20/15/28/10/83/38.
- **`.github/workflows/detect-changes.yml`** already computes path-scoped outputs (`rust_changed`, `node_changed`, `sdk_swift_changed`) that other workflows gate on.

The gaps, each verified rather than assumed:

- **Relayflow is wired into no GitHub Action.** `git grep -l verify-features -- .github` returns nothing. It has never run as a pre-merge check, so a PR can break a declared feature and merge green.
- **The schedule lives outside the repo.** It runs via `relay cloud schedule workflows/verify-features.ts --cron ...`, which is imperative state on one machine. Nothing in the repo declares that it should run, so nothing notices if it stops.
- **It is cloud-bound in practice.** The header documents `relay node workflow run` as an alternative, but that path is not exercised by anything, so "runs on any node" is untested rather than supported.

**Why this is now a priority, and the case that proves it.** On 2026-08-15 the fleet stopped dispatching work entirely for hours: the broker's readiness gate required Claude Code to render the literal string "Welcome back", Claude stopped rendering it, and every spawned agent sat idle holding a brief it was never handed. DMs died on the same path. **Every existing suite stayed green throughout**, because `->pty:ready` short-circuits readiness before any heuristic runs and only `tests/e2e/fleet/nodes/stub-agent.cjs` emits it — the test double is more cooperative than any real harness, so fleet E2E never executed the code that broke. A feature-level check that asserts *"a spawned agent receives its brief"*, measured at the recipient, would have caught it in one run.

**The enabler:** all 194 features already carry `location:`. Mapping changed paths to affected features is therefore mechanical — it does not require inventing a taxonomy, only joining two things that already exist.

## Next

1. **Add a durable check for the class that broke.** Assert at the recipient that a spawned agent receives its brief and that an agent-to-agent DM arrives — grep a unique marker out of the *recipient's* transcript, never a sender-side receipt. Sender receipts are exactly what hid `relay#1523` for a day.
2. **Make the test double stop lying.** Either `stub-agent.cjs` must stop emitting `->pty:ready`, or coverage must exist that does not, so the real readiness path is exercised. Until then "Fleet E2E green" carries no information about readiness.
3. **Wire relayflow into a GitHub Action as a pre-merge check**, gated on `detect-changes.yml` outputs joined to manifest `location:` fields: a PR touching a path that implements feature X runs the tier that verifies X. Full sweep on schedule, scoped sweep per PR, so the gate stays fast enough to be tolerated.
4. **Declare the schedule in the repo** rather than as out-of-repo cron state, so a stopped schedule is visible in a diff.
5. **Make "runs on any node" real** by exercising `relay node workflow run` in CI, not only `relay cloud schedule`. A documented alternative that nothing runs is a claim, not a capability.
6. **Decide what blocks a merge.** Tiers 1–2 (35 features) are plausible as blocking; tiers 5–6 (121) are probably report-only. Write that policy down — an unbounded gate gets disabled the first time it is inconvenient, and a gate nobody can afford to enforce is not a gate.

## History

- **2026-08-16** — Filed after the fleet dispatch outage. Established that the relayflow, the 194-feature manifest with per-feature `location:`, and path-scoped change detection all already exist and are simply not joined; the missing piece is CI wiring plus an in-repo schedule, not new machinery. Recorded the outage as the motivating case: every suite stayed green while the fleet could not dispatch any work at all.
