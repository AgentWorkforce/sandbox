---
status: active
owner: khaliq
updated: 2026-08-16
repos:
  - AgentWorkforce/relay
---

# Relayflow as a merge gate

Goal: every essential relay feature is verified before merge and on a schedule, running on any node, so a feature cannot break silently between releases.

## Now

The pieces exist and are not connected. Each gap below was checked, not assumed.

- **`workflows/verify-features.ts`** is the relayflow. It walks features tier by tier, records one structured result per check, and on failure raises a Slack alert, files a GitHub issue, attempts a fix on a branch and opens a draft PR with re-verified evidence. Its own header says it is "designed to run on a schedule (nightly or post-merge)".
- **`.agentworkforce/features/manifest.yaml` declares 194 features**, every one carrying a `verify_tier` (1–6) *and* a `location:` naming the code that implements it. Tier spread: 20 / 15 / 28 / 10 / 83 / 38.
- **`.github/workflows/detect-changes.yml`** already computes path-scoped outputs (`rust_changed`, `node_changed`, `sdk_swift_changed`) that other workflows gate on.

The gaps:

- **Relayflow is wired into no GitHub Action.** `git grep -l verify-features -- .github` returns nothing. It has never run as a pre-merge check, so a PR can break a declared feature and merge green.
- **The schedule lives outside the repo**, as `relay cloud schedule` state on one machine. Nothing in the repo declares it should run, so nothing notices if it stops.
- **"Runs on any node" is untested.** The header documents `relay node workflow run` but nothing exercises it, so it is a claim rather than a capability.

**The motivating case.** On 2026-08-15 the fleet stopped dispatching work for hours: the broker's readiness gate required Claude Code to render the literal string "Welcome back", Claude stopped rendering it, and every spawned agent sat idle holding a brief it was never handed. DMs died on the same path. **Every existing suite stayed green**, because `->pty:ready` short-circuits readiness before any heuristic runs and only `tests/e2e/fleet/nodes/stub-agent.cjs` emits it — the test double is more cooperative than any real harness, so fleet E2E never executed the code that broke. A feature check asserting *"a spawned agent receives its brief"*, measured at the recipient, would have caught it in one run.

**The enabler:** all 194 features already carry `location:`, so mapping changed paths to affected features is mechanical. This is a joining problem, not a new taxonomy.

## Next

1. **Wire relayflow into a GitHub Action as a pre-merge check.** Extend `detect-changes.yml` to join changed paths against manifest `location:` fields and emit the affected feature ids; run only the tiers those features belong to. Scoped per PR, full sweep on schedule, so the gate stays fast enough to be tolerated rather than disabled.
2. **Decide and write down what blocks a merge.** Tiers 1–2 (35 features) are plausible as blocking; tiers 5–6 (121) are probably report-only. An unbounded gate gets switched off the first time it is inconvenient, and a gate nobody can afford to enforce is not a gate.
3. **Make "any node" real.** Have the action dispatch the run to a fleet node via `relay node workflow run` rather than assuming cloud, and pick the node at runtime instead of pinning one. All four nodes now run a current broker (barry 11.6.6, finn-mini and sf-mini 11.6.5), so there is no longer a version reason to special-case where it executes.
4. **Declare the schedule in the repo** rather than as out-of-repo cron state, so a stopped schedule shows up in a diff.
5. **Add the durable check for the class that broke.** Assert at the recipient that a spawned agent receives its brief and that an agent-to-agent DM arrives — grep a unique marker out of the *recipient's* transcript, never a sender-side receipt. Sender receipts are exactly what hid `relay#1523` for a day.
6. **Make the test double stop lying.** Either `stub-agent.cjs` stops emitting `->pty:ready`, or coverage exists that does not, so the real readiness path is exercised. Until then "Fleet E2E green" carries no information about readiness.

## History

- **2026-08-16** — Elevated to active with the PR-check and any-node work as the immediate Next. All four fleet nodes brought to a current broker first (barry 11.5.1 → 11.6.6, verified at the control plane), removing version skew as a reason to pin the run to cloud. chief-broker remains on 11.5.4 pending a careful restart — see `open-threads.md`.
- **2026-08-16** — Filed after the fleet dispatch outage. Established that the relayflow, the 194-feature manifest with per-feature `location:`, and path-scoped change detection all already exist and are simply not joined; the missing piece is CI wiring plus an in-repo schedule, not new machinery.
