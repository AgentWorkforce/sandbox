---
status: active
owner: khaliq-chief
updated: 2026-07-30
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
