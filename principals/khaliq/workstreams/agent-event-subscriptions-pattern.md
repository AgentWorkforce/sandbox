---
status: active
owner: none (reference doc, not a task lane)
reports_to: relayfile-subs-lead-0811
updated: 2026-08-12
---

**2026-08-12 correction:** frontmatter previously listed `subs-pattern-0811`
as owner. That agent name is not registered anywhere in the workspace —
verified via a direct DM attempt ("Agent not found"). This file was never an
active task lane; it's reference documentation. No one is idle here because
no one was ever assigned.

# Agent Event Subscription Pattern

Reference doc for any future agent lead who needs to subscribe itself or a
channel to a specific GitHub event without re-deriving the commands from
scratch. Covers both the CLI path (`agent-relay integration subscribe`) and
the SDK in-code path (`onWrite` from `@relayfile/sdk`).

**Delivery blocker (as of 2026-08-11):** End-to-end delivery through relaycast
is blocked by the idempotency KV store being unbound in production
(`cast.agentrelay.com`). All inbound delivery currently returns 503. The KV
namespace binding fix is pending in `relaycast-cloud`. Subscribe commands
still succeed (exits 0, bindings stored), but events will not land in relay
channels until the KV binding is restored. See "Known Bugs" section.

---

## 1. "I am a lead waiting for PR #N to merge — what do I run?"

After verifying prerequisites (Section 6), run:

```bash
export RELAY_WORKSPACE_KEY="rw_7ccfea89"   # production workspace key

agent-relay integration subscribe github \
  --resource AgentWorkforce/relay \
  --to '#github-pr-events' \
  --events message.created,thread.reply \
  --workspace-key "$RELAY_WORKSPACE_KEY"
```

For a different repo (e.g., `cloud`):

```bash
agent-relay integration subscribe github \
  --resource AgentWorkforce/cloud \
  --to '#github-pr-events' \
  --events message.created,thread.reply \
  --workspace-key "$RELAY_WORKSPACE_KEY"
```

Then listen on the channel. When a PR merge event fires, it will land in
`#github-pr-events`. The channel message content includes the VFS path
(e.g., `/github/repos/AgentWorkforce/cloud/pulls/<N>/meta.json`) and the
provider event JSON. Filter for `state: closed, merged: true` to detect a
merge specifically.

To get notified directly as a named agent instead of a channel:

```bash
agent-relay integration subscribe github \
  --resource AgentWorkforce/cloud \
  --to '@daytona-lead' \
  --spawn 'agent-relay agent spawn --name daytona-lead --cli "claude --agent"' \
  --events message.created \
  --workspace-key "$RELAY_WORKSPACE_KEY"
```

`--spawn` is a relay CLI string executed to create the recipient agent if it
does not exist in the workspace. Only supported for agent targets, not channels.

---

## 2. CLI Path — Step by Step

### Full command signature

```
agent-relay integration subscribe [provider] \
  --resource <value>           # provider-native resource (e.g. "owner/repo")
  --to <target>                # relay recipient: @agent-name or #channel-name
  --events <list>              # comma-separated relay event names (see Section 4)
  [--spawn <cli>]              # shell command to create the agent if absent
  [--bridge-url <url>]         # writeback bridge URL (optional, enables bidirectional)
  [--bridge-secret <secret>]   # HMAC secret for writeback bridge
  [--workspace-key <key>]      # relay workspace key (or RELAY_WORKSPACE_KEY env)
  [--token <token>]            # agent token (or RELAY_AGENT_TOKEN env)
  [--base-url <url>]           # relay API base URL (or RELAY_BASE_URL env)
```

### What the command does internally (5 steps)

1. Resolves `--resource` (e.g., `AgentWorkforce/relay`) to a VFS path glob via
   `resolveResourcePath(provider, resource)` → e.g.,
   `/github/repos/AgentWorkforce/relay/**`
2. Creates a relay inbound webhook via
   `POST https://cast.agentrelay.com/v1/integrations/relayfile/inbound-target`
   with `{ channel, provider, pathGlob }` in the request body (see Bug 1 below)
3. Registers a relayfile cloud webhook subscription at the resolved path glob
   via the daemon control-plane socket (`$TMPDIR/relayfile.sock`)
4. Stores a binding in `~/.relayfile/bindings.json` with the subscription ID,
   inbound URL, and relay webhook token
5. Creates a relay integration subscription for writeback (bidirectional event
   delivery from the relay channel back to the provider via the writeback bridge)

### Verify a subscription was created

```bash
agent-relay integration subscribe --list --workspace-key "$RELAY_WORKSPACE_KEY"
```

Or check the bindings file:

```bash
cat ~/.relayfile/bindings.json
```

