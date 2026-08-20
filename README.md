# @agent-relay/sandbox

Provider-agnostic sandbox runtimes and orchestration for agent workloads.

Agents that write code need somewhere to run it. This package provides a single
runtime port that several sandbox providers implement, plus the orchestration
layer that drives a sandbox through a workload: launch it, put files into it,
run commands, stream results back, and tear it down.

The point of the port is that the orchestration layer holds no provider
knowledge. Swapping providers is a change of adapter, not a change of caller.

> **Status: pre-release scaffold.** This repository currently contains the
> package skeleton — build, typecheck, test, and release wiring. The runtime
> adapters and orchestrator land in subsequent changes, and the public API is
> not stable until a `1.0.0` release.

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
| `snapshots` | `true` | `false` | A snapshot source is a host-local artifact — the SDK resolves it under `~/.microsandbox/snapshots/` and indexes it in a local DB cache — so a cloud create cannot reach one. Configuring `snapshot` with a cloud backend is refused in the constructor, before any SDK call. |
| `isolation` | `'strong'` | `'unknown'` | Locally the SDK boots a microVM with its own guest kernel on a virtualization-capable host, which this package can stand behind. The cloud backend's isolation is vendor-documented but not observable from here, and this adapter measures nothing about it. |

`'unknown'` is not a synonym for weak. It means this package has not established
the guarantee, so a caller that requires one must decide for itself rather than
read an unverified `'strong'`.

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
