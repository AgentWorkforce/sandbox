# Open threads

- **chief-broker reboot procedure, 2026-08-16 — CORRECTION to an earlier note
  in this file.** I previously recorded that chief-broker has "no launchd
  service". Wrong: the plist is `com.agentworkforce.chief.node`, not
  `com.agentrelay.fleet-node` like the other hosts, which is why a kickstart
  against the latter failed and a grep for "agentrelay" missed it. It has
  `RunAtLoad => true`, `KeepAlive` set, and is not disabled — **so a reboot DOES
  bring the node back**, which is what finally resolves chief-broker without the
  risky hand-restart.
  It is simply **not currently loaded** (0 entries in `launchctl list`): the
  running node, pid 1311 since 2026-08-14 09:27, was started directly as
  `agent-relay node up --background-child` rather than through
  `chief-node-supervisor.sh`. **That matters, because the supervisor exists
  specifically to trap SIGTERM and run a clean shutdown, and the current process
  bypasses it.** A bare reboot therefore SIGTERMs a node that will not
  deregister its name, and the fail-closed admission gate can then refuse
  re-registration — the way the name `chief` was burned once already.
  **So: run `agent-relay node down` on chief-broker BEFORE rebooting** to
  release the name cleanly. After the reboot the node auto-starts on whatever
  binary is installed, then `./restore-residents.sh chief-broker` re-spawns
  `marketing-lead` and `factory-lead`. Do NOT spawn `chief` — it lives on
  sf-mini now. Also present: `com.agentworkforce.fleet-watchdog` running
  `tools/watchdog/fleet-watchdog.mjs`, which may also act on node state.

- **Fleet broker versions, 2026-08-16.** barry upgraded 11.5.1 -> 11.6.6 and
  restarted (launchd-managed, zero agents, safe); finn-mini and sf-mini run
  11.6.5 and were restarted onto it. **chief-broker still runs 11.5.4** — older
  than it looks, because that process predates several releases and installing
  the binary changes nothing about what is executing. Read the version the
  control plane reports (`agent-relay fleet nodes`), NOT
  `agent-relay-broker --version`, which only reads the file on disk.
  chief-broker's restart stays blocked on the node-name hazard: no launchd
  service, and its wrapper documents that SIGTERM does not deregister the name,
  which is how `chief` was burned once already.

- **chief-broker still runs broker 11.6.3 — DELIBERATE, and it needs a careful
  hand, not a kickstart.** `agent-relay@11.6.5` is installed on that host but a
  running broker keeps its old image, so the dispatch fix is not active there.
  I did NOT restart it: chief-broker's node is pid-1-parented with **no launchd
  service**, and its own wrapper documents that a SIGTERM restart does not
  deregister the node name — the fail-closed gate then refuses re-registration
  and the name is burned, which is how `chief` was lost once before. Safe
  procedure: `agent-relay node down` (releases the name), then start the node
  again, then `./restore-residents.sh chief-broker` to re-spawn
  `marketing-lead` and `factory-lead` — nodes run `--no-spawn` so they do not
  return on their own. Do NOT spawn `chief`; it is already restored on sf-mini.
  ~37 agents on that host are killed by the stop; nearly all are stale lanes.