Currently active binding in `rw_7ccfea89`:
- Subscription ID: `whsub_4304cfed-d9df-4dc4-8064-d99e86ea9677`
- Path glob: `/github/repos/AgentWorkforce/relay/**`
- Channel: `#github-pr-events` (channel ID `212864116140937216`)
- Inbound URL: `https://cast.agentrelay.com/v1/integrations/relayfile/inbound/rw_7ccfea89/212864116140937216?provider=github&path_glob=%2Fgithub%2Frepos%2FAgentWorkforce%2Frelay%2F**`

---

## 3. SDK In-Code Path

Use `onWrite` from `@relayfile/sdk` when an agent wants to subscribe directly
inside its own Node.js process. This bypasses relay channels entirely and
receives events over a persistent WebSocket.

### Installation

```bash
npm install @relayfile/sdk
```

### Basic usage

```javascript
import { onWrite } from '@relayfile/sdk';

// Subscribe to PR changes on AgentWorkforce/relay
const unsubscribe = onWrite(
  '/github/repos/AgentWorkforce/relay/**',
  async (event) => {
    console.log('VFS write event:', event.operation, event.path);

    // Detect PR merge: path ends with /meta.json (or /pulls/<N>.json),
    // and the content (when available) has state=closed, merged=true.
    // Note: event.value is not yet populated in v1 — read the path separately.
    if (event.path.includes('/pulls/') && event.operation === 'update') {
      console.log('PR state change at', event.path);
      // Fetch the file content to check if merged=true:
      //   const content = await relayfileClient.readFile(event.path);
      //   if (content.state === 'closed' && content.merged === true) { ... }
    }
  },
  {
    workspaceId: process.env.RELAYFILE_WORKSPACE_ID,  // e.g. "rw_7ccfea89"
    operations: ['create', 'update'],                  // default; add 'delete' if needed
    // token: omit — auto-derived from client.getToken() and refreshed on reconnect
  }
);

// To stop listening:
// unsubscribe();
```

### Full signature

```typescript
onWrite(
  pattern: string,              // VFS path glob, must start with '/', '**' only valid at end
  handler: (event: WriteEvent) => void | Promise<void>,
  options?: {
    client?: RelayFileClient;   // custom client; if omitted, reads RELAYFILE_TOKEN env
    workspaceId?: string;       // if omitted, reads RELAYFILE_WORKSPACE_ID env
    operations?: ('create' | 'update' | 'delete')[];  // default: ['create', 'update']
    signal?: AbortSignal;       // abort controller to stop the subscription
    baseUrl?: string;           // if omitted, reads RELAYFILE_BASE_URL or uses default
    token?: string | (() => string | Promise<string>); // WS auth override; leave unset for auto
    onPollingFallback?: (info: { reason: string; cause?: unknown }) => void;
  }
): () => void  // returns unsubscribe function
```

### WriteEvent shape

```typescript
{
  workspaceId: string;       // e.g. "rw_7ccfea89"
  path: string;              // e.g. "/github/repos/AgentWorkforce/relay/pulls/1478/meta.json"
  operation: 'create' | 'update' | 'delete';
  revision: string;          // VFS revision ID
  previousRevision: null;    // not yet populated in v1
  timestamp: string;         // ISO 8601
  source: 'agent' | 'sync' | 'api';  // 'sync' = came from a provider webhook
}
```

Note: `event.value` (file content) is not populated in v1. To read the actual
PR JSON after an event fires, use the relayfile REST API or FUSE mount.

### Required environment variables

```bash
RELAYFILE_WORKSPACE_ID=rw_7ccfea89   # workspace ID
RELAYFILE_TOKEN=<token>               # auth token (if not providing a custom client)
# Optional:
RELAYFILE_BASE_URL=https://api.relayfile.com   # defaults to production
RELAYFILE_SDK_DEBUG=true              # enable verbose SDK logging to stderr
```

---

## 4. Event Names

### `--events` values for `agent-relay integration subscribe`

The `--events` flag accepts comma-separated relay event names. These are relay
channel message types, not GitHub webhook event types.

| `--events` value | When it fires |
|---|---|
| `message.created` | A new message is posted to the relay channel (default) |
| `thread.reply` | A reply is posted to an existing thread (default) |
| `message.created,thread.reply` | Both of the above (the default if `--events` is omitted) |

The relay events `message.created` and `thread.reply` are the only two
currently supported by `agent-relay integration subscribe`. They correspond to
new events landing in the relay channel from the relayfile inbound bridge.

### VFS event types used by `onWrite` and `relayfile listen`

The `onWrite` SDK and the `relayfile listen` CLI use VFS-level event types:

| VFS event type | Relay SDK `operation` | When it fires for GitHub |
|---|---|---|
| `file.created` | `'create'` | New PR opened, new commit, new review posted |
| `file.updated` | `'update'` | PR state change (open→closed→merged), push to branch, review updated |
| `file.deleted` | `'delete'` | Object actually deleted upstream (not for closed/merged/archived — see Section 5) |

