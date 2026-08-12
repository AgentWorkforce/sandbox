---
status: active
owner: fleet-attach-impl-0811
previous_owner: relay-1483-review-barry-0811
reports_to: chief
updated: 2026-08-11
repos: [relay, cloud]
phase1_pr: "relay#1480"
phase1_status: merged
physical_pr: "relay#1483"
physical_status: merged
phase2_status: implemented-pending-review
phase2_prs: "cloud#2995, relay#1484"
---

## 2026-08-11 19:14Z — canonical fleet-native --node implemented, two PRs open

`fleet-attach-impl-0811` reports the canonical fleet-native `--node` path (Phase
2/3 from the 08-11 dispatch, previously scoped "future, out of scope") is
implemented in two minimal PRs, not yet merged:

- **`cloud#2995`** (`34f76a7b`) — workspace-auth ticket/session, a separate
  terminal NodeDO lane, server-enforced view mode, bounded limits/expiry/
  reconnect, and a distinct `node_unreachable` vs `agent_not_found` error.
  CI: Typecheck, Build core+platform, Relaycast unit tests, package suites, and
  the regression gate all green; one root Vitest job still pending at last
  check, `mergeStateStatus: UNSTABLE` for that reason. Branch protection on
  `cloud/main` isn't machine-readable (private repo, no GitHub Pro API access)
  — treat review as required until proven otherwise.
