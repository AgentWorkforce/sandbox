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

**The live blocker is credential, not compute — and it is still broken today.**
Verified 2026-08-14 07:56Z from the chief repo:

```
relayfile status
  error: refresh delegated relayfile credentials: delegated relayfile
  credentials expired or revoked. Re-bootstrap ... with `agent-relay cloud
  login`; cloud re-mint fallback failed: agent-relay CLI >= 8.7.0 required
  with `agent-relay cloud session --help` ... (error: unrecognized subcommand
  'cloud' / Usage: agent-relay-broker <COMMAND>)
```

Two distinct defects stacked, and the second is the interesting one:

1. The delegated Relayfile credentials are expired. This is the same failure
   that stalled dispatch on 2026-08-12, when the `/github` projection for
   workspace `rw_7ccfea89` went stale with repeated `HTTP 401 'Token has
   expired'`. It was never durably fixed, only worked around.
2. **The automatic re-mint fallback invokes the wrong binary.** It shells out
   to something that resolves to `agent-relay-broker` — the Rust broker, which
   has no `cloud` subcommand — and then reports a misleading
   "agent-relay CLI >= 8.7.0 required". The real `agent-relay` CLI on this
   machine is 11.5.5 and `agent-relay cloud session --help` works fine. So the
   self-heal path can never succeed, and its error message points the operator
   at a version upgrade that would change nothing.

   Leading hypothesis, **not yet confirmed in source**: the fallback resolves
   the CLI through `AGENT_RELAY_BIN`, which on this machine is set to
   `/Users/khaliqgant/.local/bin/agent-relay-broker`. Read the relayfile source
   before writing this down as fact — a string in an error message is not the
   mechanism.

Until Relayfile can mint credentials unattended, a cloud-node Factory will
stall exactly the way the laptop one does. Moving the host first would only
relocate the outage.

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

1. Fix the Relayfile credential self-heal, starting with the wrong-binary
   fallback — confirm the mechanism in source first. This is the gating item;
   nothing downstream works without it.
2. Decide the cutover rule: when the cloud-node Factory comes up, the laptop
   instance must stop dispatching, and that has to be enforced by the claim
   layer rather than by remembering to turn one off.
3. Only then stand up Factory on a cloud node with its own resolved
   `factory.config.json` and an explicit `--config` path.

Depends on `daytona-fleet-nodes` for the node itself, and shares the
enrollment constraint recorded in `chief-in-sandbox`: fleet enrollment is
browser-session-only, so no agent can enroll the node it needs.

## History

### 2026-08-14 — workstream opened; Relayfile self-heal found broken at the binary

Khaliq named this priority 4 of four. Confirmed by survey that no workstream
covered moving Factory dispatch to a cloud node. While scoping it, ran
`relayfile status` and found the delegated credentials still expired and the
automatic re-mint fallback failing against `agent-relay-broker` instead of the
`agent-relay` CLI — a self-heal path that cannot succeed and whose error
message misdirects the operator to a version upgrade. Recorded as the gating
blocker rather than the hosting change.
