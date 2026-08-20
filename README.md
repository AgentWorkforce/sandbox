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

### Provider constraints

Each adapter inherits its provider SDK's requirements, and they are not all the
same as this package's:

| Adapter | Peer dependency | Requirements beyond this package's |
| --- | --- | --- |
| `DaytonaRuntime` | `@daytonaio/sdk` | — |
| `E2BSandboxRuntime` | `e2b` | — |
| `MicrosandboxRuntime` | `microsandbox` | **Node.js 22+**, a platform-specific native addon (macOS arm64, Linux x64/arm64, Windows x64/arm64), and — for its `local` backend — hardware virtualization: KVM on Linux, Apple Silicon on macOS, or WHP on Windows 10+ |
| `LocalSandboxRuntime` | — | A reachable local sandbox service |

The package itself keeps a Node 20 floor, because a consumer that never touches
the microsandbox adapter never loads that SDK: it is imported lazily, at first
use, and a load failure is reported with the constraint that most often
explains it.

### Microsandbox capabilities are backend-sensitive

`MicrosandboxRuntime.capabilities` is derived from the backend the instance is
bound to, not reported as a single process-wide constant:

| Capability | `local` | `cloud` | Why |
| --- | --- | --- | --- |
| `snapshots` | `true` | `false` | A snapshot is a host-local artifact: the installed SDK's typings describe `Snapshot` as an artifact on disk and resolve one under `~/.microsandbox/snapshots/<name>/`. This adapter consumes such an artifact from the calling host and never transfers it, so a create issued against a remote backend has nothing to resolve. Configuring `snapshot` with a cloud backend is refused in the constructor, before any SDK call. |
| `isolation` | `'strong'` | `'unknown'` | Locally the SDK boots a microVM with its own guest kernel on a virtualization-capable host, and the installed package states that requirement itself, so `'strong'` rests on something checkable here. This adapter observes and measures nothing about the cloud backend's isolation. |

Both values describe what this package has **established**, not what any
provider documents. `'unknown'` is not a synonym for weak and is not a claim
that the guarantee is missing — it means this package has not established one,
so a caller that requires a specific guarantee must decide for itself rather
than read an unverified `'strong'`.

Cloud region placement and resource enforcement are likewise not represented as
measured facts. Custom or published **ports are not supported**: the SDK builder
exposes `port()`/`portBind()`, but the ports this package targets have no
public-port surface, so the adapter never calls them and never implies a
reachable port.

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

Requires Node.js 20 or newer. The microsandbox adapter's own tests need Node 22+
to load the real SDK; without it, its SDK-contract checks skip rather than fail.

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