- **`relay#1484`** (`6244479c`) — an outbound, separate broker terminal socket,
  bounded queues, PTY snapshot/output routing, and an ephemeral loopback
  `--node` proxy; `--ssh-host` (relay#1483) is untouched. Local gates: `cargo
  fmt --all -- --check`, `cargo check -p agent-relay-broker`, terminal wire
  test 1/899 (rest filtered) all pass. **`mergeStateStatus: BLOCKED`,
  `reviewDecision: REVIEW_REQUIRED`** — relay's branch protection requires 1
  approving review, and per this repo's standing practice that reviewer is
  Khaliq (same gate #1476 is waiting on). Chief will not submit that review
  under Khaliq's authenticated `gh` session — it would launder Chief's
  judgment as his signature. **This is Khaliq's precise external blocker.**

Chief dispatched independent code-review workflows against both PRs
(`wf_9ec0d5b5-582` for relay#1484, `wf_cf063fa7-4f1` for cloud#2995) to surface
bugs before either goes in front of Khaliq — findings will be added here and
reported to the owner once the workflows complete.

The lane also confirmed it never found `workstreams/cross-node-attach.md` on
its mounted Relayfile or Relay worktree — consistent with the standing
Relayfile-coordination gap (leads on other nodes can't read Chief's brain).
It kept the two PRs as the durable checkpoint instead of inventing a duplicate
one, which is the right call given that gap.

**Update 19:31Z — both reviews back, neither clean, merges held.**

`relay#1484` (head `113e089e`, clippy-fixed): fresh CI running, still
`REVIEW_REQUIRED` — same Khaliq-reviewer gate as `relay#1476`.

`cloud#2995` (head `34f76a7b`): CI fully green, `mergeStateStatus: CLEAN`, but
independent review (`wf_cf063fa7-4f1`, 14 agents) found **7 defects, 6
CONFIRMED**. Most severe and directly on-point for this feature's purpose:
`handleDisconnect()` (`node.ts:867`) now only closes `control`-role sockets
instead of all sockets, so an explicit node disconnect no longer tears down
the `terminal-node`/`terminal-client` lanes — a live `drive`-mode session
(accepting keystrokes) survives a disconnect call the platform believes
severed the connection, and `/terminal/status` still reports
`terminal_connected: true`. Also confirmed: a null terminal-client frame
crashes the handler instead of hitting the malformed-JSON catch (force-closes
the socket via Cloudflare's Hibernatable WS 1011 instead of the graceful
`terminal.error`); an empty `data_base64` input frame is misclassified as
`input_too_large`. One PLAUSIBLE reconnect-race (unordered `socketForRole()[0]`
pick can grab a stale closing socket). Posted in full to the PR; fix list sent
to `fleet-attach-impl-0811`, who remains active and standing by for review —
it explicitly will not deploy/merge/approve action-required workflows itself.

**Update 19:29Z — `relay#1484` review also back, not clean.** `wf_9ec0d5b5-582`
(16 agents) found 10 defects, 9 CONFIRMED. Five correctness issues worth
fixing before Khaliq's review: a `terminal_sessions` leak on Open-dispatch
failure (`fleet.rs:137`); the loopback proxy collapsing 404/409 into a blanket
503 so a nonexistent/headless agent hangs on a blank terminal instead of
erroring (`attach-fleet-node.ts:178`); `--json`/`--reasoning`/`--diagnostics`
silently discarded on `--node` while `--ssh-host` forwards them
(`local-agent.ts:549`); a reconnect-backoff branch that never doubles its
delay on an invalid auth header (`terminal_control.rs:152`); and a PLAUSIBLE
dark-session bug where reconnect never resyncs session state
(`fleet.rs:83`). Five more confirmed cleanup findings (unreaped tracking maps,
release not clearing new state, a hand-maintained broker emulator with no
shared contract, triplicated flag-exclusion checks, a changelog rule
violation) at the owner's discretion. Posted in full to the PR; fix list sent.

**Update 19:44Z — `relay#1484` fix push verified by direct diff, not by
summary.** Owner reported "incorporated the valid CodeRabbit/Cubic findings" at
head `4771be7c`. Chief pulled the diff and checked it against its own 5
findings rather than trusting the report: **2 of 5 actually fixed** (the
`terminal_sessions` leak on Open-dispatch `Err`, and the reconnect-backoff
doubling), plus the snapshot-request map is now reaped by `maintenance.rs`
(bonus, addresses a cleanup finding). **3 remain open despite looking close:**
the 503-masks-404/409 status collapse is unchanged — `captureAndRenderSnapshot`
still keys purely on HTTP status and the loopback proxy still always returns
503; the `--json`/`--reasoning`/`--diagnostics` flags are now correctly built
and passed into `deps.attachNode(...)` at the command layer, but
`attachFleetNode` itself still does `void options;` and drops them one layer
deeper — a fix that looks complete at the call site and isn't at the sink; and
the Disconnected-arm resync gap is untouched. `cloud#2995` has not been
touched at all (still head `34f76a7b`) — all 3 of its correctness findings
remain open. Sent the precise file:line status back to the owner.

**Update 19:50Z — both PRs genuinely fixed, verified by diff, both held for
Khaliq.** `cloud#2995` head `e86b65dc`: all 3 correctness findings confirmed
fixed (disconnect closes every socket role with an explanatory comment,
null/non-object terminal-client frames get a graceful `invalid_message`
instead of crashing, empty input is a proper 0-byte ack). CI green modulo one
slow-but-reliable Vitest job. `relay#1484` head `cdc36d75`: all 5 correctness
findings fixed — real 404/409 status mapping in the loopback proxy, `--node
--json` now emits NDJSON via a `worker_stream` wrapper (and honestly warns
that `--reasoning`/`--diagnostics` don't apply to a raw PTY stream rather than
silently dropping them), and the `Disconnected` arm now clears all three
terminal tracking maps with Relaycast re-opening sessions on reconnect. Only
the release-path cleanup (cleanup-severity, not correctness) remains
untouched — not blocking. Fresh CI just started on `relay#1484`.

**Both PRs held for Khaliq, not self-merged, for different reasons.**
`relay#1484` has a real GitHub gate (`reviewDecision: REVIEW_REQUIRED`) Chief
will not bypass. `cloud#2995` has no enforced gate, but every cloud PR merged
tonight (#2984, #2989, #2994) was merged by Khaliq personally — Chief is
matching that observed pattern given this ships new authenticated
terminal-bridging capability, rather than treating the absence of a
GitHub-enforced rule as license to self-merge.

**Next:** confirm `relay#1484`'s fresh CI goes green, then both PRs are
genuinely ready for Khaliq's review — flag both to him as a pair. After merge:
Cloud deploy + Relay release to Finn and Daytona, then the mandatory live
proof.

Goal: attach to an agent running on any fleet node, from any machine in the
workspace — `view`/`drive`/`passthrough` preserved across the hop, a clear
failure when the target node is unreachable, distinct from "no such agent."

## Dispatch — 2026-08-11 18:20Z — canonical fleet-native owner active

`fleet-attach-impl-0811` is registered on `finn-mini`
(`node_d4190c4c2ca5c26bf547301347af4028`) under the bounded proof team led by
`chief-proof-coordinator-0811` on the same physical node. The targeted dispatch
receipt matched `handlerNodeId` and `dispatchedNodeId`; on-target process and
cwd proof remain required in the ACK and final evidence.

The lane owns Relay issue `#1449`, with `#1327` as the raw PTY transport gap.
It must use an authenticated, short-lived node/agent/mode-bound attach ticket
and a separate outbound backpressured terminal stream; server-enforced
read-only view; bounded buffers; expiry, cancellation, reconnect, and replay
controls. It must prove Barry and Daytona using the same `--node` mechanism,
show that no SSH process carried the canonical proof, and keep `--ssh-host` as
the recovery fallback. Wrong agent, offline node, expired/replayed ticket,
view-input rejection, forced reconnect, and bounded-buffer overflow are named
negative controls. No open PR currently implements this follow-on.

Live fallback negative control at 18:24Z: attaching from Khaliq's Mac to the
new Chief on Finn with `--ssh-host finn-mini` reached the physical host but
failed with exit 127 because Finn's noninteractive SSH `PATH` cannot find
`agent-relay`; the installed binary is
`/Users/khaliqgant/.local/bin/agent-relay`. An explicit on-host binary plus
`/Users/khaliqgant/.agentworkforce/relay/finn-mini-node/state` attached and
drove the coordinator successfully. The attach owner received this regression:
SSH fallback needs injection-safe remote binary discovery for common user-local
and Homebrew installs, while canonical fleet-native attach must not depend on
remote SSH shell configuration at all.

## Now — 2026-08-11 19:53Z — SSH fallback merged; fleet-native remains next

`relay#1483` merged to `main` as `ed8144c9a`; it exposes physical-node SSH only as the explicit
`--ssh-host <host>` fallback. `--node` is reserved for the canonical
fleet-native path: resolve placement through Relay/Cloud and carry an
ephemeral, backpressured terminal stream over an outbound node connection,
without requiring inbound SSH. That same canonical transport should serve
physical nodes and Daytona sandboxes.

Final reviewed head was `986b90e77`: ordinary project-local broker discovery,
macOS/Linux cwd lookup, empty-host rejection, strict presence checks for
conflicting empty broker options, option-terminating agent arguments,
multi-process ambiguity checks, JSON drive/passthrough stdin preservation, a
shared attach-mode type, and the `--ssh-host` naming correction are included.
Final evidence is 342 attach tests, lint/format, `build:cli`, diff check, live
Barry attach on the final implementation, all GitHub checks green, zero
unresolved review threads, and Barry approval.

Chief appointed `relay-1483-review-barry-0811` on Barry; placement matched
node `node_210867409538764800`, ACK was received, and it completed every review
thread/check plus fix-and-re-review duty against the exact merged head. The
reviewer was released after the merge and durable checkpoint; Chief remains
owner of the canonical fleet-native follow-on.

The existing Daytona node has real spawn-placement proof, but it was enrolled
without the Relayfile mount. Replacement owner
`daytona-relayfile-closeout-barry-0811` is active on Barry and is reusing the
same node/sandbox without cloning or reprovisioning. The full
mount/write/byte-coverage proof remains blocked: production run `31516360915`
reached the deploy target and again failed because
`TranscriptionWorkerServiceToken` has no SST value.

## Original diagnosis — 2026-08-11 — relay#1449

**Filed by a previous Chief session, 2026-08-10.** Root cause, already
diagnosed precisely, do not re-derive: `attach` is local-only by
construction. It resolves its target via `resolveBrokerConnection` →
`.agentworkforce/relay/connection.json`, a **project-scoped file on local
disk**. Its three overrides (`--broker-url`, `--api-key`, `--state-dir`) all
mean "point me at a different *local* connection file," not "reach a
different node." `fleet spawn` takes `--node`; `attach` has no node concept
at all.

**Proven broken by direct measurement the same day, not just inferred:**
`relay-1449-proof-0810` ran 9 attach attempts across `finn-mini`, `barry`,
`sf-mini`, all 4 modes, all failed identically to "no such agent" — because
the CLI builds one broker client from `127.0.0.1` and has zero references to
`nodeId`/`targetNode`/`fleet` in any of its four attach modules. The remote
agent is never looked for.

**Chief hit this defect again tonight, independently, before finding the
issue already existed.** Diagnosing `soc2-lead-0811`'s dead session on
`barry` required SSHing in directly and using `attach --state-dir <exact
local path>` from inside the box itself — the standard CLI path from this
Mac could not reach it. That workaround does not scale and would not have
worked without direct host access.

**Why it matters more tonight than yesterday:** Daytona sandbox fleet nodes
just became a genuinely working execution surface (`daytona-fleet-proof-0811`,
verified end-to-end this session). The whole point of a sandbox node is
running work somewhere other than this Mac — and today nobody can watch or
drive an agent placed there without SSHing into the sandbox host directly,
the same supervision hole the issue names for `barry`.

**What already exists that could carry it, per the issue itself:** Cloud
already streams a terminal out of a remote box —
`cloud/ARCHITECTURE.md:136` describes a broker inside a sandbox providing
real-time terminal streaming with the client connecting directly. The ask is
not a new transport; it's pointing the existing one at a fleet node instead
of only a sandbox.

## What's asked for, verbatim from the issue

1. A way to attach to an agent hosted on another node in the same workspace
   — e.g. `agent-relay node agent attach <name> --node <node>`, or a
   workspace-scoped `agent attach` that resolves the host itself.
2. The `view`/`drive`/`passthrough` distinction preserved across the hop;
   `view` especially should be safe to hand to an observer.
3. A clear failure when the target node is unreachable, distinct from "no
   such agent."

**Explicitly not asked for:** relaxing `attach`'s local path, or a second
control plane. If the right answer is that this belongs in Cloud rather than
the relay CLI, the issue says so explicitly and it should be re-homed there
— it has no owner today and was never going to arrive as a side effect of
unrelated fleet work.

## Next

1. Publish/consume the Relay CLI build containing `ed8144c9a` so the short
   global command is available without using the source-worktree bin.
2. Keep the physical transport fail-closed: SSH auth is the trust boundary,
   the broker remains loopback-only, the API key remains on-host, JSON gets no
   PTY, and an ambiguous remote state directory requires `--state-dir`.
3. Implement canonical fleet-native `--node`: registry placement resolution
   plus an outbound ephemeral terminal tunnel. SSH remains fallback/recovery.
4. Restore the Daytona owner after the production secret/deploy blocker is
   cleared, add the Relayfile mount, and capture the named multi-host proof.

## History

- **2026-08-11** — Workstream opened. `relay#1449` had sat open, unowned,
  since 2026-08-10T17:29Z with no PR. Chief independently re-hit the same
  defect diagnosing `barry` tonight before finding the issue already
  existed — a sign this has been costing real time without a durable record
  pointing back to the fix.

- **2026-08-11** — `cross-node-attach-lead-0811` took ownership. Preflight:
  read all prior evidence (relay-1449-proof-0810 DMs, 9/9 attach failures,
  mechanism trace), cloud/ARCHITECTURE.md terminal-streaming section, all
  four attach modules. Architecture decision: PARTIALLY relay-CLI-owned,
  PARTIALLY Cloud-owned.

  **Phase 1 (relay#1480, review-ready):** Workspace-scoped name resolution
  for distinguishability — closes requirement #3. New `fleet-hint.ts`
  probes the workspace registry on 404; if the agent has `metadata.fleet.nodeId`
  on another node, emits "agent 'X' is registered on node 'finn-mini';
  cross-node attach is not yet supported" instead of "no agent named 'X'".
  11 new tests, 279 total green, mutation-tested. No new transport.

  **Phase 2 (Cloud-owned, design posted to relay#1449 comment):** Extend the
  existing terminal-streaming mechanism (cloud/ARCHITECTURE.md:133-176) to
  fleet-node-hosted agents. New Cloud API endpoint:
  `POST /workspaces/{wid}/fleet-nodes/{nodeId}/agents/{name}/attach →
  {execUrl, apiKey, ttlSeconds}`. Relay CLI adds `--node <nodeId>` that calls
  this endpoint and substitutes `execUrl` for the local broker URL. Mode
  preservation automatic (same WS protocol). Clear unreachable failure: 503
  from Cloud endpoint, distinct from 404.

  **Phase 3 (future, out of scope):** Physical fleet nodes (barry, finn-mini,
  sf-mini) — no signed-URL mechanism exists. Requires broker exposure beyond
  loopback + cloud proxy or new wire protocol.

- **2026-08-11 cleanup checkpoint** — `relay#1480` was verified merged at
  10:57Z. Phase 2 remains design-only: the lead's source check found no
  `execUrl`/signed-preview handler in the fleet package, only in the existing
  cloud-agent/sandbox paths. No implementation was started. The lead was
  waiting 94 minutes with zero pending messages and was released; this active
  workstream needs a new owner before coding resumes.

- **2026-08-11 physical-node deferral overturned by the live Barry need.**
  `relay#1483` implements `agent-relay node agent attach <name> --ssh-host
  <host>` as an explicit fallback by executing the existing attach client on
  the target. The broker stays loopback-only and its API key never leaves the
  host. From
  Khaliq's Mac, the built CLI rendered `chief-barry-codex-0811-1440` in view
  mode and delivered drive input that returned `NODE_DRIVE_OK`. A second live
  run used Barry's full Tailscale SSH hostname, proving the safe single-state
  fallback when the SSH alias differs from `barry-node`. Review found and the
  patch fixed JSON PTY contamination, project-local state discovery, ambiguous
  managed-state selection, empty hosts, and a duplicated mode type. Latest
  local gate: 326 attach tests, lint, format, CLI/workspace builds, diff check,
  and independent re-review green. Fleet-native `--node` remains the canonical
  follow-on for both physical and Daytona nodes.
