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

Requires Node.js 20 or newer.

## Releasing

Publishing is manual-dispatch only, via the `Publish` workflow. It defaults to a
dry run and requires an `NPM_TOKEN` secret configured by the repository owner
before a real publish will run. Nothing publishes automatically on push or
merge.

## License

Apache-2.0. See [LICENSE](./LICENSE).
