# Chief

Chief is the front door to an agent team. It keeps durable context in
Markdown, sees human work in connected surfaces through Relayfile, and
dispatches ready work to the hosted Factory.

The operating model is deliberately simple:

```text
Human intent on configured surface → Chief → Cloud Factory → agent work in GitHub
                                          ↓
                         checkpoints back to the source surface
```

The source surface stays legible to people. GitHub stays legible to agents.
Chief reconciles outcomes without copying every low-level task into every
system, and no agent merges without explicit human approval.

## Set up

Prerequisites: `agent-relay`, `relayfile`, a Cloud login, and a Claude harness.

```bash
npm run setup
```

### Upgrade an existing Chief

The v1 two-file setup remains readable during the migration window. Pulling
this version does not rewrite `teams.json`, change the selected workspace, or
widen Relayfile scopes.

```bash
npm run config:migrate                 # read-only preview
npm run config:migrate -- --write      # backup and convert teams.json
```

`chief.config.json` is left untouched for rollback. Existing deployments can
continue on v1 until their principal intentionally runs the write step.

Chief also owns one active Factory dispatch contract at
`<chief>/factory.config.json`, generated from the committed
`factory.<principal>.config.json` variant. Factory does not discover contracts:
start it with the Chief-owned path explicitly.

```bash
factory start --mode live --config /absolute/path/to/chief/factory.config.json
```

Chief services export `FACTORY_CONFIG_PATH` and `CLONE_ROOT`; an interactive
shell may instead use the literal `<chief>/factory.config.json` path.

Onboarding:

1. Signs in to Agent Relay Cloud if needed.
2. Selects one canonical workspace and verifies that Relaycast, Relayfile, and
   RelayAuth resolve the same durable identity.
3. Creates the principal's isolated Markdown brain.
4. Verifies every provider connection declared by the active senses paths.
5. Reuses the active contract's explicit Factory readiness label and verifies
   the hosted Factory brain. No label-administration permission is required.
6. Verifies least-privilege access to only the configured provider paths and
   `/digests`. Khaliq's active profile reads Notion, reads GitHub, and reads and
   writes Linear.
7. Installs resident macOS services that keep those paths mounted in
   `senses/`, run the Relay node, and continuously verify roster and message
   liveness with the fleet watchdog.
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

That attaches to the resident agent named by the active `teams.json`. You can also
DM that name from any Agent Relay session in the same workspace. Onboarding
rejects a workspace whose Relaycast, Relayfile, and RelayAuth identities have
drifted. The watchdog pages on a missing roster resident, a blind Relaycast
monitor, or a renamed successor taking over from the canonical Chief.
Restart-stable resident-agent identity is the first Factory task, with a
stop/start regression test required before that stronger guarantee is made.

`npm run chief:view` opens a read-only local view. The web dashboards show
infrastructure rather than the Chief conversation:

- `https://agentrelay.com/cloud/dashboard/fleet` shows the current Relay node
  roster and socket/handler health.
- `https://agentrelay.com/cloud/dashboard/factory` shows Factory instance
  heartbeats, issue runs, dispatch, and completion telemetry.

Use `npm run chief` when you want to talk to Chief.

### Deploy Khaliq's Cloud Chief

`chief-khaliq` also has an event-driven Cloud deployment unit for customer
conversation surfaces. It is separate from the resident Relay node: Slack app
mentions and Telegram bot messages provision a sandbox for one trigger, and
the reply is written back to the same Slack thread or Telegram message.

The bundle contains an explicit Khaliq-only context allowlist read from a
reviewed commit on the Chief repository's `main` branch. It does not upload the
repository, the working tree, other principal profiles, journals, customer
data, secrets, or unrelated factory/integration configuration.

```bash
npm run cloud:deploy:khaliq:dry-run  # validate only; no side effects
npm run cloud:compile:check          # deterministic local bundle verification
npm run cloud:deploy:khaliq          # deploy this one tenant agent after review
```

The last command deploys only `chief-khaliq`; it is not a whole-team atomic
deployment. See `docs/cloud-chief-khaliq.md` for provenance and surface details.

## Open the workforce cockpit

```bash
npm run orgchart
open http://127.0.0.1:4780
```

The cockpit is runtime-derived:

- `teams.json` always selects the active principal and declared resident
  roster;
- the local Agent Relay broker contributes agents that are actually running;
- Agent Relay Cloud contributes the hosted execution layer and enrolled fleet
  nodes, including Mac minis, capabilities, tags, versions, and active-agent
  counts;
- `tools/orgchart/org.json` is only an optional hierarchy overlay when its
  principal matches the active roster. A Will overlay is ignored when Khaliq's
  roster is active.

Organization and execution are intentionally separate tabs. People and agents
form the reporting tree; Cloud and enrolled machines provide execution capacity.
The cockpit refreshes both from live state, and View/Drive is enabled only for
agents attached to this local broker.

## Dispatch work

The active `factory.config.json` selects the source. A GitHub-native issue is
ready only when it is open and carries the configured readiness label. Under a
Linear-native contract, an issue becomes Factory work only when all of these
are true:

- title starts with `[factory]`;
- team is `AR`;
- label includes `factory-ready` (or the canonical `factory` equivalent);
- state is `Ready for Agent`;
- an optional recipe label selects `agent:single`, `agent:workflow`, or
  `agent:team`; without one, the configured default recipe is used;
- a repository-routing label such as `cloud`, `relay`, or `relayfile` is set.

Factory creates and coordinates GitHub-side work, then writes useful
checkpoints back to the configured source. It never merges.

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

The exact page-to-project bootstrap mappings authorized for the current Notion
backlog live in `factory-intake/notion-tonight.json`. Factory owns the parser,
privacy gate, idempotency, GitHub publication, and exact-path fleet dispatch;
Chief owns only this operator-specific routing data and the read-only mount.
Exact-path destinations must name the fleet node that owns the absolute path;
`self` is intentionally unpinned and allows least-loaded placement.

## Layout

| Path | Purpose |
|---|---|
| `teams.<principal>.json` | The principal, the resident agent roster, senses scopes, and recipe choice |
| `factory.<principal>.config.json` | Committed variant of Chief's Factory dispatch contract |
| `factory.config.json` | Generated per-machine active contract passed explicitly to Factory |
| `CLAUDE.md` | Chief's persona and operating manual |
| `principals/<name>/` | Active principal's memory, journal, and workstreams |
| `senses/` | Scoped Relayfile projection (gitignored) |
| `factory-intake/` | Operator-authorized source-to-project routing manifests consumed by Factory |
| `teams.json` | Resident Agent Relay roster |
| `scripts/` | Onboarding, doctor, mount supervisor, and attach commands |

The historical root `memory/`, `journal/`, and `workstreams/` remain an earlier
profile. The active brain is always `principals/<slug>` for the active roster's principal.
