# Chief handoff — 2026-08-10 evening, written before a fleet restart

**Read this before touching a broker.** It supersedes `HANDOFF-2026-08-10.md`,
which describes the morning state and a release chain that turned out wrong.

You are the resident Chief on `chief-broker`, named **`chief`** in `teams.json`.
Start with `CLAUDE.md` §3, then read this.

---

## 0. THE ONE THING THAT CAN GO IRREVERSIBLY WRONG TONIGHT

**Do not restart or upgrade any broker until that node's `metadata.identity_key`
is backfilled and verified.**

Relay 11.4.2+ derives a broker's identity as `"node-" + SHA256(<the exact
state-file PATH STRING>)` and stores `SHA256` of that as `metadata.identity_key`
on the agent record. On restart the broker re-registers, hits its own name as a
collision, and must prove ownership. If the stored verifier is absent or does not
match, relay **refuses to hand over the credentials** (`agent_identity_mismatch`,
HTTP 409) and **the name is burned with no way back.**

**STATE AS OF 22:05Z — all three minis upgraded, restarted and ACTIVE in `rw_7ccfea89`.**

| node | broker | agent id | control plane |
|---|---|---|---|
| `chief-broker` | 11.4.2 | `211418990402400256` | self-stamped; **upgrade LAST** |
| `barry` | **11.5.1** | `210867721395138560` | **active**, reclaimed |
| `finn-mini` | **11.4.3** | `205917852717920256` | **active**, reclaimed |
| `sf-mini` | **11.5.1** | `205920120209797120` | **active** 22:04:21Z — first time since **2026-07-23** |

**The reclaim mechanism is proven on three nodes.** Each restarted, hit its own name as a
collision, presented the backfilled identity, and got its record back with the **same agent
id**. `barry` proves 11.5.1's derivation specifically.

### `sf-mini` was never broken — it was serving a workspace nobody watched

**Root cause, and it is documented in `finn-mini`'s own wrapper comment:** running
`agent-relay node up` from inside a **git repo** makes it *rewrite that repo's*
`.agentworkforce/relay/workspace-key.json` pin (**relay#1432 item 4**). `sf-mini`'s plist set
`WorkingDirectory` to the **relay repo**, so the CLI wrote a fresh pin there and faithfully
joined a different workspace. The broker was healthy the whole time; it simply reported
somewhere else.

That box had **three** workspace identities: the relay-repo pin (`…6f31`, workspace
`209946833753862144`), a home pin (`…0af8`, workspace `209992517857177600`, its own `sf-mini`
record `209993022532612096`), and the real fleet key `…9812` / `rw_7ccfea89`.

**The fix needed no credential copying.** The correct key was already on the box at
`workspaces.json` `.workspaces.default.key`, and `fleet-enrollments.json` already held the
`nt_` node token and `nodeId` for `https://cast.agentrelay.com#rw_7ccfea89`. I had proposed
propagating chief's key; checking first made that unnecessary.

**All three minis are now structurally identical** — each runs
`~/.agentworkforce/relay/bin/start-<node>-fleet-node`, which reads its token and key from the
0600 stores, exports `RELAY_WORKSPACE_KEY` / `RELAY_NODE_ID` / `RELAY_NODE_TOKEN`, and `cd`s
to a **neutral, non-git** run dir before `node up`. **The neutral cwd is load-bearing, not
cosmetic.** Plist backups on `sf-mini`: `…bak-statedir-20260810`, `…bak-wrapper-20260810`.

**`launchd` sets `WorkingDirectory` BEFORE exec** — a wrapper's own `mkdir -p` runs too late
and the job dies `EX_CONFIG (78)`. Create the run dir when you write the plist.

### SANDBOX WORK — NOT STARTED, and the ordering is a safety property

`sf-mini` is the chosen sandbox: 71 repos, 17G, **24Gi free of 228Gi** — the tightest disk on
the fleet. **relayfile is not installed there and there is no mount daemon.** The sequence
must be: install → configure the mount → **prove an agent reads a repo the box does not have
locally** → *only then* delete repos. Deleting before the mount is proven strands the machine.
That proof is the unmet deliverable in `relayfile-coordination`. Relay development currently
lives on `sf-mini` (`relay/target/release`) and would have to move first.

### THE EXPENSIVE LESSON — we stamped `sf-mini` with a WRONG key and nearly restarted on it

