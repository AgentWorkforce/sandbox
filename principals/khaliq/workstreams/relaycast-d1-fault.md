---
status: active
owner: relay-1562-workspace-sf-0817
reports_to: chief
updated: 2026-08-18
repos: [relaycast, relay, cloud, relaycast-cloud]
---
# Relaycast D1 fault — one backend defect wearing four faces

Goal: stop Drizzle-on-D1 queries failing intermittently in the relaycast
engine, and stop those failures surfacing as raw SQL, silent hangs, or
healthy-looking nodes that cannot do their job.

## Now — 2026-08-18

The fault is **live**. Tracked in `relay#1562`. The same signature —
a Drizzle query failing against D1, surfaced with the raw statement — has now
appeared on two different tables:

- `Failed query: insert into "workspaces" (...)` — 2026-08-17, breaking
  `POST /v1/workspaces` and therefore relay CI's standalone smoke, which
  provisions a fresh workspace on every run with no workspace key.
- `NodeRegistrationError: Failed query: select "status" from "nodes"` —
  2026-08-18 07:18Z, in sf-mini's node stderr, killing its provider child.

**relaycast#333** (`fix(engine): make workspace creation resilient`) is the
only work anyone has built against this. It makes the workspace + default
`#general` channel one atomic D1 batch, reuses fixed ids across attempts so a
lost response replays to the same workspace, retries only Cloudflare-classified
transient failures with backoff and jitter, and returns a generic
`internal_error` body so SQL and bound parameters cannot reach a client or a
CI log. Eight unresolved review threads, two of which break its own headline
claims — see History.

## Next

- Land the eight review threads on relaycast#333, `httpError` predicate first.
- Prove it in the self-host container: both arms, and state which branch of
  `runAtomicWrites` actually ran.
- Decide whether the retry/classify/redact machinery in `d1Retry.ts` and
  `httpError.ts` should be applied beyond `workspace.create`. It is generic;
  `select "status" from "nodes"` is failing today with no retry and no error
  boundary at all.
- Publish the engine and bump `relaycast-cloud` (package **and** handler source
  marker) before any of this changes production. Merging #333 alone does not.

## History

### 2026-08-18 — the "it stopped reproducing" call was wrong

Probed `POST /v1/workspaces` 30 times against production — 10 sequential, 20 in
concurrent bursts, controls separating random from concurrency-triggered
failure. **30/30 `201`.** `Package Validation` was eight-for-eight green. On
that basis Chief reported the fault resolved and downgraded #333 to "two real
robustness defects, fixed, uncreditable to the incident."

Within the hour, sf-mini's log produced the `nodes` failure timestamped during
the testing window. **The probe measured one query and generalised to the
shared dependency.** A single-endpoint probe cannot clear a database. Any
future all-clear must sample several queries across several tables.

Consequence: the before/after production measurement is unavailable, so #333's
local tests are the only evidence that will ever exist for it. That raises the
bar on its review findings rather than lowering it.

### 2026-08-18 — review found two defects that break #333's own claims

- **`httpError.ts`** — `safeClientErrorMessage` uses `(error.status ?? 500) >= 500`
  while `errorResponse` uses `(error.status || 500)`. With `status: 0` the mask
  never fires and the raw message ships inside an HTTP 500. The leak the PR
  exists to close survives through one nullish-coalescing operator. Cubic found
  the mirror case: legacy coded 5xx get masked despite carrying a code. The
  predicate is wrong in both directions.
- **`ports/database.ts:154`** — `runAtomicWrites` falls through to
  `runSequentially` when the handle has neither `withTransaction` nor `batch`.
  No transaction, no rollback. "One atomic batch" holds only when the handle
  happens to provide the capability. An unenforced invariant is a convention.
- **`workspace.test.ts:76`** — and this is why neither was caught: the test
  claiming to verify atomicity injects its failure **before `BEGIN IMMEDIATE`**,
  so mid-batch rollback is never exercised. The one boundary the change is
  about is the one with no coverage.

### 2026-08-17 — root cause found

`POST /v1/workspaces` wrote the workspace and its default channel as **two
separate D1 writes**, and Cloudflare does not retry writes. Found by
`relay-1562-workspace-sf-0817` overnight; PR opened as relaycast#333.

### 2026-08-18 09:30Z — ROOT CAUSE: 41,320 workspaces, 98.6% empty, no way to delete any

Queried production D1 (`relaycast-cloud`, 1.97 GB, 1,010,564 reads /
368,549 writes per 24h) directly with wrangler.

| table | rows |
|---|---|
| **workspaces** | **41,320** |
| channels | 50,516 |
| messages | 82,292 |
| agents | 24,172 |

```
total_ws     41,320
empty_ws     40,742    <- ZERO messages, ever
created_24h     585
created_1h       72
```

**Only 578 workspaces in the entire history have ever carried a message.**
`ci-standalone-smoke.sh` mints a fresh one on every CI run because it starts
with no workspace key; relayflow bootstraps do the same; ~1,700/day and
rising. **relaycast#336 — there is no DELETE for workspaces anywhere in the
API**, so they accumulate permanently.

Every `POST /v1/workspaces` therefore inserts into a 41k-row table and its
indexes, and that is the operation timing out. Measured 09:09Z: `500` in 5.2s,
two requests that never returned at 20s, then `201`s at 9.5s and 7.4s —
against a 06:57Z baseline the same morning of 30/30 at 0.73–2.57s. Edge health
was 200 in 42ms throughout: the edge is fine, the write plane is not.

That cascades into sf-mini's broker failing its `4 x 5000ms` registration
handshake, the relayflow bootstrap `ETIMEDOUT` (cloud#3072), and the
`Standalone macOS Smoke` CI flake.

**This reframes relaycast#333.** Its retries and atomicity are worth having,
but retrying an insert into an ever-growing table does not address why the
insert is slow. Fix order: stop creating a workspace per CI run (relay);
give workspaces a lifecycle (relaycast#336); then reclaim the existing 40,742.

Reclaim predicates, measured, so the choice is deliberate:

| set | count |
|---|---|
| `chief-*` (Chief's probes) | 36 |
| CI-named + >7d + no msgs + no agents | 4,239 |
| no msgs + no agents + >7d | 16,331 |
| CI-named `relay-<8hex>` | 20,052 |
| all empty | 40,742 |

The spread from 4,239 to 40,742 is the safety question and it is Khaliq's.
`ON DELETE cascade` is declared to channels and agents, but SQLite only
enforces FKs with the pragma on — verify against D1 first. And deleting rows
will not shrink the file without a `VACUUM`, which D1 may not expose; row
count is what makes inserts slow, so it is still worth doing.

**A separate defect found while measuring:** workspace names collide.
`relay-6bf605d7` appears 3 times and `relay-4a214c1a` 4 times, different
creation dates, different contents. From an 8-hex space with ~20,000 CI-named
workspaces that should be vanishingly rare — the generator has far less
entropy than its format implies, and `GET /workspaces/by-name/{name}` is a
real endpoint, so lookups are ambiguous.
