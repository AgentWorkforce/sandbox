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
unavailable. A healthy restart keeps the same sandbox ID. A failure during that
rehydration itself (auth, rate limit, or network) is not proof the exec daemon
is dead, so it is propagated as-is and never triggers a replacement.

When the post-start readiness probe fails, the runtime defaults to creating and proving
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

### Daytona wire-supplement

Daytona's Sandbox wire response carries two fields — `sandboxClass` (the
sandbox's class/tier) and `warmPoolId` (set while a sandbox is an unclaimed
warm-pool member) — that exist on the low-level `@daytona/api-client` DTOs but
that the vendored `@daytonaio/sdk`'s `Sandbox` class does not copy onto
itself. `DaytonaRuntime.getWireSupplement(handle)` fetches both directly via
the SDK's low-level `sandboxApi`, the same reach pattern `runtime.ts` already
uses for detached create.

This is a narrow, deliberately temporary gap, not a fork of the SDK: the
other fields once suspected missing (`autoDestroyAt`, `autoPauseInterval`,
`spot`) already ship on the public `Sandbox` class as of `@daytonaio/sdk`
0.200.0–0.205.0 — a dependency bump alone covers those. Tracked upstream at
[daytona/clients#207](https://github.com/daytona/clients/issues/207)
(precedent: [#192](https://github.com/daytona/clients/pull/192), which added
`spot` the same way). Retire `src/daytona/wire-supplement.ts` once
`processSandboxDto()` copies `sandboxClass`/`warmPoolId` and a subsequent SDK
bump picks that up — `runtime.test.ts`'s `DaytonaRuntime smoke` suite has a
load-bearing regression test that fails once that happens.

### Modal runtime contract

`ModalRuntime` takes an explicit Modal **token pair** (`tokenId` and
`tokenSecret` — Modal does not use a single bearer key), an App name, an image
tag, a home directory, and an ownership-name prefix. It never reads ambient
credentials or a local Modal profile.

A Modal Sandbox is a child of an App, built from an Image, and it has a
**maximum lifetime after which the provider terminates it** — the SDK's own
default is five minutes. `maxLifetimeMs` is therefore required configuration and
is always sent explicitly. `createTimeoutSeconds` on `launch` is a deadline on
the create call and is deliberately not forwarded to that lifetime.

Modal exposes no stop/start for a Sandbox; `terminate` is the only lifecycle
transition and it is terminal. `start` and `stop` are absent rather than
no-ops, and `lifecycle` is declared false permanently. Async exec is likewise
not implemented: Modal cannot re-resolve a running exec by id, so the
`startScript`/`getScriptStatus`/`getScriptLogs` trio is omitted entirely instead
of being half-supported.

Ownership rides on Modal's native server-side tags rather than on a naming
convention. Every sandbox carries an ownership tag, every lookup filters on it
server-side, and reattachment and deletion both re-check it. Warm leasing is
implemented against that real tag filter but remains undeclared until a live
probe confirms it. Snapshots, volumes, PTY, and tunnels exist in the provider
and are documented, but are not advertised because this package's port exposes
no operation for them.

That last distinction is now stated structurally rather than in prose. The
adapter declares `declaredCapabilityModes`, so PTY and snapshots resolve to
`"not-exposed"` — a fact about this package's port, which `isPendingEvidence()`
reports as unmovable — rather than to a bare `false` a later canary might read
as merely unverified. `lifetime` resolves to `"deadline"`, which is the
structural reason a Modal sandbox can never be never-idle. Output is
`"buffered"`: Modal streams, the adapter drains. Warm leasing deliberately gets
no mode, because modes describe a capability's shape and not its verification
state.

The official SDK is isolated under `src/modal/internal/`, and because that SDK
speaks gRPC rather than HTTP there is no injectable transport seam; the boundary
is a structural mirror that is checked at build time instead. All create,
lookup, exec, upload, and deletion operations have explicit deadlines. See
[the Modal adapter notes](./docs/modal.md) for dependency provenance, provider
constraints, cost model, and capability evidence.

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