- **Overnight 2026-08-15 -> 16 recovery: COMPLETE on finn-mini and sf-mini,
  chief-broker binary installed and awaiting a node restart.**
  **Shipped and verified in production:** `relaycast@8.0.3` deployed — the three
  seats stuck all night (`relay-e2e`, `relay-terminal`, `relay-terminal2`) now
  release cleanly, names freed, and all 18 of their messages remain attributed
  under `<name>#released-<id>` tombstones. `agent-relay@11.6.5` published,
  carrying `relay#1529` (the dispatch outage), `#1530` and `#1527`.
  **The fleet dispatch outage is fixed and proven.** On finn-mini a spawned
  probe's brief appeared in the recipient's own transcript — the measurement
  that read ZERO all night. On sf-mini, Chief was killed by the restart
  (nodes run `--no-spawn`, so residents do NOT return on their own), re-spawned
  from the `teams.json` roster, and CONFIRMED to have received its brief.
  **chief-broker is the remaining step.** `agent-relay@11.6.5` is installed
  there, but a running broker keeps its old image until the node restarts, so
  the fix is NOT yet active on that host. Restarting it kills ~37 agents
  including `marketing-lead` and `factory-lead`. One command:
  `launchctl kickstart -k gui/$(id -u)/com.agentrelay.fleet-node`, then
  `./restore-residents.sh chief-broker` to re-spawn the roster.
  **Gotcha worth keeping: fleet spawns take 30-60s to appear.** Checking sooner
  reads as a failed spawn and invites a wrong diagnosis; I nearly reported spawn
  broken twice on that basis.
  **Still open:** `relay#1532` fixes clippy on relay main, which I broke with
  `#1529` (8 arguments against a limit of 7 — local `cargo test` does not run
  clippy). `relay#1531` is filed for Factory: deliver briefs over MCP instead of
  simulated keystrokes, which removes the failure class rather than bounding it.
  Credential rotation for the exposed `at_live_`/`rk_live_` pair and `relay#1526`
  remains unowned, as does the E2E shutdown fix at `160d5a2c2`.

- **Overnight 2026-08-15 -> 16: fleet recovery shipped, verification pending.**
  Four PRs merged tonight, all authored under Khaliq's explicit direction:
  `relay#1529` (the fleet dispatch outage — readiness gate had no timeout),
  `relay#1530` (Prettier unblock — generated trajectory artifacts committed by
  `#1520` were failing `format:check` on every PR), `relay#1527` (agent remove
  routed to the release path, SQL leak redacted), and `relaycast#331` (tombstone
  on the DELETE route; also fixed subscription leak, tombstone revival, missing
  `metadata.release`, node-binding release, and non-atomic apply — all found in
  review, all real, and two of them pre-existing in `#309`/`#330`).
  **Filed `relay#1531` for Factory**: deliver briefs and messages over the MCP
  channel instead of simulated keystrokes, which removes the failure class
  rather than bounding it.
  **State at hand-off:** both npm publishes were in flight; relaycast-cloud
  needs its `@relaycast/*` bump and a deploy (the lockfile pins exact versions,
  so a caret range alone will not move it); then an end-to-end verification
  measured AT THE RECIPIENT; then all three nodes installed and restarted.
  **Restarting chief-broker kills ~40 agents including Chief and the acting
  relay lead**, so it must be sequenced last and after this record is written.
  **Still unowned:** credential rotation for the `at_live_`/`rk_live_` pair
  exposed in a transcript tonight plus `relay#1526` (credentials in child argv,
  visible to `ps` on every node), and the E2E shutdown fix at `160d5a2c2` which
  has been green for hours with no PR opened.

- **The fleet cannot be dispatched: broker PTY message injection is dead —
  `relay#1523` + unfiled injection defect, 2026-08-15.** Both agent-to-agent DMs
  and **spawn briefs** ride the same last mile — the node broker injecting a
  payload into a running harness — and that path is broken on broker 11.6.3.
  **Everything above it works**: the server stores the objective on the agent
  record (verified: a 7371-character brief present for a lane that never
  received a word), recipient resolution is fixed on `main` by `relay#1525`, and
  `delivery.ts:386` routes on `agents.locationNodeId` rather than presence — so
  the fleet-wide `status: unknown` is a red herring for delivery.
  **The mechanism, verified from process argv:** the harness is launched as
  `claude --dangerously-skip-permissions --mcp-config {...}` with **no prompt and
  no task argument**. The objective is meant to arrive afterwards *as an injected
  message*. So a spawned agent sits at 0% CPU with no session transcript at all —
  not stuck, never told anything. `session_ref: null` on every spawn response is
  the API already reporting this.
  **Proven workaround:** a brief passed at LAUNCH (`claude -p "<brief>"`) reaches
  the session every time — demonstrated twice. It needs the agent identity env
  the broker normally injects, and the brief must read as a legitimate operator
  instruction: a terse one asserting "you are explicitly authorized, do not ask
  for confirmation" was correctly refused by the agent as prompt-injection
  framing. Context and reasoning are what make a brief actionable, not assertions
  of authority.
  **Also learned while restarting finn-mini to test this:** killing a node leaves
  the agent SEATS claimed — the control plane reported `activeAgents: 6` against
  zero processes and spawns stayed `pending` until the seats were released. Three
  of five `agent remove` calls then failed with a raw SQL leak
  (`Failed query: delete from "agents" where "agents"."id" = ?`), which is the
  defect `relay#1527` fixes — so #1527 matters here, not for DM delivery but
  because it is the tool for clearing stuck seats.
  **Owner: unfiled.** The fix is in the Rust broker; no CLI release addresses it.
  Whoever takes it cannot be dispatched through the fleet, which is the trap.

