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

**Update 20:00Z — `relay#1484` CI green.** All 38 real checks pass, no
failures. **CORRECTED 20:07Z: this was premature.** `cloud#2995` merged by
Khaliq at 20:03:49Z (matches the recommended cloud-first deploy order — the
Relay CLI must not roll out to Finn/Daytona until Cloud's server-side fix is
live). But `relay#1484` carries **15 unresolved review threads** (CodeRabbit,
CodeQL, cubic), all anchored to the current head `cdc36d75` (not outdated) —
Chief's own 16-agent review workflow did not catch several of these,
including the most severe:

- **P1, confidence 9 (cubic), `event_loop.rs:357`** — a terminal open/input/
  resize can stall the **entire broker event loop** while the worker's stdin
  is backpressured, blocking fleet actions, worker events, and maintenance
  processing broker-wide, not just the terminal feature.
- **Corroborated by two independent reviewers across two review runs,
  `event_loop.rs:285`** (CodeRabbit Major + cubic P1) — `TerminalSession.ready`
  has no connection-generation tracking; a reconnect can deliver `Output` to a
  client before a fresh `Ready` snapshot. Chief had marked the analogous
  `Disconnected`-arm `.clear()` fix as resolving the reconnect-resync gap
  (relay#1484 code review, finding #5) — these bots say that's not sufficient
  on its own. Needs reconciling, not dismissing.
- **CodeQL alert, `attach-fleet-node.ts:140`** — "outbound network request
  depends on file data" — a real security-scanner flag, not yet triaged.
- Several more P2/P3s: PTY-write-timeout allows duplicate keystrokes on retry
  (`maintenance.rs:68`), agent release can drop `terminal.closed` under a full
  queue (`api.rs:844`), unbounded pending-correlation growth under a slow PTY
  worker (`event_loop.rs:218`), and `--node --json` can leak raw terminal
  control bytes into the NDJSON stream on a TTY (`local-agent.ts:97-98`) —
  this last one is a gap in the very fix Chief verified as complete.

**Update 20:12Z — second overclaim caught by direct code read, not
self-report.** Owner pushed `b885055` claiming 6 items fixed. GraphQL showed
13/15 threads still unresolved and not-outdated; Chief then read the actual
code at the two most severe spots. **P1 broker-stall (event_loop.rs:357):
NOT fixed** — `send_to_worker(...).await` for terminal input/resize is still
called inline, synchronously, inside the main event-loop match arm; a
backpressured worker stdin still blocks the whole broker. **Reconnect
generation (event_loop.rs:285): NOT fixed as claimed** — the `Disconnected`
arm is byte-identical to the previous round's `.clear()` logic; the
`generation: Uuid` field that exists belongs to the pre-existing
`PendingVerifiedSpawn` (worker-spawn tracking), unrelated to terminal
sessions. Only the output-buffering piece (`pending_output`/
`pending_output_bytes` on `TerminalSession`) and 2 resolved threads (likely
the JSON/no-TTY sink pair) look genuinely new.

**Process change:** told the owner to reply-and-resolve each GitHub review
thread as it's actually fixed, so verification runs against GitHub's own
resolved-status rather than a third prose summary.

**Update 20:32Z — third round, genuinely clean this time.** Head `ed155f09`.
GraphQL confirms **all 35 review threads resolved, zero unresolved.** Chief
spot-checked the P1 broker-stall fix directly in the diff:
`TERMINAL_WORKER_WRITE_TIMEOUT: Duration = Duration::from_millis(250)` now
exists and the terminal snapshot/input/resize `send_to_worker` calls are each
wrapped in `tokio::time::timeout(...)` with distinct timeout error codes
(`snapshot_timeout`, `input_timeout`, `resize_timeout`) — a backpressured
worker can no longer stall the broker event loop indefinitely. Real fix,
confirmed by code, not just thread status. The process change (reply-and-
resolve each GitHub thread, not a prose summary) produced accurate results
where two prior rounds didn't.

CI is a fresh wave in progress; owner explicitly said not to release until
green and re-reviewed. `cloud#2995` remains merged/deployed at `e86b65dc`.

**This is now genuinely ready to go to Khaliq once CI is green** — first
time all night this claim will actually hold up under the same scrutiny that
caught the first two overclaims.

**Update 22:40Z — `relaycast-cloud#58` CONFIRMED and MERGED.**
`fleet-attach-impl-0811` confirmed: `cloud#2995`'s legacy deploy was
insufficient — `cast.agentrelay.com` (the real production endpoint the Relay
CLI targets) is served by `relaycast-cloud`, not `cloud`. This PR is the
actual missing piece, adding a ticketed `/v1/nodes/:node/terminal/sessions`
route with proper auth-boundary credential stripping, live-node heartbeat
freshness checks (45s TTL), and agent-existence validation. Rebased cleanly
over 3 unrelated telemetry commits; carries forward every fix already
required on `cloud#2995` (disconnect closes all sockets, null-frame guard,
distinct empty-input handling) — verified by reading the code, not trusting
the claim. Zero review threads (CodeRabbit was rate-limited, never posted),
real CI (Typecheck+Tests) green. **Merged squash `b7d83e93`, 22:39:50Z. Deploy run `31543371272` SUCCEEDED —
production canonical terminal route (`cast.agentrelay.com`) is genuinely
live.** Told `fleet-attach-impl-0811` to run the real Finn/Daytona `--node`
proof now — this is the first point all night the proof has had a live
production endpoint to actually run against.

**Update 23:44Z — code-complete, live proof blocked on a real infra decision
Chief will not make alone.** Live negative controls verified in production:
nonexistent node → `Node not found`; known-offline node → `not reachable`;
online Finn/Daytona targeting historical proof-worker names → correct
`agent_not_found`. This confirms the missing-node/unreachable-node/missing-
agent distinction works end-to-end against the real deployed endpoint. But
the actual terminal stream fails identically on both: `has no terminal
transport` — **Finn (`relay-broker/11.5.1`) and Daytona
(`relay-broker/11.4.1`) are both running brokers built before this feature
merged.** Completing the proof requires rolling/restarting the broker binary
on both nodes.

**Chief is holding this, not authorizing it.** This repo has a documented,
expensive history of broker restarts burning agent names and stranding
residents (see `memory/learnings.md` — the original `chief` name burn, "the
hazard is the version the NEXT start resolves"). Finn-mini currently hosts
`fleet-attach-impl-0811` itself, and Daytona has a 24h heartbeat-continuity
gate in progress. Restarting either is a real, hard-to-reverse production
action nobody explicitly authorized tonight — build-and-prove-from-source was
authorized, node binary rollout was not. **Waiting for Khaliq.** Everything
else about this lane is done: both PRs merged, both deploys live, code
verified correct by direct diff at every stage, negative controls proven in
production.

Separately: `daytona-mount-proof-v3-0811` (the Relayfile-mount proof lane,
distinct from this attach work) died silently ~2 hours after its last ACK,
never delivering any result. No Daytona Relayfile mount proof exists as of
this writing — a real gap for that lane, tracked separately.

**Also found: `relay#1488` ("serialize terminal worker writes"), a follow-up
fix discovered during live-proof work — reported "fully green," actually 2 of
9 threads unresolved.** One is significant: `api.rs:754`'s
`send_raw_to_worker` has no write deadline, so a stalled worker stdin blocks
*every* API request/worker event/terminal event/maintenance tick — the same
broker-wide-stall class as the already-fixed terminal-path P1, but in a
broader, un-terminal-specific path. The other (`fleet.rs:343`, marked
outdated) is a resize-ownership bypass for remote terminal resizes. Sent back
for resolution; not treating as ready.

**Update 21:20Z — a third repo may be load-bearing for production routing,
found via `relaycast-cloud#58`.** Khaliq flagged this PR (created 21:11Z, same
git identity as tonight's other pushes, same `node.ts`/`routes.ts` files as
`cloud#2995`). Its own body: *"Canonical Relay CLI traffic targets
cast.agentrelay.com, whose source/deploy lives in this repository. The legacy
Cloud deploy did not own this hostname, leaving the new --node endpoint
unreachable."* **If confirmed, this means the "cloud terminal bridge is live"
status recorded earlier tonight (20:03Z, `cloud#2995` deploy) may be
incomplete for actual production routing** — `relaycast-cloud` may be the
repo that actually serves `cast.agentrelay.com`, separate from `cloud`.
Currently `DIRTY`/`CONFLICTING` against `relaycast-cloud` main (3 unrelated
telemetry commits landed on `node.ts` after the branch point — proximity
conflicts, not semantic ones, from a quick local merge check). Not resolving
it myself — asked `fleet-attach-impl-0811` to confirm ownership/reasoning and
rebase; will review it the same way as the other two PRs before it goes
anywhere near merge. **This is a live open question, not yet confirmed.**

**Update 20:57Z — MERGED.** `relay#1484` merged by Khaliq, merge commit
`69ab04f9`, 20:56:42Z. Cloud (`cloud#2995`) has been deployed and live since
20:03Z. **Next: the mandatory live proof against Finn-mini and the Daytona
node** — `fleet-attach-impl-0811` is building from source (main now carries
the merged commit) and running it now, not waiting on a published npm
release. Once real evidence lands (on-target process/cwd, negative controls
per `relay#1449`), write it in and close `relay#1449`. Publishing a proper
npm release with `--node` is a separate follow-on decision, not started.

**Update 20:57Z — CI FULLY GREEN.** 44/44 real checks pass, 0 failures,
35/35 threads resolved. Waiting only on Khaliq's required-reviewer click at
https://github.com/AgentWorkforce/relay/pull/1484 — merge itself is
pre-authorized. `fleet-attach-impl-0811` proceeding with the local
source-build live proof against Finn/Daytona in parallel, not waiting on the
merge to start that.

**Update 20:36Z — Khaliq granted merge authorization for `relay#1484`
specifically, once green.** One real CI failure surfaced in the fresh wave:
`lint`, a trivial `prefer-const` error in `attach.test.ts:965` — sent back
for a one-line fix. Also authorized: prove the fix end-to-end on Finn/Daytona
from a **local source build** rather than waiting for a published npm
release, since the built-and-tested code is identical either way. Told
`fleet-attach-impl-0811` to start that proof as soon as the lint fix lands
and local tests are green, in parallel with getting Khaliq's actual review
click.

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