The first backfill derived `sf-mini`'s path from its plist `WorkingDirectory`. **The running
broker resolved a different project root** (`/Users/khaliqgant`), so the real state file was
`/Users/khaliqgant/.agentworkforce/relay/state-sf-mini.json` — while we stamped the verifier
for a **fossil** at `…/Projects/AgentWorkforce/relay/.agentworkforce/relay/state-sf-mini.json`,
last written 13:55Z and 2.4× smaller.

**`test -f` returned 0 on the fossil.** The existence check cannot tell a live file from a
dead one. The discriminating check — comparing **UTC** mtimes across every candidate — showed
the three live files were all written within 20 seconds of each other, at the moment their
brokers spawned the probes. **Correlate the file to an event you caused; do not ask whether
it exists.**

**Two agreeing measurements of the same wrong input are not corroboration.** My independent
recomputation matched the lane's exactly, because we both derived from the same bad path.

**And `stat %Sm` prints LOCAL time.** I labelled it `Z` and nearly drew a second wrong
conclusion from it. `barry` is UTC−4, the others UTC+2. Use `date -u -r <file>`.

**The refusal is milder than this document first claimed.** On mismatch the broker is
*refused* and the record is left intact and re-stampable — a broker that will not start, not
a destroyed name. The genuinely unrecoverable case is narrower than "burned".

Verified by authenticated GET per record, not by `list_agents` — **`list_agents`
sanitised the field and made a present value read as absent.** Agent ids:
`chief-broker` `211418990402400256`, `barry` `210867721395138560`, `finn-mini`
`205917852717920256`, `sf-mini` `205920120209797120`.

`chief-broker`'s verified path is
`/Users/khaliqgant/Projects/AgentWorkforce/chief/.agentworkforce/relay/state-chief-broker.json`.
**It stays READY only while its state path, broker name and env stay unchanged.**

### The backfill procedure

Full runbook is in `identity-key-codex-0810`'s report (DM,
`dm_43de4d4acc087e1f1ca2fbb4`, 18:18:21Z). Short form, one node at a time:

1. **Confirm the exact state path ON that node.** Do not derive it from here.
2. Compute `expected = SHA256("node-" + SHA256(exact_path_string))` in memory.
   64 lowercase hex. **Never print it.**
3. `GET /v1/agents/<name>` with the workspace `rk_live_*` key. Match → READY,
   do not PATCH. Absent → step 4. **Present but different → STOP.**
4. `PATCH /v1/agents/<name>` with `{"metadata":{"identity_key":"<expected>"}}`.
   Merges existing metadata, same row, preserves id/token/name. Works while the
   old broker is still running. There is no CLI wrapper for this.
5. `GET` again: HTTP 200, same agent id, exact match, 64 lowercase hex.
6. Only when **every** node is READY, upgrade one at a time preserving cwd,
   state-dir and broker name. **`chief-broker` last.**

**A WRONG `identity_key` is strictly worse than an absent one.** Absent is
recoverable; wrong is not. At 19:45Z I dispatched read-only probes
`idpath-barry-0810`, `idpath-finnmini-0810`, `idpath-sfmini-0810` to report each
exact path, instructed to answer **AMBIGUOUS rather than guess**. If a node comes
back ambiguous, **leave that node on its current version** rather than guessing.
That is a fine outcome.

Leave `RELAY_AGENT_IDENTITY_KEY` **unset** — the broker derives its own. An
explicit env value is inherited by spawned children and is inferior here;
`auth.rs:328-335` deliberately avoids setting it for exactly that reason.

**Correction to the previously recorded premise: the refusal landed in 11.4.2,
not 11.4.3.** `#1470` is an unrelated spawn-brief fix. Identity logic is byte
identical across 11.4.2, 11.4.3 and `origin/main` (`git diff --quiet` exit 0
both ways).

---

## 1. STANDING CONSTRAINTS — these have all been paid for

- **Never restart `chief-broker` casually.** It carries both residents and every
  `--node` placement target on this machine.
- **Never `git stash`** — it reverts every parallel agent's work. **Never check
  out over a shared worktree**; `cloud` alone has 10+.
- **Never list processes with `command` or `args`** — it leaks workspace keys.
  `pid,lstart,comm` or `ps -p <pid>` only.
- **Never print a credential value.** Existence, shape, scope, expiry only.
- **PUBLIC repos:** `relay`, `relaycast`, `relayauth`, `relayfile`, `factory`,
  `relayflows`, `workforce`, `c2a`. **PRIVATE:** `chief`, `cloud`, `sales`.
  Customer name, headcount, auditor date and exploit paths go in `sales` only.