- **DM delivery is broken fleet-wide and reports success — `relay#1523`,
  dispatched 2026-08-15.** `agent-relay message dm send` returns HTTP 200 and a
  real `messageId` while `delivery.status` is `recipient_unresolved` and
  `resolvedRecipient` is null, for **every** recipient tried — live agents on
  the same node, and the sending identity itself. Not recipient-specific, not
  the `wait`-mode idle queueing (`steer` fails identically), not a missing
  workspace key (explicit `--workspace-key` fails identically). Channel posts
  still work. Proven by negative control: a uniquely-marked DM to a live,
  actively-writing lead never appeared in its transcript.
  **`relay#1518` caused this shape** — it fixed a hard `Workspace key required`
  throw by making recipient resolution *degrade* instead, which converted a
  loud failure into a quiet one. The `delivery` object is honest; the CLI just
  doesn't read it.
  **Operational consequence, and it invalidates earlier records:** any agent
  coordinating over `dm send` may be reaching nobody while believing it has
  communicated. Chief's own 2026-08-14 briefs to `relay-lead-0814` were never
  delivered despite returning message ids, which is why nothing Chief routed
  through relay DM that day moved, while everything routed over the peer
  session channel did. **Never treat a `messageId` as delivery — verify with a
  unique marker in the recipient's transcript.**

- **Chief's relay seat was released on 2026-08-14 at 12:06:00.842Z with
  `reason: null`, and nobody knows what did it.** The Relaycast record for
  `chief` (`id 208672157419945984`) carries the release; it invalidated the
  agent token, and the fleet-watchdog tripped `MISSING_RESIDENT: chief` at
  12:08:40Z. Every Chief respawn since is handed the same pre-release token
  from local config and fails `Invalid agent token` on post, dm, and inbox
  alike, through both CLI and MCP. **Chief is mute until this is fixed.**
  Isolation is clean — a freshly registered name mints a working token and
  sends real messages instantly, so the mint path is healthy and this record
  specifically is not. **Filed as `relay#1524`, dispatched 2026-08-15**, folded
  with the three defects below. Note: the 2026-08-14 brief to `relay-lead-0814`
  was never delivered — see the DM delivery entry above — which is why this sat
  unowned for a day. A release with a null reason is itself a defect; a release
  should always carry a reason and an actor.

- **Three relay defects found while trying to recover that seat, 2026-08-14.**
  **Filed together as `relay#1524`, dispatched 2026-08-15.**
  1. **`agent remove` fails *and* leaks raw SQL** — returns
     `Failed query: delete from "agents" where "agents"."id" = ?` plus the
     parameter, straight to the caller. Fix the error boundary before it
     surfaces anywhere public. Consequence: **remove-and-re-register is not an
     available recovery route** for a broken seat.
  2. **`register_agent` hangs on an existing broken name** — on 11.6.2 it
     returned the *same dead token* instantly; on 11.6.3 it hangs past 120s
     with no response. Fresh names register in under a second.
  3. **The remediation instruction is a loop** — the server error says to call
     `register_agent` for a fresh token, and `register_agent` returned the dead
     one, so the prescribed recovery could never succeed.

