# Daytona fleet-node lifecycle investigation

Owner: `daytona-lifecycle-lead`
Started: 2026-08-08 22:37 Europe/Oslo
Reports to: `chief-khaliq`

## Constraints

- Never merge or push a default branch.
- Do not restart, upgrade, re-enrol, or release any node or agent.
- Do not run `agent-relay update`.
- Do not inspect full process arguments; only `pid,lstart,comm` is permitted.
- Do not touch paused webhook queues (`cloud#2917`).
- Do not print or commit secrets.
- Push every completed increment and send aliveness DMs about every 15 minutes.

## Checkouts

- Cloud: `/Users/khaliqgant/Projects/AgentWorkforce/chief/.worktrees/daytona-cloud`
  - branch: `codex/daytona-lifecycle-investigation`
  - based on fresh `origin/main` at `c24c4c08e`
- Relay: `/Users/khaliqgant/Projects/AgentWorkforce/chief/.worktrees/daytona-relay`
  - branch: `codex/daytona-lifecycle-investigation`
  - based on fresh `origin/main` at `7a42f3bd5`
- The existing Cloud checkout was dirty and 74 commits behind; it was not modified.

## Timeline and findings

- 2026-08-08T20:37:17Z: Initial aliveness DM delivered to `chief-khaliq`.
- Veto tools named by workspace instructions were not exposed in this session; noted before repository discovery.
- Both required repositories are available in isolated, current feature-branch worktrees.
- `cloud#2946` detaches slow Daytona provisioning from the request lifetime. It addresses cold-create cancellation and does not explain a sandbox that was already enrolled and heartbeating.
- Relay `v11.4.0` sends fleet heartbeats every 12 seconds. The server node liveness TTL is 45 seconds and its sweep alarm runs every 30 seconds. A 39-second created-to-last-heartbeat span is compatible with several accepted heartbeats; it is not the sandbox lifetime.
- Relay spawn completion and action-invocation settlement do not release a worker. Release is a distinct fleet action. The proposed invocation-settlement shared cause is therefore refuted by the execution paths.
- Previous fleet evidence found agent processes still alive after their records changed status during WebSocket resets/bulk expiry. That mechanism is not presently evidenced for the historical Daytona node.
- The checked-in fleet enrollment path does not tear down a successful sandbox. A generic smoke harness deletes its own sandbox in `finally`, but it never performs fleet enrollment. Retained evidence had not identified which path created the historical node.
- Read-only Daytona access is available through the existing 1Password item without printing the credential. Current inventory has two unrelated running sandboxes; neither was touched. The organization audit endpoint is available and is being used to correlate the historical create/delete actor.
- 2026-08-08T20:49:30Z: Progress/aliveness DM delivered to `chief-khaliq`.
- Daytona audit correlation for 2026-08-05 found 151 sandbox creates, all workforce-deployment calls from `sdk-typescript/0.0.0`; there was no create from the fleet bridge's pinned legacy SDK 0.180.0. No delete near the node heartbeat/TTL transition belongs to a fleet sandbox. The two deletes at 20:23:56Z and 20:24:14Z were `duet-inbox-a/b` deployments created four hours earlier.
- The generic smoke harness's explicit `delete` would be audited, so it did not tear down the recorded fleet node. The node was enrolled inside a pre-existing runtime or outside the identifiable Daytona create path; no mapping/log survives.
- A disposable, non-enrolled Daytona probe used SDK 0.180.0, the Relay 11.4.1 snapshot, and `autoStopInterval: 0`. A child using Relay's detached/unref pattern stayed alive with the sandbox started at 0, 15, 35, 45, 60, and 75 seconds. The diagnostic sandbox was then explicitly deleted. No node or agent was enrolled, restarted, or released.
- Rescued the prior unpushed Phase 1 diagnostic branch in a third isolated worktree: `/Users/khaliqgant/Projects/AgentWorkforce/chief/.worktrees/daytona-cloud-phase1`, branch `codex/2656-daytona-phase1-harness`, stacked on the head of `cloud#2946`.
- Added a durable investigation note to that branch and removed argv inspection from the bootstrap's process inventory; it now emits only PID, start time, and executable name.
- Pushed branch `codex/2656-daytona-phase1-harness` at `3185d138f` and opened stacked Cloud PR `#2963` (`Instrument Daytona fleet-node lifecycle`) against the `cloud#2946` head. GitHub reports it CLEAN and MERGEABLE; initial applicable CI and CodeRabbit checks passed.
- Local verification passed: six liveness-observer tests, guarded persisted-enrollment restart proof, 17-case reaper guard proof, shellcheck, diff whitespace check, added-line argv scan, and secret-pattern scan.
- Veto MCP tools remained unavailable, so the requested `veto_diff_review` could not be invoked; local and GitHub checks above are the available substitute evidence.

## Current verdict

- Historical Daytona death mechanism: **unknown**. Audit and a current isolated probe rule out the checked-in smoke harness's explicit teardown and the command-session settlement reaper. The 39-second inference is incorrect.
- Shared cause with spawned-lane deaths: **not supported**. The invocation-settlement candidate is refuted; retained spawned-lane evidence points to registry/WebSocket status mutation while processes remained alive.
