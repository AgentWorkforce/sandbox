# `mountRelayfile: true` HTTP 500 — root cause, fix, and live before/after

**Status:** evidence record. Every log line below is captured output, not narration.
**Defect:** `POST /api/v1/fleet/nodes/sandbox/ensure` with `mountRelayfile: true` returns
`{"error":"internal"}` HTTP 500, deterministically, after ~77s. `mountRelayfile: false`
returns 201 in 27s. Isolated to that one field by AgentWorkforce/sandbox-router PR #11.

| Tag | Meaning |
|---|---|
| **[OBSERVED]** | Captured from a command or log today. |
| **[INFERRED]** | Reasoning on top of the observations. |

---

## 1. The server-side error

[OBSERVED] Pulled from Cloudflare Workers Logs for the exact failing window rather than a
live tail (the failure is 6 hours old; `wrangler tail` cannot reach backwards):

```
POST /accounts/f7232cb80f6fab86a95426302af243e4/workers/observability/telemetry/query
  timeframe 2026-08-22T13:42:00Z … 13:45:00Z, needle "fleet-node-sandbox-ensure"
```

```
level: error
message: [fleet-node-sandbox-ensure] ensure failed
area:    fleet-node-sandbox-ensure
error:   Failed initial relayfile sync: exit 124:
  2026/08/22 13:42:49 mount layout=scoped remote=/ local=/home/daytona/workspace sync=mirror mode=poll
  2026/08/22 13:42:49 Mirror started at /home/daytona/workspace. Sync interval 30s +/- 20%.
  2026/08/22 13:43:09 skipping oversized local file /home/daytona/workspace/_logs/rw_7ccfea89/2026-08-17.jsonl
                      (9824362 bytes > 8388608 byte writeback cap); not enqueued
  relayfile initial sync made no progress for 60s; canceling
  2026/08/22 13:43:49 websocket event apply failed for /gmail/threads/_index.json: context canceled
  2026/08/22 13:43:49 mount full-tree traversal summary remote_root="/" list_calls=4 entries_seen=777
                      files_seen=417 directories_seen=360 bytes_seen=202332869
                      traversal_complete=false traversal_failed=true duration_ms=58429
  2026/08/22 13:43:49 mount sync cycle failed: context canceled
```

**The sync was not stuck — it was killed while making progress.** `entries_seen=777`,
`duration_ms=58429`: it was mid-traversal when the watchdog cancelled it.

---

## 2. Mechanism

`SandboxOrchestrator.startMount` wraps the first `relayfile-mount --once` in an in-sandbox
**idle watchdog** (`buildIdleWatchedCommand`, `src/mount-script.ts`). The watchdog re-touches
a marker whenever one of its *progress files* is newer than the marker, and `exit 124`s once
the marker sits still for `idleTimeoutSeconds` (60s here).

The progress file for an **unscoped** mount came from `initialSyncProgressFiles()`:

```ts
if (roots.length === 0) {
  return [`${stateDir.replace(/\/+$/u, "")}/.relayfile-mount-state.json`];  // never written
}
return roots.map((_r, i) => `/tmp/relayfile-mount-initial-sync-${i}.json`); // passed as --state-file
```

`relayfile-mount`, given `--state-dir` and no `--state-file`, resolves its private state to
(`relayfile internal/mountsync/state_path.go`, `ResolveMountStatePath`):

```
<state-dir>/<MountStateID(workspace, remoteRoot, localRoot, kind)>/state.json
```

`.relayfile-mount-state.json` is `LegacyMountStateFileName`, and even in the legacy layout it
lived under the **local root**, never under the state dir. The watched path was written by
nothing, ever. `[ -f "$file" ]` was always false, the marker never advanced, and the watchdog
fired at exactly 60s regardless of how healthy the sync was.

The daemon was never silent: `persistTraversal` (`internal/mountsync/syncer.go:5693`)
checkpoints every 32 files into the real state file. The signal existed; the watchdog was
pointed at a phantom.

### Why only `mountRelayfile: true`, and why deterministic

- `mountRelayfile: false` → no `autoRelayfileMount` → no mount, no watchdog → 201 in 27s.
- `mountRelayfile: true` → the route sets `autoRelayfileMountRequired: true`, so the mount
  error is re-raised, `provisionFleetSandboxNode` tears the sandbox down, and the route's
  catch-all returns the opaque `{"error":"internal"}`.
