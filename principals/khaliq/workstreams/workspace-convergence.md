---
status: active
owner: khaliq-chief
updated: 2026-07-30
repos: [chief, relay, cloud]
---
# Workspace convergence

**Goal:** One Agent Relay Cloud workspace durably identifies Khaliq's Chief and
team across Relaycast, Relayfile, and RelayAuth, including broker restarts.

**Now:** The configured `default` Cloud workspace resolves Relaycast,
Relayfile, and RelayAuth to one durable Relay workspace identity. Onboarding
and the doctor enforce that invariant. AR-448 dispatched three Relay agents
through the hosted Factory and completed successfully.

**Next:** Review and land AR-448's agent-owned GitHub work, then verify a broker
restart preserves the Chief address/mailbox and workspace history. RelayAuth
capacity recovery remains the prerequisite for fresh scoped credentials and
provider writeback.

## History

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
