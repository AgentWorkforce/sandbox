---
status: active
owner: cross-repo-coordinator-0812
reports_to: chief
updated: 2026-08-13
repos: [relay, cloud, relaycast-cloud, workforce, factory]
---

## Goal

Prove cross-machine, cross-harness session continuity via relayhistory.
Referred to in-session as "our first customer" — a real customer requirement,
not an internal exercise. Exact pasted spec text is not recoverable (see
provenance note below); only the shape of the work is known.

**Definition of done, confirmed directly by Khaliq (2026-08-13 09:53Z, via
chief-app-local, not reconstructed):** a session — its identity, ownership,
active actor, and full steering/turn history — that started on one machine
can be **picked up and continued from a different machine**. This is a
materially higher bar than [[cross-node-attach]], which streams a terminal to
an already-running process on its original host — that proves you can *watch/
drive* a remote session, not that the session itself can *relocate*.

**Mechanism, confirmed directly by Khaliq (2026-08-13 09:54Z, via
chief-app-local):** should work across both harness (Claude/Codex/etc.) and
machine, without special-casing, by leveraging the already-computed internal
relay session ID and uploading the session's jsonl transcript to
relayhistory-cloud. **The acceptance bar is explicit: agents must actually run
the entire flow end-to-end and fix whatever breaks — a design doc or partial
proof does not count.**

## Now — 2026-08-13, discovered via ai-hist reconstruction, not a live report

