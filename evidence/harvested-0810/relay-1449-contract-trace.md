# relay#1449 — CONTRACT TRACE: `attach` and the node concept

**Ref read:** `AgentWorkforce/relay` `main` @ `7a42f3bd530f413368220f41d0b7297d03f6eafc`
(isolated clone; the shared worktree was never checked out over).
Issue bodies read via `gh issue view` on the same repo.

---

## 0. Corrections to the starting facts

**Fact 1 — CONFIRMED.** `attach` is local-only by construction and lives in
`packages/cli/src/cli/commands/local-agent.ts:480-509`. Stronger than stated:
`node agent attach` *is* `local agent attach`. `packages/cli/src/cli/commands/node.ts:87`
calls `registerLocalAgentCommands(node)` — the `node` group re-registers the local
group verbatim. There is no separate node-side implementation to fix.

**Fact 2 — PARTLY WRONG, and the wrong part matters.** `--state-dir` does mean
"a different local connection file". `--broker-url` / `--api-key` do **not**.
They are a genuine remote broker address: the resolved URL is used directly as the
HTTP base and is mechanically rewritten to the WS URL
(`packages/cli/src/cli/lib/broker-connection.ts:88-105`,
`packages/harness-driver/src/transport.ts:424-430`). Nothing on that path is
loopback-only. Pear already uses exactly this pair to drive a broker in a Daytona
sandbox over the public internet. The client half of cross-node attach is **already
built and already shipping**. What is missing is not the flag — it is that no
reachable URL for a fleet node's broker exists anywhere to put in it (§2, hop 4).

**Fact 3 — CONFIRMED at source.** `attach` declares exactly `--mode`, `--broker-url`,
`--api-key`, `--state-dir`, `--json`, `--reasoning`, `--diagnostics`
(`local-agent.ts:484-490`). No `--node`. `--node` exists only on `fleet spawn`
(`packages/cli/src/cli/commands/fleet.ts:117-118`).

---

## 1. The end-to-end trace

### Hop 1 — CLI surface
`packages/cli/src/cli/commands/node.ts:87` → `registerLocalAgentCommands(node)`
→ `local-agent.ts:480-509`.
**Identifies the target by:** a bare agent-name string (`local-agent.ts:483`).
No workspace, no node, no repo qualifier. Options carry `{brokerUrl, apiKey, stateDir}`
only (`:498-505`).

### Hop 2 — dispatch + preflight
`runAttach` — `local-agent.ts:62-75`. Calls `isNativeHarness(name, options)` **first**,
before mode dispatch, then routes to `attachView` / `attachPassthrough` / `attachDrive`.
`isNativeHarness` — `packages/cli/src/cli/lib/attach-native.ts:295-309` — resolves its
own connection and calls `client.listAgents()` **unguarded**: any rejection propagates
and kills the attach.
**Identifies the target by:** name + the same three options.

### Hop 3 — connection resolution
`resolveBrokerConnection` — `packages/cli/src/cli/lib/broker-connection.ts:84-106`.
Order: explicit flag → env → `connection.json`, resolved **independently for URL
(`:94`) and key (`:100`)**.
Used by drive and passthrough via `prepareAttachTarget` (`attach.ts:326-344`;
`attach-drive.ts:1464`, `attach-passthrough.ts:330`).

> **A second, duplicated resolver exists.** `view` does not use it. `attach-view.ts:190-214`
> defines `resolveViewBrokerConnection`, a near-copy with the same independent
> URL/key resolution, called at `attach-view.ts:404`. Any fix to hop 3 must land twice.

**Identifies the broker by:** a URL string. **This is the only hop where a node
concept could enter cheaply** — and it is already capable of naming a remote host.

### Hop 4 — `connection.json`
`defaultStateDir()` = `<projectRoot>/.agentworkforce/relay`
(`broker-connection.ts:50-53`); read from local disk at `:39-47`; fields `url` / `api_key`
(`:92`, `:99`).
**Identifies the target by:** a URL written by the local broker for itself. The broker
binds **`127.0.0.1` by default** (`crates/broker/src/cli/mod.rs:250-254`, again at `:336`),
and `node up` forces an **ephemeral port** — `env.AGENT_RELAY_BROKER_PORT ??= '0'`
(`node.ts:249`).

**→ THIS IS WHERE THE TARGET STOPS BEING ADDRESSABLE.** Not because the resolver is
local-only — it isn't — but because for a fleet node the only URL that exists is
`http://127.0.0.1:<ephemeral>`, which is meaningless off-box, and **nothing in the
workspace directory carries an address to replace it with**: `RelayNode`
(`packages/sdk/src/messaging/types.ts:59-76`) has `id`, `name`, `status`, `capabilities`,
`repoKeys`, `load`, `lastHeartbeatAt`, `tags`, `version` — and **no url, host, or port
field at all**. `fleet nodes` can tell you `barry` is alive and can tell you nothing
that could be fed to `--broker-url`.

