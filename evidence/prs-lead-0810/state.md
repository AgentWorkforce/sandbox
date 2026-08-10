# chief-prs-lead-0810 — closing state

Lane: get every open PR in `AgentWorkforce/chief` into a mergeable state.
Written 2026-08-10 ~19:5xZ, before the fleet restart. Measured, not planned.

## Board — all work is pushed, nothing is only in a scratchpad

`main` = `06448764` at time of writing.

| PR | branch | head | mergeable | unresolved threads |
|---|---|---|---|---|
| #5 | `chief/node-plist-keepalive` | `bfd0d139` | MERGEABLE | 0 |
| #23 | `chief/yc-demo-brain` | `13521123` | MERGEABLE | **1 — deliberate, see below** |
| #25 | `chief/orgchart-hierarchy` | `0ff4aaa2` | MERGEABLE | 0 |

Also landed earlier by Khaliq/chief with my resolutions in them: **#15** (`940d6f7`),
**#17** (`ff6361c`).

Every conflict resolution is recorded in a comment on its own PR, stating which
side won and why. Those comments are the durable record; this file is an index.

## Two findings that live nowhere else

### 1. There is no CI in this repository

Zero `.github/workflows/` files on `main` and on all eight PR head branches.
Zero workflow runs in the repository's entire history (`gh run list` with no
filters returns empty). The only `statusCheckRollup` entry is a `CodeRabbit`
StatusContext — a review bot's own status, not a test.

**So `gh run list --branch` returns empty for every PR here, and empty means
"no CI exists", not "CI passed."** Any lane that reports per-PR CI green off
that empty result is manufacturing a green from nothing.

The repo ships **eight test suites that nothing invokes**: `validate`,
`config:test`, `factory:test`, `orgchart:test`, `cloud:test`, `watchdog:test`,
`cloud:typecheck`, `cloud:compile:check` — plus `delegation:test`, which
arrived with #24. I substituted these as the verification gate for every PR in
this lane, baselining first so a red meant something.

```
BASELINE main 621548ff ....... 8/8 PASS
#17 resolved ecf68410 ........ 8/8 PASS
#5  resolved bfd0d139 ........ 8/8 PASS + launchd 11/11
#23 resolved 13521123 ........ 8/8 PASS
#25 resolved 0ff4aaa2 ........ 9/9 PASS (incl. delegation 48/48, orgchart 28/28)
```

**Trap for the next lane:** `npm run validate` exits 1 in any fresh clone —
`Error: No active roster at <clone>/teams.json`, because `teams.json` is
per-machine and untracked. That is the environment, not a defect.
`cp teams.khaliq.json teams.json` makes it pass. A lane that runs `validate` in
a clone and reports failure is reporting its own scaffold.

**Recommendation:** one small workflow file running those nine suites.

### 2. All four senses scopes are offline and have been since 2026-08-07

Read from the resident's `senses/*/.relay/state.json` at 19:19Z on 2026-08-10:

| scope | status | last **success** | last **attempt** | error |
|---|---|---|---|---|
| `/github` | `offline` | 2026-08-07T23:36:37Z | 19:14:14Z | `context deadline exceeded` |
| `/linear` | `offline` | 2026-08-07T18:41:43Z | 19:19:02Z | `dial tcp: lookup file.agentrelay.com: no such host` |
| `/notion` | `offline` | 2026-08-07T23:38:11Z | 19:17:13Z | `no such host` |
| `/digests` | `offline` | 2026-08-07T22:11:22Z | 19:09:29Z | `no such host` |

Every scope is 20 hours to 3 days stale. **The attempt cursor advances every few
minutes while the success cursor stays frozen** — live-but-frozen, which is
exactly the shape #17 was written to detect, and both failure modes are the two
#17 documented on 08-05.

**Consequence:** any lane reading `senses/linear/`, `senses/github/` or
`senses/notion/` right now is reading Thursday. Read GitHub live via `gh`.
`/digests` being down is why the scheduled digest has nothing fresh.

`CLAUDE.md` calls workspace convergence the first platform priority and says
these failures are blocking rather than warnings. Nobody appears to own it. I
did not touch it — a `launchctl kickstart` is documented in that same thread as
symptomatic relief that does not hold.

## The one thread left open on purpose — #23

`#23` thread `PRRT_kwDOTnOGOs6W2sBa`-adjacent (`memory/projects.md:44`): the
`<project>-<workstream>-<role>` spawn-naming convention has no uniqueness
component. It collides when a workstream dispatches two workers with the same
role, or retries while the earlier worker still exists.

Verified: `docs/onboarding-khaliq.md` §5 states the requirement and then admits
**"Collisions aren't rejected, they're confusing."** The document that sets the
rule concedes it is unenforced.

