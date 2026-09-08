# Hosted Sandbox (Private Preview)

`@agent-relay/sandbox/hosted` is a small HTTP create/run/destroy facade for a
deployment that exposes the companion AgentWorkforce cloud endpoints. It is a
private preview and is not deployed or available for live production use yet.
The SDK does not perform provider setup, collect approvals, discover ambient
configuration, or expose provider credentials.

```ts
import { withHostedSandbox } from "@agent-relay/sandbox/hosted";

const result = await withHostedSandbox({
  baseUrl: "https://agentrelay.com/cloud",
  token: process.env.AGENTWORKFORCE_TOKEN!,
  workspaceId: "00000000-0000-4000-8000-000000000000",
  providerId: "e2b",
}, (sandbox) => sandbox.run("echo hello"));
```

The token is an AgentWorkforce user CLI token, not a provider key. All options
are explicit; there is no environment-variable discovery. `createHostedSandbox`
is available when callers need separate `run` and `destroy` control. Cleanup is
retryable after a failed request, while commands remain disabled after the
first destroy attempt. A workload failure and cleanup failure are returned as
an `AggregateError`.

`appKey` and `environment` use lowercase dashboard identifiers: they must start
with `a-z`, then contain only lowercase letters, digits, `.`, `_`, `:`, or `-`.
Their byte limits are 128 and 64 respectively.

Command limits are byte limits: commands are at most 64 KiB, absolute `cwd` is
at most 1024 bytes, and each environment value is at most 8 KiB. The default
transport deadline allows 60 seconds for create/destroy and gives a run's
provider timeout an additional five seconds to return its result. An explicit
`requestTimeoutMs` bounds every operation, including the response body read.
Run results may include `truncated: true` when the backend clipped captured
output.

The deployment must provide `POST /api/v1/workspaces/{workspaceId}/sandbox-sessions`,
`POST /api/v1/workspaces/{workspaceId}/sandbox-sessions/{id}/run`, and
`DELETE /api/v1/workspaces/{workspaceId}/sandbox-sessions/{id}`. The SDK never
calls a setup endpoint. If setup is unavailable, `HostedSandboxError.setupUrl`
points to the dashboard integration scope without including a token, session,
or provider-native identifier.

Existing provider-key quickstarts remain supported. For a directly configured
provider runtime, see the [provider quickstart](../README.md#run-your-first-workload)
and [setup contract](setup.md).
