# Why Factory dispatches nothing — root cause, measured 2026-08-11 ~09:00–10:30Z

**Author:** `factory-lead`
**Trigger:** Khaliq put me on Factory: "focus on factory instances and getting the
factory up and running."
**Verdict:** The daemon is healthy and correctly configured. **It has never had a
current projection to read.** All four dispatch-ready issues are absent from the
mirror it enumerates, so discovery correctly finds nothing and dispatches nothing.

---

## The headline

Factory is **up**, has been up **11h40m**, is pointed at the **right contract**, and
is **subscribed**. It has dispatched **zero** work. That is not a Factory bug — it is
Factory faithfully enumerating an empty answer.

`issueSource: github` makes discovery **100% projection-coupled**: `#readyIssuePaths()`
is exactly `#githubIssuePaths()`. If the mirror does not contain an issue, that issue
does not exist as far as dispatch is concerned, no matter what GitHub says.

---

## The decisive measurement

Four open issues pass **both** safety gates (`requireLabel: factory` **and**
`requireTitlePrefix: [factory]`), confirmed against GitHub:

| Issue | Recipe label |
|---|---|
| `factory#221` — babysitter writes to GitHub as the local `gh` user | `agent:single` |
| `factory#222` — automatic babysitter only covers Factory-created PRs | `agent:team` |
| `sandbox#8` — seed local sandboxes by sharing git objects | `agent:single` |
| `workforce#306` — accept a persona in relay spawn / relayflow steps | `agent:team` |

Presence of each in the mirror Factory reads
(`chief/.integrations/github/repos/<owner>__<repo>/issues/by-id/<n>.json`):

```
ABSENT  AgentWorkforce__factory#221
ABSENT  AgentWorkforce__factory#222
ABSENT  AgentWorkforce__sandbox#8
ABSENT  AgentWorkforce__workforce#306
```

**4 of 4 absent.** And the truncation point is visible:

| Projected repo | issues present | max id present | needed id |
|---|---|---|---|
| `AgentWorkforce__factory` | 67 | **210** | 221, 222 |
| `AgentWorkforce__workforce` | 28 | **303** | 306 |
| `AgentWorkforce__sandbox` | **0** | — | 8 |

The mirror is not empty and not corrupt — it is **stale at a fixed point in the past**,
and every dispatch-ready issue was created after that point. This is why the gate has
looked "held closed" for days: nothing was holding it, there was nothing to hold.

---

## The causal chain, each link measured

**1. The delegated Relayfile credential is expired or revoked.**

```
$ relayfile status
error: refresh delegated relayfile credentials: delegated relayfile credentials
expired or revoked. Re-bootstrap relayfile credentials with agent-relay cloud login.
```

**2. The Agent Relay cloud session it would refresh from is HEALTHY.** This is the
part that changes the fix. Expiry arithmetic only, no values:

- `accessTokenExpiresAt` 2026-08-11T17:11:25Z — **valid, +6.8h**
- `refreshTokenExpiresAt` 2026-11-08T17:11:25Z — **valid, +2142h**

So this is **not** "Khaliq must re-login." The upstream session is fine; the derived
delegated credential is what died.

**3. The automatic re-mint fallback cannot run, because `agent-relay` resolves to the
broker binary.**

```
cloud re-mint fallback failed: agent-relay CLI >= 8.7.0 required with
`agent-relay cloud session --help` ... (error: unrecognized subcommand 'cloud'
Usage: agent-relay-broker <COMMAND>)
```

**Correcting my own first inference:** I assumed a missing or too-old CLI. Both
`agent-relay` binaries on PATH are fine — mise's is **11.4.2**, `~/.local/bin`'s is
**11.5.1**, and *both* have the `cloud` subcommand. The install is not the problem;
**resolution** is. Whatever relayfile execs lands on `agent-relay-broker`, a Rust
binary with no `cloud` verb.

The Go CLI documents an override for exactly this — `AGENT_RELAY_BIN`. Probe against a
control:

- **control** (no override): fails **instantly** with the credential error above.
- **probe** (`AGENT_RELAY_BIN=~/.local/bin/agent-relay`): **exit 124 at 120s, zero
  bytes on stdout and stderr.**

The override **does** change behaviour — the instant credential failure is gone, so the
re-mint path is now being attempted. **It is not a proven fix.** A silent 120s hang is
a different failure, not a success, and I am not reporting it as one. Most likely it
then blocks on the mount-start lock in link 4.

There is a second candidate the CLI names explicitly and which my own probe matches:
`agent-relay cloud session --json returned a masked accessToken`. The token I read back
is **12 characters** — i.e. masked. That may be the real refusal rather than the binary
resolution. **Both are live hypotheses; I did not separate them.**

**4. Two launchd supervisors both claim the same mount, so auto-refresh is blocked.**

```
com.agentworkforce.chief.senses             pid 1304   last exit 1
  -> node chief/scripts/chief-senses.mjs run          KeepAlive: on non-zero exit
com.agentworkforce.chief.integrations-mount pid 6779   last exit 137 (SIGKILL)
  -> relayfile restart rw_7ccfea89 --foreground       KeepAlive: true
```

Factory's own log, line 3:

```
local mount is stale (mount process (pid 62129) is not running) and auto-refresh
failed (... another mount initialization is already in progress for
chief/.integrations; wait for it to finish or stop the active mount before retrying)
```

**This is the duplicate-daemon decision Khaliq was asked for on 2026-08-08 and which
was never made.** It is now load-bearing: the second supervisor's restart loop is what
holds the initialization lock that blocks the first one's refresh.

