# Open threads

- **CORRECTION 2026-08-07, and it retracts most of what this file said this
  morning: there are THREE agent-registration paths, and the 11.4.2 admission
  gate covers only one.** Established by `relay-name-reclaim-lead` reading the
  live workspace and the source, after Chief spent the morning unable to explain
  why `chief` was stranded while `chief-khaliq` reclaimed twice. They were never
  running the same code.
  1. **Broker self-registration** (what `chief` used) — Rust `AuthClient` → POST
     `/v1/agents` → 409 → `admit_agent_registration`, `crates/broker/src/relaycast/auth.rs:959`.
     **Gated** on `identity_key`. Records show `type=human`, empty metadata.
  2. **Broker-spawned worker** (what `chief-khaliq` and `marketing-lead` used) —
     node-control `agent.register` → `registerAgentViaNode`,
     `packages/engine/src/engine/node.ts:1118`. A server-side
     `onConflictDoUpdate` on `(workspace_id, name)` that overwrites `tokenHash`
     with `setWhere = status != 'active' OR locationNodeId == this node`. The node
     id was unchanged across the restart, so it matched. **Never touched the gate
     and never needed an identity key.** Records carry `metadata.fleet.nodeId`
     and a `registeredAt` stamp — that stamp *is* the reclaim.
  3. **SDK fallback** — `registerOrRotate` → 409 → get + `rotateToken`.
     **Ungated; the name alone suffices.**
  The populations separate perfectly by path, so the earlier "same gate, opposite
  outcomes" framing was a category error: it compared a path-1 record to a path-2
  record and read the difference as a gate decision.
  **Consequences.** `chief-khaliq` is *not* "one hard kill from a burned name" —
  that claim is withdrawn; it reclaims through path 2's server-enforced node
  proof. And the backfill fix is narrow (~4 path-1 records), not a fleet
  migration. Note also that path 2's `setWhere` already ships the exact
  `status != 'active'` trap the reclaim brief warns against.

- **Agent-identity work is filed as six issues, 2026-08-07, none labelled for
  dispatch.** By `relay-name-reclaim-lead`, from
  `docs/brief-agent-name-reclaim-20260807.md`. Nothing implemented.
  - **A — relaycast#309** — freeing a name requires deleting history, and the
    delete is refused for any agent that has ever spoken. **Land this first.**
  - **B — relay#1452** — the gate has no migration path. **Sequencing decided:
    land A, release the stranded name, let the create branch stamp on the next
    honest restart, and hold adopt-and-stamp** until A is in and the legacy
    population is characterized. The lead argued its own briefed fix *down* after
    measuring, and was right: a legacy record carries no ownership proof at all,
    so adoption can only infer ownership from absence — the weakest possible
    basis for touching the boundary that stops AR-448.
    **The legacy population is 226 of 864**, not the ~4 the brief assumed and
    not the "~4" Chief repeated in its own ruling after being told otherwise.
  - **C — relay#1451** — `node up` spawns `AGENT_RELAY_BIN` unvalidated. The
    briefed fix was insufficient: routing through the resolver still returns the
    CLI, because the override branch only does `existsSync` and never checks the
    binary is a broker. The right predicate already sits unused at
    `cli/lib/broker-lifecycle.ts:755`.
  - **D — relaycast#311** — SDK `registerOrRotate` hands over any agent's
    identity on name alone, reachable from the MCP `register_agent` tool, while
    the CLI's `agent register`/`agent add` hard-409. That inconsistency is part
    of the finding, not noise.
  - **E — relaycast#310** — the PATCH hole below.
  - **F — relaycast#312** — `GET /v1/agents` reports every live agent as
    `unknown` while the column holds `active`. **Not cosmetic:** an engineer
    verifying a guard through the API sees no agent ever active, concludes the
    disjunct is always true, and concludes the boundary is open. Chief and the
    lead ran exactly that chain and were one message from escalating a false
    security finding. A field that reads one way to SQL and another to every
    consumer is a trap aimed at whoever is trying to verify a security property.
  **Still open:** is `sweepStaleAgents` actually invoked today? It decides
  whether path 2's protection is a five-minute window (it flips `active` →
  `offline` after `STALE_THRESHOLD_MS`, and once flipped the node-identity
  requirement evaporates) or permanent. Chief's 08-06 note says the sweep has had
  no caller since the Cloudflare migration and relaycast#306 is still unmerged —
  if that holds, the window does not exist and `offline` is sediment.

