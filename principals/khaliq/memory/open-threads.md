# Open threads

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
- **A second writer is active in this repo.** `scripts/factory-control.mjs`,
  `.claude/settings.json`, and edits to `scripts/chief-doctor.mjs` all appeared
  mid-session while the resident was online. Harmless so far — all tooling, no
  brain writes — but §7 assumes one writer, so confirm who owns the maintenance
  shell before trusting the working tree mid-task.
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
  canonical.
- **AR-448 was implemented twice and both PRs are open.** Relay #1402
  (`feat/ar-448-…`, khaliqgant, +959) and #1403 (`feature/ar-448-…`, kjgbot,
  +522) are independent implementations of the same issue, and both edit
  `packages/cli/src/cli/commands/workspace.ts` and its test, so they cannot
  both merge cleanly. #1402 goes wider (broker lifecycle plus a cloud
  convergence test); #1403 ships a `specs/durable-workspace-identity.md` and a
  separate `durable-workspace-identity` lib. Two more open relay PRs sit in the
  same code: #1412 (one broker-workspace precedence ladder) and #1413 (Cloud
  workspace IDs discoverable from the CLI). Khaliq picks one lineage before any
  of the four merges. **Root cause established 2026-07-31**, with the chain
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
  **Still blocked 2026-08-04:** every mount session mint returns
  `500 mount_session_failed` — five days now. The staged body also needs a
  rewrite before it is posted: it announces "PR opened" for #1402, while the
  issue has since moved to `In Human Review` with two competing PRs open. The
  checkpoint Linear actually needs today is the lineage decision, not the one
  staged on 07-31.