**5. Staleness, quantified by Factory itself:**

```
local mount is stale (last reconcile 9223m ago); refreshing
```

**9,223 minutes = 6.4 days.**

**6. One mirror per workspace, so 15 of 17 routed repo mounts are refused by design.**

```
warning: could not start relayfile mount at .../relayauth: workspace rw_7ccfea89 is
already mirrored at .../chief/.integrations; refusing to silently re-home it
```

15 such lines, one per routed repo. This is **not** a bug — it is the one-mirror
constraint (`relayfile#409`/`#411`) meeting a 17-repo contract. It also explains the
recorded note that widening `repos.names` 9 → 18 *"made Factory's 16 failed per-repo
mounts worse"*: every added repo adds one guaranteed-failing mount. Harmless today
because the single `chief/.integrations` mirror is the one that matters, but it makes
the log unreadable and buries real errors.

**7. Live events are degraded to HTTP polling.**

```
[factory] live subscription starting {"transport":"subscribe-and-poll",
                                      "highWatermark":"evt_1328217"}
[relayfile-sdk] WebSocket connect failed; falling back to HTTP polling.
                Live events will be delayed. (forced-polling-pre-open: ws-error-pre-open)
```

**7 occurrences over 11h40m — that is not a hot retry loop**, so it is a degradation,
not a storm. It compounds the known ~620ms-per-file read cost.

---

## What the whole daemon log actually contains

**46 lines for 11h40m of uptime.** Composition: 1 startup line, 2 stale-mount lines,
15 per-repo mount refusals (2 lines each), 2 subscription lines, 7 WebSocket fallbacks.

**Zero** lines matching `dispatch`, `discover`, `triage`, `match`, `claim` or `spawn`.

It has not tried and failed to dispatch. It has never had anything to dispatch.

---

## One false alarm I generated and killed before reporting it

`npm run factory:status` prints `"repos": ["chief"]` against a 17-repo contract. That
reads like routing collapsed to a single repo. **It has not.** `status(repoNames)`
echoes its own CLI argument straight into the JSON (`scripts/factory-control.mjs:430`),
and `planCommand()` defaults that argument to the literal `["chief"]` when none is
passed (`:966-970`). The field describes **what I typed**, not the contract's routing
scope. Reading the producing source before believing the field is what caught it.

`npm run factory:status` is otherwise genuinely green: contract resolved at the
correct active path, `issueSource: github`, readiness label `factory`, hosted
`cloud-factory-brain` **active**, `mergePolicy: never`, workspace `rw_7ccfea89`.
**Three independent green lights over a queue that is structurally empty** — the same
shape recorded on 2026-08-10, still true.

---

## Contract drift, still live

`factory.config.json` (active) vs `factory.khaliq.config.json` (committed) differ by
**exactly one line**: `cloud` is absent from the active `repos.names`. That is the
interim drop made 2026-08-10 to reduce failing mounts, **still in place, 17 vs 18**.
It is deliberate and recorded, but it is drift and should either be reverted or
promoted into the committed file rather than left as an undocumented local delta.

Also worth noting: the active contract sets **no `repos.default`** and **no
`safety.requireTeamKey`** (correct — `requireTeamKey` is Linear-only), and
`babysitter.enabled: true` with `terminalState: "human-review"`.

---

## What I did not do, deliberately

- **Did not restart, stop, or unload either mount supervisor.** Killing the wrong one
  re-breaks the projection Factory depends on, and which supervisor owns the mount is
  an open decision belonging to Khaliq since 2026-08-08.
- **Did not run `relayfile stop && relayfile start`** (Factory's own suggested repair)
  for the same reason.
- **Did not touch `ROUTED_PR_BABYSITTER_ACTIVATION_ENABLED`**, add a readiness label,
  or merge anything.
- **Did not re-mint any credential.**

---

## Recommended order of repair

1. **Resolve the two-supervisor collision first.** Nothing else can hold. Pick one
   owner — `integrations-mount` is the one whose sole job is the mount and whose
   KeepAlive is unconditional; `senses` does more than the mount and exits 1. Unload
   the loser, then confirm the lock clears.
2. **Re-mint the delegated Relayfile credential.** The cloud session is valid, so this
   should not need an interactive login. Separate the two hypotheses from link 3 first
   — binary resolution (`AGENT_RELAY_BIN`) vs masked-token refusal — because they have
   different fixes and I did not discriminate them.
3. **Force one full reconcile and re-measure the truncation table above.** The
   acceptance test is not "no error" — it is `factory#221`, `factory#222`, `sandbox#8`
   and `workforce#306` becoming **PRESENT** in `issues/by-id/`.
4. **Only then** decide whether to open the dispatch gate. Unwedging releases all four
   at once, two of them `agent:team`. That is Khaliq's call, not mine.
5. Separately: file the `AGENT_RELAY_BIN` resolution defect, and decide whether a
   17-repo contract against a one-mirror-per-workspace constraint is the right shape
   at all — today it guarantees 15 failing mounts on every start.

## Boundary on this report

Links 1, 2, 4, 5, 6, 7 and the decisive absence measurement are **directly measured**.
Link 3 is **partially diagnosed**: the override demonstrably changes behaviour, but I
have not proven which of the two named causes is operative, and the probe ended in a
120s hang rather than a success. Nothing here has been verified against the *hosted*
Factory brain — this is the local `chief-broker` instance only.
