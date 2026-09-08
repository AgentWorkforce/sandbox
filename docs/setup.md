# Provider setup and the software-factory path

The execution entry point is `@agent-relay/sandbox/core`: `withSandbox` gives a
small workload a create/run/cleanup scope, while `createSandbox` gives a caller
an explicit session. Use a configured provider adapter with either. Provider
keys remain a supported standalone path.

The account-setup entry point is `@agent-relay/sandbox/setup`. It is a public,
provider-neutral backend contract. It includes no account-provider client,
hosted endpoint, login flow, credential store or billing implementation.

## Hosted setup composition

A hosted "Connect with AgentWorkforce" flow should authenticate the user, bind
their tenant/environment on the server, collect any required approvals, and
show progress until the provider account is ready. The authenticated backend
owns those operations. Neither a browser nor a coding agent receives a raw
account-provisioning client or a credential binding through this interface.

```ts
import {
  createProviderSetup,
  type ProviderSetupBackend,
} from "@agent-relay/sandbox/setup";

// Created by trusted server code for one authenticated tenant/environment.
// Implement with your account service and durable readiness store.
declare const tenantBackend: ProviderSetupBackend;
const setup = createProviderSetup(tenantBackend);

// Call from the trusted prewarm job after authenticating the setup intent.
// Reuse this key for retries of the same intent; the backend must enforce it.
const progress = await setup.prewarm("e2b", { idempotencyKey: "onboarding-123" });

// On a later status request/job: read only, never starts account setup.
const current = await setup.status("e2b");
```

The normalized result is one of:

| Status | Consumer behavior |
| --- | --- |
| `ready` | A usable credential binding exists in the scoped backend. Acquisition may proceed, subject to capacity and other constraints. |
| `warming`, `retryAfterMs` | Schedule a later status read. Delay is an integer from 1 to 60,000 ms. |
| `approval-required` | Return control to the authenticated onboarding UI; workload acquisition must not wait on or manufacture approval. |
| `unavailable` | Keep acquisition disabled and offer the application's supported setup alternatives. |

Responses accept only these fields. Account identifiers, keys, vault references
and raw provider errors are not returned. Unexpected shapes and backend failures
raise a sanitized `ProviderSetupError`. The wrapper neither polls nor retries a
setup mutation; durable idempotency, progress storage, backend deadlines and
approval revalidation belong to the backend. A prewarm call is **not** evidence
of approval. Do not implement that check with a client-supplied `approved: true`.

## Connect setup to execution

Once the backend has resolved the chosen account's credentials, it constructs
the runtime privately. The optional readiness gate checks the current binding
before each new acquisition:

```ts
import { withSandbox, type SandboxRuntime } from "@agent-relay/sandbox/core";
import type { ProviderSetup } from "@agent-relay/sandbox/setup";

declare const setup: ProviderSetup;
declare const tenantRuntime: SandboxRuntime;

const output = await withSandbox({
  runtime: tenantRuntime,
  readiness: { providerId: "e2b", port: setup },
}, (sandbox) => sandbox.run("echo ready", { timeoutMs: 10_000 }));
```

The check is strict: only boolean `true` permits allocation. A false, malformed
or failed readiness read stops before launch. Withdrawing readiness does not
block destruction of an existing session. The gate does not create accounts,
renew credentials, authorize the user, or measure provider capacity. Existing
runtime lookup and cleanup still require correctly scoped backend credentials.

`ProviderSetup` is structurally compatible with sandbox-router's boolean
provisioning port: supply `provisioning: setup` to a router version exposing that
option. The setup module has no dependency on sandbox-router. Routing can remain
above the provider adapters without introducing a package dependency cycle.

## Product boundary

| Entry point | What the user gets | What they operate |
| --- | --- | --- |
| Sandbox SDK with a provider key | One working sandbox and portable runtime operations | Their workload, account configuration and resource recovery |
| Software Garden | Issue-to-PR orchestration, coding/review agents and a merge gate | Their Garden deployment and configured integrations |
| Hosted AgentWorkforce integration | A place to connect accounts and delegate factory operation | The repositories, policies and approvals they choose |

The SDK should succeed at the first task. The next step is visible when a user
needs factory orchestration or managed operations, not imposed by an SDK failure.
Link to [Software Garden](https://github.com/AgentWorkforce/software-garden) at
that point. A hosted integration should expose "Connect" only with an operating
backend, or clearly identify it as unavailable while retaining provider keys as
an alternative. This change supplies the SDK contract; it does not implement or
certify a live hosted account-onboarding flow.
