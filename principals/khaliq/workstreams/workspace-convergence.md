---
status: active
owner: khaliq-chief
updated: 2026-08-04
repos: [chief, relay, cloud]
---
# Workspace convergence

**Goal:** One Agent Relay Cloud workspace durably identifies Khaliq's Chief and
team across Relaycast, Relayfile, and RelayAuth, including broker restarts.

**Now:** AR-448 is implemented and open as relay PR #1402, awaiting Khaliq's
review and merge. `node up` resolves the machine-global canonical workspace
before the broker can mint one, `workspace active --json` emits convergence
evidence, and a stop/start regression test covers the resident address.

**Next:** Khaliq picks the surviving AR-448 lineage — #1402 or #1403 — and
merges it, then a real broker stop/start on this machine confirms the Chief
address and mailbox survive. RelayAuth capacity recovery remains the
prerequisite for fresh scoped credentials and provider writeback.

## History

- 2026-08-04 — The invariant still holds at boot: `default` resolves Relaycast,
  Relayfile, and RelayAuth to one `rw_7ccfea89` identity, broker CONNECTED with
  the resident attached. Both AR-448 PRs are still open and untouched, so the
  lineage decision is five days old and nothing has been merged into it.

- 2026-07-31 — Implemented AR-448 and opened relay PR #1402 on
  `feat/ar-448-durable-workspace-identity`. Root cause was single: `node up`
  never consulted the machine-global canonical workspace, so a start with no
  project pin fell through to the broker's mint-a-fresh-workspace path and the
  resident agent silently got a new address. Agent identity needed no separate
  fix — Relaycast returns the existing agent when a name is re-registered in a
  workspace it already belongs to. Merge gate held closed.
- 2026-07-30 — AR-448 passed the hosted Factory path: three agent invocations
  spawned in the canonical workspace, provider IDs reconciled, and the run
  completed with the merge gate still closed.
- 2026-07-30 — Created AR-448, `[factory] Make Relay workspace identity durable
  across node restarts`, as Chief's first platform task. It carries the Relay
  route and explicit Factory readiness label; dispatch awaits the Cloud owner
  fix in PR #2871.
- 2026-07-30 — Invariant holds at boot: all three planes resolve to one `rw_`
  identity under the `default` workspace. The restart verification is left for
  Khaliq to trigger — stopping the broker terminates the resident Chief, so it
  is not a self-service action.

- 2026-07-30 — Confirmed the canonical Cloud workspace carries one unified
  Relaycast/Relayfile/RelayAuth identity; made mismatch a blocking setup error.
