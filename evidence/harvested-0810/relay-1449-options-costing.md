# relay#1449 — costing A / B / C

**Refs:** `AgentWorkforce/relay` `main@7a42f3b` (isolated clone).
Read-only sibling checkouts for the engine/cloud side:
`relaycast-cloud` (branch `docs/migration-0033-comment`), `cloud` (`main`).

---

## 0. A correction to my own part-3 report

I wrote that the broker's auth middleware "passes everything through when no key is
configured — the normal state for a loopback broker." **That is wrong.**
`crates/broker/src/runtime/init.rs:119-125` always mints `br_<uuid4>` when
`RELAY_BROKER_API_KEY` is unset and exports it before the router is built, so
`configured_broker_api_key()` (`listen_api.rs:396-401`) is effectively never `None`
for a normally-started broker. Auth is always on.

This makes option C's exposure meaningfully *smaller* than my earlier phrasing implied,
so it matters. Everything else in that report stands: one flat key, no scopes, no
per-route capability (`listen_api.rs:920-952`).

## 0b. A correction to the framing of the question

The brief describes B as "no cloud in the path." That is not what B is.

- **A** — control (ticket) through Cloud, **data direct node↔client**.
- **B** — control through Cloud, **and every PTY byte through Cloud too**.
- **C** — control and data direct. **The only option with no cloud in the path.**

B has strictly *more* Cloud in the data path than A does. If "no cloud in the path" is
a goal, B does not serve it and C is the only option that does.

---

## Shared prerequisite: the mode-scoped credential

Since `view`-safety is a hard requirement, price it once. Today the broker has one
flat bearer key checked by blanket middleware (`listen_api.rs:920-952`), minted at
`init.rs:119-122`, guarding every route including `POST /api/input/{name}`,
`ws /api/input/{name}/stream` (`listen_api.rs:462-465`), `POST /api/resize/{name}`,
`/api/spawn`, and `/api/shutdown`.

**Minimum addition:** the broker accepts, alongside its master key, short-lived
*grants* carrying `{mode, agent, expiry}`, and the middleware becomes route-aware —
a `view` grant is rejected at input/resize/spawn/shutdown and scoped to one agent name.

- **A needs this.** The ticket *is* a broker credential.
- **C needs this.** Same reason.
- **B does not need it at all** — and this is B's single strongest argument. Under B
  the client never receives a broker credential; it authenticates to Relaycast under
  its own identity and the engine decides whether to forward `attach.input` frames.
  Mode enforcement lives at the proxy; the broker's flat key never leaves the machine.

Size: ~150-300 lines of Rust in `listen_api.rs` plus a grant-minting endpoint and
tests. Non-trivial but bounded, and it is the piece that turns "view is safe because
we hand out a subcommand" into "view is safe because the server refuses."

---

## Option A — Cloud mints an attach ticket + provides ingress

**Changes, by repo/layer**
- `relay` CLI: `--node` on `attach` (`local-agent.ts:480-509`); hop-3 resolver reads a
  ticket as an atomic `(url, key, mode)` triple (`broker-connection.ts:84-106` **and**
  the duplicate `attach-view.ts:190-214`); re-point the `isNativeHarness` preflight
  (`attach-native.ts:295-309`) at the remote target. ~200-400 lines.
- `relay` broker (Rust): scoped grants, ~150-300 lines (above).
- `relay` SDK: `nodes.attachTicket()` + `RelayNode` gains an endpoint
  (`packages/sdk/src/messaging/types.ts:59-76`). ~100 lines.
- `cloud` / `relaycast-cloud`: ticket issuance endpoint, **and ingress**.

**NAT: NO.** This is the hole in A and I understated it last time. Cloud can mint a
ticket for a machine it can reach. Daytona sandboxes are reachable because Daytona
provides a signed preview URL (`cloud/ARCHITECTURE.md:133-186`). A laptop behind NAT
is not reachable, and A supplies nothing that changes that. **A is complete only for
nodes that already have ingress.** For Khaliq's four machines, A on its own does not
deliver the capability — it still needs C's or B's transport underneath.

**Cloud unreachable: NO.** No ticket, no attach.

**Mode-scoped credential:** requires the broker work above. Not free.

**Deps:** #1382 **blocking** — the ticket delivers `(url, key)` from a non-local source
while the caller (usually a relay agent) has `RELAY_BROKER_API_KEY` in env; env beats
the file-sourced key (`broker-connection.ts:94` vs `:100`) → guaranteed 401 →
`isNativeHarness` aborts. #1419 prerequisite (WAN + expiring ticket → routine
reconnects). #1462 independent.

**HOL/perf:** none. Data path is a direct WS, same as today.

**Size:** small in relay, unbounded in Cloud (ingress is the whole problem).

---

## Option B — tunnel attach over the existing `/v1/node/ws`

There are two honest variants; the brief's framing describes B1, which I think is
disqualifying.

### B1 — multiplex onto the existing control socket
**Why it fails on the evidence:**
- One WS, `ws.split()` into sink/stream, one `select!` task; every outbound frame
  awaits the same sink (`node_control.rs:1578`, `send_wire` at `:1896-1904`).
