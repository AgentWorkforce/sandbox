---
status: active
owner: relayfile-subs-lead-0811
reports_to: agent-coordination-lead-0811
updated: 2026-08-11
repos: [relayfile, relay, cloud]
---

Goal: certain agents listen to certain things. An agent waiting on a specific
event — a PR merging, a review comment landing, a deploy completing — gets a
push the moment it happens, instead of a human or a sweep loop polling `gh`
on its behalf.

## Now — 2026-08-11 — appointed as a standing lead, not a one-off proof

**Origin:** Khaliq watched `daytona-lead-0811v3` sit waiting on `cloud#2984`'s
merge tonight with nothing but Chief's periodic sweep checking on it via `gh`
polling every 15-20 minutes. Asked for push-not-poll subscriptions. First
dispatch (`relayfile-subs-lead-0811`) was pointed at the wrong primitive —
`relayfile integration bind` (a lower-level channel-binding command) — before
a more direct one was found: top-level `agent-relay integration subscribe
[provider] --resource <value> --to @agent-or-#channel --events <list> --spawn
<cli>`, which subscribes a relay recipient directly to relayfile events, with
auto-spawn of the recipient if absent. Redirected mid-flight; verification of
that command is in progress.

**Khaliq then escalated this from a one-off proof to a standing, owned
capability: "get an agent team to own that."** `relayfile-subs-lead-0811` is
the accountable lead — not just for tonight's proof, but for the ongoing
question of *which agent should listen to which event*, across every
workstream this brain runs. It dispatches its own specialists per the
standard shape (appoint, hold to a standard, verify evidence — Chief does not
implement, and neither does a lead).

## The design question this lead owns

Not just "can an agent subscribe to an event" — **"which agent should listen
to what."** Examples already live in tonight's own workstreams:
- A lead waiting on its own PR's merge/CI state should hear about it directly,
  not poll.
- `pr-shepherd`'s whole design already assumes a push model (GitHub webhook
  triggers) — this workstream's mechanism may be exactly what backs it.
- Chief's own overnight sweep loop is itself a polling workaround for the
  absence of this — if the subscription mechanism is solid, the sweep's
  cadence can lengthen or shrink to something event-driven instead.

## Fleet Subscription Map — which agent should listen to what

Derived from reading all active workstream docs (2026-08-11). This is the
strategic design the lead owns. Each row is an agent/lane, the event it
should receive, and the subscription that would eliminate its polling.

### Tier 1 — Highest value, wiring is straightforward

Note: `--events` in `agent-relay integration subscribe` takes relay channel event names
(`message.created`, `thread.reply`), NOT GitHub event type strings. The VFS event column
shows what VFS event fires at the path; the relay channel receives it as `message.created`.

| Agent / Lane | Currently waiting on | VFS event (at path) | VFS path glob | Relay target | Priority |
|---|---|---|---|---|---|
| **daytona-lead** (any future instance) | A cloud or relayfile PR to merge | `file.updated` (state=closed, merged=true) | `/github/repos/AgentWorkforce/cloud/pulls/**` | `#github-pr-events` → agent polls channel for merge | HIGH |
| **pr-shepherd** (when built) | PR state changes across all repos (open, stale, CI red) | `file.created`, `file.updated` | `/github/repos/AgentWorkforce/**` | @pr-shepherd persona (via --spawn) | HIGH |
| **Chief's sweep loop** | PR merges, CI completions across all repos | `file.updated` | `/github/repos/AgentWorkforce/**` | Chief itself OR `#chief-github-events` | MEDIUM |

### Tier 2 — Valuable but require multi-provider setup

| Agent / Lane | Currently waiting on | VFS event | Provider | VFS path glob | Priority |
|---|---|---|---|---|---|
| **factory-live-dispatch** | Linear issue labeled `factory-ready` + `[factory]` title prefix | `file.updated` (label applied) | linear | `/linear/issues/**` | HIGH — the stale queue (17 eligible issues) only drains today when Chief polls |
| **lifecycle-workflows** (relayflows DAG) | Step completion signals from other agents | `file.created`/`file.updated` | github | `/github/repos/*/checks/**` | MEDIUM — relayflows already has `onRelay()` for agent-to-agent; external CI completion is the gap |
| **fleet-mount** (barry/finn-mini) | Mount sync health; workspace VFS updates | `file.updated` | relayfile (SDK) | `onWrite()` directly in mount binary | LOW — mounts already use `--websocket=true` poll + WebSocket |

### Tier 3 — Design not yet clear enough to subscribe

| Agent / Lane | Gap | Why not yet |
|---|---|---|
| **soc2-agent-traceability** | Audit events, deploy completions | Events not yet mapped to VFS paths |
| **sage/nightcto** | Factory recipe outputs | Coupling unclear until factory-live-dispatch wires up |
| **cross-node-attach** | Node health changes | Not a GitHub or Linear event |

### Key insight: Chief's sweep loop is the biggest win

Chief sweeps every 15-20 min across all repos. Replacing that with a
`#chief-github-events` subscription on `/github/repos/AgentWorkforce/**`
means Chief is notified within seconds of any PR merge, CI state change, or
review. The sweep cadence can then become a low-frequency health check (1/hr)
rather than the primary delivery mechanism. Immediate 90%+ reduction in gh
API calls from the local machine.

### Immediate next subscription to create (after KV fix)