Corroborated by `main`'s own `memory/learnings.md`: reclaim is unreliable
(`agent-relay agent remove` reported success and left five of six agents
present); the recorded remedy is *"not to reclaim a name but to abandon it"*;
and `relaycast#306` would have silently converted a node-bound reclaim into
name-alone takeover. **Where a lookup is keyed on the name, the name is the
identity, so a collision is not cosmetic.**

**The fix belongs at the dispatcher — reserve the name at spawn and reject a
duplicate — not in a brain document, and explicitly not entropy or a retry
loop**, which make the collision rarer without making it impossible and so stop
it being observable. Left unresolved so it stays visible to whoever owns
dispatch.

## What #25 needed beyond conflict resolution

All four review findings on #25 reproduced against the merged tree; none were
stale, none were wrong. Fixed in `0ff4aaa`, three regression tests added:

- **P1** — a workstream owner whose repo the workstream does not list was
  dropped from the tree entirely. `buildHierarchy` contradicted the repo's own
  `matchAgents` (`serve.mjs:757`), which explicitly treats ownership as
  repo-independent. Still demonstrable today via
  `principals/will/workstreams/agent-org-primitives.md` (`owner: chief`, repos
  omit `chief`). The other instance the reviewer cited, `factory-live-dispatch.md`,
  was reassigned on 08-10 and no longer shows it.
- **P2** — a repo-less agent was silently omitted;
  `buildHierarchy({agents:[{name:'repo-less'}],projects:[]})` returned zero
  workers.
- **P2** — declared titles never reached the card; the swap was gated on
  `inferredLabel`, false whenever a title exists. `org.json` declares 52 titles,
  so this was essentially the whole overlay.
- **P2** — keyboard focus was lost on every 10s poll; `tabIndex` was restored
  but `focus()` was never called. This is the one fix reasoned from the render
  path rather than reproduced — there is no DOM harness in the repo.

Fixing the P1 required splitting `buildHierarchy` into two passes: placement is
first-claim-wins, and one project's `Unassigned` sweep could claim an owner
before the workstream they own was examined. `alsoIn` is now deduplicated by
workstream file, because one workstream spanning three repos renders under each.

## What #5 needed beyond conflict resolution — a silent watchdog outage

Will's #5 extracted the launchd plist emitter into a tested
`scripts/lib/launchd.mjs`; `main`'s `43ad458` had meanwhile added an **inline**
emitter to `install.mjs`. Both in one module is a redeclaration `SyntaxError`,
so Will's wins. **But `main` added a service alongside its emitter**, and Will's
`plist()` destructures its input, so the fleet watchdog's `startInterval: 600`
was accepted and discarded:

```
StartInterval present : false
KeepAlive present     : false
RunAtLoad present     : true
```

The plist installs, `launchctl` reports the job loaded, and the ten-minute fleet
liveness watchdog **runs once at login and never again**. Neither side was wrong
alone; the defect existed only in the combination, and no diff review would have
shown it. `launchd.mjs` gained `startInterval`, a resident+periodic combination
now throws, and the two new tests fail against Will's emitter as written
(9 pass/2 fail) and pass after (11/11).

Flagged to @willwashburn on the PR: the better shape is probably one declared
`kind: "resident" | "periodic" | "one-shot"` rather than two mutually-exclusive
booleans, which would have made this collision impossible to express. That is
his call and I did not take it.

## Notes on method, for whoever picks this up

- **`#24` merged into `chief/orgchart-hierarchy`, not `main`.** Its merge commit
  `0c3b9cd5` is not an ancestor of `main`. #25 carries it. If #25 is closed
  rather than merged, #24's 1105 lines go with it.
- **A verification harness can fail like the thing it tests.** My first
  content-preservation check on the 08-06 journal reported ~30 bullets missing
  from both sides. All artefacts: I piped lines beginning `- ` into `grep`,
  which parsed them as options. Re-run in Python, the true answer was zero
  missing. A harness that can exit non-zero for its own reasons will read as a
  real defect.
- **Two whole journal entries for one day merge by section, not by
  concatenation** — otherwise you get two frontmatter blocks and a doubled
  section order.

---

# Addendum — the merged-PR thread sweep (completed)

All **11** threads stranded on the five merged PRs are now **answered**. Three
resolved, eight deliberately left open because they are real and unfixed.

| PR | threads | resolved | open (answered) |
|---|---|---|---|
| #28 | 6 | 3 (credentials) | 3 |
| #24 | 4 | 0 | 4 |
| #6 | 1 | 0 | 1 |

