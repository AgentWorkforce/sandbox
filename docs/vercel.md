# Vercel Sandbox adapter

Evidence discipline used throughout this document:

- **OBSERVED** — measured by this repository against the live API, with the run
  that produced it named.
- **DOCUMENTED** — stated by the provider's own docs or SDK types.
- **INFERRED** — reasoned from the two above. Never treated as measurement.

## Configuration and ownership

Install the exact peer this adapter was validated against:

```bash
npm install @vercel/sandbox@3.0.1
```

`VercelSandboxRuntime` takes explicit `token`, `teamId`, `projectId`,
`namePrefix`, and `defaultHomeDir`. It never reads `VERCEL_TOKEN`,
`VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, or `VERCEL_OIDC_TOKEN` from ambient
process state, and it passes credentials explicitly on every SDK call so the
vendor's own fallback chain — environment, then an on-disk OAuth token — can
never silently supply an operator's identity.

Unlike a single-key provider, Vercel Sandbox cannot be addressed by a token
alone: every request is scoped to a team and a project (DOCUMENTED, SDK
`Credentials`). All three fields are required.

### Identity is the name

A Vercel sandbox is addressed by its **name**, unique within a project, not by
an opaque server id (DOCUMENTED: `Sandbox.get({ name })`). `RuntimeHandle.id`
therefore carries the sandbox name. That makes the configured `namePrefix` a
real ownership boundary rather than a labelling convention: `stop`, `start`, and
`destroy` throw `VercelForeignSandboxError` for any name outside the prefix,
even when the handle was attached with `owned: true`.

Generated names are `<prefix>-<uuid16>`. A caller-supplied name is slugged to a
lowercase DNS-safe label and salted with an 8-hex digest of the original, so two
different requests that slug to the same string still get distinct sandboxes
instead of colliding onto one. Names are kept inside a conservative 63-character
bound; the provider's exact limit is not in the SDK types, and discovering it as
a create failure is not a design.

### Label lookup

`Sandbox.list` accepts both `namePrefix` and a `tags` map as server-side filters
(DOCUMENTED, `APIClient.listSandboxes`), so `findByLabels`, `findAllByLabels`,
and `countByLabels` are real label searches here rather than the degraded `[]`
the Freestyle adapter is forced into.

Every returned row is nonetheless re-checked against the requested tags in
process. A server filter that were ever ignored would hand the caller someone
else's sandbox as a warm lease, which is strictly worse than no lease at all.
The local check costs nothing and removes that class outright.

`warmLease` still declares **false**. The implementation exists; the evidence
that the server filter actually filters does not yet.

### Reattachment does not resume

`getById` is implemented over `list`, not `Sandbox.get`. `Sandbox.get` resumes
the session as a side effect — it boots a VM and starts billing (DOCUMENTED).
A crash-recovery scan over a hundred handles must not be able to wake every one
of them. `start` is the single place the adapter wants that side effect, and it
is where `Sandbox.get({ resume: true })` is called.

## Exec, files, and deadlines

The port speaks shell scripts; the provider speaks argv. Commands are wrapped as
`sh -c <script>` with `cwd` and `env` handed over through the provider's own
fields, so no caller value is ever spliced into a command string — the quoting
injection class simply does not arise. Environment variable names are still
validated.

Detached commands carry their `timeoutMs` into the sandbox, where the provider
enforces it whether or not anyone awaits the result (DOCUMENTED). A detached run
whose caller died would otherwise burn CPU until the session timeout.

`truncated` is deliberately never set on a result. The provider does not report
an output cap, and `undefined` means "not reported", never "known complete".

Every remote operation has its own explicit deadline — create, lookup, exec,
file, lifecycle, delete — because their honest magnitudes differ by two orders
of magnitude. Above all of them sits `retryDeadlineMs`, an absolute ceiling on a
single logical operation *including the SDK's internal retries*. The vendor SDK
depends on `async-retry`; without a signal that spans the whole call, a request
retried N times outlives the caller's deadline by a multiple of it. The deadline
is carried in an `AsyncLocalStorage` and joined onto every request the SDK
issues inside that operation, so concurrent operations on one runtime cannot
abort each other.

A composite operation shares **one** budget across all of its round trips. This
is the difference between a timeout and a promise: `runScript` runs the command
and then fetches its output, `uploadBundle` creates parent directories, writes,
and verifies, and `start` may look up, settle, resume, and settle again. Giving
each round trip a fresh copy of the timeout would let a caller who asked for 60
seconds wait several minutes, and would make `uploadBundle`'s worst case scale
with the number of directories the bundle happens to span. When a call is cut
short, the error names *which* cap fired — the operation budget or the SDK retry
ceiling — because "did not complete within 60000ms" after 25ms sends a reader
hunting for a slow network instead of at the ceiling they configured.

The vendor boundary is a checked assignment, not a cast. Each SDK result is
assigned through the structural interface in `internal/sdk.ts`, so a vendor
signature change breaks the build in the one file that owns the boundary. An
`as unknown as` would accept the drift silently and surface it later as a
runtime failure against a live sandbox. (Pattern adopted from
`modal-adapter-0821`.)

## Cleanup

Vercel deletion removes the list row rather than flagging it, so absence is the
only available proof. `destroy` submits the delete, then polls a fresh prefix
listing until the name is gone.

One guard matters: a row that reappears under the same name with a *different*
`createdAt` is a different sandbox, not a survivor. Without it, a reused name
reads as our sandbox refusing to die, and a clean teardown reports a leak.

When absence cannot be verified within the deadline, `destroy` throws
`VercelDestroyVerificationError` **and retains the registration**, so cleanup
can be retried. Dropping it would make a leaked sandbox unreachable through this
runtime and therefore invisible to every subsequent audit.

`listOwned` is the audit surface. It hides terminated (`failed`, `aborted`)
sandboxes by default and surfaces them on request, along with the provider's raw
status and its reported `activeCpuMs` / `wallClockMs`.

### Scoped leases

`acquire()` returns an `AsyncDisposable`, so a sandbox can be bound to a lexical
scope and destroyed — with destruction verified — on every exit path including a
thrown error:

```ts
await using lease = await runtime.acquire({ labels: { job: "build" } });
await runtime.exec(lease.handle, "npm test");
```

The shape is borrowed from the SDK's own `await using` support on
`Sandbox.create`. Cleanup you cannot forget is the only kind that survives a
crash path.

## Capability status

| Capability | Declared | Basis |
| --- | --- | --- |
| `asyncExec` | true | Derived from method presence; detached `runCommand` plus `getCommand` re-resolution. |
| `reattach` | true | `getById` over `list`. |
| `detachedLaunch` | false | `Sandbox.create` resolves only once the sandbox is running (DOCUMENTED), so there is no mid-boot handle to hand back. The optional method is omitted rather than faked. |
| `warmLease` | false | Implemented over the `tags` filter; awaiting live proof the filter filters. |
| `lifecycle` | false | `stop()` and the `resume` path are implemented; awaiting a live stop → settled → resume → exec round trip. |
| `pty` | false | `openInteractive()` exists in the SDK but is not reachable through this package's port. |
| `snapshots` | false | `snapshot()` and `fork()` exist in the SDK but are not reachable through this port. |
| `streamingLogs` | false | `Command.logs()` is an async iterator; this adapter buffers and returns a completed result. |
| `neverIdle` | false | **Settled, not merely unproven.** Every Vercel sandbox carries a termination deadline (DOCUMENTED: default 5 minutes, max session 45 minutes on Hobby / 24 hours on Pro). There is no never-idle tier to promote this to. |
| `cleanupVerified` | false | Implemented and unit-tested; promotion gated on the live canary reporting `destroyed === verifiedGone`. |

Capability means *reachable through this package's ports*. The vendor SDK having
a method is not the same as this adapter exposing it, and that gap is where
false capability claims come from.

`reconcileVercelCapabilities` is exported and takes a structural surface rather
than the concrete runtime, so its *failure* paths are unit-tested with
deliberately broken fakes. A reconciliation whose failure path nobody has
exercised is a reconciliation nobody has checked — including the specific check
that will gate the `cleanupVerified` promotion.

Note that an under-claim is deliberately permitted: `start`/`stop` are
implemented while `lifecycle` declares `false`. The orchestrator reads the
declaration, not method presence, so under-claiming is safe — and it is the only
way a capability can wait for live evidence. A rule forbidding it would make the
evidence discipline this package runs on impossible.

A construction-time reconciliation walks all three registries — workflow, outer
declared, observed — and throws `VercelCapabilityMismatchError` if any `true`
claim lacks the implementation behind it. Under-claiming is always allowed; that
is how a capability stays false until live evidence promotes it.

## Provider shape and pricing

DOCUMENTED, from <https://vercel.com/docs/vercel-sandbox/pricing> (page last
updated 2026-08-04), verified 2026-08-21:

| Metric | Pro / Enterprise rate |
| --- | --- |
| Active CPU | $0.128 per vCPU-hour |
| Provisioned Memory | $0.0212 per GB-hour |
| Sandbox Creations | $0.60 per 1M |
| Data Transfer (egress) | $0.15 per GB |
| Snapshot Storage | $0.08 per GB-month |

Shape: 1 vCPU, or an even number between 2 and 32; default 2. Each vCPU includes
2 GB of memory, so memory is not independently configurable. 32 GB ephemeral
NVMe per sandbox. Region `iad1` only. Max 15 open ports.

Plan ceilings: Hobby 4 vCPU / 8 GB / 45-minute sessions / 10 concurrent; Pro
8 vCPU / 16 GB / 24-hour sessions / 10,000 concurrent; Enterprise 32 vCPU /
64 GB.

Allocation is rate-limited dynamically rather than by a fixed cap: Hobby starts
at 20 vCPUs/minute ramping to 40; Pro starts at 150 ramping to 5,000. The rate
decays back to the starting value after 10 idle minutes. A burst-until-429
concurrency probe therefore measures the *current* rate, not a fixed ceiling,
and must say which it observed.

### The billing subtlety that decides the comparison

Active CPU excludes I/O wait: "Time spent waiting for I/O (such as network
requests, database queries, or AI model calls) does not count toward Active CPU"
(DOCUMENTED). For an agent that waits on LLM APIs most of its life, that is a
large discount on the CPU line.

**Provisioned Memory is not discounted the same way.** It is "the memory
allocated to your sandbox (in GB) multiplied by the time it runs (in hours)"
(DOCUMENTED) — wall-clock, not active time, billed in 1-minute minimum
increments. So the memory line is a wall-clock floor that idle-heavy workloads
cannot duck.

INFERRED, worked through for the default 2 vCPU / 4 GB shape over one wall-clock
hour:

| CPU utilisation | Active CPU | Memory | Total |
| --- | --- | --- | --- |
| 100% | $0.256 | $0.0848 | $0.341 |
| 10% (agent waiting on LLM APIs) | $0.0256 | $0.0848 | $0.110 |
| 0% (idle but running) | $0.000 | $0.0848 | $0.085 |

The idle-heavy case is ~3.1× cheaper than the saturated one, and the floor is
$0.0848/hour — the memory charge. Any cross-provider comparison must be made
against that floor rather than against the active-CPU rate alone, or it will
overstate the advantage. The correct summary is: *active-CPU billing makes the
CPU line small for I/O-bound agents; the wall-clock memory line is what actually
sets the price.* Stopping a sandbox promptly, not merely leaving it idle, is
what removes that floor.

Sandbox creations are negligible at $0.0000006 each and do not move any
comparison.

## Live evidence

**Not yet collected — provider credentials pending Khaliq provisioning
2026-08-21.** Vercel is not yet in the team's 1Password, so no live run has
occurred: zero sandboxes created, zero spend. Nothing in the capability table
above may be read as claimed or measured.

The n=1 canary and n=7 benchmark — cold create p50/p95,
ready state after create, first exec latency, burst-until-429 concurrency,
cleanup discipline (destroyed vs verifiedGone), and delivered-vs-documented
shape — are pending credential provisioning. Until that run lands, every
behavioral cell in the capability table above stays `false`, and this section
must not be read as if it contained measurements.

The harness is written and ready to fire: `scripts/vercel-bench.ts`. It ledgers
each sandbox name and fsyncs it *before* the create call goes out, so a crash
between submit and response still leaves a reapable record; it caps count,
vCPUs, and sandbox lifetime; and it ends every run with an independent prefix
audit that reports `destroyed` and `verifiedGone` as separate numbers. If those
two disagree, that disagreement is the finding.

## Dependency provenance

- npm package: `@vercel/sandbox@3.0.1` (exact, not a range), Apache-2.0
- npm integrity:
  `sha512-q/Ne1UaqZ4PWmOj0kTl/KByAR9ZRxOgJCH8WNWcV3ERgb00lO6TQKwS1dSsypHSBHHDfjihByMKX/mlfjIw/cg==`
- tarball shasum: `30a7a6d9d6366b20ed46fa59a157274455419227` (207 files, 1.5 MB
  unpacked)
- upstream commit: `d7c3bf55d520c6e5b5381ed87285967b30ecc083`

  The npm packument carries no `gitHead` for this package — it is published from
  a monorepo by a release bot. The commit above is not a guess: it is the
  `gitCommit` of the resolved `git+https://github.com/vercel/sandbox` dependency
  recorded in the package's SLSA v1 provenance attestation, built from
  `refs/heads/main` via `.github/workflows/publish.yml`. Attestation:
  <https://registry.npmjs.org/-/npm/v1/attestations/@vercel%2fsandbox@3.0.1>
- SDK docs: <https://vercel.com/docs/vercel-sandbox/sdk-reference>
- pricing and limits: <https://vercel.com/docs/vercel-sandbox/pricing>
- lockfile: `package-lock.json` records the resolved tarball and integrity

The vendor SDK is imported in exactly one module, `src/vercel/internal/sdk.ts`,
and the import is dynamic so the dependency stays genuinely optional.
`src/vercel/config.ts` and `src/vercel/capabilities.ts` import no vendor types,
so a consumer can construct and type-check a configuration without the peer
installed.