- The route passes `autoRelayfileMount: {}` — **no `paths`** — so it always took the broken
  `roots.length === 0` branch, with `remote=/`: a full-workspace cold materialization of
  ~202 MB for `rw_7ccfea89`. That reliably exceeds 60s, so the bug fires every time.
- [INFERRED] Small workspaces finish the first sync inside 60s and never notice. That is why
  this survived: the defect is invisible until a workspace outgrows a 60s cold sync.

### The 50s timing asymmetry

Not a retry loop and not a timeout on a remote call. 76.6s = ~15s sandbox create + **exactly
60s of watchdog idle** + ~1s teardown. The 60s idle window *is* the delta.

---

## 3. [OBSERVED] Live before/after — real Daytona sandboxes, real production relayfile

Two fresh sandboxes from the fleet snapshot
`relay-orchestrator-sdk-11.8.0-relayfile-v0.10.35-runtime-4.1.41`, each seeded with the same
creds file the fleet bridge writes, each running the **exact** shell
`startMount` emits (`proof/emit-shells.mts` renders it from the checked-out
`src/mount-script.ts`; `proof/run-proof.mts` drives it). The relayfile token is a fresh
whole-workspace token for `rw_7ccfea89`, minted through cloud's own
`POST /api/v1/workspaces/:id/relayfile/delegated-token`. The ONLY variable is the mount-script
version.

The emitted shells differ exactly where expected:

```
[before] watched      = '/home/daytona/.relayfile-mount-state/.relayfile-mount-state.json'
[before] --state-file = NONE
[after]  watched      = '/tmp/relayfile-mount-initial-sync-0.json'
[after]  --state-file = ['/tmp/relayfile-mount-initial-sync-0.json']
```

### BEFORE (origin/main) — sandbox `9caa04ef`

```
[20:39:31] initial sync launch…
[20:40:36] initial sync EXITED code=124 after 64.4s
--- initial sync log
2026/08/22 20:39:31 Mirror started at /home/daytona/workspace. Sync interval 30s +/- 20%.
2026/08/22 20:40:00 skipping oversized local file .../2026-08-17.jsonl (9824362 bytes > 8388608 cap)
relayfile initial sync made no progress for 60s; canceling
2026/08/22 20:40:31 mount full-tree traversal summary remote_root="/" list_calls=3 entries_seen=774
                    files_seen=417 directories_seen=357 bytes_seen=203525726
                    traversal_complete=false traversal_failed=true duration_ms=58420
--- PHANTOM path the unscoped watchdog watched:
ls: cannot access '/home/daytona/.relayfile-mount-state/.relayfile-mount-state.json': No such file or directory
--- files the daemon actually wrote under --state-dir:
/home/daytona/.relayfile-mount-state/9c19f8692e914587394146043f6e07b9/state.json
--- explicit initial-sync state files in /tmp:
ls: cannot access '/tmp/relayfile-mount-initial-sync-*.json': No such file or directory
--- mirror: 202M, 443 files
```

`entries_seen=774 / files_seen=417 / bytes_seen≈203.5 MB / duration_ms=58420` reproduces the
production failure (`777 / 417 / ≈202.3 MB / 58429`) essentially exactly. **The two `ls`
results above are the whole bug in four lines**: the watched path does not exist, the written
path does.

### AFTER (this branch) — sandbox `fca79a31`

```
[20:39:34] initial sync launch…
[20:44:36] TIMED OUT (harness deadline) after 301.8s
--- initial sync log
2026/08/22 20:39:34 Mirror started at /home/daytona/workspace. Sync interval 30s +/- 20%.
2026/08/22 20:41:01 skipping oversized local file .../2026-08-17.jsonl (9824362 bytes > 8388608 cap)
--- explicit initial-sync state files in /tmp:
-rw-r--r-- 1 daytona daytona 298460 Aug 22 20:44 /tmp/relayfile-mount-initial-sync-0.json
--- mirror: 223M, 1511 files
```

**No `made no progress` line. No `exit 124`. No `traversal_failed`.** The progress file exists
and its mtime keeps advancing (20:44, five minutes in), so the watchdog keeps extending. The
mirror reached 1511 files — 3.4× what the killed run managed. The run ended only because *this
harness* stopped at 301.8s, not because anything in the sandbox gave up.