### Hop 5 — broker HTTP/WS API
`packages/harness-driver/src/transport.ts` and `client.ts`:
- events WS `/ws` (`transport.ts:424-426`; view connects at `attach-view.ts:413,550`)
- `GET /api/spawned/{name}/snapshot` (`client.ts:838`)
- `POST /api/input/{name}` (`client.ts:710`), input WS `/api/input/{name}/stream`
  (`transport.ts:429`) — drive/passthrough only (`attach-drive.ts:196,280,467`;
  `attach-passthrough.ts:210,793`)
- `POST /api/resize/{name}` (`client.ts:754`)

Auth: a single flat `X-API-Key` header (`transport.ts:439-441`, `:499-500`).
**Identifies the target by:** agent name **inside one broker's namespace**. A broker
knows only the agents it spawned; a remote agent is not in its `/api/spawned`.

### Hop 6 — PTY
`crates/broker/src/pty_worker.rs:654-659, 1827-1838, 1917` — output is emitted as
`worker_stream` frames and broadcast to every `/ws` client.
**Identifies the target by:** worker name within the process.

---

## 2. Where the node concept has to enter

**Hop 3, sourced from a new field at hop 4's replacement.** Concretely, the minimum
change that does not add a second control plane:

1. **Give the workspace directory an address.** `RelayNode` gains a broker attach
   endpoint, or — better, because it also solves the credential problem — Relaycast
   gains a `nodes.attachTicket(node, agent, mode)` call returning
   `{wsUrl, apiKey, mode, expiresAt}`. This rides the **same Relaycast SDK plane
   `fleet spawn --node` already uses** (`fleet.ts:141-152` →
   `packages/sdk/src/messaging/relaycast.ts:626+`, `commands.invoke`). No second
   control plane.
2. **`attach` gains `--node <name>`.** When present, hop 3's source becomes that
   ticket instead of `connection.json`. Hops 5 and 6 are untouched — the client
   already speaks this protocol to a remote broker.
3. **Precondition: URL and key must resolve as an atomic pair** (both resolvers).
   That is exactly relay#1382; see §4.

This is the direct analogue of the Cloud sandbox flow, and it is small — provided
the node is reachable. For a laptop behind NAT it is not, which is §3.

---

## 3. The `cloud/ARCHITECTURE.md:136` claim — CONFIRMED in half, REJECTED in half

Read at `/Users/khaliqgant/Projects/AgentWorkforce/cloud/ARCHITECTURE.md:133-186`.

**Confirmed:** the mechanism really is generic, and the relay CLI really is already
the client for it. Cloud derives a broker key by
`HMAC-SHA256(serverSecret, "broker:" + sandboxId)`, gets a signed Daytona preview URL
for port 9800, returns `{wsUrl, apiKey, expiresAt}`, and the client connects
**directly** with `X-API-Key` — which is `attach --broker-url … --api-key …`.
The issue is right that this is not a new transport.

**Rejected:** "that mechanism aimed at a fleet node" understates the work, because
Daytona supplies three things for free that a fleet node has none of:

| Supplied by Daytona | Fleet node today |
|---|---|
| **Ingress** — broker on `0.0.0.0:9800` + signed preview URL | broker on `127.0.0.1` (`cli/mod.rs:253`), ephemeral port (`node.ts:249`), typically behind NAT |
| **Directory** — Cloud knows the sandbox id → URL | `RelayNode` has no address field (`types.ts:59-76`) |
| **Credential authority** — Cloud owns the secret, so it can *derive* a key on demand | node's broker key is minted locally; Cloud cannot issue one for it |

