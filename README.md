# Chief

Chief is the front door to an agent team. It keeps durable context in
Markdown, sees human work in Linear and agent work in GitHub through Relayfile,
and dispatches ready work to the hosted Factory.

The operating model is deliberately simple:

```text
Human intent in Linear → Chief → Cloud Factory → agent work in GitHub
                                  ↓
                       checkpoints back to Linear
```

Linear stays legible to people. GitHub stays legible to agents. Chief
reconciles outcomes between them without copying every low-level task into
both systems, and no agent merges without explicit human approval.

## Set up

Prerequisites: `agent-relay`, `relayfile`, a Cloud login, and a Claude harness.

```bash
npm run setup
```

Onboarding:

1. Signs in to Agent Relay Cloud if needed.
2. Selects one canonical workspace and verifies that Relaycast, Relayfile, and
   RelayAuth resolve the same durable identity.
3. Creates the principal's isolated Markdown brain.
4. Verifies Linear and GitHub workspace connections.
5. Reuses an existing explicit Factory readiness label and verifies the hosted
   Factory brain. No Linear label-administration permission is required.
6. Verifies least-privilege access to only `/linear`, `/github`, and
   `/digests`.
7. Installs resident macOS services that keep those paths mounted in
   `senses/` and run the Relay node.
8. Runs a readiness doctor.

For repeatable or CI checks:

```bash
npm run setup -- --non-interactive --no-services
npm run doctor
```

## Talk to Chief

```bash
npm run chief
```

That attaches to the resident agent named by `chief.config.json`. You can also
DM that name from any Agent Relay session in the same workspace. Onboarding
rejects a workspace whose Relaycast, Relayfile, and RelayAuth identities have
drifted. Restart-stable resident-agent identity is the first Factory task, with
a stop/start regression test required before that stronger guarantee is made.

`npm run chief:view` opens a read-only local view. The web dashboards show
infrastructure rather than the Chief conversation:

- `https://agentrelay.com/cloud/dashboard/fleet` shows the current Relay node
  roster and socket/handler health.
- `https://agentrelay.com/cloud/dashboard/factory` shows Factory instance
  heartbeats, issue runs, dispatch, and completion telemetry.

Use `npm run chief` when you want to talk to Chief.

## Dispatch work

A Linear issue becomes Factory work only when all of these are true:

- title starts with `[factory]`;
- team is `AR`;
- label includes `factory-ready` (or the canonical `factory` equivalent);
- state is `Ready for Agent`;
- an optional recipe label selects `agent:single`, `agent:workflow`, or
  `agent:team`; without one, the configured default recipe is used;
- a repository-routing label such as `cloud`, `relay`, or `relayfile` is set.

Factory creates and coordinates GitHub-side work, then writes useful
checkpoints back to the Linear issue. It never merges.

GitHub issues mirrored into Linear can be promoted through the same durable
Relayfile writeback path used by Chief:

```bash
npm run factory:promote -- AR-445 relay single
npm run factory:promote -- AR-449 cloud,relay team
npm run factory:create -- factory-tasks/cloud-2872-workflow-schedule-lifecycle.json
```

The command adds missing readiness, route, and recipe labels, prefixes the
title, moves the issue to `Ready for Agent`, waits for the provider-backed
mount to converge, and is idempotent on rerun. Declarative task specs use the
same checks and make cross-repository team work auditable before dispatch.

## Layout

| Path | Purpose |
|---|---|
| `chief.config.json` | Active principal, workspace, scopes, and work policy |
| `CLAUDE.md` | Chief's persona and operating manual |
| `principals/<name>/` | Active principal's memory, journal, and workstreams |
| `senses/` | Scoped Relayfile projection (gitignored) |
| `teams.json` | Resident Agent Relay roster |
| `scripts/` | Onboarding, doctor, mount supervisor, and attach commands |

The historical root `memory/`, `journal/`, and `workstreams/` remain an earlier
profile. The active brain is always the `brainRoot` in `chief.config.json`.