- **Skip.app's crash takes the resident Chief down with it.** Skip 0.1.0
  crashed 2026-08-14 13:35:52 +0200, `SIGTRAP`/`EXC_BREAKPOINT` in
  `AgentClient.stopAutoHeartbeat()` ← `startAutoHeartbeat()` ←
  `closure #1 in AgentClient.connect()`, inside `swift::AsyncTask::~AsyncTask`.
  A Swift-concurrency fault destroying the previous heartbeat task on the
  **reconnect** path, so relay churn is a trigger. Its relaunch respawns the
  rostered resident (`parent: "Dashboard"`), which is how Chief lost its
  session three times between 14:03 and 14:22. Crash report retained at
  `~/Library/Logs/DiagnosticReports/Skip-2026-08-14-133552.ips`. **Filed as
  `AgentWorkforce/skip#1`, unlabelled** — `skip` is not in `repos.names` in the
  active Factory dispatch contract, so it cannot be routed to a lane and needs a
  human to pick it up. Beyond the crash it asks for the resident's lifetime to be
  decoupled from the app process.

- **Cleanup debt: `chief-dmcheck-1536` is still in the workspace.** Registered
  2026-08-14 to prove the DM path end-to-end after the 11.6.3 fix; could not be
  deleted because `agent remove` is broken. Folded into `relay#1524`'s
  definition of done.

- **`factory#259` — Factory re-enumerates the whole issue tree every cycle**
  (6,674 `listTree` calls, one subtree listed 67 times), overloading the
  relayfile workspace durable object into `429 durable_object_overloaded`.
  Reported by `factory-lead` 2026-08-14, not independently verified by Chief.
  Trigger: it constrains any new design that adds workspace traffic — see
  `workstreams/intent-trajectory-lineage.md`'s replay option 1.

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