```
agent-relay integration subscribe github \
  --resource AgentWorkforce/cloud \
  --to '#github-pr-events' \
  --events pull_request.closed
```

This covers `cloud` repo merge events — the daytona-lead use case. Once the
relaycast KV binding is live and the CLI `path_glob` bug is fixed, this is a
one-liner for any future daytona or cloud-waiting lead.

## Team

| Agent | Role | Status |
|---|---|---|
| relayfile-subs-lead-0811 | Standing lead — owns the design question | Active |
| relaycast-kv-0811 | Fix KV namespace binding in relaycast-cloud Worker | ✅ Complete — no code change needed, re-deploy only |
| subs-pattern-0811 | Write recipe doc at agent-event-subscriptions-pattern.md | ✅ Complete |

## Next

1. ~~Form small team~~ ✅ Done — relaycast-kv-0811 + subs-pattern-0811 running.
2. Await relaycast-kv-0811 findings → KV binding fix → end-to-end delivery test.
3. Await subs-pattern-0811 output → recipe doc published.
4. Once recipe doc is live and KV fix confirmed: create subscription for
   `AgentWorkforce/cloud` PRs → `#github-pr-events`.
5. Assess Chief's sweep loop reduction once cloud-PR subscription is proven.
6. File a relay CLI PR to fix the `pathGlob` → `path_glob` camelCase bug.

## Blockers

- **GitHub App webhook delivery suspended on GitHub's side (primary blocker):**
  `sync/status` shows `webhookLastEventAt: 2026-08-03T07:26:26Z`, `lagSeconds: 0`.
  The 27 dead-lettered envelopes are **NOT the cause** — they span May 30–July 15 (D1
  timeout failures, historic), and GitHub continued delivering events successfully after
  those through Aug 3. After Aug 3, GitHub stopped delivering entirely — `lagSeconds: 0`
  with no cursor movement means events aren't arriving at all (not failing to process).
  Issues created on the relay repo today (Aug 11) didn't advance the watermark, confirming
  real-time GitHub webhook delivery has stopped.
  `webhookHealthy: true` and `webhookLastError: null` = relayfile's receiving endpoint is
  alive and not returning errors to GitHub. The "connected" indicator is OAuth/installation
  health, not webhook delivery health.
  `sync/refresh POST {"provider":"github"}` returned 202 queued but watermark unchanged.
  **Root cause hypothesis**: GitHub suspended the App webhook on their side (separate from
  relayfile's connection status). This happens when repeated delivery failures are recorded
  on GitHub's end. The D1 errors were internal (relayfile returned 200 to GitHub), so
  that's not the trigger — but another failure mode may have caused GitHub-side suspension.
  **Admin action required:** Check GitHub App webhook delivery status in GitHub org settings
  (Settings → GitHub Apps → relayfile → Webhook deliveries) to see if delivery shows as
  Suspended or if recent deliveries have errors on GitHub's side. Also check whether the
  relayfile GitHub App webhook secret was rotated after Aug 3 (HMAC mismatch would cause
  silent discard → cursor stuck, but no error recorded).
- **relaycast KV binding — RESOLVED (relaycast-cloud#57 merged and deployed):**
  Run #31487818487 green (1m59s). Confirmed live: probing inbound URL returns 401 (HMAC
  fail) not 503 (KV fail). This blocker is cleared.
- **Daemon delegated credentials expired (FIXED):**
  All cached delegated tokens expired Aug 7. Fixed by minting a fresh `relay_ag_...` token
  via `POST /api/v1/workspaces/{cloud_uuid}/relayfile/delegated-token` and writing to
  `~/.relayfile/delegated/1fcac40f2f48ebae8ab4425d/07619f741036faf6ffda843a.json`.
  The daemon now bootstraps quickly without the 12-30s relay CLI exec on each call.
- **relay CLI bugs (2):**
  1. `pathGlob` vs `path_glob` — tracked relay#1479 (filed)
  2. `RELAYFILE_CLOUD_TOKEN` not passed — `runIntegrationList` passes `""` to
     `ensureCloudCredentials` instead of `*cloudToken`, forcing always-exec of relay binary.
     File: `main.go` line ~3534. To be filed as relay#1480 (or similar).
- **onWrite SDK alternative**: `@relayfile/sdk onWrite(pattern, handler)` bypasses relay
  channel entirely — agent subscribes directly to VFS events via WebSocket. Avoids KV
  dependency. **Chief/Khaliq decision needed** before adopting.

## History

- **2026-08-11 ~10:50Z** — relayfile-subs-lead update #4: daemon binary fix confirmed
  (was using broker binary; now uses relay binary at PID 39205). Second CLI bug found
  (`RELAYFILE_CLOUD_TOKEN` pass-through gap). `onWrite` SDK alternative documented.
  agent-coordination-lead ruled option C: document and hand off. relaycast-kv-lead is
  doing the KV fix investigation (relaycast-cloud#56).
- **2026-08-11** — Fleet subscription map drafted. Two specialists dispatched.
  Relaycast KV blocker identified. Subscribe exits 0 (daemon restarted with
  correct AGENT_RELAY_BIN); delivery blocked on KV fix.
- **2026-08-11** — Workstream opened. Khaliq escalated a one-off "wire this
  up" ask into a standing team appointment. `relayfile-subs-lead-0811`
  designated the accountable lead.