- **The admission gate is a coordination gate, not a security boundary — and one
  live hole makes that concrete.** `PATCH /v1/agents/:name`
  (`relaycast packages/engine/src/routes/agent.ts:291`) requires only
  `requireWorkspaceKey` and shallow-merges arbitrary metadata onto **any** agent,
  so a key holder can write `identityKey` today and then reclaim through the
  gate. `POST /agents/:name/rotate-token` (`routes/workspace.ts:415`) is likewise
  workspace-key-only. **This is not theoretical here:** the workspace key is
  passed in broker `pty` argv and readable by any local process via `ps` — the
  same leak flagged for rotation below and reconfirmed twice today. Key from
  `ps` → PATCH an identity onto any agent → reclaim it. **Rotation does not close
  this while argv exposure stands.** Chief described that gate as a security
  boundary all day; it is not. Being filed by the lead.
  *Also falsified:* relay#1436 was carried here as the threat to the gate. It is
  not — `registerOrRotate` drops metadata entirely on the conflict branch, so
  #1436's metadata only lands on create. It is open, checks green, not near
  merge, and not the risk.

- **The org hierarchy lives on one laptop, and three gaps are now filed.**
  Khaliq asked for initiatives/epics/projects organized and visible, and for it
  to be managed from Cloud and trickle down to local. Measured 2026-08-07, it is
  the reverse and there is nothing hosted to trickle from:
  - **Cloud has no org primitive at all** — `grep -r reportsTo cloud/packages`
    returns zero. The whole declared structure is `chief/tools/orgchart/org.json`
    on this machine. → **cloud#2949**, filed, unlabelled.
  - **Linear's hierarchy does not reach Chief** — 0 of 234 issues carry a
    `project_id`, `parent_id`, `cycle_id` or `milestone_id`; the fields are absent
    from the record, not null. 17 projects and 10 milestones are projected with
    nothing linking to them, and initiatives/cycles are not projected at all. So
    no consumer can roll Linear work up by project today. → **relayfile#403**.
  - **`fleet nodes` returns a non-deterministic subset, and a healthy node can
    swallow a spawn silently.** `finn-mini` returned `pending` and never
    dispatched while heartbeating and advertising `spawn:codex`; `barry` returned
    `dispatched` and the agent was up in 20s. Chased further, the enumeration
    itself proved unreliable — a node omitted from one response is present in the
    next, with no offline state ever reported. **Corrected: nothing "died" today.
    finn-mini and sf-mini were both omissions, not state changes**, and the two
    "node is down" conclusions Chief drew, plus the corrections to them, were all
    wrong. There is also no CLI surface to inspect an invocation afterwards.
    → **relay#1448**, with the enumeration measurement as the root-cause
    candidate for the silent `pending`.
  Khaliq's call 2026-08-07: **file, do not build.** `org.json` stays the system of
  record and the local orgchart tool renders it until he sequences the Cloud work.
  Chief's own view of all this is `scratchpad/org-board.html`, unpublished.

- **Partnerships is a new org unit, and Herdr is its first seat.**
  Added to `tools/orgchart/org.json` 2026-08-07 on Khaliq's instruction:
  `partnerships` (unseated department, reports to `chief-khaliq`) with
  `herdr-lead` under it. `herdr-lead` is live on fleet node **barry** (codex,
  id `211430740238159872`), deliberately off Khaliq's laptop, owning
  `workstreams/herdr-fleet-surface.md`.
  **Its brief was hand-carried as three DMs, and that is a defect, not a
  delivery.** barry has no copy of the brain, so a placed agent cannot read its
  own workstream — which is precisely T7 in that workstream ("place an agent on a
  mini and have it work in a live-mounted tree with nothing cloned" is documented
  nowhere). The lead was told to treat T7 as load-bearing for that reason. Until
  a mount reaches the fleet nodes, every remote appointment costs a manual
  context transfer and leaves no durable brief.

- **NEW 2026-08-07, and it is the one that threatens continuity: the resident's
  canonical name can be permanently burned by an unclean shutdown.** On broker
  11.4.2 the fail-closed admission gate refuses to re-register a name it cannot
  prove ownership of. The broker flushes state on SIGTERM but does **not**
  deregister its own name, and the reclaim key is minted at first registration
  and never persisted locally — so a stranded name is unrecoverable, and
  `agent-relay agent remove` refuses server-side once the agent has history.
  This already happened: the node's name `chief` is burned (record frozen at
  `lastSeen` 09:05:32Z) and the node now runs as **`chief-broker`**.
  **Why it matters beyond cosmetics:** CLAUDE.md §7 makes the canonical
  `teams.json` name the definition of Chief's continuity — "if the canonical
  name cannot be reacquired, keep the existing resident online and page the
  principal." A burn makes reacquisition *impossible*, not merely hard. So far
  spawned agents (`chief-khaliq`, `marketing-lead`) have been reclaimed
  successfully where the broker's own name was not, and nobody knows why that
  asymmetry exists — which means nobody can say `chief-khaliq` is safe.
  **Mitigation in place, and it is partial.** A wrapper at
  `~/.agentworkforce/relay/bin/chief-node-supervisor.sh` is now launchd's
  `program`; it traps SIGTERM/SIGINT and runs `agent-relay node down` for a
  clean release, which makes unload/reload repeatable. A SIGKILL, a panic, or a
  power loss bypasses the trap entirely. **The durable fix is platform-side:
  persist the reclaim key, or let a node deregister its own name on shutdown.**
  Not authored by this Chief — it appeared while the resident was down; see the
  second-writer thread below.

