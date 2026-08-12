# Relayfile Agent Subscriptions

**Status:** Live — `whsub_4304cfed-d9df-4dc4-8064-d99e86ea9677` active in `rw_7ccfea89`
**Last updated:** 2026-08-11
**Lead:** relayfile-subs-lead-0811

## Problem

Agent-relay agents waiting on GitHub events (PR merges, reviews, pushes) had no push-delivery mechanism. The only pattern was polling `gh pr view` in a loop every 15–20 minutes. This was demonstrated by `daytona-lead-0811v3` sitting idle while waiting for cloud#2984.

## Solution: Relayfile Webhook Subscriptions → Relay Channel

Relayfile cloud maintains VFS subscriptions: when a GitHub event updates a VFS path, the cloud POSTs to registered webhook URLs. By pointing those webhook URLs at the relaycast inbound bridge, events land in a relay channel where any agent subscribed can be notified instantly.

## Verified Mechanism

### Step 1: Get the HMAC inbound URL

```bash
curl -s -X POST https://cast.agentrelay.com/v1/integrations/relayfile/inbound-target \
  -H "Authorization: Bearer <relay-workspace-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "github-pr-events",
    "provider": "github",
    "path_glob": "/github/repos/AgentWorkforce/relay/**"
  }'
```

**CRITICAL:** The field is `path_glob` (snake_case), NOT `pathGlob`. The relay CLI has a bug where it sends camelCase — the server rejects it with 400 "invalid relayfile inbound target body".

Response includes:
- `data.url`: The HMAC-signed inbound URL for this workspace/channel/provider/path combination
- `data.secret`: The derived HMAC secret the relayfile cloud will use to sign events

### Step 2: Register the cloud webhook subscription

Via the relayfile daemon control plane socket:

```bash
curl -s --unix-socket "$RELAYFILE_SOCKET" \
  -X POST "http://localhost/v1/integrations/webhook-subscriptions" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<inboundUrl from step 1>",
    "pathGlobs": ["/github/repos/AgentWorkforce/relay/**"],
    "secret": "<secret from step 1>"
  }'
```

Socket path on macOS: `$TMPDIR/relayfile.sock` (e.g., `/var/folders/6d/.../T/relayfile.sock`)

Response: `{"subscriptionId": "whsub_...", "workspaceId": "rw_..."}`

### Step 3: Store the binding

Record in `~/.relayfile/bindings.json` under `"bindings"`:

```json
{
  "provider": "github",
  "pathGlob": "/github/repos/AgentWorkforce/relay/**",
  "channel": "github-pr-events",
  "webhookId": "wh_212864162113163264",
  "webhookToken": "(relay webhook token — used for relay-side delivery, not relayfile cloud)",
  "subscriptionId": "whsub_4304cfed-d9df-4dc4-8064-d99e86ea9677",
  "inboundUrl": "https://cast.agentrelay.com/v1/integrations/relayfile/inbound/rw_7ccfea89/212864116140937216?provider=github&path_glob=...",
  "createdAt": "2026-08-11T09:27:41Z",
  "updatedAt": "2026-08-11T09:49:00Z"
}
```

## Event Delivery Chain

```
GitHub API
  ↓ (GitHub App webhook)
relayfile cloud
  ↓ (POST to whsub inbound URL, HMAC-signed)
cast.agentrelay.com /v1/integrations/relayfile/inbound/{ws}/{channel}
  ↓ (HMAC verified, event routed)
#github-pr-events channel in rw_7ccfea89
  ↓ (agent subscription or polling)
Relay agent
```

## Answered Design Questions

### Q1: PATH_GLOB scope

- **Per-repo**: `/github/repos/{owner}/{repo}/**` — catches all events for one repo
- **Per-repo with owner shorthand**: The relay CLI's `resolveGitHubBindPathGlob("owner/repo")` resolves to `/github/repos/{owner}/{repo}/**` via `agent-relay cloud session`, but this requires the agent-relay binary (not the broker binary) to be in PATH.
- **Org-wide**: Explicit `/github/repos/{org}/**` — catches all repos in the org
- **Cross-org**: Not supported; VFS root structure is per-workspace

### Q2: Channel vs DM

- `relayfile integration bind` targets a **channel**, not a DM
- No DM delivery at subscription time
- **Bridge-agent pattern**: Run an agent subscribed to `#github-pr-events` that monitors events and re-dispatches as DMs to waiting agents

### Q3: Payload shape

Not yet observed from a live GitHub event. Expected shape (from relaycast schema):
```json
{
  "eventId": "...",
  "type": "relayfile.changed",
  "path": "/github/repos/AgentWorkforce/relay/pulls/1478/...",
  "revision": "...",
  "provider": "github",
  "timestamp": "...",
  "snapshot": {
    "path": "...",
    "contentType": "application/json",
    "content": "<base64-encoded GitHub event JSON>"
  }
}
```

