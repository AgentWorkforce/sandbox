# @agent-relay/sandbox

Provider-agnostic sandbox runtimes and orchestration for agent workloads.

Agents that write code need somewhere to run it. This package provides a single
runtime port that several sandbox providers implement, plus the orchestration
layer that drives a sandbox through a workload: launch it, put files into it,
run commands, stream results back, and tear it down.

The point of the port is that the orchestration layer holds no provider
knowledge. Swapping providers is a change of adapter, not a change of caller.

> **Status: pre-1.0.** The public API may still change before a `1.0.0`
> release.

## Install

```bash
npm install @agent-relay/sandbox
```

Provider SDKs are peer dependencies: install the one you intend to use. A
consumer that only runs local sandboxes does not need a remote provider SDK.
Adapters for providers that publish no JavaScript SDK speak their HTTP API
directly and add no dependency at all; they take an injectable `fetch` instead.

## Design

Two pieces, deliberately kept apart:

- **Runtime adapters** implement a small port — launch, exec, file transfer,
  teardown — against one provider apiece.
- **The orchestrator** drives a workload through whichever runtime it is given.
  It is generic over the provider's handle type and knows nothing about any
  specific provider.

Configuration is injected, never baked in. The package ships no default
templates, endpoints, hostnames, or credentials: anything environment-specific
is a required argument supplied by the caller. This keeps the package usable
outside the environment it was extracted from, and keeps credential handling in
the caller where it belongs.

Each adapter also declares what it genuinely supports rather than what its
method names imply. `resolveSandboxRuntimeCapabilities` reads that declaration,
so a caller learns up front whether a provider can reattach to a sandbox by id,
poll a background command, hand back a still-booting sandbox, or search by
label — instead of discovering the answer from a failure at run time.

### Daytona restart recovery

`DaytonaRuntime.start()` does not trust the provider state transition alone. It
rehydrates the SDK sandbox and runs a bounded `true` readiness probe after `start`,
because Daytona can report `STARTED` while its Toolbox exec daemon remains
unavailable. A healthy restart keeps the same sandbox ID.

When that post-start command fails, the runtime defaults to creating and proving
a replacement before deleting the unusable sandbox. The returned handle is
updated in place and can therefore have a new `id`; callers must persist that
returned ID. The replacement preserves the configured snapshot plus provider
labels, environment, lifecycle, volume, and network settings, but non-volume
filesystem changes in the old sandbox are not copied. Stateful callers that
prefer a hard failure to that trade-off can set `recreateOnFailedStart: false`.

### E2B runtime contract

`E2BSandboxRuntime` implements both the outer orchestration port and the live
`WorkflowRuntime` surface: metadata/state lookup, reattachment, synchronous and
durable asynchronous execution, upload/download, home-directory resolution,
pause/resume, and owned-resource teardown. It deliberately does not expose a
detached-launch method because E2B's public create call waits for a running
sandbox. Its live capability descriptor likewise reports PTY and streaming logs
as unsupported because this adapter exposes neither behavior, even though the
provider SDK has lower-level APIs for them.

The adapter applies an explicit sandbox lifetime on create, reconnect, and
synchronous use; `sandboxLifetimeMs` defaults to the configured asynchronous
run budget.

Synchronous runs always carry an explicit command lifetime cap, because E2B —
alone among the providers here — applies a 60-second default when the field is
omitted, while the orchestrator omits `timeoutMs` on most execs. A run without a
caller timeout therefore uses `syncRunBudgetMs`, which defaults to the
configured `runBudgetMs` (30 minutes unless set). An explicit caller timeout
always wins, and is the only thing that extends the sandbox past
`sandboxLifetimeMs`; the implicit budget never does.

Asynchronous session IDs are immutable idempotency keys. A retry
reconciles the durable admission record with E2B's process list and will not
erase the session directory or submit another copy. Status is pending only
while the matching provider process is present. If that process disappears
without publishing its exit sidecar, status becomes terminal with
`E2B_ASYNC_PROCESS_LOST_EXIT_CODE` (`255`).

## Development

```bash
npm ci
npm run build      # tsc → dist/
npm run typecheck
npm test           # node:test
```

Requires Node.js 20 or newer.

## Releasing

Publishing is manual-dispatch only, via the `Publish` workflow, and defaults to
a dry run. Nothing publishes automatically on push or merge.

Authentication is npm OIDC trusted publishing — there is no publish token to
store. A real publish requires the repository owner to register this repository
and workflow as a trusted publisher for the package on npmjs.org; releases carry
[provenance](https://docs.npmjs.com/generating-provenance-statements) attesting
the commit and workflow they were built from.

## License

Apache-2.0. See [LICENSE](./LICENSE).
