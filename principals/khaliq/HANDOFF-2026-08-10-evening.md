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

| node | broker | `identity_key` | state |
|---|---|---|---|
| `chief-broker` | 11.4.2 | **PRESENT**, exact match | **READY** |
| `barry` | 11.3.1 | ABSENT | needs backfill |
| `finn-mini` | 11.4.0 | ABSENT | needs backfill |
| `sf-mini` | 11.1.1 | ABSENT | needs backfill |

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
