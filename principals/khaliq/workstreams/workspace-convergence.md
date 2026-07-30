---
status: active
owner: khaliq-chief
updated: 2026-07-30
repos: [chief, relay, cloud]
---
# Workspace convergence

**Goal:** One Agent Relay Cloud workspace durably identifies Khaliq's Chief and
team across Relaycast, Relayfile, and RelayAuth, including broker restarts.

**Now:** The configured `default` workspace resolves all three data planes to
the same `rw_` identity. Onboarding and the doctor enforce that invariant.

**Next:** Stop and restart the resident broker, verify the Chief address and
workspace remain stable, then file the RelayAuth native delegated-mint repair
as the first platform issue.

## History

- 2026-07-30 — Invariant holds at boot: all three planes resolve to one `rw_`
  identity under the `default` workspace. The restart verification is left for
  Khaliq to trigger — stopping the broker terminates the resident Chief, so it
  is not a self-service action.

- 2026-07-30 — Confirmed the canonical Cloud workspace carries one unified
  Relaycast/Relayfile/RelayAuth identity; made mismatch a blocking setup error.