- Frames are `Message::Text` — JSON. PTY bytes need base64 (+33%) or JSON escaping,
  and TUI output is dense in control bytes that escape to `\u00XX` (6 bytes each).
  Realistic 2-4× expansion.
- `HEARTBEAT_INTERVAL = 12s` (`node_control.rs:29`); #1462 declares silence past four
  intervals (48s) a disconnect.
- **Therefore: a congested uplink during a busy repaint delays the heartbeat behind
  queued PTY frames, and the node drops off the fleet because a human was watching a
  terminal** — presenting as precisely the symptom #1462 just fixed.
- Engine side: every frame is an inbound Cloudflare Durable Object message that wakes a
  hibernating DO and runs the full control parse/dispatch
  (`relaycast-cloud/.../durable-objects/node.ts:435`, `state.acceptWebSocket` at `:311`).
  A single TUI repaint is hundreds of frames, each billed.

### B2 — control frame asks the node to dial an ephemeral data socket; engine proxies
Fixes HOL and encoding (binary frames, dedicated socket, DO awake by design). But:
- `/v1/node/ws` is "the ONLY fleet surface the worker intercepts"
  (`relaycast-cloud/packages/relaycast/src/fleet/routes.ts:7`). A data path is a **new
  surface**, not a tweak.
- NodeDO holds one socket **per provider** with per-provider supersede-on-reconnect
  (`node.ts:3, 237, 306-307`). A data socket registering under the broker's provider
  identity closes the control socket with `4000 superseded`. Must register as a
  distinct provider — a real landmine, manageable but easy to get wrong.
- Client leg needs a new authenticated streaming surface too (the existing
  client-facing realtime DO is `workspaceStream.ts`).

**NAT: YES** — the node dials outbound. This is B's real advantage.
**Cloud unreachable: NO** — and worse than A, because now the *data* dies too.
**Mode-scoped credential: YES, for free** — enforced at the proxy; no broker change.
**Deps:** #1382 *partly* — the cross-wired-pair root cause does not apply (no broker
URL/key resolution), but the aborting-probe root cause (`attach-native.ts:295-309`)
still is. #1419 prerequisite, and worse: a second failure domain (node-control
reconnect) sits under every attach session. #1462 **hard dependency** — it is the
liveness detector for the exact socket B rides, and under B1 attach traffic can
*cause* the condition it detects.

**Size:** the largest by a wide margin. New wire frames in
`crates/broker/src/fleet_wire.rs:596-628`, new stream handling in
`node_control.rs` (3,718 lines today), a new DO/surface + proxy + auth in
`relaycast-cloud`, plus the client leg. Two repos, two languages, a new Cloudflare
cost line proportional to how much anyone watches a terminal.

---

## Option C — bind the node broker beyond loopback, reached directly

**Changes**
- Plumb `--api-bind` through `node up` (today `api_bind` defaults to `127.0.0.1`,
  `crates/broker/src/cli/mod.rs:250-254`, and `node.ts:249` forces
  `AGENT_RELAY_BROKER_PORT ??= '0'`, an ephemeral port).
- **Fix a concrete bug:** `connection.json` writes
  `"url": format!("http://{}:{}", cmd.api_bind, actual_port)` (`runtime/init.rs:157`).
  Bind `0.0.0.0` and the advertised URL becomes `http://0.0.0.0:<port>` — not dialable
  by anyone. C needs an *advertised host* distinct from the bind address.
- A directory entry so `--node` can resolve host:port (same `RelayNode` field as A).
- Scoped grants in the broker (shared prerequisite).

**Worth saying plainly: C's minimum viable form already works today, with zero code.**
`attach --broker-url http://barry:9800 --api-key <key>` is a supported, shipping path
(`local-agent.ts:485-486`). The only reasons it isn't used are that the port is
ephemeral and the key is buried in `connection.json` on the other box. That is a
discovery problem, not a capability problem.

**NAT: NO on a plain LAN; YES over an overlay** (WireGuard/Tailscale) — and the overlay
requires *zero relay code*.
**Cloud unreachable: YES. Unique to C.** This is the only option that keeps working
when Relaycast is down, which for a supervision tool is not a small property.

**Exposure, precisely — as asked, no hand-waving:**
1. **No TLS anywhere in the broker.** `axum::serve` on a plain `TcpListener`
   (`runtime/init.rs:136, 399`); rustls appears only as a *client* feature
   (`crates/broker/Cargo.toml:25, 43`). So on a plain LAN the API key travels in
   cleartext on every request, and **every PTY byte travels in cleartext** — including
   whatever the agent prints, which routinely includes tokens.
2. **The key is an unscoped, non-expiring, non-rotatable bearer token**
   (`init.rs:119-122`; `listen_api.rs:920-952`). One passive capture is durable full
   control.
3. **Blast radius is the whole broker**, not one agent: `/api/spawn` and
   `/api/shutdown` sit behind the same single check.