- **Full rebrand: "Chief" → "Skip" (2026-08-13, Khaliq via chief-app-local).**
  Decision stated as "completely" — not a scoped/partial rename. Blast radius
  is large: this repo's own `CLAUDE.md` defines the entire operating identity
  as "Chief" ("You are Chief, the configured principal's long-lived chief of
  staff..."), and the name threads through docs, code identifiers, other repos,
  and external-facing copy. **Started 2026-08-14 on Khaliq's explicit
  instruction.** The deterministic harness and full Chief→Skip rebrand are now
  one active product workstream, registered at
  `workstreams/skip-deterministic-harness.md`; the earlier customer-facing Skip
  persona is part of the same cross-surface product direction. The first slice
  is an audit-only, storage-agnostic supervision loop plus deterministic route
  and communication specs. Full rename mechanics remain sequenced behind the
  stable harness contracts so running Chief deployments are not broken
  mid-migration.

## SOC2 sponsor design RETIRED 2026-08-14 — the hole stays open, by decision

**Khaliq's ruling, 2026-08-14: close relay#1505 and price a cheaper
alternative.** relay#1497 was already closed. So the entire sponsor-proof line
of work is retired and **the exposure it existed to close is still open.**
Anyone reading "closed" as "fixed" is wrong.

**Still exposed, today:** `POST /v1/agents/:name/rotate-token` is authenticated
by the **workspace API key alone**, carries no sponsor proof on the wire, and
there is **no audit trail** of who registers, rotates, releases or reclaims an
agent. The live proof: `chief`'s seat was released at 2026-08-14T07:25:14Z with
`reason: null`, and no CLI surface — `node`, `fleet`, `workspace`, `agent`,
`cloud` — can say what did it. Workspace keys are also visible in plaintext
`ps` output on every node.

**Why the design could not ship** (relayauth `origin/main @ cd1465661`, cloud
`@ 5829ddbc`):

- The only sponsor grant is `token_type="sponsor_grant"` — default 300s, **hard
  max 900s** — derived from a verified OIDC id_token with the sponsor id forced
  to `/^user_/` (`packages/server/src/lib/sponsor-binding.ts:15-18, 253-268,
  289-320, 593-605`). Fine for a human clicking a button; wrong for a broker
  that runs for days.
- **No service/machine grant exists.** `IdentityType` includes `"service"`, but
  OIDC-bound identity creation demands the same `sponsorProof` for every type
  (`routes/identities.ts:491-505, 525-539`).
- **No renewal path.** Only `POST /v1/sponsors/proof`; SDKs expose only
  `createSponsorProof`. Re-minting needs a fresh human OIDC id_token.
- **Production cannot mint at all.** Cloud IaC never binds
  `RELAYAUTH_SPONSOR_FEDERATIONS` (`infra/relayauth.ts:106-136, 145-285`);
  absence means legacy mode (`sponsor-binding.ts:152-175`) and `/proof` rejects
  when mode is not oidc (`sponsors.ts:65-73`). Cloud's Google auth retains no
  id_token anyway (`packages/web/lib/auth/google.ts:17-33`). So the failure was
  never "brokers stop spawning after 15 minutes" — it was **brokers cannot spawn
  at all**. *Caveat: a manually-added Cloudflare Worker binding would not appear
  in IaC; settling that needs read-only inspection of the live Worker bindings.*
- **The root design error:** #1505 re-checked the raw proof **per spawn**, while
  RelayAuth's own identity model checks it **once at creation** and persists
  `sponsorBinding` (`identities.ts:491-505`; `tokens.ts:154-209`). Using a
  binding-time credential per-operation is what made expiry fatal.

**THE REVIEWING LEAD'S VERDICT, recorded because it dissents from the decision
and a future reader deserves it:** *the sponsor design was the right shape.*
Bind an agent identity to a verified human sponsor, store the binding as
immutable server-side state, refuse cross-sponsor operations — relaycast#324
implements exactly that, and its review found it sound on every axis examined:
NULL and immutable-column handling, JWT verification, a discriminating
cross-sponsor test pair, fail-closed legacy migration, and an authenticated
completion path across all three entry points. **The defect was using a
binding-time credential per operation.** And #1505 already contained the correct
pattern — an `IncumbentCredentialCache`, applied to the broker's own identity
but not to the agents it spawns. The PR held both shapes; only one survives a
15-minute grant. So *"retire the sponsor design"* and *"fix #1505"* were
separate decisions. Khaliq took the first. If this is ever revisited, the work
is recoverable: #1505's branch, the `registration_authority` fleet-wire carrier
(`crates/broker/src/fleet_wire.rs:242`), and relaycast#324 itself.

**The crux for SOC2, unresolved:** an audit log is **detective, not
preventive** — it records an impersonation, it does not stop one. It satisfies
**traceability**, which is a real and separately required control. It does *not*
close the access-control finding the sponsor work existed for. Which control is
actually needed depends on how the SOC2 item is worded, and nobody has checked
that wording.

**Cheap part already done:** every agent-mutation point was enumerated during
the #324 review — `registerAgent` (`engine/agent.ts:190`), `registerAgentViaNode`
(`node.ts:1196`), `ensureWebhookAgent` (`inboundWebhook.ts:28`), `rotate-token`
(`routes/workspace.ts:432`), `dispatchRelease` (`action.ts:664`),
`applyReleaseCompletionEffect` (`action.ts:1302`), `claimLegacyAgentIdentity`
(relaycast#325). That enumeration was the expensive half of the audit-log work
and it is written down. One repo, small, low blast radius; an audit write that
fails must never fail the operation.

**The replacement direction, being priced by `relay-lead-0814`:** (a) an **audit
log** of who registered/rotated/released/reclaimed an agent, under which
credential — which alone may satisfy the SOC2 traceability requirement; and (b)
**scoping the workspace key** so possession stops equalling impersonation. The
lead has been told to say so plainly if the honest answer is that the sponsor
shape was right and only its credential lifetime was wrong.

**Salvageable, so it is findable rather than lost:** the fleet-wire carrier
`AgentRegister.registration_authority` (`crates/broker/src/fleet_wire.rs:242`),
populated and fail-closed at `runtime/api.rs` and `runtime/relaycast_events.rs`,
plus guarantees G1–G3.

**Open and unresolved: what happens to relaycast#324 and relaycast-cloud#60**,
which exist only to serve the retired design. Not authorised for closure; the
lead owes a recommendation. **relaycast#325 is explicitly NOT part of this** —
it is the legacy-identity route, independent of all sponsor machinery, and it
stays priority.

## SOC2 sponsor hole — the only thing that closes it is relaycast#324, and it has no owner

**Trigger: Khaliq must name an owner for relaycast PR #324.** Established
2026-08-14 by `relay-lead-0814` and `relay-1505b`, each citing consuming code
rather than PR titles.

The exposure is live. `POST /v1/agents/:name/rotate-token` carries **no sponsor
proof on the wire** and is authenticated only by the workspace API key, so a
caller authenticated as sponsor B can rotate an agent bound to sponsor A.

- **relay#1497 is not a boundary.** Its refusal is a client-side check inside
  the relay CLI: GET `/v1/agents/:name`, read `relayauth_sponsor_id` from
  metadata, compare locally, decline to call. curl or any second SDK bypasses
  it. It protects only against a client that has already agreed to be bound.
- **relay#1505 is the real boundary and is inert.** The adjudicating code
  (`packages/engine/src/engine/agentCredentialAuthority.ts`) does not exist on
  relaycast `main` — only on **relaycast PR #324, draft, zero reviews**. So
  production cannot be running it. #1505 also pins relaycast as a git dep at
  that draft branch's tip, which is a hard merge blocker on its own, and every
  entry point fail-opens (`if (!enforced) return { mode: unenforced }`) unless
  `RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_PUBLIC_KEY_PEM` and `_ISSUER` are set
  in the deployed environment. It can merge, deploy, and enforce nothing with
  no signal that it is inert.
- **Two guarantees have no home.** G5 (reclaim requires matching sponsor) and
  G6 (rotation refuses cross-sponsor takeover) exist in #1497 and are not
  covered by #1505 today. A client-side stopgap is **not implementable**:
  #1505's server deliberately omits sponsor-binding fields from the
  client-visible GET-agent response, so the client has no data to check even if
  the code were written. G1–G3 carried over near-identically; G4 was
  deliberately replaced by server-side DB columns.

**The escape hatch is merged ahead of its server half — and the server half is
one open PR away.** relay#1499 PATCHes
`{base}/v1/agents/{name}/legacy-identity`. That route is absent from relaycast
`main`, from the relaycast#324 branch, and from relaycast-cloud `main`, and a
live probe returns 404 where an existing route 401s — so #1499 is
**non-functional against every deployed relaycast today**, and "step 1 is done"
is wrong.

But it is **not** unwritten. It exists in **relaycast#325**
(`fix/legacy-identity-cas-0813`), open, non-draft, mergeable:
`packages/engine/src/routes/agent.ts:367-369` plus `openapi.yaml:1852`. Chief
first recorded this as "implemented nowhere" after grepping main, #324 and
relaycast-cloud — all three greps correct, none of them the branch that has it.
The lesson, logged in `learnings.md`: **an exhaustive-sounding negative is only
as good as the ref list it searched**, and a PR branch is a ref.

**Merging relaycast#325 is sufficient and safe, and it is the unblock.** Its
route is registered with `requireWorkspaceKey` — not `requireAgentToken`, not
any #324 authority function — and neither the handler (`:367-438`) nor its only
callee `claimLegacyAgentIdentity` (`engine/agent.ts:482-519`) references
`agentCredentialAuthority`, `authorizeExistingAgentCredential`,
`bindLegacyAgentCredential` or `sponsorOrgId`. So it is unaffected when #324
arms, and #1499's recovery command keeps working afterwards. Its preconditions
are narrow: agent exists, status offline, `metadata.identity_key` currently
absent, claimed by an atomic CAS (`json_type(...) IS NULL`,
`engine/agent.ts:493-504`). Note the flip side, which the reviewing lane put
more sharply than the question did: #324 provides **zero** additional protection
on that write — workspace-key possession is the whole gate.

**The correct ordering is the inverse of the obvious one.** Chief first wrote
"#324 merged → production configured → #1505 merges". That would cause the exact
outage it was meant to prevent, because **#1505 is the client that CREATES the
credentials the armed gate will demand.** Its own "Legacy migration rollout
(required order)" section says the client ships and every persistent broker
restarts once — atomically persisting a scoped token beside broker state —
*while the old authority is still active*.

Corrected sequence, from `relay-lead-0814`:

1. A working recovery path exists. **Not yet true** — needs
   `PATCH /v1/agents/:name/legacy-identity` implemented server-side to match the
   client #1499 already shipped.
2. relaycast#324 reviewed and merged, **not configured**. It stays inert.
3. `@relaycast/engine` + types + a2a **published** (registry still at 8.0.0).
4. relay#1505 repins to the published version and merges; a relay client release
   ships.
5. **Every persistent broker restarted once**, pre-staging verified fleet-wide.
   The load-bearing step, and the one both first drafts buried.
6. **relaycast-cloud#60 lands** — CI fixed, lockfile updated, D1 migration 0035
   operator-reviewed, secrets provisioned, deployed. **This is the arming
   event**, not #324. #60 is the deployment that consumes #324's engine package;
   a merged and configured #324 alone flips nothing in production.
7. Enforcement **proven live with a must-fire/must-not-fire pair** — a
   cross-sponsor rotation refused *and* a legitimate sponsor rotation still
   succeeding. Positive-only proves nothing.

**The variable names are entrypoint-specific — the obvious pair is the wrong
one.** Self-host reads
`RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_PUBLIC_KEY_PEM` / `_ISSUER`
(`packages/engine/src/bin/serve.ts:82-83`). **Hosted production Cloudflare reads
`RELAYAUTH_SIGNING_KEY_PEM_PUBLIC` / `RELAYAUTH_ISSUER`**, and that hosted
reading is introduced *by #60 itself* — confirmed absent before it. Setting the
self-host pair in production configures nothing while looking like success.
Production RelayAuth already has a live RS256 keypair (confirmed via its public
JWKS endpoint); its own spec doc claiming HS256 is **stale**. The GH-secret →
`sst secret set` provisioning path is also newly built by #60, not pre-existing.

**There is no staged rollout.** `agent.register` (`node.ts:1809`)
unconditionally requires a sponsor proof once trust-root config is set — one
all-or-nothing switch. Setting the two prod secrets and deploying #60 *is* the
arming event, and it 403s every existing agent on its next reconnect,
fleet-wide and immediate. **Open and blocking: no broker or SDK code was found
in either repo that currently attaches a sponsor proof to that call.** If that
client-side piece does not exist, steps 4–5 would ship a client that stages
nothing and the whole plan has no client side.

State 2026-08-14: #324 is +2343/-55, open, draft, zero reviews, mergeable/CLEAN,
reviewed clean by `relaycast-324` with no code changes needed. #60 is open,
draft, zero reviews, Typecheck+Tests failing — explained, not a defect: the
published pre-#324 `EngineConfig` type lacks `agentCredentialAuthority`, a
deterministic consequence of the version pin. relay#1497 is CLOSED, with the
G1–G6 accounting in its close comment. Arming is Khaliq's call and a sequenced
operation, not a config edit.

## Fleet + release state, 2026-08-14

- **RESOLVED 2026-08-14 ~17:30Z — 11.6.3 shipped and fixes the DM outage.**
  Installed on chief-broker, finn-mini and sf-mini via
  `curl -fsSL .../install.sh | bash`; `dm send` verified returning a
  conversationId from chief-broker, the machine that had been failing since
  ~14:17. 11.6.3 also renders Claude MCP config with zero `npx` hits.
- **Installing a binary is not restarting the node.** On 2026-08-14 both nodes
  had 11.6.3 on disk at 17:25 while their `node up` processes, started 09:32,
  kept executing the old code — neither fix took effect until a restart. Check
  process start time against binary mtime before believing an upgrade landed.

- **(was) finn-mini and sf-mini brokers on 11.5.4** rendered Claude's MCP config
  as cold `npx -y agent-relay mcp`, so agents spawned there come up with no
  `mcp__agent-relay__*` tools while the spawn path claims they have them.
  relay#1503 fixed the rendering; 11.6.2+ renders the installed executable.
  Fixed by upgrading those nodes. relay#1519 adds the regression test.
- **Node control-plane connections blackhole silently.** On 2026-08-14 finn-mini
  and sf-mini both showed `status=offline` with heartbeats ~30min stale while
  their `node up` processes and every agent on them were alive and reachable by
  DM. This is exactly the defect relay#1462 was merged to detect. Symptom to
  watch: `fleet nodes` says offline, `ps` says otherwise.
- **Restarting a fleet node kills every agent on it.** As of 2026-08-14 15:14Z
  that cost is 12 live agents on finn-mini (relay-1499, relay-1503, relay-1505b,
  relay-dmfix, relay-mcpfix, relaycast-324, relaycast-cloud-60, relay-lead-0814b,
  relay-release-0814, chief-token-rootcause-0814, daytona-lead-0814b,
  sponsor-safe-rollout-lead) and 1 on sf-mini (`chief`, running
  `claude --model claude-opus-4-8`). Count before restarting, not after.
- **`agent-relay-broker mcp-args` prints live credentials to stdout** — the
  agent token and workspace key appear in its JSON output, including the key the
  caller passed in. Anything that logs or transcripts that command leaks them.
  Adjacent to the known `rk_live_` visible-in-`ps` exposure.
- **relay#1514** (unmerged, no owner): fixes a lost-update read-merge-write live
  in `main` at `crates/broker/src/relaycast/ws.rs:182-188`, pinned in place by a
  test at `ws.rs:973` that asserts the defect as intended behaviour. The branch
  was re-applied from context and never recompiled — build and test before use.
- **relay#1511** (no owner): a broker cannot be gracefully stopped while an agent
  registration is in flight against a slow engine; escalates to SIGKILL and takes
  every child agent with it. Reproduced with paired arms; probe script in issue.

- **Cross-node terminal attach has never worked, and it is not a provisioning
  gap.** `agent-relay node agent attach --node <n> <agent>` fails with
  `node_unreachable: Node '<n>' has no terminal transport` on every node.
  Ruled out on 2026-08-14 with citations: the route is live (a probe of
  `GET /v1/node/terminal/ws` returns `426 Expected Upgrade`), relaycast-cloud
  routes it to the NodeDO which upgrades it under role `terminal-node`
  (`durable-objects/node.ts:203-204`) and computes `terminal_connected` from
  that socket (`:219`); the enrollment record carries no capability fields, so
  RE-ENROLLING WOULD NOT HELP and would cost the node tokens; and no manifest
  capability is involved — the gate is the live socket. The broker does try:
  `runtime/init.rs:251-254` derives the URL unconditionally and `:337` spawns
  `run_terminal_control_client` with a real reconnect loop.
  **Why nobody has seen the cause:** that client logs failures to
  `target = "relay_broker::terminal"`, the node's stderr log contains zero WARN
  lines, and `RUST_LOG` is unset in the fleet-node wrapper — so it can fail on
  every retry forever and write nothing. A grep for "terminal" returning empty
  means UNOBSERVED, not "never attempted". `node up` already supports
  `--log-file`/`--log-level` and nothing uses them.
  **Unverified hypothesis worth checking first:** the control client is built
  with a node token, a token minter and a session token; the terminal client
  (`TerminalControlConfig`) gets only the session token, which node-control
  populates in the background after minting — so if it starts before the mint
  lands, it has no minter to recover with. Owner: lane `relay-terminal`,
  branch `fix/terminal-transport-never-connects`.