- **RESOLVED 2026-08-07: the impersonation path is closed, verified by probe
  rather than by release notes.** The thread below feared that a process
  registering an existing name would be handed the incumbent's address, inbox,
  and token. Directly tested on the running 11.4.2 broker with a throwaway name:
  the second registration returns `Agent "…" already exists in this workspace`,
  exits without a token, and leaves the incumbent untouched. The registration
  path fails closed. (Probe agent removed afterwards.) The cost of that
  hardening is the burned-name thread above — the same gate, seen from the other
  side.

- **RESOLVED 2026-08-07: the broker version drift is fixed and `relay-version`
  is green.** `BROKER_BINARY_PATH` in the launchd job's `EnvironmentVariables`
  is checked before the `node_modules` candidates, so the running broker is
  finally 11.4.2 instead of the shadowed transitive 10.6.7. All thirteen doctor
  checks now read OK — the first fully green doctor with no ERROR line. The
  underlying shadowing is unchanged: a version floor on the transitive
  `@agent-relay/fleet` is still the durable fix, and the pin is a per-machine
  workaround that a fresh clone will not inherit.

- **PARTIALLY ANSWERED 2026-08-07: a node rename preserves node id and history.**
  `chief` → `chief-broker` kept `node_5b46ac5e9f427fcedc07f77f95f642eb`, its
  2026-07-30 `createdAt`, and all 61 attributed agents. So the long-open question
  "does `--broker-name` orphan the node?" is answered **no — for an unused
  name**. It does *not* answer the `kjg-laptop` case, which is the hard one
  precisely because that name already owns a different node id
  (`node_210851746276208640`). Renaming onto a free name and merging onto an
  occupied one are different operations, and only the first is now evidenced.
  What a rename *does* cost is the old Relaycast name, permanently — see above.

- **RESOLVED 2026-08-07: v11.4.2 ships the admission gate.** Khaliq triggered
  the publish; the release completed 08:51:15Z and both `b4b96dfb3` and
  `5c2ad8ee3` are confirmed ancestors of the `v11.4.2` tag. Upgrading this
  machine and restarting the node closes the impersonation path described below.
  **Trap that nearly cost a wasted restart:**
  `~/.agentworkforce/relay/update-cache.json` served `latestVersion: 11.4.1`
  from a check at 07:55Z, an hour before the release. `agent-relay update` would
  have installed 11.4.1 — without the gate. Delete that cache before trusting
  `update --check` after any release.

- **The broker-side name-collision gate is absent from every released CLI, and
  Chief runs a released CLI.** `crates/broker/src/relaycast/auth.rs` — the whole
  admission gate — does not exist in the v11.4.1 tree; it is `main`-only, via
  `b4b96dfb3` and `5c2ad8ee3`, both dated after v11.4.1 was tagged
  (2026-08-03). Chief's node runs 11.4.0. Without the gate the pre-existing
  behaviour applies: re-registering a name that already exists in the workspace
  hands over the incumbent's agent. **So a process on this workspace registering
  as `chief-khaliq` would be given Chief's address, inbox, and token.**
  *Not yet verified:* whether Relaycast rejects this server-side independently
  of the broker. Until someone proves it does, treat the path as open — this is
  a fail-closed question and absence of proof is not coverage.
  Resolution is one action that unblocks three things: **cut a release
  containing `b4b96dfb3` and `5c2ad8ee3`.** It closes this path, unblocks
  AR-448's live stop/start proof, and hardens the `kjg-laptop` rename restart.
  Khaliq's call; Chief recommended against running untagged `main` on the host
  that carries the resident.

- **SUPERSEDED 2026-08-07: the drift was never CLI-vs-CLI, it is CLI-vs-broker,
  and upgrading the CLI cannot fix it.** The old entry here blamed two installed
  CLIs (mise shim 11.2.0 vs `~/.local/bin` 11.4.0). Both paths now resolve to
  **11.4.2** and `relay-version` is *still* the doctor's only ERROR, which
  falsifies that diagnosis. The real cause: the node runs with
  `WorkingDirectory=…/AgentWorkforce/chief`, so `agent-relay node up` resolves
  the broker out of this repo's `node_modules` — the running broker is
  `chief/node_modules/@agent-relay/broker-darwin-arm64/bin/agent-relay-broker` at
  **10.6.7**, while the managed binary at `~/.agentworkforce/relay/bin` is
  11.4.2. It arrives transitively and nothing in this repo asks for it:
  `agentworkforce@4.1.37 → @agentworkforce/cli → @agentworkforce/local-surface →
  @agent-relay/fleet@10.6.7 → @agent-relay/harness-driver → broker-darwin-arm64`.
  **Consequence: every `agent-relay update` on this host upgrades a broker that
  never runs.** The 11.4.2 upgrade did exactly that, which is why the admission
  gate was absent from the restart it was cut for. The doctor already prints
  `brokerBinary` naming the node_modules path; it was read as drift rather than
  as the answer. Fix is a version floor on the transitive `@agent-relay/fleet`,
  or launching the node from a directory that does not shadow the managed
  binary. Khaliq's call which.