### GitHub → VFS event mapping

| GitHub event | VFS event | VFS path pattern |
|---|---|---|
| PR opened | `file.created` | `/github/repos/{owner}/{repo}/pulls/{N}/meta.json` |
| PR updated (title, body, label) | `file.updated` | `/github/repos/{owner}/{repo}/pulls/{N}/meta.json` |
| PR merged (state=closed, merged=true) | `file.updated` | `/github/repos/{owner}/{repo}/pulls/{N}/meta.json` |
| PR closed without merge | `file.updated` | `/github/repos/{owner}/{repo}/pulls/{N}/meta.json` |
| Review submitted | `file.created` | `/github/repos/{owner}/{repo}/pulls/{N}/reviews/{id}.json` |
| Review updated | `file.updated` | `/github/repos/{owner}/{repo}/pulls/{N}/reviews/{id}.json` |
| Issue opened | `file.created` | `/github/repos/{owner}/{repo}/issues/{N}.json` |
| Issue updated/closed | `file.updated` | `/github/repos/{owner}/{repo}/issues/{N}.json` |
| Commit pushed | `file.created` or `file.updated` | `/github/repos/{owner}/{repo}/commits/{sha}.json` |

**PR merge is a `file.updated` event, not a `file.created` event.** A PR
goes from open → closed with `merged: true`, and relayfile updates the
existing file at the PR's path rather than deleting it. Closed/merged/archived
state is preserved as data, not represented as a file delete.

---

## 5. VFS Path Reference

### Path structure for GitHub events

```
/github/repos/{owner}/{repo}/
  pulls/
    {number}/
      meta.json           # PR metadata (state, merged, title, author, etc.)
      reviews/
        {review_id}.json  # individual reviews
    by-label/{label}/     # alias subtree (listing only, not materialized per-PR)
  issues/
    {number}.json
    by-assignee/{accountId}/
      {number}.json       # alias
  commits/
    {sha}.json
```

### Path for a specific PR merge

If you are waiting for PR #1478 in `AgentWorkforce/relay` to merge, the path
that gets a `file.updated` event is:

```
/github/repos/AgentWorkforce/relay/pulls/1478/meta.json
```

To subscribe to all PRs in a repo:

```
/github/repos/AgentWorkforce/relay/pulls/**
```

To subscribe to all PRs across all AgentWorkforce repos:

```
/github/repos/AgentWorkforce/**
```

### Path format notes

- `{owner}/{repo}` maps to `/github/repos/{owner}/{repo}/` with a forward
  slash separator (no `__` double-underscore). The digest test data uses
  `AgentWorkforce__workforce` in canonical paths only when displaying
  multi-level identifiers in a flat context; the actual VFS path uses `/`.
- The `--resource` flag on `agent-relay integration subscribe` accepts the
  GitHub shorthand `owner/repo` and the CLI resolves it to the full VFS glob
  via `resolveGitHubBindPathGlob("owner/repo")` → `/github/repos/{owner}/{repo}/**`.
  This requires the relayfile daemon to be reachable (see Prerequisites).

---

## 6. Prerequisites Checklist

Before running `agent-relay integration subscribe`:

- [ ] **Relayfile daemon running** with correct `AGENT_RELAY_BIN`

  The daemon MUST be started with `AGENT_RELAY_BIN` pointing to the relay CLI
  binary, not the broker binary:

  ```bash
  # Correct:
  export AGENT_RELAY_BIN=~/.agentworkforce/relay/bin/agent-relay
  relayfile daemon start

  # Wrong — will break all cloud credential calls with "agent-relay >= 8.7.0 required":
  export AGENT_RELAY_BIN=~/.local/bin/agent-relay-broker
  relayfile daemon start
  ```

  To verify the running daemon has the right binary:
  ```bash
  ps aux | grep relayfile | grep -v grep
  # Look for AGENT_RELAY_BIN in the environment of the daemon process
  # Or restart with the correct env if unsure
  ```

- [ ] **`RELAY_WORKSPACE_KEY` set**

  ```bash
  export RELAY_WORKSPACE_KEY="rw_7ccfea89"   # production workspace key
  ```

  Obtain from: `agent-relay cloud session` or `~/.agentworkforce/relay/cloud-auth.json`.

- [ ] **GitHub integration connected**

  ```bash
  relayfile integration status github
  # Should show: connected
  ```

  If not connected:
  ```bash
  relayfile integration connect github
  ```

- [ ] **Relay workspace accessible**

  ```bash
  agent-relay workspace list --workspace-key "$RELAY_WORKSPACE_KEY"
  ```

