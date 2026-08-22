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
| Tarball SHA-1 | `c6499f7dfd87702832d1def619036d8569390f4b` — **verified** against the registry's `dist.shasum` |
| Registry signature | **verified** (`npm audit signatures`) |
| SLSA provenance attestation | **none published** for this version |
| `gitHead` (packument) | `79b729fb75abdde51d1130d3a7347416a5da75b6` — **recorded but NOT verifiable**, see below |
| Docs | <https://modal.com/docs/sdk/js/latest/Sandbox> |

The API surface mirrored in `src/modal/internal/sdk.ts` was read from that
release's shipped `index.d.ts`, not from documentation prose.

**A provenance caveat worth carrying to other adapters.** The packument's
`gitHead` does *not* resolve to a public commit: an authenticated lookup of
`79b729fb…` returns "No commit found" in **both** `modal-labs/libmodal` (where
the JS SDK's source lives) and `modal-labs/modal-client` (which is what the
packument's `repository` field actually points at — itself a mismatch, since
that repo is the Python client). Modal also publishes **no SLSA attestation**
for this version, so there is no signed build-provenance path to fall back on
either.

So `gitHead` is recorded here for completeness and is explicitly **not** relied
on. What this adapter's provenance actually rests on is the pair that *were*
verified: the tarball hash matching the registry's `dist.shasum`, and the
registry signature. A `gitHead` that cannot be resolved is a string, not
evidence, and should not be quoted as one.

### The provenance ladder

Generalised from this package and cross-checked against the Vercel adapter,
whose npm publish pipeline produces a different — and luckier — shape. No single
mechanism is available everywhere, so provenance is established by descending
until something verifies, and by recording which rung actually held:

| Rung | Mechanism | Availability |
|---|---|---|
| 1 | SLSA / npm provenance attestation | **Not universal.** Absent for `modal@0.9.0`. Across our two dependency trees it covered 67/235 and 69/241 packages — under a third. |
| 2 | Registry signature (`npm audit signatures`) | Broad. Verified for all 235 packages in this tree. |
| 3 | Tarball hash vs the packument's `dist.shasum` | Always available; requires downloading the tarball. |
| 4 | `gitHead` | **Resolve before quoting.** One `gh api repos/<owner>/<repo>/commits/<sha>` settles it. |

Two failure modes this package hit that the ladder is shaped around:

- **A present-but-unresolvable `gitHead` is worse than a missing one**, because
  it reads as provenance in a table and is not.
- **The `repository` field cannot be trusted to name the repo the package is
  built from.** Modal's points at `modal-labs/modal-client` — the *Python*
  client — while the JS SDK lives in `modal-labs/libmodal`. Checking the SHA
  against both is what surfaced it.

Rung 1 is the strongest when present, and is exactly the rung that was
unavailable here — which is why the pattern is a ladder rather than a
technique.

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

Modal also imposes a **hard 24-hour ceiling** on that lifetime, and
`MODAL_MAX_LIFETIME_MS` rejects anything above it at construction. Past 24 hours
the provider offers no continuous-run option at all — its own guidance is to take
a filesystem snapshot and restore it into a *new* sandbox. A genuinely persistent
sandbox is therefore not something Modal can be configured into; it is something
a caller must rebuild daily, losing anything not captured in the snapshot.

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

**The server-side filter is re-checked in process.** Every sandbox a listing
returns has its tags verified against what was asked for, controlled by
`verifyTagsClientSide` (default `true`). Ownership here rests entirely on
Modal's tag filter, and that filter has not been proven live — `warmLease` is
still `false`. A filter that is silently ignored, partially applied, or changed
in a future release would hand back a foreign sandbox **as a warm lease**, which
is strictly worse than returning no lease: the caller would exec into another
tenant's container. Unlike providers that return tags inline with the listing,
Modal exposes `getTags()` as a separate call, so this costs one extra round trip
per candidate; verification is skipped when there is nothing to check, and a
caller who has measured the filter can opt out.

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

### Structured modes

The booleans above cannot say *why* a capability is absent, and for this adapter
that gap was being papered over by hand — `MODAL_STRUCTURALLY_FALSE` exists
precisely because `lifecycle: false` and `neverIdle: false` are settled facts
while every other `false` is a pending observation. `modalCapabilityModes`
states that distinction in the type system instead, via the
`declaredCapabilityModes` port field.

| Mode | Value | Reason |
|---|---|---|
| `outputStreams` | `buffered` | Modal's `exec()` really does return separate live `ReadableStream`s, and `runScript` hands back separated `stdout`/`stderr`. But both streaming members of the union mean *streamed live*, and the adapter drains both pipes with `readText()` before returning. Separated after the fact is still buffered. |
| `filesystem` | `ephemeral` | `terminate()` is the only lifecycle transition and it is terminal; there is no stop/start pair for state to survive across, so `persistent` cannot apply. |
| `lifetime` | `deadline` | Every Modal Sandbox carries a maximum lifetime the provider enforces — 5 minutes by default, `MODAL_MAX_LIFETIME_MS` (24h) at the ceiling. This is `MODAL_STRUCTURALLY_FALSE.neverIdle` stated in the type: per the union's own note, a provider that always terminates at a deadline cannot offer a never-idle tier. |
| `interactive` | `not-exposed` | Modal supports `pty: true`. This package's port declares no PTY operation, so it is unreachable *here*. |
| `snapshots` | `not-exposed` | Modal has real `snapshotFilesystem()`/`snapshotDirectory()`. This package's port declares no snapshot operation. |

