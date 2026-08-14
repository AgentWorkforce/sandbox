---
status: active
owner: unassigned
reports_to: chief
updated: 2026-08-14
repos: [factory, relayfile, cloud, relay, chief]
---

Goal: Factory dispatch runs on a cloud node, not on Khaliq's laptop, so work
expressed on any surface is picked up and executed without a human machine
being awake.

## Now

Not started as a hosting change. This is priority 4 of Khaliq's stated four
(2026-08-14) and had no workstream until today. `factory-live-dispatch` tracks
whether Factory dispatches *at all*; this workstream tracks moving that
dispatch onto a cloud node. They are related but not the same, and the second
was untracked.

**The active dispatch contract is already correct and does not need changing**
to move hosts. `<chief>/factory.config.json` reads `issueSource: "github"`,
`safety` gated on the `factory` label plus a `[factory]` title prefix,
`mergePolicy: "never"`, and a repo list spanning the AgentWorkforce org. Routing
scope lives inside that file, never in file placement — so a cloud-node Factory
needs its own resolved copy of `factory.khaliq.config.json` and its exact path
passed with `--config` on every command and runtime. A `factory.config.json`
sitting in another repo is inert, not a fallback.

**The live blocker was never the credentials.** It is a name collision on one
environment variable, root-caused and worked around 2026-08-14 08:05Z. Full
mechanism in the History entry below; the short version is that
`AGENT_RELAY_BIN` means *the broker binary* in `relay` and *the agent-relay
Node CLI* in relayfile's Go CLI, so Relayfile's automatic credential re-mint
execs the Rust broker, fails, and blames the operator's CLI version. Every
relay-spawned agent inherits that variable, so this breaks Relayfile for the
whole fleet, not one machine. `relayfile-sdk-auth-0814` (chief-broker) owns the
real fix, per Khaliq: use the SDK, do not shell out.

The observed failure, before the workaround:

```
relayfile status
  error: refresh delegated relayfile credentials: delegated relayfile
  credentials expired or revoked. Re-bootstrap ... with `agent-relay cloud
  login`; cloud re-mint fallback failed: agent-relay CLI >= 8.7.0 required
  with `agent-relay cloud session --help` ... (error: unrecognized subcommand
  'cloud' / Usage: agent-relay-broker <COMMAND>)
```

Credential expiry is routine and self-healing by design. What made it an
outage is that the self-heal path could never run: it execs the wrong binary
and then reports a version error against a CLI that is already current
(11.5.5, with the subcommand it claims is missing). The operator is directed
to an upgrade that would change nothing.

Until that is fixed at the source, a cloud-node Factory will stall exactly the
way the laptop one does, because relay sets the offending variable for every
agent it spawns. Moving the host first would only relocate the outage.

**Two rules that constrain any implementation** (both learned from the AR-448
duplicate, see `memory/learnings.md`):

- A claim belongs to the work unit, not to a surface or a dispatcher. Running
  Factory on a cloud node while a laptop instance is also live creates exactly
  the two-dispatcher condition that produced the duplicate. Deduplication must
  key on work-unit identity across surfaces, not on either dispatcher's private
  state.
- A dispatch gate fails closed. If the claim cannot be recorded, abort. A queue
  that silently re-offers claimed work is worse than one that stalls.

No agent or Factory workflow merges a PR. `mergePolicy` is already `never` and
stays that way.

## Next

1. Land `relayfile-sdk-auth-0814`'s fix (SDK instead of shell-out, plus the
   `AGENT_RELAY_BIN` misreading, plus the misdirecting error message). Mechanism
   is confirmed; this is now execution, and it gates everything below.
   Interim unblock for any agent hitting it today: run relayfile with
   `AGENT_RELAY_BIN=~/.local/bin/agent-relay`.
2. Decide the cutover rule: when the cloud-node Factory comes up, the laptop
   instance must stop dispatching, and that has to be enforced by the claim
   layer rather than by remembering to turn one off.
3. Only then stand up Factory on a cloud node with its own resolved
   `factory.config.json` and an explicit `--config` path.

Depends on `daytona-fleet-nodes` for the node itself, and shares the
enrollment constraint recorded in `chief-in-sandbox`: fleet enrollment is
browser-session-only, so no agent can enroll the node it needs.

## History

### 2026-08-14 — root cause: `AGENT_RELAY_BIN` means two different things in two repos

Verified against `origin/main`, not inferred from the error text.

relayfile ships a **Go** CLI (`cmd/relayfile-cli`, wrapped by the npm package as
`bin/relayfile-cli-<platform>`). That is where the shell-out lives, which is why
grepping only the TypeScript found nothing — and why the fix Khaliq remembers
landing "a long time ago" covered the TS SDK and left this implementation
behind.

`cmd/relayfile-cli/main.go`: `agentRelayBinary()` (line 1160) returns
`$AGENT_RELAY_BIN` if set, else `"agent-relay"`.
`ensureAgentRelayCLICompatible()` (line 1167) then execs that binary for
`--version` and for `cloud session --help`, and lines 1261/1287 exec it again
for the real session call. `minAgentRelayCLIVersion` is `"8.7.0"` at line 55.

In `relay`, the same variable means the **broker** binary — see
`packages/cli/src/cli/lib/client-factory.ts:64` (`binaryPath =
process.env.AGENT_RELAY_BIN`), and `integration-cleanup-journal.ts:371` whose
error text says outright *"The resolved agent-relay-broker binary … or set
AGENT_RELAY_BIN to a current build"*. Every relay-spawned agent, the resident
Chief included, runs with `AGENT_RELAY_BIN` pointed at
`~/.local/bin/agent-relay-broker`. So relayfile execs the Rust broker, gets
`unrecognized subcommand 'cloud'`, and reports "agent-relay CLI >= 8.7.0
required".

**The discriminating measurement**, chief-broker 08:05Z, same machine, same
credentials, seconds apart:

- `relayfile status` → creds expired, re-mint fallback failed with the 8.7.0 error.
- `AGENT_RELAY_BIN=~/.local/bin/agent-relay relayfile status` → `auth:
  agent-relay session ok`, `github healthy lag 0s`, last event 2m57s ago.

So the credentials were never the problem. This is almost certainly the root
cause of the 2026-08-12 dispatch stall recorded in [[factory-live-dispatch]],
where the `/github` projection went stale with repeated
`HTTP 401 'Token has expired'` and could not refresh.

The general rule, already in `memory/learnings.md`: reusing a primitive is not
free — check who writes it. A shared env-var name with two owners and two
meanings is the defect, independent of the shell-out.

`relayfile-sdk-auth-0814` dispatched on chief-broker to remove the shell-out in
favour of the SDK path, stop reading `AGENT_RELAY_BIN` as the CLI regardless,
fix the misdirecting error message, and land a regression test that fails
before and passes after.

### 2026-08-14 — workstream opened; Relayfile self-heal found broken at the binary

Khaliq named this priority 4 of four. Confirmed by survey that no workstream
covered moving Factory dispatch to a cloud node. While scoping it, ran
`relayfile status` and found the delegated credentials still expired and the
automatic re-mint fallback failing against `agent-relay-broker` instead of the
`agent-relay` CLI — a self-heal path that cannot succeed and whose error
message misdirects the operator to a version upgrade. Recorded as the gating
blocker rather than the hosting change.