- [ ] **Relaycast KV store bound (BLOCKED as of 2026-08-11)**

  End-to-end event delivery to relay channels requires the idempotency KV
  namespace to be bound in the `relaycast-cloud` Cloudflare Worker deployment.
  Until the KV binding is restored, all inbound deliveries return 503. Subscribe
  commands succeed and bindings are stored, but events will not flow through.

  Check status: `relaycast-kv-0811` is investigating the fix.

---

## 7. Known Bugs

### Bug 1: relay CLI sends `pathGlob` (camelCase) but server requires `path_glob` (snake_case)

**Location:** `packages/cli/src/cli/commands/integration.ts`, line ~467

```typescript
// BUG: current code
body: JSON.stringify({
  channel: input.channel,
  provider: input.provider,
  pathGlob: input.pathGlob,   // ← wrong: server requires path_glob
}),
```

**Symptom:** `agent-relay integration subscribe` exits with error:
`Could not create relayfile inbound target: invalid relayfile inbound target body`

**Workaround:** Call the inbound-target endpoint directly with the correct field name:

```bash
curl -s -X POST https://cast.agentrelay.com/v1/integrations/relayfile/inbound-target \
  -H "Authorization: Bearer $RELAY_WORKSPACE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "github-pr-events",
    "provider": "github",
    "path_glob": "/github/repos/AgentWorkforce/relay/**"
  }'
```

Alternatively, use a `/`-prefixed path directly in `--resource`:
```bash
agent-relay integration subscribe github \
  --resource '/github/repos/AgentWorkforce/relay/**' \
  --to '#github-pr-events'
```

**Fix:** Change `pathGlob:` to `path_glob:` in `integration.ts` line ~467.
Relay CLI PR needed.

### Bug 2: Daemon must be started with `AGENT_RELAY_BIN` pointing to relay CLI, not broker

**Location:** Relayfile daemon credential bootstrap

**Symptom:** All calls requiring cloud credentials fail with:
`agent-relay CLI >= 8.7.0 required` (or similar version check error)

**Root cause:** The daemon's `providerStatus → runIntegrationList →
ensureCloudCredentials → cloudCredentialsFromAgentRelay()` calls the binary
pointed to by `AGENT_RELAY_BIN`. If that binary is `agent-relay-broker` (which
has no `cloud` subcommand), the credential bootstrap fails on every request.

**Workaround:** Kill and restart the daemon:
```bash
# Kill old daemon
kill $(pgrep -f "relayfile daemon")

# Restart with correct binary
AGENT_RELAY_BIN=~/.agentworkforce/relay/bin/agent-relay relayfile daemon start
```

**Verify:**
```bash
agent-relay integration subscribe github \
  --resource AgentWorkforce/relay \
  --to '#github-pr-events' \
  --workspace-key "$RELAY_WORKSPACE_KEY"
# Should exit 0, not "agent-relay CLI >= 8.7.0 required"
```

### Bug 3: Relaycast idempotency KV store unbound in production (primary delivery blocker)

**Location:** `cast.agentrelay.com` Cloudflare Worker deployment (`relaycast-cloud`)

**Symptom:** All relayfile inbound delivery POSTs return HTTP 503.
`c.get('engine').kv` is `undefined` in the worker — the KV namespace binding
was dropped in a recent deployment.

**Impact:** This blocks ALL relayfile inbound deliveries (GitHub, Slack, Linear,
etc.) to relay channels. `agent-relay integration subscribe` exits 0 and
bindings are created, but events cannot land in channels until the binding is
restored.

**Workaround:** None — this requires a deployment fix to `relaycast-cloud`'s
SST/Cloudflare Worker config to re-add the KV namespace binding
(`IDEMPOTENCY_KV` or equivalent).

**Status:** `relaycast-kv-0811` is investigating. Track the fix before testing
end-to-end delivery.

---

## Full Event Delivery Chain (when working)

```
GitHub App webhook (on any repo event)
  ↓
relayfile cloud (validates, maps to VFS path, emits file.created/updated/deleted)
  ↓  (POST to whsub inbound URL, HMAC-signed)
cast.agentrelay.com /v1/integrations/relayfile/inbound/{ws}/{channelId}
  ↓  (HMAC verification → idempotency KV check → channel lookup → message format)
#github-pr-events channel in rw_7ccfea89
  ↓  (message.created or thread.reply event)
Any relay agent subscribed to the channel
```

The relay channel message payload (expected shape, unconfirmed until first live delivery):
```json
{
  "eventId": "...",
  "type": "relayfile.changed",
  "path": "/github/repos/AgentWorkforce/relay/pulls/1478/meta.json",
  "revision": "...",
  "provider": "github",
  "timestamp": "2026-08-11T10:00:00Z",
  "snapshot": {
    "path": "...",
    "contentType": "application/json",
    "content": "<base64-encoded GitHub PR JSON>"
  }
}
```

Watch `#github-pr-events` after the KV fix to confirm the actual shape.