**Honest verdict on ownership: this is a split, and Cloud owns the hard half.**
The relay CLI half is genuinely small (§2 steps 2–3, plus #1382). Ingress and ticket
issuance are Cloud/Relaycast responsibilities and have no home in the relay CLI.
I would keep #1449 open in `relay` scoped to the CLI/contract half, and re-home
ingress + attach-ticket issuance to `cloud`.

**One alternative worth naming, because it dodges the NAT problem entirely:** each
node already holds a persistent **outbound** WS to the engine at `/v1/node/ws`
(`crates/broker/src/node_control.rs`). Tunnelling attach over it needs no ingress at
all. But that channel is a small tagged-JSON control protocol —
`ServerToNode {deliver, action.invoke, ping, reply, error}` /
`NodeToServer {node.register, node.heartbeat, node.deregister, agent.register,
agent.deregister, delivery.ack, action.result, inventory.sync}`
(`crates/broker/src/fleet_wire.rs:596-628`) — with **zero PTY/terminal/stream concepts
anywhere in it** (verified: no `worker_stream`/`pty`/`terminal` token in
`node_control.rs`, `relaycast_ws.rs`, or `fleet_wire.rs`). Adding a high-rate
bidirectional byte stream to the socket that also carries heartbeats and message
delivery is a real Rust broker + engine transport change with head-of-line-blocking
risk, and it lands directly on top of #1462's liveness work. It is the more correct
long-term answer and the more expensive one. It is *not* "an existing transport
pointed somewhere else".

---

## 4. Are #1382, #1419, #1462 the same defect?

**None of the three is #1449 wearing different clothes.** But one of them is on
#1449's critical path, and that does change the shape of the fix.

**#1382 — separate defect, same hop, hard precondition. This is the one that
changes the shape.** It is not about nodes at all: it is cross-*repo* attach on one
machine, where a reachable URL exists and the failure is credential cross-wiring.
Its two root causes are confirmed exactly as filed: independent URL/key resolution
(`broker-connection.ts:94` vs `:100`) and an aborting capability probe
(`attach-native.ts:295-309`, `listAgents()` unguarded).
**Why it gates #1449:** any cross-node fix hands the client a `(url, key)` pair from a
non-local source. The caller is very often a relay agent with `RELAY_BROKER_API_KEY`
set for *its own* broker. Under today's resolver, env key beats the supplied pair →
guaranteed 401 → `isNativeHarness` aborts the whole attach. A #1449 fix shipped before
#1382 fails on day one, for every agent-initiated attach.
**Fix #1382 first, and fix it in both resolvers** — `broker-connection.ts:84` and the
duplicate `attach-view.ts:190`.

**#1419 — genuinely separate, but promoted from annoyance to blocker by #1449.**
It is a session-lifecycle defect: a drive session does not re-establish after
broker/PTY replacement, and its exit contract cannot distinguish transport loss from
user intent. Over loopback that is rare. Over a WAN hop with a 24h-expiring ticket it
is routine. Remote drive is not usable without it. Not a duplicate — a prerequisite.

**#1462 — genuinely separate; different plane, different layer, and note it is a
PR, not an issue** (it closes #1457). It fixes write-only liveness detection on the
node→engine control WS in the Rust broker. It shares an *error class* with #1419's
exit-contract defect — trusting a signal that does not prove liveness — but no code
and no mechanism. Its relevance to #1449 is conditional: it only becomes a direct
dependency under the tunnel-over-node-control design, where a blackholed node-control
socket would silently hang every attach session on that node.

---

## 5. PRESERVE — what enforces view / drive / passthrough today

**Answer: nothing on the server. The distinction is 100% client-side.**

- `view` is read-only purely because `attach-view.ts` never opens an input stream. It
  opens only the events WS and the snapshot GET (`attach-view.ts:413, 550, 520-523`).
  Drive and passthrough call `openInputStream` → `ws /api/input/{name}/stream`
  (`transport.ts:429`; `attach-drive.ts:196, 280, 467`; `attach-passthrough.ts:210, 793`).
- View adds local hygiene only: it strips input-report DECSET modes before writing to
  the terminal (`attach-view.ts:1-18, 315, 374`), consumes and discards stdin
  (`:70-80`), and never resizes the shared PTY (noted at `attach-drive.ts:494-504`).
- Server-side auth is **one flat key checked for equality by blanket middleware**:
  `crates/broker/src/listen_api.rs:920-952`. No scopes, no roles, no per-route
  capability, no read-only credential. `/api/input/{name}` and its stream sit behind
  that same single check (`listen_api.rs:462-465`). If no key is configured, the
  middleware passes everything through (`:925-927`) — the normal state for a
  loopback broker.

**The consequence for #1449, and I think this is the most important finding in this
trace:** today `view` is safe to hand to an observer only because you hand them a
*subcommand*, never a *credential*. The moment the hop goes remote, the ticket is
`{wsUrl, apiKey}` — and that same key authorizes `POST /api/input/{name}`. An observer
handed a "view" ticket can drive the agent by changing one flag. The Cloud sandbox
path has exactly this property already.

So requirement 2 of the issue ("`view` preserved across the hop, safe to hand to an
observer") **cannot be met by any client-side fix.** It requires a mode-scoped
credential that the **Rust broker** rejects at `/api/input` and `/api/resize` —
i.e. `listen_api.rs:920-952` has to learn more than one key class. That is a real
addition to the broker, it is not optional, and it is invisible if the design is
drawn only at the CLI layer.

---

## 6. Summary answers

- **Where does addressability break?** Hop 4. Not the resolver — the *directory*.
  `--broker-url` can already name a remote broker; there is simply no address for a
  node's broker anywhere in the workspace model (`RelayNode` has no address field),
  and the broker binds loopback on an ephemeral port.
- **Minimum change, no second control plane?** Put an attach endpoint / short-lived
  scoped attach ticket on the existing Relaycast plane that `fleet spawn --node`
  already uses; add `--node` to `attach`; make hop 3 read the ticket as an **atomic
  (url, key, mode) triple**. Hops 5–6 unchanged.
- **Same defect?** No, all three are distinct. #1382 is a hard precondition and must
  land first. #1419 is a prerequisite for remote *drive* being usable. #1462 is a
  dependency only under the tunnel design.
- **Cloud or relay?** Split, Cloud owns the hard half (ingress + ticket issuance).
  The relay CLI half is small. Say so on the issue.
- **Extra, unasked-for but blocking:** view-safety across the hop needs a server-side
  mode-scoped credential in the Rust broker. No client-side design satisfies it.
