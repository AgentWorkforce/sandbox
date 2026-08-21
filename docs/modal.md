# Modal adapter

## Dependency provenance

Validated against the official JavaScript/TypeScript SDK:

```bash
npm install modal@0.9.0
```

| Field | Value |
|---|---|
| Package | `modal` (modal-labs/libmodal) |
| Version | `0.9.0`, published 2026-07-09 |
| License | Apache-2.0 |
| Integrity | `sha512-kCXcdJkhbJorf/q/6T9Wdlg6in9JmRnCNQnV6rVBMyeqNV/iXI6BYk4IzY4cvZ6dbauNeDMjk/Q08cbxvoIaXg==` |
| `gitHead` | `79b729fb75abdde51d1130d3a7347416a5da75b6` |
| Docs | <https://modal.com/docs/sdk/js/latest/Sandbox> |

The tarball's SHA-1 was verified against the registry's `dist.shasum`
(`c6499f7dfd87702832d1def619036d8569390f4b`) and the API surface mirrored in
`src/modal/internal/sdk.ts` was read from that release's shipped `index.d.ts`,
not from documentation prose.

The peer range is pinned narrowly (`>=0.9.0 <0.10.0`) because the SDK is a `0.x`
beta whose own README states that breaking changes ship in `0.X.0` releases.

### Why there is no `fetch` seam

Unlike the Agent37 client, this adapter cannot take an injectable transport.
The Modal SDK speaks **gRPC** (`nice-grpc`, `protobufjs`, `cbor-x`), so there is
no HTTP layer to intercept. Isolation is achieved structurally instead: every
vendor type the adapter touches is mirrored as an interface in
`src/modal/internal/sdk.ts`, and `runtime.ts` depends only on those mirrors.

That mirror is enforced, not merely documented. `createOfficialModalClient`
assigns the real `ModalClient` **through** `ModalClientLike` rather than using an
`as unknown as` cast, so if Modal changes a signature the build fails here
instead of failing at runtime against a live sandbox.

## How Modal's model differs from this package's port

A Modal Sandbox is not a peer of an E2B or Daytona sandbox, and the differences
are load-bearing.

**Sandboxes are children of an App, built from an Image.**
`sandboxes.create(app, image, params)` requires both. `appName` and `imageTag`
are therefore required configuration; the adapter resolves one App and one Image
per runtime and reuses them. `createAppIfMissing` defaults to `false`, because
creating provider-side objects as a side effect of a lookup should be opted into.

**Sandboxes have a maximum lifetime, and the SDK default is five minutes.**
Modal terminates the sandbox once it elapses, running work included. Every other
provider this package adapts treats a sandbox as living until told otherwise, so
`maxLifetimeMs` is **required** configuration and is always sent explicitly.
Silently inheriting a five-minute cap is the single largest footgun in this
provider.

`createTimeoutSeconds` on `launch` is a **client-side deadline on the create
call** and is deliberately *not* forwarded to Modal's `timeoutMs`. Conflating
them would give a caller who asked to wait 30 s for provisioning a sandbox that
self-destructs 30 s later.

**Sandboxes cannot be stopped and restarted.** `terminate()` is the only
lifecycle transition and it is terminal — no suspend, resume, or wake exists.
`start` and `stop` are absent from `ModalRuntime` rather than present as no-ops,
and `lifecycle: false` is declared so the capability resolver, which cannot see
an absent method, agrees. This is structural and will not be promoted by a live
run.

**Modal reports no sandbox state enum.** The SDK's `Sandbox` object exposes only
`poll()`, which returns `null` while running and an exit code once finished. So
`findAllByLabels` leaves `state` undefined unless the caller actually filters on
it, in which case each candidate costs one extra round trip. Reporting a guessed
state for free would be worse than reporting none.

**V1 `create` is pinned on purpose.** Modal also offers `experimentalCreate`
(the V2 backend). V2 sandboxes **do not support tags** and **are not returned by
`sandboxes.list()`**, which would silently destroy both the ownership model and
the cleanup story below. Do not "upgrade" that call.

## Ownership and collision safety

Modal has native, server-side tags: `create({ tags })`, `setTags`/`getTags`, and
`list({ tags })` which returns only sandboxes carrying *all* the requested tags.
This is a real label primitive, and ownership is built directly on it rather
than on a naming convention.

- Every sandbox is created carrying `{ [ownerTagKey]: namePrefix }`
  (`agentRelayOwner` by default).
- Every lookup merges that tag into the server-side filter, so a foreign sandbox
  is never fetched, let alone returned. `owned: false` is an explicit escape
  hatch for cross-lane audits.
- A caller label that would overwrite the ownership tag raises
  `ModalTagCollisionError` instead of being silently merged. Either resolution
  is a bug: ours would make a foreign sandbox look owned, theirs would make ours
  invisible to cleanup.
- `getById` re-checks ownership and reports a foreign sandbox as `null` — "not
  one of mine" and "not there" are the same answer to that question.
- `destroy` re-checks ownership *before* terminating and raises
  `ModalForeignSandboxError` on a mismatch. That costs one extra round trip on
  an irreversible operation, which is the correct trade.

Sandbox names are additionally prefixed (`<namePrefix>-<name|uuid>`), because
Modal requires a sandbox name to be unique within an App.

## Capabilities