The `not-exposed` cells are the ones to be careful with. They are facts about
*this package's port*, not pending observations about Modal, so
`isPendingEvidence()` returns `false` for them and a live canary proving Modal
has PTY must **not** promote either. They move only if someone adds an operation
to the port. Note also what is absent from the table: `warmLease` stays a
pending `false` boolean. Modes describe a capability's shape, not its
verification state, and are not a route around the house rule.

`reconcileModalCapabilities` runs at construction time and throws
`ModalCapabilityMismatchError` if a declaration and the implementation disagree —
for example a declared `lifecycle: true` with no `start`/`stop`, a no-op
lifecycle method, or a partial async-exec trio. It guards the modes on the same
terms: a `never-idle` lifetime, a live-streaming `outputStreams`, a `persistent`
filesystem, or a positive `interactive`/`snapshots` claim each fail the build.
The point is to fail on a developer's machine rather than in production.

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

## Live evidence: not yet collected

**Provider credentials pending Khaliq provisioning, 2026-08-21.** Modal is not
yet present in 1Password — a read-only scan found zero Modal items across the
account — so no live run has occurred and **no capability cell may be read as
claimed**.

Every cell in `modalObservedCapabilities` is `false`, including
`cleanupVerified`. Promotion requires a dated live-canary note in this section
quoting a measured result; nothing is promoted on the strength of an SDK
signature.

| Cell | Status | Promotable by a live run? |
|---|---|---|
| `cleanupVerified` | `false` | Yes |
| `warmLease` | `false` | Yes — the top promotion target |
| `reattach` | `false` | Yes |
| `snapshotCapture` | `false` | Yes |
| `lifetimeOverride` | `false` | Yes |
| `concurrencyCeiling` | `false` | Yes |
| `lifecycle` | `false` | **No — structurally impossible.** Modal has no stop/start. |
| `neverIdle` | `false` | **No — structurally impossible.** Every Modal Sandbox carries a termination deadline: 5 minutes by default, 24 hours at most. |

The two structural cells are also listed in `MODAL_STRUCTURALLY_FALSE`, so a
future canary cannot mistake them for pending observations and "promote" them.

Still UNKNOWN until a live run happens: cold-create p50/p95, readiness and
first-exec latency, concurrency ceiling, cleanup verification, delivered-vs-
requested shape, and whether the 2 vCPU / 4 GiB reference shape is grantable on
the account's plan.

Modal authenticates with a **token pair** (`MODAL_TOKEN_ID`,
`MODAL_TOKEN_SECRET`), not a single bearer key, and the adapter never reads
either from ambient process state.

### The benchmark harness is ready and waits on credentials only

`src/modal/bench.ts` implements the run; `src/modal/live.bench.test.ts` is the
gated entry point. It fires as soon as the token pair exists:

```bash
MODAL_LIVE_BENCH=1 MODAL_BENCH_APP=<app> MODAL_BENCH_IMAGE=python:3.13 \
MODAL_ENVIRONMENT=<non-main-env> \
  op run --env-file=<(printf '%s\n%s\n' \
     'MODAL_TOKEN_ID=op://AI Agents/Modal/MODAL_TOKEN_ID' \
     'MODAL_TOKEN_SECRET=op://AI Agents/Modal/MODAL_TOKEN_SECRET') -- \
  node --test --import tsx src/modal/live.bench.test.ts
```

It creates billable resources, so it is guarded on three independent axes, each
sufficient alone:

- **Ledger before use.** Intent is recorded *before* the create call is issued,
  so a create that times out or dies mid-flight still leaves a record. Logging
  only successful creates would lose precisely the sandboxes most likely to
  leak.
- **Bounded cost.** A projection at Modal's published sandbox rate is charged
  against a hard cap before each create, and the run aborts rather than exceed
  it. The projection uses the sandbox's *full configured lifetime*, not its
  expected duration, because a leaked sandbox bills for all of it.
- **Verified cleanup.** Teardown runs in a `finally` — including when the budget
  guard aborts the run — and every id is re-checked against the provider
  afterwards. A survivor raises `ModalLeakedSandboxError` rather than being
  assumed gone. Where a runtime cannot re-resolve by id, the entry stays
  `destroyed` rather than being upgraded to `verified-gone`.

All three guards are unit-tested against a fake runtime in
`src/modal/bench.test.ts`, so they are proven before they are trusted with a
real account.