- **This machine carries two node identities, and the rename is a merge, not a
  relabel.** Found 2026-08-07 while preparing the rename restart:
  `chief` / `node_5b46ac5e9f427fcedc07f77f95f642eb` — created 07-30, online, 61
  agents attributed — and `kjg-laptop` / `node_210851746276208640` — created
  2026-08-05T20:09:33Z, offline, last heartbeat 07:49:54Z on 08-07. The
  machine-global `~/.agentworkforce/relay/fleet-enrollments.json` is keyed by
  `relaycastUrl#workspaceId` (**not** by node name) and its single record claims
  this machine is `kjg-laptop`/`node_210851746276208640`. The running broker
  nonetheless reports the `chief` id, so `node up` is not honouring that
  enrollment — which is itself unexplained. Consequence: `--broker-name
  kjg-laptop` has three possible outcomes (rename the `chief` record, adopt the
  enrolled id and orphan 61 agents, or mint a third), and nobody knows which.
  Khaliq held the rename on that basis. **Answer which id wins before reusing the
  name**, and find out where `node_5b46ac5e…` is persisted — it is in no local
  state file, only in worker logs, so it appears to be server-assigned.

- **The `kjg-laptop` rename was written to the plist and never took effect.**
  Verified 2026-08-07 after the restart: the plist on disk carries
  `--broker-name kjg-laptop`, but `launchctl print
  gui/501/com.agentworkforce.chief.node` shows the loaded job's `arguments` are
  still `{agent-relay, node, up}`, and `fleet status` still reports name `chief`.
  The job was never unloaded and reloaded, so launchd kept the definition it had
  at load time. **Editing a plist is not applying it** —
  `launchctl bootout` + `bootstrap` (or `kickstart -k`) is. Still open, and the
  open question below (does a rename preserve node id and its agent history?) is
  still unanswered, because the restart that was supposed to answer it ran the
  old arguments.

- **Original entry — this machine's fleet node is renaming to `kjg-laptop`
  (Khaliq, 2026-08-07).**
  It currently appears as `chief` only because `com.agentworkforce.chief.node.plist`
  runs plain `agent-relay node up` from `WorkingDirectory=…/AgentWorkforce/chief`,
  and the node name defaults to the project directory basename — verified against
  the installed 11.4.0 binary's `--broker-name <name>` help text. So the node is
  named after a folder, not a role, and the org chart's `chief-khaliq → chief`
  attribution works only by that coincidence. Held pending the release decision,
  because the restart is when the missing admission gate would be exercised.
  *Open question to answer at restart, not by reasoning:* whether the rename
  preserves node id `node_5b46ac5e…` and the 60 agents of history attributed to
  it. `node.ts` reads `options.brokerName ?? enrolledNodeName`, which suggests
  enrollment carries identity and the name is metadata over it — but confirm it.
- **There is no working agent credential revocation on installed relay 11.2.0
  (2026-08-06).** Both paths fail. MCP `remove_agent` with `delete_agent: true`
  returns `dispatched` and only releases the *process* — the record and token
  survive, and a released agent still read `status=active` eleven minutes
  later. `agent-relay agent remove <name>` fails server-side on every seat
  tried with `Failed query: delete from "agents" where "agents"."id" = ?`,
  hypothesised (unverified) as a foreign-key constraint from message and
  presence history. One seat, `cloud-chief-command-deck-designer`, *is* absent
  from the roster after the same call that failed for six others — unexplained
  and worth explaining, since it is either the one thing that worked or a
  different mechanism. Consequence: any policy requiring completed
  revoke/rotate before release is currently unsatisfiable — revoke fails on a
  constraint and rotate re-exposes through #1389. `relay-credential-invalidation-revoke-lead`
  owns finding a real path; the target is a **minimal token-invalidate
  operation that keeps historical records**, never hard deletion.
- **finn-mini and barry both fail to run spawned agents while reporting
  healthy (2026-08-06).** Four lanes lost: three on finn-mini with messages
  stacking unconsumed, one on barry where the queue drained and nothing ran.
  Both nodes advertise `online / live / handlers=true`. Node health is
  self-reported and attests to nothing about whether dispatched work executes.
  Investigate before trusting either machine with work again; the same claude
  CLI ran correctly on `chief`, `kjg-laptop`, and `sf-mini` in the same window,
  so it is the nodes and not the runtime.

