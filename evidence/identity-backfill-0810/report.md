# Relaycast identity-key backfill evidence — 2026-08-10

Workspace: `rw_7ccfea89`

## Outcome

The four known fleet broker records are READY:

| Broker | Agent ID | Final state | Evidence |
|---|---:|---|---|
| `chief-broker` | `211418990402400256` | READY | Pre-existing and previously verified by chief; untouched during this run. |
| `barry` | `210867721395138560` | READY | Initial GET 200, ID matched, `identity_key` absent; PATCH 200; read-back GET 200, same ID, exact verifier match true, 64 lowercase hex true; exit 0. |
| `sf-mini` | `205920120209797120` | READY | Initial GET 200, ID matched, `identity_key` absent; PATCH 200; read-back GET 200, same ID, exact verifier match true, 64 lowercase hex true; exit 0. |
| `finn-mini` | `205917852717920256` | READY | Initial GET 200, ID matched, `identity_key` absent; PATCH 200; read-back GET 200, same ID, exact verifier match true, 64 lowercase hex true; exit 0. |

No workspace key or derived hash is recorded in this evidence.

## Authentication contract

Relaycast workspace authentication is:

```text
Authorization: Bearer <workspace-key>
```

There is no `workspaceId` query/body parameter and no `X-API-Key` header.

This was established from code before the first production request:

- `relay/crates/broker/src/relaycast/auth.rs`: `build_relay_client` passes the workspace key to `RelayCastOptions::new(api_key)`.
- `relaycast/packages/sdk-rust/src/client.rs`: `HttpClient::build_request` applies reqwest `.bearer_auth(&self.api_key)`.
- The cloud engine auth middleware reads only `Authorization` with an exact `Bearer ` prefix.
- `GET /v1/agents/:name` uses `requireWorkspaceRead`; `PATCH /v1/agents/:name` uses `requireWorkspaceKey`.

Chief previously received HTTP 403 while intending to use this same shape. Since the SDK and cloud handler agree and this run received HTTP 200, that earlier 403 came from request construction rather than from a different authentication contract.

## Confirmed identity path strings

The verifier was derived in memory from each exact, on-node-confirmed path string. Neither intermediate nor final hashes were printed or persisted.

- `barry`: `/Users/barry/.agentworkforce/relay/barry-node/state/state-barry.json`
- `sf-mini`: `/Users/khaliqgant/Projects/AgentWorkforce/relay/.agentworkforce/relay/state-sf-mini.json`
- `finn-mini`: `/Users/khaliqgant/.agentworkforce/relay/finn-mini-node/state/state-finn-mini.json`

Derivation contract:

```text
hex(SHA256("node-" + hex(SHA256(exact_path_string))))
```

## Extra-broker denominator sweep

The sweep was GET-only. No extra record was patched.

| Candidate | HTTP | Exists | Agent ID | `identity_key` |
|---|---:|---|---|---|
| `nightcto-finn` | 404 | false | none | not applicable |
| `nightcto-sf` | 404 | false | none | not applicable |
| `sf-mini` from `com.agentrelay.fleet-node.plist` | 200 | true | `205920120209797120` | present |

Static launchd inspection on `sf-mini` established:

- `com.agentrelay.fleet-node.plist` directly invokes `agent-relay` with explicit `--broker-name sf-mini`, working directory `/Users/khaliqgant/Projects/AgentWorkforce/relay`, and no `--state-dir`. It maps to the existing `sf-mini` registration rather than adding another denominator entry.
- `com.agentrelay.factory.plist` invokes the `factory` program from `/Users/khaliqgant/Projects/AgentWorkforce/pear`. It does not invoke `agent-relay`; it has no `--broker-name`, `--state-dir`, `NODE_NAME`, `STATE_DIR`, or `RELAY_AGENT_IDENTITY_KEY` entry. No defensible Relaycast broker name was present, so no agent-name guess or production probe was made for it.

The fresh sweep completed with exit 0; the two HTTP 404 responses were treated as confirmed record absence, not request/auth failure.

## Operational safeguards observed

- Every backfill stopped before PATCH unless GET returned 200, the agent ID matched, and `identity_key` was absent.
- Each PATCH was followed by a fresh GET and exact in-memory comparison.
- No broker was restarted, stopped, upgraded, signaled, or otherwise reconfigured.
- `chief-broker` was not queried or mutated during this run.
- `nightcto-finn`, `nightcto-sf`, and the factory launch agent were not mutated.