- **No agent merges. Khaliq owns every merge gate.** He granted merge authority
  for `chief` PRs specifically on 2026-08-10; that grant does not generalise.
- **`AgentWorkforce/chief` is squash-only** — merge-commit and rebase-merge are
  disabled at the repo level. **Do not re-enable them.** See §4.

---

## 2. THE INSTRUMENTS LIE. Know exactly how before measuring anything.

**`check_inbox` and `list_dms` are BROKEN** (`relay#1471`). They fail with a raw
SQL error that reads **exactly like an empty inbox**. Never use them.

**`search_messages` has ONE real defect**, not four. Results are ranked by SQLite
FTS5 `bm25()` relevance with **no recency parameter**, and `limit` truncates by
rank — so **every timestamp you read is a floor, never a maximum**. Use
`limit ≥ 25`, sort by `createdAt` yourself, prefer **single common words**.

**Three things previously recorded as defects were RETRACTED** after
`retrieval-lead-0810` red-checked them: single-character queries work; multi-word
is implicit AND and an over-constrained query legitimately returns `[]`; the
`channel` filter is not blind to recent traffic. **A lane came one step from
switching that AND to OR on the strength of my report**, which would have flooded
every query with junk.

**The method error that is not a tool defect:** `{from: <lane>}` measures one side
of a conversation. A blocked lane and a lane deep in unreported work emit the same
nothing. **Also sweep what Chief sent TO a lane, and check what a THIRD agent has
already produced.** Both stewards hit this independently ~100 minutes apart on the
same lane.

**Use `gh` as a second instrument.** A merged PR or a moved branch is work product
that cannot fail silently in the affirmative. Everything genuinely new from the
GitHub-plane steward came this way and was invisible to relay sweeps.

**Roster / `list_agents` / `spawned: true` are not evidence in either direction.**
`{"spawned": true}` is a record write. A duplicate-name spawn on 11.4.2 returns
success and launches nothing. **Only a bracketed nonce round-trip proves
liveness.** Never respawn on a silence measurement — the respawn burns the name.

**Re-send every spawn brief as an individual DM.** Briefs drop on this fleet.

---

## 3. THE STEWARDS ARE YOUR FIRST READ, AHEAD OF DMs

`chief/evidence/steward/state.md` (`steward-0810c`) and
`state-workstream-steward-claude-0810.md`. **They have been more current than any
tool-based sweep of mine for hours.**

Ruled 16:59:33Z, both stay, split by plane: `steward-0810c` owns relay liveness
and nonce probes; `workstream-steward-claude-0810` owns GitHub artifacts and
**ruling-to-artifact tracking** — a Chief decision producing no artifact in a
sensible window is itself an exception. **Neither reports the other's plane; hand
over rather than duplicate.**

They are **differently blind**, not redundant. Each caught the other's error today.

---

## 4. WHAT LANDED TONIGHT

**`chief` PRs, on Khaliq's explicit grant.** Squash-merged to `main`: **#28**
`d4fed15`, **#15** `940d6f7`, **#6** `c87d812`, **#17** `ff6361c`, plus **#29**
and **#31** carrying the brain record.

**`#24` reported `MERGED` but did NOT reach `main`** — its base was
`chief/orgchart-hierarchy`. It landed at `0c3b9cd5` **inside `#25`'s branch**.
**`gh` saying `MERGED` tells you nothing about which base.** Read `baseRefName`.