**What contains it:**
- **Bind to a tailnet/WireGuard interface instead of `0.0.0.0`.** This is the honest
  answer for four owned machines: encryption, device identity, and NAT traversal, for
  zero relay code. It relocates the trust boundary to the overlay — a legitimate
  engineering choice, not a compromise.
- If binding to a real LAN is required: terminate TLS (new server dependency + a
  self-signed cert/pinning story — real work, and none of it exists today).
- Scoped grants (shared prerequisite) contain #2 and #3 regardless.

**Deps:** #1382 — **does not fire** in the hand-typed form, because explicit flag wins
for *both* URL and key (`broker-connection.ts:88`, `:97`). It fires the moment a
`--node` lookup supplies the URL but leaves the key to env. So C avoids #1382 only in
its least ergonomic form; the ergonomic form needs it, same as A.
#1419 prerequisite, but mildest — LAN, no ticket expiry, failure modes closest to
today's loopback. #1462 independent.

**HOL/perf:** none, and the best of the three — a direct LAN WS is lower latency than
today's cloud-mediated anything.

**Size:** smallest. Advertised-host fix + `--api-bind` plumbing + directory field +
`--node` + shared grant work. Order of a few hundred lines across CLI and broker.

---

## Comparison

| | A (Cloud ticket) | B2 (tunnel) | C (direct) |
|---|---|---|---|
| Works behind NAT | ✗ | ✓ | ✓ via overlay only |
| Works with Cloud down | ✗ | ✗ | **✓** |
| Bytes traverse Cloud | ✗ | **✓** | ✗ |
| Mode-scoped `view` | needs broker grants | **free at the proxy** | needs broker grants |
| #1382 | blocking | partial | avoidable in one form |
| #1462 | independent | **hard dependency** | independent |
| HOL risk | none | B1 can evict the node | none |
| Repos touched | relay + cloud | relay + relaycast-cloud (2 langs) | relay only |
| New recurring cost | none | per-byte Cloudflare | none |

All three reuse ~4,800 lines of existing attach client unchanged
(`attach.ts` 1,333 + `attach-drive.ts` 1,566 + `attach-view.ts` 612 +
`attach-passthrough.ts` 981 + `attach-native.ts` 310). None of them rewrites the client.

---

## Verdict

**C for the capability, A's directory as the durable contract, B rejected.**

The decisive observation is that **A and C are not competing for the same use case.**
A's value is the *directory* and the *credential* — those are the right long-lived
abstractions and they are genuinely what's missing. A's ingress half only ever works
for machines Cloud can reach, which is sandboxes, not laptops. C's value is the
*transport* for machines you own. They compose; they don't compete.

So: ship the contract A would have introduced, and let C satisfy it without Cloud
minting anything.

1. **#1382 first**, both resolvers (`broker-connection.ts:84`, `attach-view.ts:190`).
2. **Scoped grants in the broker** (`listen_api.rs:920-952`) — this is what makes
   `view` real, and every path needs it. Not deferrable; it is the capability.
3. **`RelayNode` gains an endpoint field; `attach` gains `--node`**, resolving an
   atomic `(url, key, mode)` triple. Populate it for a tailnet node with no Cloud
   involvement; Cloud can populate the same field later for sandbox/customer nodes.
   Same contract, both futures.
4. **Fix the advertised-URL bug** (`init.rs:157`) and plumb `--api-bind` through
   `node up`.
5. Recommend the tailnet bind in docs. It deletes the ingress problem rather than
   building it.

The improved "node unreachable ≠ no such agent" error rides along in step 3 as a
commit, not a phase.

**Why B is rejected**, not merely ranked last: it is the most expensive option in the
most places (two repos, two languages, a new Cloudflare surface, a new permanent
per-byte cost), it puts a second failure domain under every attach session, its cheap
variant can evict a node from the fleet for the crime of being observed, and it makes
a fundamentally peer-to-peer capability permanently dependent on Cloud. Its one real
advantage — free mode enforcement at the proxy — is worth roughly 200-300 lines of
Rust under A or C. That is not a good trade for the rest of it.

**If two are close, the tiebreaker.** A and C are close on total effort once the
shared grant work is priced in. The tiebreaker is the six-month test you named:
in six months, C's artifacts (a node endpoint field, scoped grants, `--node`) are all
still correct and are exactly what A would need. A's artifacts *without* C are a
ticket system for machines that cannot be reached. C is the strict subset that
survives either future.

## And plainly, since you asked me not to soften it

The relay CLI half is small — a few hundred lines. The broker half (scoped grants) is
real, bounded, and belongs in relay. The genuinely hard half — ingress and credential
issuance for machines Cloud cannot reach — belongs in Cloud and should not be attempted
in the relay CLI.

What has changed since I first said that is the conclusion, not the premise: **for
Khaliq's four owned machines, the hard half can be deleted rather than built.** An
overlay network supplies ingress, encryption, and device identity for zero relay code.
Building Cloud ingress to reach machines he already controls would be paying for a
problem he does not have. Cloud's ingress work is still the right answer for customer
and sandbox nodes — it is just not on the critical path for this issue.