- **The delegation gate is a library with no production caller (chief#24).**
  48 tests, name normalization, lead-before-fan-out, node pinning, rollup
  aggregation — all enforced *in the lib*, and nothing in the chief repo calls
  it, because dispatch happens when Chief-the-agent invokes the relay spawn
  tool rather than through a code path. **A library nobody calls is a
  convention with tests**, which is the defect the project existed to fix, one
  level up. The lead conceded this against its own delivered work. Sequence
  decided: Chief's operating doctrine mandates calling the gate before any
  spawn (a convention, honestly labelled, and Chief *is* the caller), then the
  enforcement point moves into the relay spawn path — the real fix, in the
  lineage relay#1436 opened, after the demo. The PR body must state the
  limitation so a future reader does not read 48 green tests as enforcement.
- **"What makes something a Chief" is undefined in the data (2026-08-06).**
  Two agents hit this independently from opposite ends. `CHIEF_SEGMENT`
  (delimited "chief" in a deployed name or persona id) matches **zero** of 18
  live deployments, so the shipped dashboard shows "Chiefs: 0".
  `HOSTED_CHIEF_PERSONAS` matches exactly one — `cloud-factory-brain`, active,
  9 runs — which Cloud's own record describes as routing approved Linear and
  GitHub issues into the hosted Factory without merging or releasing. That is a
  dispatcher, not a coordination layer. The danger is not the stat:
  `isChiefDeployment` also feeds the lead tier, so the same predicate can put a
  crown on that dispatcher and assert accountability that does not exist.
  **This is a gap in convention, not in the data model** — corrected after an
  initial, stronger claim that no structural field existed. `personas.intent`
  is a real indexed column (`schema.ts:137`, `idx_personas_intent`,
  `drizzle/0041`), and the deployments route already joins personas
  (`route.ts:1036`), so exposing it is one line and no migration. Its live
  values are `relay-orchestrator`, `review`, `cloud-sandbox-infra` — **nobody
  has minted an `intent: "chief"`**. So the durable fix is small and additive,
  and the real decision is a product one: what earns that value. `deploymentRole`
  was still correctly deleted, because the real path does not run through it.
  Standing rule until then: nothing earns a crown, and a lead tier that cannot
  resolve an accountable lead from structural data shows no lead.
- **The Cloud fleet APIs cannot be verified before they ship.**
  `/api/v1/fleet/agents` 404s in production because the route ships in the PR
  that adds it, and `/api/v1/fleet/nodes` 403s because both routes require a
  session cookie while the CLI bearer token is rejected. With browser
  automation unavailable, fleet capacity, the hierarchy, and readable names are
  not production-verifiable pre-merge by any method — only post-deploy. Any
  "verified 100%" condition on those items is unsatisfiable as literally
  worded; it needs an explicit post-deploy check with a named rollback trigger.
- **Factory run totals disagree and neither is substantiated.** A supervising
  probe reported 87 runs; the delivery lead counted 50 against the same
  production API. The payload exposes no cursor, so 50 is likely a capped
  recent window rather than a total. Unresolved — do not display a run total
  anywhere until it is.

- **Identity metadata can be written today; only the atomic spawn write is
  missing (2026-08-06).** Chief first reported this as "the platform has no
  typed metadata" — wrong, and corrected by
  `chief-delegation-governance-dispatch-lead`. `CreateAgentRequest.metadata`
  and `UpdateAgentRequest.metadata` exist in the relay SDK, are normalized on
  read, and are exposed through `register_agent`; 451 of 745 workspace agents
  already carry metadata, and the fleet spawn path itself writes
  `metadata.fleet`. The actual gap is that the **fleet spawn action schema does
  not forward identity fields** and `add_agent` forwards only `{model}`, so
  identity cannot be written *atomically at spawn*. Design: Chief writes it as
  a mandatory second step that **fails closed** — if the write fails, abort and
  reap the worker rather than leave it running unattributed — with a phase-2
  relay PR adding passthrough. Canonical keys are `organization`, `project`,
  `workstream`, `role`, plus `reportsTo` and source/run IDs; the consumer
  (`packages/web/lib/fleet/agents.ts`) also accepts camelCase, snake_case,
  `org`, `repo`/`repository`, and `task*` variants, but producers write the
  canonical form only.
- **Rotating a credential while `register_agent` still leaks it contains
  nothing (2026-08-06).** The replacement re-enters the transcript at the next
  registration, which metadata writes and recovery both require — so
  rotate-then-continue is self-defeating, and so is "rotate after smoke" for
  any seat that keeps running. The only sequences that actually contain are:
  rotate at seat retirement, rotate with out-of-band delivery, or fix relay
  **#1389** first. That issue is the exact match — `register_agent` returns the
  live agent token in its reply, on a mandatory call — and it already records a
  prior instance from 2026-07-30 with rotation requested. Related open issues:
  #1379 (argv/logs/JSON), #1409 (redaction gaps), #1370 (CLI prints secrets),
  #1059 (secrets in agent shell env). **Do not open a sixth**; add instances as
  comments so the record stays in one place. Known-good pattern worth copying:
  pipe the token into `curl --config -` on stdin so it never reaches argv and
  cannot appear in `ps`.
- **The workspace key leaked into this transcript again (2026-08-06).**
  `agent-relay node status` printed `rk_live_…` twice — as `Workspace Key` and
  inside the observer URL — on installed CLI 11.2.0. Relay PR #1405 addresses
  the observer link; this is the plain status path on an older binary. Add to
  the standing rotation batch and prefer `--json | jq` over bare `node status`.

- **Chief was handed a program on Khaliq's authority, relayed by an agent, and
  is holding.** `sage-nightcto-factory-map-20260731` asked Chief to own the
  Sage/NightCTO distributed-Factory program and relayed a fleet topology (Cloud
  control plane, Mac mini execution nodes). Its verifiable claims check out, but
  an agent asserting "Khaliq explicitly directs" is not the same as Khaliq
  saying so, and this commits fleet-wide execution. Chief recorded the map
  (`workstreams/sage-nightcto-factory-program.md`) and dispatches nothing until
  Khaliq confirms directly. Trigger: ask him at the next exchange.
- **The hosted Factory brain has no contract configured at all.**
  `cloud-factory-brain` returns empty `inputValues` and `inputSpecs`, so
  `spec.capabilities.factoryBrain.triage` has no `repoByLabel` or `defaultRepo`.
  Hosted dispatch worked because Chief's hardcoded Linear defaults filled the
  gap; removing them exposed it. This blocks any gated workload, Sage and
  NightCTO included.

- **Chief-owned Factory contract cutover merged in chief#10.** Factory resolves
  one explicit contract, with no target-repository or clone-root search. The
  active `<chief>/factory.config.json` is generated from the committed
  `factory.<principal>.config.json` variant and routes `chief`, `cloud`,
  `factory`, `hoopsheet`, `pear`, `relay`, `relayfile`, and `workforce` through
  its GitHub-native `factory` label gate with `mergePolicy: never`. Legacy
  per-repo contracts are not fallback layers; their coordinated removal remains
  AgentWorkforce/chief#11.

- Verify `agent-relay node up` resolves the configured Cloud workspace after a
  full stop/start and preserves Chief's durable address.
- **RESOLVED 2026-08-07: RelayAuth mints again and the #2857 gate no longer
  exists.** For five days this was recorded as the single blocker behind the
  AR-448 checkpoint, Factory control, and the Sage program's item 1, all waiting
  on a "gated #2857 D1 capacity recovery needing Khaliq's explicit grant."
  Neither half survived contact: cloud#2857 was closed `NOT_PLANNED` on
  2026-08-04, so the grant Chief was holding for could never have been given;
  and the doctor is fully green this morning — mount running, credential
  refreshed 2026-08-07T07:51:49Z, all three integrations `ready`, hosted Factory
  brain active with a fresh heartbeat. The senses projection last refreshed
  2026-08-05T23:57Z, so reads are live rather than the 07-31 snapshot.
  **Lesson, and it is the expensive one:** Chief carried a blocker for five days
  without re-testing it, and carried an authorization gate for an issue that had
  been closed for three. A blocker is a claim about the present; re-verify it on
  every session start, or it becomes a reason not to work.
  Now unblocked and unowned: the AR-448 Linear checkpoint (needs the rewrite
  already decided on 08-04 — the lineage decision, not the stale "PR opened"
  body), and Factory writeback generally.
- **Senses reconcile is unreliable, in two distinct ways (2026-08-05).**
  First, DNS to the file host flaps: mounts fail with `dial tcp: lookup
  file.agentrelay.com: no such host` while `curl` resolves it from the same
  machine. A launchd kickstart
  (`launchctl kickstart -k gui/501/com.agentworkforce.chief.senses`) buys a
  clean reconcile and does not hold — linear was failing again five minutes
  after one, while digests kept succeeding. Nobody owns this yet; it is below
  Relayfile, in the host's resolution.
  Second, **`/github` cannot reconcile at all** and is the harder failure. It
  dies on cursor resolution with `context deadline exceeded`, from a fresh
  process as readily as the resident one, so it is not the DNS fault. Last
  successful reconcile 2026-08-05T01:42:48Z. Its outbox holds 77 pending
  commands dating to 07-31 plus one failed on `superseded by newer local
  content` — plausibly a backlog too large to drain inside the deadline, which
  would make it self-sustaining. **Read every GitHub fact live via `gh`, never
  from `senses/github/`, until this clears.**
  Chief's half is done: the doctor now checks per-scope freshness (chief#17).
- GitHub integration health resolved on its own: both installations read
  `ready` with events through 2026-08-03, and the doctor no longer reports
  `syncHealthy:false`. Nothing was done to fix it, so if it recurs, treat the
  earlier degradation as intermittent rather than newly broken.
- Deploy the Cloud Factory brain persona, enable its reversible production
  flag, and prove one canary Linear issue reaches a GitHub-side agent run.
- Connect Khaliq's and Will's Chiefs in the same Relay workspace once Will's
  resident agent name is known.
- **Credential rotation batch (inherited from Will's 07-29 profile, still
  open).** Three live secrets were exposed and rotating them alone is not
  enough because the next boot re-leaks the new values: the broker API key
  (`br_…`, leaked by a raw `env` dump), and the workspace key (`rk_live_…`)
  plus agent token (`at_live_…`), which are passed in broker/claude process
  argv — world-readable via `ps` — and printed in plaintext into
  `~/Library/Logs/chief-node.log`. Needs a relay platform fix (pass secrets
  via env or file instead of `--mcp-config` argv, redact key values from
  node/broker logs) filed as an issue, then rotation. Owner: Khaliq's
  decision on whether this Chief files it or Will's already has.
  **Add one more, 2026-08-04:** a Cloud access token (`cld_at_…`, expiring
  2026-08-04T10:01:55Z) was printed into the resident session transcript by
  Chief running `agent-relay cloud session --json` while diagnosing the
  `--reveal-token` failure. Short-lived and now expired, but the transcript is
  persisted, and the refresh token behind it lives until 2026-11-01.
  `agent-relay cloud login` again to rotate. The general rule stands and Chief
  broke it: never run a command that prints a credential — on 11.2.0 plain
  `--json` is exactly such a command, which is why the mask exists in 11.4.0.
  **Broke it again 2026-08-07, and the values are current.** Chief ran
  `ps -eo pid,lstart,command` while diagnosing the restart and the broker's `pty`
  argv dumped the live workspace key (`rk_live_…`) and both agent tokens
  (`at_live_…` for `chief-khaliq` and `marketing-lead`) into the resident
  transcript in plaintext. These are the *post-restart* values, so they are live,
  not expired like the `cld_at_` above. Flagged for rotation.
  Two lessons, both cheap: a redaction rule that only covers commands *named*
  after credentials misses `ps`, and this is the third channel (argv, node log,
  observer link) to leak the same key — **the argv fix is the one that closes all
  of them**, so prioritise it over rotation, which alone just re-leaks at the
  next spawn. Until it lands, treat any full process listing as a credential
  dump: filter to `pid,lstart,comm` and never include `command`/`args`.
- **Will's Chief needs its `brainRoot` repointed.** His brain moved from the
  repo root to `principals/will/` on 2026-07-30 (Khaliq's call). Nothing in
  this repo referenced the old paths — skills and scripts are all
  `<brainRoot>`-relative — but if Will's resident runs from its own config, that
  config still points at the root and must be updated before it writes again.
- **A second writer is active in this repo, and it now changes production
  behaviour.** Earlier instances were tooling only (`scripts/factory-control.mjs`,
  `.claude/settings.json`, `scripts/chief-doctor.mjs`). On 2026-08-07, while the
  resident was down for the restart, that writer authored
  `~/.agentworkforce/relay/bin/chief-node-supervisor.sh`, made it launchd's
  `program`, chose the node's new name `chief-broker`, and diagnosed the burned
  name — all changes to how Chief boots, none of them recorded in the brain
  until this entry. The work looks correct and the write-up in the script's own
  header is better than most; the problem is that the durable record depended on
  a later session reading a shell script in a bin directory. §7 assumes one
  writer for exactly this reason. **Confirm with Khaliq who owns that shell**,
  and require any boot-path change to land in the brain rather than only on
  disk.
- **Relay MCP server times out at Chief's spawn.** Root-caused 2026-07-30: the
  broker does pass a correct inline `--mcp-config` declaring an `agent-relay`
  stdio server, but it launches as `npx -y agent-relay mcp`, and the launch
  exceeded Claude Code's 30s MCP connect timeout, so the resident session came
  up with no relay tools at all — no `send_dm`, `post_message`, or
  `check_inbox`. Chief can then only answer whoever is attached to its PTY, and
  Chief-to-Chief contact with Will's resident is impossible. Evidence:
  `~/Library/Caches/claude-cli-nodejs/-Users-khaliqgant-Projects-AgentWorkforce-chief/mcp-logs-agent-relay/`.
  Fix in relay: spawn the installed binary (`~/.agentworkforce/relay/bin/agent-relay`
  or the PATH entry) instead of paying npx package resolution on every spawn,
  and/or raise the connect timeout. Secondary: `.claude/settings.json` allows
  `mcp__relaycast__*`, not `mcp__agent-relay__*` — confirm which server name is
  canonical. **Intermittent, not constant (2026-08-05):** this session came up
  with the full `mcp__agent-relay__*` toolset working, so the timeout is a race
  the resident sometimes wins. Do not treat missing relay tools as the settled
  state; check before concluding Chief is mute.
- **`broker` is not a registered agent, so Chief cannot DM it.** Every
  `send_dm` to `broker` fails with `Agent "broker" not found`, and three
  separate workers hit the same wall on 2026-08-04 before falling back to
  `#general`. The broker spawns residents and hands them a task, but it does
  not hold a Relaycast identity that can receive replies. **Post
  broker-directed status to `#general`**, which is now the documented fallback
  the whole team uses. Worth a relay-side fix so spawn instructions name a
  reachable address.
- **AR-448 was implemented twice and both PRs are open.** Relay #1402
  (`feat/ar-448-…`, khaliqgant, +959) and #1403 (`feature/ar-448-…`, kjgbot,
  +522) are independent implementations of the same issue, and both edit
  `packages/cli/src/cli/commands/workspace.ts` and its test, so they cannot
  both merge cleanly. #1402 goes wider (broker lifecycle plus a cloud
  convergence test); #1403 ships a `specs/durable-workspace-identity.md` and a
  separate `durable-workspace-identity` lib. The two neighbouring relay PRs in
  the same code have since resolved on their own: **#1413 merged 08-02** (Will,
  Cloud workspace IDs discoverable from the CLI) and **#1412 was closed**
  (Will, one broker-workspace precedence ladder). Khaliq picks one AR-448
  lineage. **Root cause established 2026-07-31**, with the chain
  evidenced end to end: Factory dispatched AR-448 at 22:56 and recorded the
  claim only in its own hosted state store
  (`factory-cloud-orchestrator.ts` dedupes on `stateStore.getIssue`, which no
  other dispatcher can read); the writeback that moves the issue out of
  `Ready for Agent` failed on the RelayAuth D1 outage and was treated as
  non-fatal; AR-448 therefore still reads `stateId = Ready for Agent`,
  `updatedAt 2026-07-30T20:41:32Z`, unchanged since creation; 77 minutes later
  a second dispatcher took the still-ready issue and opened #1403.
  **Remaining fix is cloud-side** — claim before spawning, not after, and abort
  the dispatch when the claim write fails. Chief's half (a promote-time guard
  that refuses to re-offer an issue with an open PR) is done.
  **Status 2026-08-07 — the lineage question changed shape.** AR-448's substance
  is already in `main` via PR #1429 (`4acdd97d4` precedence ladder, `5c2ad8ee3`
  restart registration reclaim; both confirmed ancestors of `origin/main`).
  Neither AR-448-branded commit is in main. So both PRs are now stale patches
  against a file #1429 rewrote, and the decision is not "merge which one" but
  "does either add anything main lacks" — mostly #1402's restart/convergence
  test evidence. Recommend harvesting those tests onto current main as a fresh
  PR and closing both. Unmet either way: the stop/start regression proof, which
  needs Khaliq at the keyboard because stopping the broker kills the resident.
  **Status 2026-08-05:** the re-dispatch window is closed — AR-448 reads
  `In Human Review`, still carrying `factory-ready`. Both PRs remain open and
  untouched (#1402 last updated 07-30, #1403 07-31), and both now report
  `mergeable: CONFLICTING` — read live from GitHub, because GitHub senses are
  twelve hours stale. #1413 merging into the same code is the likely cause.
  The decision is Khaliq's, outstanding six days, and it no longer merely
  waits: every day adds rebase cost to whichever branch survives. Fleet
  identity work should not build on either branch until it lands.
  **Status 2026-08-04:** the re-dispatch window is closed — AR-448 reads
  `In Human Review` in the senses projection, though that projection stopped
  refreshing 2026-07-31T08:13Z, so it is the last known state and not a live
  one. It still carries `factory-ready`. Both PRs are still open and untouched
  (#1402 last updated 07-30, #1403 07-31). The lineage decision is Khaliq's and
  has been outstanding five days; fleet identity work should not build on
  either branch until it lands.
- **Workspace keys leak through observer links too.** `agent-relay node status`
  prints `https://agentrelay.com/observer?key=rk_live_…` in plaintext — a
  channel the 07-29 rotation batch did not cover. Relay PR #1405 (`fix(plugins):
  stop exposing workspace keys in observer links`) is open and addresses it;
  confirm it covers the CLI status path, not only plugin output.
- **AR-448's Linear checkpoint is written but unposted.** Relay PR #1402 is
  open (2026-07-31). The checkpoint body is staged at
  `factory-tasks/ar-448-pr-opened-checkpoint.md` and
  `npm run factory:comment -- AR-448 <body-file> [key]` now exists to post it,
  but every attempt fails at `500 mount_session_failed` when minting a senses
  session — the same RelayAuth capacity problem blocking fresh scoped
  credentials. The comment command's writeback path (draft → receipt) has
  therefore never executed against a live mount; only its argument and body
  validation are verified. Trigger: once `npm run doctor` shows the mount
  healthy, run
  `npm run factory:comment -- AR-448 factory-tasks/ar-448-pr-opened-checkpoint.md ar-448-pr-1402-opened`,
  confirm the receipt, then move AR-448 out of `Ready for Agent`.
  **Status 2026-08-05:** the mint blocker cleared — the mount holds a valid
  credential and the Linear outbox is empty, so the writeback path is finally
  testable. Two things still gate the post. The staged body is the superseded
  "PR opened" text: the issue is in `In Human Review` with two conflicting
  implementations, so the checkpoint Linear needs is the lineage decision, and
  the body must be rewritten around it. And the reconcile loop is stalled, so a
  draft would be staged against a projection that is not advancing. Confirm the
  loop is live, rewrite the body, then post and move AR-448 out of
  `Ready for Agent`.