**#24's four are NOT on `main`.** `#24` merged into `chief/orgchart-hierarchy`,
so its code rides on **#25**, which is still open. **They are fixable before that
PR merges** rather than stranded.

## Confirmed defects, in severity order

**1. `recordDispatch` is a read-modify-write race — the fail-closed dispatch
gate fails open.** `scripts/lib/delegation-ledger.mjs:93`, on #25's branch.
Reproduced with 8 concurrent processes claiming 8 distinct names, 4 runs:

```
run 1: spawned=8 refused=0 recorded=8   clean
run 2: spawned=8 refused=0 recorded=8   clean
run 3: spawned=6 refused=2 recorded=6
         spawned-but-unclaimed = [worker-1, worker-2]
         refused-but-claimed   = [worker-5, worker-8]
run 4: spawned=7 refused=1 recorded=7
         spawned-but-unclaimed = [worker-5]
```

Intermittent, and it fails in **two opposite directions at once**:
*spawned-but-unclaimed* is an agent running with no recorded identity — the
AR-448 shape the module's own docstring cites as the thing it exists to
prevent; *refused-but-claimed* is a name permanently blocked by a worker that
never started. `renameSync` keeps the file valid JSON throughout, so **there is
no corruption to detect — the ledger is always consistent and simply missing
claims.** The fixed `${path}.tmp` adds a hard `ENOENT` on rename when two
writers collide. Distinct temp files would fix the *visible* symptom and leave
the *silent* one; this needs a lock across read→check→write, or a CAS.

**2. `releaseDispatch` releases by name alone** (`:109`). No run/source
comparison, so a late cleanup from an earlier run frees a newer live claim.
`identity.dispatch.runId` is already stored and already read by the
duplicate-claim error — only the comparison is missing. Compounds with (1).

**3. `applyLedgerIdentity` re-expresses the completeness predicate and they have
already drifted** (`:128`). `readAgentIdentity` accepts aliases
(`org`, `project_name`, `task`, `worker_role`) and requires four fields
including `workstream` plus `ROLES.includes(role)`; `applyLedgerIdentity` tests
three canonical keys for mere presence. Fails both ways — overwrites an
alias-declared record (and later reads then prefer the injected canonical
values), and skips the overlay for a canonical record missing `workstream`.

**4. `#28` P1 — the handoff document names a resident that does not exist.**
`HANDOFF-2026-08-10.md:246` says the canonical name is `chief-khaliq`; both
`teams.khaliq.json` and the live `teams.json` name it **`chief`**
(`['chief','marketing-lead','factory-lead']` in both). `active-lanes.md:286`
and `:406` also assert `teams.json` still says `chief-khaliq` — false.
**Relevant to the restart: the successor Chief reads this document first.**
Bonus: the live `teams.json` task string opens *"Read `chief.config.json`"* —
that file does not exist anywhere; the committed variant is already corrected.

**5. `#28` P2 — `npm run setup` silently drops `slack.channel`.**
`createFactoryContract` emits no `slack` key; `existingFactoryRepos` preserves
only `.repos`; `onboard.mjs:340-346` overwrites **both** the variant and the
active contract. `babysitter.enabled` survives, so the babysitter stays on
while losing the channel it posts to — healthy-looking and silent. The general
fix is to merge the generated contract *over* the existing file, so the next
field added does not repeat this.

**6. `#6` — `chief.sh` retries a permanent input error forever.** Merged to
`main` as `c87d812`. `MODE` is unvalidated from `$1`/`$2`; the fail-fast at
`:77` covers only `ensure_broker`/`ensure_target`, and the attach loop treats
every non-zero exit as a lost seat. An invalid `--mode` fails instantly, so the
`>= 30s` fresh-backoff never triggers and it spins at the 10s cap — ~6
attempts/min forever, **printing `seat lost` and blaming the broker for the
user's typo**, which points a debugger at the one component this repo forbids
restarting.

## The three resolved threads — a recorded decision, not a refutation

`#28`'s credential findings were correct and are **accepted risk**. Verified:
`opencode.json` untracked and gitignored as of `7b635014`, absent from `main`'s
tree, introducing commit `261db56` **not reachable from `main`**, repo private
and now **squash-only** (`allow_merge_commit=false`, `allow_rebase_merge=false`)
which is what keeps it off `main`. **Not remediated:** credentials are
unrotated and the blob is **still reachable via the `chief/factory-allowlist-herdr-repos`
branch ref**, which still exists on the remote. Bounded to a feature branch in
a private repo — not eliminated.

The fourth `#28` thread — `permission: { "*": { "*": "allow" } }` — is a
**separate** finding not covered by that ruling, and is left open. The file is
per-machine and untracked, so untracking it removed the grant from review
without necessarily removing it from the hosts.