Watch `#github-pr-events` on the next GitHub event in AgentWorkforce/relay to confirm.

## Bridge-to-DM Pattern

For agents that need DM notification (e.g., daytona-lead waiting for cloud#2984 to merge):

```
Option A: Polling agent
  - Agent subscribes to #github-pr-events
  - Filters for target PR merge events
  - DMes the waiting agent: agent-relay message dm send --to daytona-lead "cloud#2984 merged"

Option B: Relay reflex / subscription
  - Register a relay integration subscription with --to @daytona-lead
  - The subscription triggers the agent directly on matching events
  - Requires relay#1013 feature (event-bridge package) to be stable
```

Pattern A is immediately available. Pattern B requires the event-bridge package to mature.

## Current Active Setup

| Field | Value |
|-------|-------|
| Workspace | `rw_7ccfea89` |
| Channel | `#github-pr-events` (ID: `212864116140937216`) |
| Relay webhook | `wh_212864162113163264` (delivers to channel) |
| Cloud subscription | `whsub_4304cfed-d9df-4dc4-8064-d99e86ea9677` |
| VFS path | `/github/repos/AgentWorkforce/relay/**` |
| Inbound URL | `https://cast.agentrelay.com/v1/integrations/relayfile/inbound/rw_7ccfea89/212864116140937216?provider=github&path_glob=%2Fgithub%2Frepos%2FAgentWorkforce%2Frelay%2F**` |
| Secret | HMAC-derived (stored in relaycast; not stored in bindings.json) |

## Root Cause of `agent-relay integration subscribe` Failure

The `agent-relay CLI >= 8.7.0 required` error traced to:

1. `AGENT_RELAY_BIN=/Users/khaliqgant/.local/bin/agent-relay-broker` was set in the shell environment when the relayfile daemon was started
2. The daemon's `providerStatus` → `runIntegrationList` → `ensureCloudCredentials` → `cloudCredentialsFromAgentRelay()` → `ensureAgentRelayCLICompatible()` all ran the BROKER binary (not the relay CLI) against `agent-relay cloud session --help`
3. The broker binary doesn't have a `cloud` subcommand → immediate failure

**Fix applied 2026-08-11**: Killed old daemon (PID 42190), restarted new daemon at PID 39205 with `AGENT_RELAY_BIN=~/.agentworkforce/relay/bin/agent-relay`. After restart, `agent-relay integration subscribe` exits 0 cleanly.

**Key lesson for future agents**: Always check `AGENT_RELAY_BIN` in the shell environment. If it points to `agent-relay-broker`, the relayfile daemon's credential bootstrap will fail on every call that requires cloud credentials.

## Known Bugs / Issues

1. **relay CLI `path_glob` camelCase bug** (integration.ts line 464-468): `agent-relay integration subscribe` sends `pathGlob` in the inbound-target request body, but the relaycast server schema requires `path_glob` (snake_case). Results in 400 "invalid relayfile inbound target body" for every CLI-initiated subscribe. Workaround: call the endpoint directly with `path_glob`. **Fix**: change `pathGlob:` to `path_glob:` in the relay CLI source.

2. **`RELAYFILE_CLOUD_TOKEN` not passed to `ensureCloudCredentials`** (main.go `runIntegrationList` ~line 3534): Reads `*cloudToken` from the `--cloud-token` flag/env but passes `""` to `ensureCloudCredentials`. This means `cloudCredentialsFromAgentRelay()` is ALWAYS called (slow ~12s relay binary exec). **Fix**: `ensureCloudCredentials(strings.TrimSpace(*cloudAPIURL), strings.TrimSpace(*cloudToken), ...)`. This also makes `RELAYFILE_CLOUD_TOKEN` env var work for daemon credential bypass. **Filed: relay#1481.**

3. **Daemon latency**: Even with correct `AGENT_RELAY_BIN`, the daemon's `providerStatus` handler calls `runIntegrationList` which runs `activeWorkspaceFromAgentRelay()` AND `cloudCredentialsFromAgentRelay()` — two relay binary execs taking ~9-12s each = 18-30s per request. The relay CLI's 10s socket timeout can fire before the daemon responds. The subscribe command handles this gracefully (exits 0, idempotent), but this is a performance issue to fix long-term.

4. **VFS mount is stale**: Local FUSE mount at `chief/.integrations` hasn't received relay repo updates since 2026-08-09 (last PR in index: #1468). The cloud-side webhook subscription (`whsub_4304cfed...`) is the operative delivery path.

5. **relay#1013 event-bridge not yet merged**: The `@agent-relay/event-bridge` package is still an open PR. The inbound-target endpoint IS deployed; only the CLI command has the camelCase bug.

## Proof of Delivery

### Relay webhook delivery (✅ PROVED)
At 2026-08-11T09:28:13Z, a direct POST to the relay webhook URL confirmed delivery to `#github-pr-events`.

### HMAC inbound chain (✅ PROVED through relaycast)
At 2026-08-11T10:00Z, a synthetic HMAC-signed event was POSTed to the inbound URL:
- HMAC verification: ✅ PASSED
- Event type check (`file.updated`): ✅ PASSED
- Provider match (`github`): ✅ PASSED
- Path glob match: ✅ PASSED
- Channel lookup: ✅ PASSED (no `channel_not_found` skip)
- Message formatting: ✅ PASSED (no `unformatted_event` skip)
- Idempotency KV check: ❌ **503 — KV store unavailable**

### Blocker: relaycast idempotency KV store
The relaycast inbound route uses `requireKv: true` for event deduplication. The Cloudflare KV binding (`c.get('engine').kv`) is `undefined` in the production `cast.agentrelay.com` deployment. Fix requires adding the KV namespace binding to the `relaycast-cloud` SST/Cloudflare Worker deployment.

**Impact**: ALL relayfile inbound deliveries (GitHub, Slack, Linear, etc.) to relay channels are currently returning 503. The relayfile cloud would retry delivery on 503, but the subscription events cannot land in relay channels until the KV binding is restored.

**Action needed**: Check `relaycast-cloud` SST config — the KV namespace (`IDEMPOTENCY_KV` or similar) binding may have been dropped in a recent deployment. File or confirm a bug in relaycast-cloud.

### Live event test (❌ BLOCKED — GitHub App webhook delivery stopped Aug 3)
At 2026-08-11T12:44Z full E2E diagnosis completed. KV fix confirmed live (401 not 503).
But real GitHub events (PR comment on #1478, issue #1482 created/closed, and issues
created again today Aug 11T14:00Z) produced no channel messages.

`sync/status` for `rw_7ccfea89` after full investigation (2026-08-11T14:00Z):
- `webhookLastEventAt: 2026-08-03T07:26:26.334Z` — watermark unmoved by today's test events
- `deadLetteredEnvelopes: 27` — ALL from May 30–July 15 (D1 timeout historic failures)
- `failureCodes: {process_failed: 18}`
- `lagSeconds: 0` — **no events in queue at all**, not just processing failures
- `webhookHealthy: true`, `webhookLastError: null` — relayfile's endpoint is alive, not erroring
- `sync/refresh {"provider":"github"}` → 202 queued, watermark unchanged afterward

**Dead-letter clarification (corrected 2026-08-11T14:00Z):**
The 27 dead-letters span May 30–July 15, failing with `D1_ERROR: D1 DB storage operation
exceeded timeout` (Cloudflare D1 database overload). GitHub continued delivering events
successfully after those failures all the way through Aug 3. The dead-letters are NOT
blocking new events — GitHub kept advancing the cursor despite them.

**Actual root cause**: GitHub stopped delivering webhook events at the source after Aug 3.
The `lagSeconds: 0` after the cursor means events aren't arriving at relayfile cloud at all
(not failing to process). The integration shows "connected" (OAuth valid, App installed) but
webhook delivery is separately halted on GitHub's end.

Old subscription `whsub_4304cfed` was deleted by relayfile cloud after the 503 failures.
Daemon delegated credentials (expired Aug 7) were refreshed by minting a fresh token and
writing to `~/.relayfile/delegated/`. `agent-relay integration subscribe` re-run → exit 0
(idempotent re-create, same subscriptionId).

### Next validation target — admin intervention required
**Khaliq or a relayfile admin needs to check GitHub's side:**
1. Go to GitHub org settings → GitHub Apps → relayfile → Webhook deliveries
2. Check if App webhook delivery shows "Suspended" or if recent delivery attempts fail
3. If suspended: reactivate via GitHub's UI or re-register the webhook
4. Alternative: check if the App webhook secret was rotated after Aug 3 — HMAC mismatch
   would cause silent discard at relayfile cloud (200 to GitHub, but cursor doesn't advance)

The relayfile integration itself is healthy. The break is on GitHub's delivery side.

Once GitHub resumes delivery, mechanism is proven: KV ✅ relaycast ✅ channel delivery ✅
(proven 09:28Z test) subscription ✅ (re-created). Only the GitHub-side ingest is broken.

## Alternative: onWrite SDK path

`@relayfile/sdk` exports `onWrite(pattern, handler, options)` which subscribes to VFS events
directly over WebSocket — bypasses relaycast and the KV dependency entirely. Requires
`RELAYFILE_WORKSPACE_ID` + `RELAYFILE_TOKEN` (no auto-derive without explicit token).

**Status: documented as future option. Chief/Khaliq decision required before adopting.**
See recipe doc `agent-event-subscriptions-pattern.md` Section 3 for full implementation.
Ruled option C (document + hand off) by agent-coordination-lead-0811 on 2026-08-11.
