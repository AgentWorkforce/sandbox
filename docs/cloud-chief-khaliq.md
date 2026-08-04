# Cloud deployment: chief-khaliq

`chief-khaliq` is a tenant-scoped, `cloud: true` persona. It complements the
local resident Chief without requiring a resident broker or a manually managed
daemon in the Cloud path. Each matching customer event runs in an isolated
sandbox and exits after its originating-surface reply is admitted.

## Supported customer surfaces

The static listener is the default-exported `defineAgent(...)` block in
`personas/chief-khaliq/agent.mjs`:

- Slack: catalog-backed `message.created` with the runtime's `@mention` match,
  replied to through the Slack Relayfile reply path for the originating channel
  and thread.
- Telegram: `message`, replied to through the Telegram messages writeback path
  for the originating chat with `reply_to_message_id`.

Both providers use the workspace-scoped integrations supported by the
Workforce persona schema. The handler normalizes the two payloads into one
message shape, rejects bot-authored, malformed, oversized, wrong-provider, and
wrong-tenant events, then gives the same allowlisted context to the harness.
Provider writeback receives a deterministic idempotency key derived from the
workspace, surface, and delivery id, so a delivery retry cannot create a
second external reply.

Agent Relay is not used as customer egress. It remains internal agent-to-agent
infrastructure and a test/reachability surface.

## Repo-backed context boundary

`personas/chief-khaliq/context.manifest.json` pins:

- repository: `https://github.com/AgentWorkforce/chief.git`
- reviewed ref: `refs/pull/13/head`
- commit: `004472f27f65940313ce9348a503124baa2184b7`

Every selected source file carries a SHA-256 digest. The generator reads those
files from the pinned Git object, not the current working tree. The roster is
reduced to the principal fields plus the `chief-khaliq` seat's name and role.
Only the selected Khaliq policy/memory and two relevant workstreams are
embedded. The build rejects path expansion, hash drift, repository drift, and
secret-shaped values.

The generated module is imported by the handler, so the deployment compiler
includes only the selected bytes. No raw repository archive is uploaded.

## Checks and deployment

```bash
npm run cloud:context:check
npm run cloud:typecheck
npm run cloud:test
npm run cloud:compile:check
npm run cloud:deploy:khaliq:dry-run
```

The deploy command is intentionally one tenant agent at a time:

```bash
npm run cloud:deploy:khaliq
```

It rebuilds the pinned context and calls the supported CLI surface:
`agentworkforce deploy personas/chief-khaliq/persona.json --mode cloud`.
Do not run the live command until the branch, bundle provenance, and integration
selection have independent approval.
