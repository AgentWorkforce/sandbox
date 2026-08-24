# Agent37 long-running substrate proof — 2026-08-24

## Result

Agent37 is a real sandbox substrate, not an SSE-only conversation service. Actual calls proved:

- hosting-plane request/response exec with a successful `node --version` exit;
- instance-plane file PUT/GET with a byte-identical 46-byte round trip;
- a readable Relayfile mount;
- an online Agent Relay fleet node;
- a terminally confirmed targeted spawn whose worker read the mounted sentinel;
- first and final ai-hist receipts in Relayhistory;
- controller stop/resume with successful post-resume exec and retained proof-root state;
- provider DELETE followed by GET 404.

The primary successful lifecycle run is `a37-20260824091154-21583d`. The exact generated report is `report.json`; the chronological assertions are in `resource-ledger.jsonl`.

## The nine requested metrics

| Metric | Primary run (ms) | Secondary lifecycle run (ms) | Assertion |
|---|---:|---:|---|
| `bare_create_ms` | 12,741 | 13,037 | POST create through parsed running instance response |
| `provider_ready_ms` | 1,183 | 1,243 | create return to successful exec, exit 0 |
| `agent_relay_ready_ms` | 146,723 | 164,494 | create start to roster `online` with `spawn:proof` |
| `bootstrap_gap_ms` | 133,982 | 151,457 | Relay ready minus bare create |
| `history_first_cloud_receipt_ms` | 2,198 | 2,266 | push start to pair-check matching marker/session/event |
| `targeted_spawn_ready_ms` | 6,204 | 5,373 | placement start to worker ready file containing run ID |
| `repo_mount_read_ms` | 7,360 | 7,426 | placement start to exact mounted-sentinel comparison |
| `history_drain_before_destroy_ms` | 5,681 | 7,690 | quiesce request to final matching cloud receipt |
| `destroy_ms` | 6,424 | 4,851 | provider DELETE wall time |
| `verified_gone_ms` | 328 | 288 | DELETE return to first GET 404 |

The secondary run `a37-20260824090702-4599f9` completed all lifecycle assertions and verified provider teardown, but the harness correctly reported failure when Relayfile returned queued HTTP 202 for sentinel deletion. The repaired harness accepts 202 only as an acknowledgement and polls until GET returns 404; the primary run passed that predicate.

## Why `/opt/agent37-proof` failed

`/opt/agent37-proof` was intended to be the isolated box-local workspace for app files, state, the mounted repository, trajectories, and source builds. The Agent37 template runs as a non-root user, which cannot create that path. The harness now keeps the same workspace contract under the template's writable `/tmp/agent37-proof`; the controller, fleet node, spawned worker, and secret scan all use the same root.

## Targeted-spawn failure

The pinned SDK treats `spawn:*` specially: the capability selects the node/harness, while invocation goes through the engine's native `spawn` action. The old harness overrode the action name to `spawn:proof`, which does not exist in the action registry. The repaired harness advertises and selects `spawn:proof` but leaves `actionName` unset so the SDK performs its native mapping.

## Idle behavior and honest cost category

Idle probe `a37-idle-20260824091709-269a96` persisted `auto_sleep=true` and `idle_timeout_seconds=60`, then observed actual `sleeping` after 176,614 ms. Explicit start/wake plus a successful exec took 5,756 ms. Controller stop took 3,712 ms; controller resume plus successful exec took 9,118 ms. Destroy took 7,358 ms and GET verified absence after another 323 ms.

Auto-sleep is real, but background Relay node/mount activity did not keep the box awake in an earlier run. A sleeping node disappears from the active fleet until a provider-aware controller explicitly starts it. Therefore the cited `$0.0248/day` figure is defensible only for sleep-tolerant, controller-woken workloads. For an uninterrupted long-running agent, the honest cited figure remains `$0.1565/day`.

## Environment and invocation

- initial cwd: `/Users/khaliqgant/Projects/AgentWorkforce/sandbox`
- hostname: `Khaliqs-MBP.home`
- GitHub account: `khaliqgant`; scopes included `repo` and `workflow`
- Node: `v22.22.2`
- disk at start: 44 GiB available
- Agent37 credential file: `~/.agentworkforce/provider-creds/agent37.env`, mode 0600; variable name `API_KEY`; value never printed
- authentication assertion: GET `/v1/instances` returned HTTP 200
- Veto: 3.2.0, status healthy via CLI; the Veto MCP calls were not exposed to this worker's tool manifest

No prior shell-history invocation was preserved. The measured runs used:

```sh
set -a
source "$HOME/.agentworkforce/provider-creds/agent37.env"
set +a
export AGENT37_API_KEY="$API_KEY"
unset API_KEY
npx --yes tsx .agent37-proof-0820/proof.mjs
npx --yes tsx .agent37-proof-0820/idle-probe.mjs
```

The controller dependency was pinned at `@agent-relay/sdk@11.8.0`; the remote run pinned Agent Relay 11.8.0, Relayfile 0.10.45 by SHA-256, and Relayhistory source commit `b5a469b9132f51512e47496fb01c912469bcfd63`.

## Cleanup and failure evidence

Every owned Agent37 instance was deleted and verified absent. A transient network failure once prevented in-process teardown; the leaked instance was resolved by its exact run label and metadata, deleted in 3,342 ms, and verified gone in 414 ms. The harness now bounds provider transport waits and retries idempotent cleanup. Final provider inventory contained zero proof-tagged instances.

Timeouts and failed predicates remained UNKNOWN; no 201, roster row, socket, or queued response was relabeled as readiness.