House rule: a behavioral claim stays `false` until a live probe establishes it.
"The SDK has a method for it" is not evidence.

| Capability | Value | Reason |
|---|---|---|
| `asyncExec` | `false` | `exec()` returns a live `ContainerProcess`, but nothing public re-resolves one from an id — the `execId` reattach path is `@ignore` and unexported. Implementing `startScript` without a real `getScriptStatus` would let a caller submit a command it could never poll or reap, which is exactly what the port's all-or-nothing rule prevents. The trio is omitted. |
| `reattach` | `true` | `sandboxes.fromId(id)` is real. |
| `detachedLaunch` | `false` | `create()` cannot be split into submit + resume; no mid-boot handback exists. |
| `warmLease` | `false` (pending) | Backed by a genuine server-side tag filter, unlike providers that degrade to `[]`. Declared `false` only until a live canary proves a tagged sandbox is actually returned by a tag-filtered list. `false` fails safe: the orchestrator declines to rely on warm leases rather than leaking them. |
| `lifecycle` | `false` (permanent) | No stop/start exists. |
| `pty` | `false` | Modal supports PTY on both `create` and `exec`, but this package's port exposes no PTY operation. |
| `snapshots` | `false` | Modal exposes real snapshots — see below — but this package's port exposes no snapshot operation. Capability means *reachable through this port*. |
| `streamingLogs` | `false` | `exec()` returns live `ReadableStream`s, so Modal genuinely streams; the port's `RunScriptResult` is buffered, so the adapter drains them. |

`reconcileModalCapabilities` runs at construction time and throws
`ModalCapabilityMismatchError` if a declaration and the implementation disagree —
for example a declared `lifecycle: true` with no `start`/`stop`, a no-op
lifecycle method, or a partial async-exec trio. The point is to fail on a
developer's machine rather than in production.

## Provider features characterized but not adopted

These are documented so the surface is not lost, and deliberately not wired into
the port.

**Snapshots.** `snapshotFilesystem()` and `snapshotDirectory(path)` both return
an `Image` reusable as a create source. Default retention is 30 days as a hard
cutoff from creation — usage does not extend it — and `ttlMs: null` retains
indefinitely.

**Volumes.** Modal's shared-filesystem primitive mounts via
`volumes?: Record<string, Volume>` with `reloadVolumes()` to refresh a running
sandbox. This is **reported, not adopted**: it is Modal's own primitive and is
not to be conflated with Relayfile.

**Networking.** `blockNetwork`, `outboundCidrAllowlist`,
`outboundDomainAllowlist`, `inboundCidrAllowlist`, and `updateNetworkPolicy` on
a running sandbox. The adapter surfaces `blockNetwork` and region pinning, and
rejects the combination — a network-blocked sandbox has no reachability for
region placement to affect.

**Tunnels, sidecars, readiness probes, OIDC identity tokens, custom domains.**
Present in the SDK, outside this port.

## Cost model

Modal bills per second, and publishes **two different rate cards**. Sandboxes
are billed at roughly **3× the Function rate**:

| Resource | Functions | Sandboxes | Ratio |
|---|---:|---:|---:|
| CPU per core per second | $0.0000131 | $0.00003942 | 3.01× |
| Memory per GiB per second | $0.00000222 | $0.00000667 | 3.00× |

Storage (Volumes) is $0.09/GiB/month with 1 TiB/month included. One physical
core counts as two vCPU, and the floor is 0.125 cores per container.

At a 2 vCPU / 4 GiB reference shape (`cpu: 1`, `memoryMiB: 4096`) that is
**$0.23796 per running hour**. Because there is no stop/start, a
sleep-when-idle duty cycle is not merely expensive on Modal — it does not
exist. The only idle strategy is terminate and recreate, which loses all state
unless a filesystem snapshot is paid for and re-created from.

Rates read from <https://modal.com/pricing> on 2026-08-21. Provider pricing is
time-unstable; re-verify before relying on these figures.

## Deadlines

Every operation takes an explicit, absolute client-side budget —
`createTimeoutMs`, `lookupTimeoutMs`, `execTimeoutMs`, `destroyTimeoutMs`,
`uploadTimeoutMs` — shared across all round trips the operation makes rather
than reset per call, and surfaced as `ModalDeadlineExceededError`. `runScript`
additionally hands the same budget to Modal so a runaway command is killed by
the provider even if this client goes away.

Racing a promise does not cancel the work behind it; the SDK's own `timeoutMs`
bounds the wire, and these deadlines bound the caller's wait.

## Cleanup

`destroy` prefers Modal's own verified-terminated signal: `terminate({ wait:
true })` resolves with an exit code only once the sandbox has actually finished.
If the provider resolves without one, the adapter polls `poll()` until the
sandbox reports finished. `cleanupVerified` never rests on a request merely
having been accepted.

`ModalRuntime` also exposes `close()`, which releases the SDK's gRPC channel.
It is not part of `SandboxRuntime`, but a short-lived Node process that never
calls it will not exit.

## Evidence status

No capability in `modalObservedCapabilities` has been promoted. The adapter and
its 59 mocked contract tests are complete, but no live run has occurred —
credentials were still outstanding at the time of writing. Modal authenticates
with a **token pair** (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`), not a single
bearer key, and the adapter never reads them from ambient process state.