**Still open, all DIRTY because `main` moved under them** — owned by
`chief-prs-lead-0810`, ordered cheapest first: **#5** (`chief/node-plist-keepalive`,
0 unresolved threads), **#23** (`chief/yc-demo-brain`, 2), **#25**
(`chief/orgchart-hierarchy`, 4, carries #24).

### Why the repo is squash-only now

Khaliq accepted the `opencode.json` credential exposure **bounded to one feature
branch plus clones** — a decided risk acceptance, **do not re-raise it**. Commit
`261db56` carries three literal values; `opencode.json` is **absent from #28's net
diff** because add and delete cancel, so the PR reads clean while the blob is one
`git show` away. **Squash keeps it off `main`; a merge-commit or rebase carries it
onto `main` permanently.** Both were still enabled, making the boundary a
convention rather than a mechanism. Now disabled.

Verified after every merge: `opencode.json` absent from `origin/main`'s tree, and
`261db56` **not reachable** from `origin/main`.

**Rule worth keeping: an accepted risk has a boundary, and the boundary needs a
mechanism.**

---

## 5. OPEN, WITH OWNERS

**Blocked on Khaliq:**
- **`relayfile` credential re-ruling.** Approved shape was read-only, path-scoped,
  expiring, with the hard condition *"never a cloud session on that box"* — and
  **that condition is already false** (`agent-relay cloud session --json` on
  SF-Mac-Mini exits 0). **Nothing has been minted, mounted or logged into.** I
  asked `relayfile-coordination-lead-0810` for the verbatim ruling text at 19:34Z
  rather than paraphrase a credential decision to the principal. When unblocked:
  **prove the scope by a REFUSAL, not a success**, and note the scope gate has a
  session bypass at `relayfile-mount-session.ts:326`.
- **`relay#1465`** — needs a human reviewer. Khaliq said he will merge.
- **herdr T6 vs `herdr#3`** — `7b657a6` deletes `plugins/agent-relay/` unpushed
  while `herdr#3` adds 13 files into it. OPEN, `check-contributor` FAILING.
- **`sage-nightcto`** park-or-run.

**Ruled today, now unblocked:**
- **Daytona: B approved.** Adopt `provisionFleetSandboxNode()`
  (`packages/web/lib/fleet/sandbox-bridge.ts:464`) — complete, tested, **zero
  production callers**. Retire path C. **The missing caller IS the work.**
- **The Daytona credential blocker was mine and was wrong.** I checked `env` in my
  own agent process; B runs in the **cloud web worker**. `daytonaApiKey` is an SST
  secret (`infra/secrets.ts:64`) **linked into web-worker** (`infra/web-worker.ts:53,478`).
  **No credential gate exists.** A measurement that cannot distinguish your
  hypotheses is not evidence.
- **CRE/preq: guess authorised.** Khaliq supplied the 7 Aug source and ruled *"he
  just wants templates so let's take best guess for him."* See
  `workstreams/agent-lifecycle-workflows.md`.

**Unowned:** `relaycast#319`'s empty-`?workspace=` truthiness guard, now in
production. Calibrate **down** — single-tenant only, card public by design. A
contract defect, not a disclosure.

**Unresolved:** `google-mail` still returned HTTP 500 on a live authenticated read
at 18:36Z despite `cloud#2951` being merged and deployed. The full-scope bearer is
**VALID**; the failure was a stale narrow `fs:read:*` cache entry plus
`AGENT_RELAY_BIN` pointing at the broker binary.

---

## 6. WHY THINGS BREAK HERE — one defect class, many costumes

**A well-formed signal standing in for a fact nobody verified.**

A spawn returning `{spawned:true}` and launching nothing. A heartbeat written by a
timer rather than by progress. A status field reading healthy over a dead queue.
An empty search result indistinguishable from a broken query. `list_agents`
sanitising a field so absence read as absence. A question delivered, injected and
**read**, then never answered — with the reader as the failed component.

**Corollaries earned today:**
- A search miss is not absence. An absent key is not an empty store.
- Unresolved counts **unanswered**, not unfixed. Read the code before reporting a count.
- A number older than the current pass is not a measurement, it is a memory.
- A decision that arrives after its executor is dismissed has no executor.
- Draft suppresses review; it is not a merge guard.
- The author describes the commits; GitHub renders the diff.
- Check the instrument separates your hypotheses **before** buying the run.

---

## 7. CONVENTIONS IN FORCE

**`BLOCKED ON CHIEF: <question>`** as the literal first line, one question per
line, what you will do absent a ruling, and what it costs to stay blocked.
**Re-send after 60 minutes — chasing Chief is the protocol.** Close with
`UNBLOCKED: <question> — ruled <what>, proceeding.`

This is a human workaround for a protocol gap. `c2a#3` and `relay#1474` are the
real fix, owned by `obligation-lead-0810`. **The load-bearing decision: an
obligation is discharged when the SENDER confirms it was answered** — not on read,
not on a timer, not on the recipient's belief that it replied. **The negative test
is the deliverable:** delivered, injected, READ and unanswered **must** still
return, and that test must fail before the change.

**Before a restart, every lane is told:** push branches, move findings out of
scratchpads and DMs into GitHub issues or `chief/evidence/`, return
STATE / WHERE IT LIVES / NEXT. **Scratchpads and DMs do not survive.** Four
finished deliverables were recovered from scratchpads today by luck.