**This workstream did not exist before this entry.** It was reconstructed
after the fact because the owning session (`cross-repo-coordinator-0812`) got
walled off behind sf-mini's deadlocked broker (see [[cross-node-attach]],
2026-08-13 broker-wedge entries) before it ever produced a written report of
its own. Everything below comes from `ai-hist session <id>` transcript
reconstruction (prompts only, not the agent's own responses) cross-referenced
against sf-mini's local `state-sf-mini.json`, not from the agent self-reporting.

**Provenance and its limit:** `ai-hist` captured what the agent was told/asked,
not what it answered — so this record is reliable on scope and direction, not
on progress or findings the agent itself may have produced. Treat "what it's
actually built" as unknown until the session is reachable again.

**Origin:** `cross-repo-coordinator-0812` was originally dispatched (see
[[cross-node-attach]]) as a broad-scope delegate coordinator across
factory/cloud/relayhistory/chief — survey stale/blocked PRs and issues, fix
only low-risk items, no merges/deploys, explicitly told not to duplicate
`relay-drive-mode-claude-0812`, `relay-broker-ws-unknown-codex-0812`, or
`relayfile-backend-fix-v3-0812`'s work. Khaliq then attached to it directly in
drive mode and redirected it live into the relayhistory continuity proof —
a materially different, higher-stakes mission than its original brief.

**Sub-team it coordinates** (named sessions seen in sf-mini's state, status
unconfirmed beyond existing): `mp-continuity-proof-0813`,
`mp-turn-streaming-0813`, `mp-cred-probe-0813`, `mp-relayhistory-deploy-0813`,
`mp-factory-hooks-0813`, `mp-conflict-fix-0813-v2`.

**Correction 09:51Z — this is a cross-node effort, not sf-mini-only.** The
finn-mini agent inventory (see [[active-lanes]], 2026-08-13 entry) found
several `mp-*` sub-team members actually running on **finn-mini**, not
sf-mini: `mp-conflict-fix-0813` (done — workforce PR #208 now MERGEABLE/
CLEAN, released), `mp-factory-delivery-0813` (done — factory PR #238 opened,
released), `mp-integration-proof-0813` (**resolved, not at risk** — see correction
below), `mp-cred-probe-0812` (low-value duplicate of `mp-cred-probe-0813`'s
already-completed report).

**Correction 2026-08-13 09:58Z — `mp-integration-proof-0813`'s commits were
never actually orphaned.** The earlier "possibly unreachable after a pull"
concern traced (via its worker log and relay DM history) to a *different*
probe agent (`mp-cred-probe-0813`) checking its own separate, stale checkout
at 23:15 Aug 12 — not a real problem on the canonical checkout.
`mp-integration-proof-0813` had already corrected this within minutes (23:18Z)
and generated `git format-patch` backups as extra insurance (still present in
`/private/tmp/` on finn-mini, not required, `/tmp` won't survive a reboot).
Both commits (`5e186bc` "two-mode --resume via relayhistory", `295db42`
"keep Codex Relayhistory resume journal-only") are confirmed live on
`origin/feat/cross-harness-resume`. They backed `workforce#308`, opened then
**closed 2026-08-13T08:08:16Z by `kjgbot`**: *"Closing — needs redesign.
Session continuity belongs in @agent-relay/session in the relay repo (not
workforce CLI), with turn-kit as the SDK layer and SessionActor identity
model baked in. New PR incoming with correct implementation."* — this is
exactly `relay#1496`, already tracked above. `mp-integration-proof-0813`
itself appears idle/parked since ~01:22 local (flat CPU, no reply to a
status DM) — alive, not crashed, no urgent action needed. Khaliq
explicitly confirmed (09:52Z) both nodes need to be used for this effort, not
just sf-mini.

**Code-level PRs now identified as belonging to this effort, both draft/DIRTY,
being fixed 09:49Z:**
- **`relay#1496`** — `feat(relay): add @agent-relay/session SDK for
  cross-harness session continuity with full identity/attribution model`.
  Author Khaliq directly, branch `agent/session-sdk`. This is the actual SDK
  deliverable — persists session identity, immutable ownership, active actor,
  and steering audit trail through Relayhistory's turns journal; native
  continuation for Claude-to-Claude, attributed journal-context injection for
  cross-CLI/non-Claude handoffs. Rebase+undraft dispatched.
- **`relay#1497`** — `fix(auth): require SSO-principal sponsor for agent
  registration`, branch `agent/soc2-hole1-sso-sponsor`. Not obviously part of
  this effort by title alone, but flagged by Khaliq in the same breath as
  #1496 — likely the identity/attribution model in #1496 depends on this
  sponsor-binding auth layer being real. **Also a standing SOC2-critical fix**
  (workspace-key sponsor-impersonation vulnerability, real auditor deadline) —
  see `memory/` for that thread if it predates this workstream. Rebase+undraft
  dispatched with extra care given the security sensitivity.

**PRs/issues referenced in its transcript, not yet independently verified:**
- `workforce#308` — Khaliq questioned live whether this belongs in the
  `workforce` repo at all vs. the relay/SDK surface. **Open design question,
  unresolved.**
- `factory#237` — notification-surface feedback was given to it.
- `relaycast-cloud#23` — merged; the instruction was "have that agent track it
  and move on once merged."

**Blocked since ~08:44Z**, when sf-mini's broker (pid 44644) wedged mid-session.
Khaliq's own question — *"and what about the other lanes?"* — is the last
thing in its transcript, unanswered. The session itself is confirmed alive
(live PTY child of the wedged broker), not dead — see [[cross-node-attach]]
for the unwedge/root-cause effort in progress.

## 2026-08-13 20:14Z — the driveable-session capability is an SDK surface, not web-app-specific; v1 scope is a copy-pastable command, not xterm

Two scope clarifications from Khaliq, in sequence:

1. **The terminal-attach piece is connective tissue, not new work.** `relaycast-cloud`'s Durable Object (`packages/relaycast/src/durable-objects/node.ts`) already has a distinct `handleTerminalClientUpgrade()` WebSocket role, protocol-based and not CLI-process-specific — the CLI's `--node` attach (proven tonight, relay#1484/#1495) is just one client speaking it.
2. **But v1 doesn't need a real in-browser terminal at all.** Simplest possible version: for each session shown in a dashboard, display the exact copy-pastable `agent-relay node agent attach <name> --node <node> --mode drive` command with a copy button. No xterm, no WebSocket client, yet.

**Architectural requirement, applies regardless of which UI surface: this must be an SDK-level capability, not code embedded in the `cloud` web app.** Khaliq's stated end goal: Chief itself (this CLI/interactive tool) should eventually be able to list any principal's sessions (e.g. Will's) and construct/use the same attach capability, multiplayer-style — the web dashboard is only one client of this capability, not the only one. So "list attachable sessions" and "build the attach command for a session" belong as exported functions in `@agent-relay/session` (or wherever the SDK package boundary makes sense), called by the dashboard, not implemented as dashboard-local React logic. Same principle the terminal WebSocket protocol already follows (client-agnostic protocol, CLI is just one client) — apply it one layer up, at the session-listing/attach-command level too.

## 2026-08-13 20:00Z — reprioritization: Daytona is secondary, sf-mini/finn-mini primary; cloud dashboard is now the driving requirement

Khaliq explicit: Daytona mount/attach work is important but **secondary** — sf-mini and
finn-mini are the primary machines for this continuity-proof work. Also expanded scope,
stated directly: on the `cloud` web dashboard, real Chief/Skip sessions must be visible
and **driveable/continuable by either Khaliq or Will** (his cofounder), including
continuing a session that isn't the driver's own. Each session needs metadata describing
its actual goal/workstream objective so someone unfamiliar with it (specifically Will)
can understand what it's for without prior context. Requested in a 20-minute window.
`cross-repo-coordinator-0813` (replacement for the lost `-0812` session, see History)
and `cloud-chief-display-stale-0813` (already investigating a related stale-dashboard
bug in `cloud`) both redirected to this as top priority.

## Next

1. Get sf-mini's broker unwedged (tracked in [[cross-node-attach]]) — this is
   the only blocker preventing direct contact with the owning session.
2. Once reachable, get a real status report from `cross-repo-coordinator-0812`
   itself — this record is reconstructed from prompts, not from the agent's
   own account of progress.
3. Recover the actual pasted spec text if possible (may only exist in the
   live session's own context, not recoverable from `ai-hist`).
4. Resolve the `workforce#308` placement question with Khaliq.
5. Check status of all six `mp-*` sub-team sessions individually — none
   independently verified yet.

## History

### 2026-08-13
- Workstream opened retroactively by Chief after `ai-hist`-based
  reconstruction, prompted by Khaliq asking to capture finn-mini/sf-mini
  session histories durably before any spin-down/restart risk. See
  [[cross-node-attach]] for the sibling capture of `relay-drive-mode-fix-0813`
  and the broker-wedge investigation.
