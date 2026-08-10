---
status: active
owner: chief
updated: 2026-08-10
repos: [chief, relayfile]
---
# Chief onboarding

**Goal:** A new principal gets a working, observable Chief from one guided
command without understanding Relay's internal credentials or mount topology.

**Now:** The first real principal is live. Setup covers Cloud login, durable
workspace selection and convergence, principal profile creation,
Linear/GitHub connection checks, scoped senses, resident services, and a
readiness doctor. `npm run chief` is the interactive front door;
`npm run chief:view` and the Fleet/Factory web dashboards are observability
surfaces, not alternate Chief conversations. Factory control reuses the
resident senses credential while it is valid, so a transient token-mint outage
does not create a retry storm or break read-only status.

**Next:** Turn this proven operator path into the reusable default: eliminate
the remaining GitHub installation degradation, make the installed Relay MCP
binary the default instead of timeout-prone `npx`, restore RelayAuth capacity
through the gated #2857 rebuild, and package the same workspace/senses/doctor
sequence behind the guided onboarding command.

## History

- 2026-08-04 — Two of Chief's own status checks were lying, and both are fixed
  on branches awaiting review. `cloud` errored because Chief passed
  `--reveal-token` to an installed agent-relay 11.2.0 that predates the flag —
  verified against relay `main` (11.4.0) instead of the binary — which took out
  integrations, factory, and senses behind it. `senses` reported OK because a
  supervisor pid was alive while the mount had been stopped since 07-31 with an
  expired credential, so a four-day-old projection read as current. The doctor
  now gates senses on the mount and the credential and names the upstream
  failure. Onboarding lesson: a readiness check that asserts a process rather
  than a capability makes a new principal's first green run untrustworthy.
- 2026-07-30 — Production onboarding exposed an upstream capacity failure:
  RelayAuth health remained green while token persistence returned
  `D1_ERROR: Exceeded maximum DB size`. Factory status now prefers Chief's
  already-scoped, unexpired senses credential. Provider writeback remains
  correctly blocked until the separately gated #2857 D1 recovery is granted.
- 2026-07-30 — First onboarding hardening pass completed: principal files are
  tracked, Will's brain has a structural read-only boundary, doctor WARNs have
  next actions, dashboards are documented separately from interactive Chief,
  and Factory issue promotion/creation is declarative and idempotent.
- 2026-07-30 — First live run: resident Chief booted against
  `principals/khaliq` and reconstructed full context from files alone, no chat
  history. Friction found: (1) the whole profile-aware layer is untracked, so
  the active brain has no audit trail; (2) the repo holds two brains and the
  read-only boundary on Will's is convention, not enforced; (3) the doctor
  reports `integration:github` and `factory` as WARN with no next action, so a
  new principal cannot tell which warnings block work.
- 2026-07-30 — Defined the onboarding contract from Khaliq's real setup rather
  than a synthetic demo.
