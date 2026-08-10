# Issue 306 persona spawn lane

## Status

- Worker: `workforce-306-persona-spawn`
- Broker: `chief-khaliq`
- Scope: workforce, relay, relayflows; pear is reference-only.
- Veto MCP tools are not exposed in this session.

## Checkout safety

- All four required repositories are available.
- Shared workforce and relayflows checkouts contained unrelated untracked/deleted files.
- Created isolated worktrees from current `origin/main` for workforce, relay, and relayflows on branch `codex/issue-306-persona-spawn`.
- No shared-worktree changes were modified.

## Issue history read

- The initial claim that personas cannot run non-interactively was corrected.
- The pear implementation was then proposed as a port, but that advice was explicitly overridden because it shells out to the TTY-oriented CLI and scrapes output.
- The active requirement is an SDK-only implementation for Agent Relay fleet spawn and Relayflow agents, with node-scoped launch coalescing and registration plus harness-readiness verification.

## Initial architecture findings

- Relay MCP `spawn` currently requires `name` and `cli`, forwards free-text `task`, and only acknowledges the asynchronous action invocation.
- Relay fleet `spawn(harness)` builds an `AgentSpec` and delegates to `NodeHandlerContext.spawnAgent`; default nodes advertise `spawn:<cli>` capabilities.
- Workforce `defineWorkforcePersonaNode` already calls `deploy()` in process with `mode: dev`, `detach`, `bridged`, and `noPrompt`, but it binds one proactive event persona to a `run-event` action.
- Workforce `deploy()` currently preflights only cloud-enabled event personas with `onEvent`; it does not launch ordinary interactive personas such as `nango-integrations`.
- The full registry cascade is currently implemented inside CLI `local-personas.ts` and resolves to a merged `PersonaSpec`; it is not exposed as a reusable SDK.
- Relayflows currently requires `AgentDefinition.cli`, spawns through its older Relay harness driver, and has no workforce dependency.

## Implemented design

- Workforce adds `@agentworkforce/persona-registry`, moving the CLI registry loader behind a reusable `resolvePersonaReference()` SDK while retaining a compatibility re-export for existing CLI imports.
- Workforce local-surface adds `defineWorkforcePersonaSpawnNode()` / `workforcePersonaSpawnCapability()`. It resolves and prepares interactive personas with `persona-kit`, keeps skills/MCP/sidecars in an isolated mount, layers the concrete task separately, and coalesces node + project + persona launches.
- Persona fleet spawns carry a typed broker contract requiring node registration and `worker_ready` verification.
- Relay MCP `spawn` accepts exactly one of `cli` or `persona`. Persona requests route through `spawn:persona`, poll the outer action to a terminal result, and point callers to the local-surface node helper.
- Relay broker holds verified capacity action results until `worker_ready`; early exit, timeout, explicit release, registration failure, or process-launch failure resolves the action as failed and removes the authoritative registration.
- Relay harness handles expose replay-correct `waitForReady()`.
- Relayflows accepts `persona` instead of CLI/role, resolves through the Workforce registry, prepares with `persona-kit`, takes harness/model from the spec, layers the step task separately, verifies broker inventory plus `worker_ready`, and releases/tears down staging on failure.

## Verification so far

- Workforce registry tests: exit 0.
- Workforce local-surface tests: exit 0.
- Existing Workforce CLI persona tests: exit 0.
- Relay MCP/readiness targeted tests: exit 0.
- Relay harness-driver and fleet builds: exit 0; CLI typecheck: exit 0.
- Relay broker check: exit 0; targeted metadata-contract Rust test: 1 passed, 0 failed.
- Relayflows core typecheck and targeted registry/builder/runner tests: exit 0.
- Relayflows clean install cannot include `@agentworkforce/persona-registry` until the workforce package is published; the local stacked build uses the workforce worktree artifact.

## Remaining

- Commit, push feature branches, and open three non-merge PRs referencing issue 306.

## Final review additions

- Fleet now distinguishes real `spawn(...)` shadows from plain actions named `spawn:*`; `spawn:persona` delegates to the resolved harness instead of a synthetic `persona` harness.
- Verified broker launches have a 90-second deadline, release and deregister before failure, and reject duplicate live/pending names.
- Persona mounts enable SDK-owned autosync, wait for watcher setup, and final-flush before teardown; the real autosync regression test passes.
- Exact JSON persona paths are a dedicated highest-priority registry layer, even when the project contains a same-id persona.
- The new registry package is included in Workforce publish and verify workflows.
- Release order is Relay 11.5+, then Workforce 4.1.38+, then Relayflows; dependency locks intentionally describe unpublished upstream versions and must be refreshed after publication.

## Final verification snapshot

- Workforce persona-kit: 301 passed; registry: 3 passed; local-surface: 11 passed; existing CLI persona tests: exit 0; CLI build and release-workflow tests: exit 0.
- Relay: 860 broker tests passed with 4 ignored; 53 focused TypeScript tests passed; harness-driver/fleet builds and CLI typecheck passed.
- Relayflows: core typecheck and 79 changed-path tests passed. Full core suite: 805 passed and 8 failed because the checkout lacks `tsx` and those baseline run-script tests invoke `npx tsx` (exit 127); this is recorded as a failing check, not a pass.
- Veto tools were not exposed in this environment; manual staged diff, whitespace, secret-pattern, and home-path scans found no staged issues.

## Pull requests

- Relay draft: https://github.com/AgentWorkforce/relay/pull/1464 — 43 successful checks, 0 pending/failing, 1 skipped.
- Workforce draft: https://github.com/AgentWorkforce/workforce/pull/307 — 2 successful checks, 0 pending/failing. An initial missing future lock entry failed; the follow-up uses the published 11.4 range plus a Relay 11.5 runtime feature marker, and the rerun passed.
- Relayflows draft: https://github.com/AgentWorkforce/relayflows/pull/28 — its single configured check succeeded; the PR body records the local full-suite `tsx` failures and unpublished Workforce dependency blocker.
- No PR was merged. All three local feature branches are clean and match their origins.
