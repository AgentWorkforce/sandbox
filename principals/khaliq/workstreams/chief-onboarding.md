---
status: active
owner: khaliq-chief
updated: 2026-07-30
repos: [chief, relayfile]
---
# Chief onboarding

**Goal:** A new principal gets a working, observable Chief from one guided
command without understanding Relay's internal credentials or mount topology.

**Now:** Setup covers Cloud login, workspace selection and convergence,
principal profile creation, Linear/GitHub connection checks, scoped senses,
resident services, and a readiness doctor.

**Next:** Close the three friction items from the first live run — commit the
untracked profile, resolve the two-brain boundary, and make the doctor's
integration WARNs actionable — then treat the flow as the reusable default.

## History

- 2026-07-30 — First live run: resident Chief booted against
  `principals/khaliq` and reconstructed full context from files alone, no chat
  history. Friction found: (1) the whole profile-aware layer is untracked, so
  the active brain has no audit trail; (2) the repo holds two brains and the
  read-only boundary on Will's is convention, not enforced; (3) the doctor
  reports `integration:github` and `factory` as WARN with no next action, so a
  new principal cannot tell which warnings block work.
- 2026-07-30 — Defined the onboarding contract from Khaliq's real setup rather
  than a synthetic demo.