Both sandboxes destroyed; see §6.

---

## 4. The fix

Derive the `--state-file` flag and the watchdog's watch list from one function
(`initialSyncStateFiles`) so they cannot drift, and give the unscoped initial sync an explicit
`--state-file` — exactly what the scoped branch already did.

Second defect closed on the way: under a bare `--state-dir`, the `--once` initial sync and the
concurrently running daemon resolve to the **same** private state file (neither passes
`--mount-kind`). An explicit per-sync state file ends that two-writer race.

### Tests

`src/mount-script.test.ts`, `describe("mount-script initial-sync idle watchdog")`. The load-bearing
one asserts the invariant that was violated: **every path the watchdog watches must be a path
the same emitted command tells the daemon to write.**

| | on `origin/main` | on this branch |
|---|---|---|
| watches only files the command declares (unscoped) | **FAIL** | pass |
| watches only files the command declares (scoped) | pass | pass |
| never names the legacy local-root state file | **FAIL** | pass |
| unscoped sync gets its own state file, not the daemon's | pass (vacuous — no `--state-file` existed) | pass |

```
# origin/main:    # tests 750  # pass 739  # fail 2
# this branch:    # tests 750  # pass 741  # fail 0
```

---

## 5. What this fix does NOT fix — read before calling the 500 closed

[OBSERVED] The AFTER run had still not finished its first unscoped whole-workspace sync at
**301.8s**. `startMount`'s overall budget is `initialSyncDeadlineMs ?? 240_000`, and the fleet
bridge passes no override.

[INFERRED] Therefore, for a workspace the size of `rw_7ccfea89`, this fix alone converts
`Failed initial relayfile sync: exit 124` into
`Relayfile initial sync did not finish within 240s` — an honest error instead of a spurious
one, but still a 500. The false kill is gone; the budget is now the binding constraint.

The route also cannot hold that long regardless: the CLI's own `waitTimeoutMs` is 90s.

Three ways out, none of which belong in this diff:

1. **Scope the fleet mount.** `autoRelayfileMount: { paths: [...] }` bounds the first sync and
   takes the already-correct scoped branch. Smallest change, and it is a product decision
   (which subtrees does a fleet node need?), not a mechanical one.
2. **Do not block provisioning on the first sync.** Start the daemon, return 201 with the mount
   started, let it converge in the background. `relayfileMounted` then means "mount running",
   which is arguably what it should have meant.
3. **Raise `initialSyncDeadlineMs`.** Weakest option: it cannot beat the caller's 90s.

---

## 6. Teardown

Sandboxes created for this investigation, all destroyed:

| id | purpose | state |
|---|---|---|
| `0d12bfa9-45dd-4dcd-b0fb-957b23ce7388` | first (aborted) harness run | destroyed |
| `9caa04ef-6ac7-4174-960f-ce924b03406e` | BEFORE | destroyed |
| `fca79a31-5521-4ace-a6c8-4da1aa0e87c9` | AFTER | destroyed |

No credential belonging to anyone else was rotated or consumed: the relayfile token was newly
minted through cloud's delegated-token route, and the existing entries under
`~/.relayfile/delegated/` were read for metadata only and left untouched.

---

## 7. Follow-ups (not in this change)

- **`{"error":"internal"}` is its own defect.** `ensure/route.ts`'s catch-all flattens every
  mount failure into an opaque body. Raised independently on cloud issue #3061 for the adjacent
  credential-mount failure; it cost that investigation four attempts and a Worker tail.
- **The failure path can leak sandboxes.** The CLI's orphan-cleanup branch keys on `sandboxId`
  being present in the error payload. An opaque 500 carries none, so cleanup cannot fire.
- **The same defect is duplicated in `/cloud`.** `cloud/packages/core/src/relayfile/mount-script.ts`
  has its own `initialSyncProgressFiles` with the identical phantom path on its
  `usesProviderRootFallback` branch, serving the executor rather than the fleet route.
- **The fix reaches prod only through a dependency bump.** `cloud/packages/web` consumes
  `@agent-relay/sandbox` as a published npm dep pinned at `0.1.2`. Chain: merge this →
  publish `0.1.3` → bump + merge in `/cloud` → deploy `cloud-web`.
