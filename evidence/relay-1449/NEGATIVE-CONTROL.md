# relay#1449 — Negative control: cross-node attach

Operator: `relay-1449-proof-0810`
Invoking machine: `Khaliqs-MacBook-Pro.local`, node `chief-broker` (`node_5b46ac5e9f427fcedc07f77f95f642eb`)
CLI: `agent-relay` 11.4.2 (installed binary, not a build from source)
Date: 2026-08-10 (all timestamps UTC)

## Result

From `chief-broker`, `agent-relay node agent attach` **cannot reach an agent on
another fleet node**, and the failure is **byte-identical to "no such agent"**.

## Fleet at time of test

| node | broker version | status | note |
|---|---|---|---|
| chief-broker | relay-broker/11.4.2 | online | this machine, invoker |
| finn-mini | relay-broker/11.4.0 | online | remote, target host |
| barry | relay-broker/11.3.1 | online | remote |
| sf-mini | relay-broker/**11.1.1** | online | remote — brief said 11.4.0; measured 11.1.1 |

## Measurements

### Baseline A — agent that exists nowhere (control)
```
$ agent-relay node agent attach definitely-no-such-agent-xyz123 --mode view
start_utc=2026-08-10T11:51:39Z   end_utc=2026-08-10T11:51:40Z
exit_code=1
stderr: Error: no agent named 'definitely-no-such-agent-xyz123'
```

### Baseline B — agent on the LOCAL broker (positive control, proves attach works)
```
$ agent-relay node agent attach factory-lead --mode view --json
start_utc=2026-08-10T11:52:05Z   end_utc=2026-08-10T11:52:21Z
exit_code=124   (killed by 25s timeout — i.e. it STAYED ATTACHED)
stdout: live Claude Code TUI frame (alt-screen, cursor addressing, status line)
```
Attach is functional on the local plane. This rules out "the CLI is simply broken".

### Measurement C — agent on a REMOTE node (finn-mini), all three modes
Target `r1449-target-finn-0810`, spawned on finn-mini, registered workspace-wide
with `fleet.nodeId = node_d4190c4c2ca5c26bf547301347af4028` (= finn-mini).

| mode | start_utc | end_utc | exit | stderr |
|---|---|---|---|---|
| view | 11:52:42Z | 11:52:43Z | 1 | `Error: no agent named 'r1449-target-finn-0810'` |
| drive | 11:52:43Z | 11:52:43Z | 1 | `Error: no agent named 'r1449-target-finn-0810'` |
| passthrough | 11:52:43Z | 11:52:44Z | 1 | `Error: no agent named 'r1449-target-finn-0810'` |

## Distinguishability — the issue's actual question

**The failures are not distinguishable. They are the same bytes.**

After normalising only the agent name, all four stderr payloads hash identically:

```
baseline-nonexistent-view.err    767caac113b15c902ca7b30a331663e2
remote-view.err                  767caac113b15c902ca7b30a331663e2
remote-drive.err                 767caac113b15c902ca7b30a331663e2
remote-passthrough.err           767caac113b15c902ca7b30a331663e2
```

Same exit code (1), same message, no node hint, no "exists elsewhere" hint.
A human cannot tell "you typo'd the name" from "that agent is alive on finn-mini".

## Mechanism (read from the installed 11.4.2 artifact, not from source)

`dist/cli/lib/attach.js` resolves the target through a single broker client:

- `captureAndRenderSnapshot()` calls `createBrokerClient(connection).snapshot(agentName)`;
  HTTP **404 → `{status:'not_found', message: "no agent named '<name>'"}`** (attach.js:44).
- `switchInboundDeliveryModeOrAbort()` maps 404 the same way (attach.js:529).
- The comment at attach.js:502 states the design intent outright: 404s get a
  *"uniform 'no agent named X' message"*.

`connection` comes only from `--broker-url` / `RELAY_BROKER_URL` / `connection.json`.
On this machine that resolves to **`127.0.0.1:54611`** — loopback.

Node-awareness is absent by construction:

```
grep -c "nodeId|targetNode|target_node|fleet" in 11.4.2:
  dist/cli/lib/attach.js              0
  dist/cli/lib/attach-view.js         0
  dist/cli/lib/attach-drive.js        0
  dist/cli/lib/attach-passthrough.js  0
```

`agent-relay node agent attach --help` confirms the CLI surface: options are
`--mode`, `--broker-url`, `--api-key`, `--state-dir`, `--json`, `--reasoning`,
`--diagnostics`. **There is no `--node` flag.** The command lives under
`agent-relay node`, documented as "Run and manage *this machine's* relay node".

So the remote agent is not "missing" — it was never looked for. The local broker
is asked about a name it does not own, answers 404, and the CLI reports that 404
with the same wording it uses for a genuine typo.

## Sweep — 3 remote nodes x 3 modes, 9/9 identical

```
node=finn-mini mode=view        start=2026-08-10T11:58:09Z exit=1 Error: no agent named 'r1449-target-finn-0810'
node=finn-mini mode=drive       start=2026-08-10T11:58:09Z exit=1 Error: no agent named 'r1449-target-finn-0810'
node=finn-mini mode=passthrough start=2026-08-10T11:58:10Z exit=1 Error: no agent named 'r1449-target-finn-0810'
node=barry     mode=view        start=2026-08-10T11:58:11Z exit=1 Error: no agent named 'r1449-target-barry-0810'
node=barry     mode=drive       start=2026-08-10T11:58:11Z exit=1 Error: no agent named 'r1449-target-barry-0810'
node=barry     mode=passthrough start=2026-08-10T11:58:12Z exit=1 Error: no agent named 'r1449-target-barry-0810'
node=sf-mini   mode=view        start=2026-08-10T11:58:12Z exit=1 Error: no agent named 'r1449-target-sf-0810'
node=sf-mini   mode=drive       start=2026-08-10T11:58:13Z exit=1 Error: no agent named 'r1449-target-sf-0810'
node=sf-mini   mode=passthrough start=2026-08-10T11:58:14Z exit=1 Error: no agent named 'r1449-target-sf-0810'
```

## Broker side

`crates/broker/src/listen_api.rs` serves `GET /api/spawned/{name}/snapshot` and
answers a name it does not own with `404 agent_not_found` — the same response it
gives for a genuine typo (see its own `"/api/spawned/ghost/snapshot"` test).
The indistinguishability is therefore end-to-end: the broker cannot say
"elsewhere", and the CLI would have nowhere to display it if it could.

## LIVENESS CLOSED — target proven interactive on a different physical machine

`r1449-target-sf-0810`, running on node **sf-mini**, self-reported
`host=SF-Mac-Mini` — a different physical machine from the invoker
(`Khaliqs-MacBook-Pro.local`).

Exact DM record (`relay://dm/dm_6c046e50876cbd4a97103cd1`):

| UTC | direction | content |
|---|---|---|
| 11:57:22Z | me → target | "ONE ACTION ONLY … echo nonce `r1449-SF-9c40b2e5-…`" |
| **11:58:12–11:58:14Z** | — | **attach view/drive/passthrough → exit 1, "no agent named"** |
| 11:58:23Z | target → me | `NONCE-ECHO r1449-SF-9c40b2e5-1a77-4f38-8de3-6b5a0c9e4411 host=SF-Mac-Mini` |
| 11:59:33–11:59:35Z | — | attach view/drive/passthrough again → exit 1, "no agent named" |

The three attach failures at 11:58:12–14Z fall **inside** the request→response
window (11:57:22Z → 11:58:23Z). The agent was demonstrably executing during that
interval: it received a message, ran `hostname`, and returned the exact nonce.
It was then attached-to again 70s later, with the same result.

This is not an open socket. The nonce round-trip is work product: the target
acted on new input and returned a value only a running process could produce.
So at the very moment `attach` reported *"no agent named 'r1449-target-sf-0810'"*,
that agent was alive, interactive, and running on SF-Mac-Mini.

Bracketed re-run captured in `bracketed-sf-proof.txt`.

## Targets that registered but never produced work product

The finn-mini and barry targets registered (`fleet.registeredAt` present,
`lastSeen` advancing) but never returned a nonce despite repeated `steer` DMs.
Registration and `lastSeen` are **not** liveness, so those two are reported here
as *registered, interactivity unproven* — their attach failures above still
stand as measurements, but the sf-mini target is the one carrying the proof.
The silence is consistent with the known fleet defect (no live node carries
relay#1470).

## Files
Raw captures in this directory: `baseline-nonexistent-view.{out,err}`,
`local-factory-lead-view.{out,err}`, `remote-{view,drive,passthrough}.{out,err}`.
