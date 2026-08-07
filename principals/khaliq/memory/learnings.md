# Learnings

- A process-lifetime Relaycast room is not an agent identity. Chief must bind
  to the canonical Cloud workspace so its address, inbox, and history survive
  broker restarts.
- A team is only trustworthy when the principal can inspect the individual
  agents and preserve explicit human gates.
- Bespoke Factory verification matters because each repository has a different
  definition of end-to-end correctness.
- Files provide a useful least-privilege boundary: absent means no access,
  read-only means observe, and writable paths define allowed actions.
- Never dump raw `env` into a transcript. A length-based redaction filter let
  a 35-character `br_` broker key through. Grep for the specific variables
  needed, or filter by key name, never by value length.
- Never start Chief's node from inside a Claude Code session. Claude Code
  stamps `CLAUDE_CODE_CHILD_SESSION=1` into every Bash subprocess and the
  broker passes it through, so Chief silently stops persisting transcripts.
  Any clean-env path works (`npm run chief` from a real terminal, or launchd).
  The marker cannot be checked from inside a session — verify persistence by
  watching the session `.jsonl` grow.
- A doctor `OK` on `broker` says the process is up, not that the planes are
  healthy. Read every integration line; GitHub can report a recent event while
  both sync and ingress are unhealthy.
- **A claim that lives in one dispatcher's private state is not a claim.**
  Factory fences work in its own hosted state store, which no other dispatcher
  can see. Because Factory is surface-agnostic, the claim cannot live in one
  surface's fields either — the same work unit can arrive via Linear, Notion,
  or GitHub. The claim has to belong to the work unit, be written before agents
  spawn, and be projected back to whichever surface expressed it.
- **Read the platform's own config before encoding a policy about it.** Chief
  asserted a Linear-only work model for two days because `chief.config.json`
  and `CLAUDE.md` said so, and Chief never opened a `factory.config.json` in
  any target repo. One file read (`hoopsheet` sets `issueSource: "github"`)
  would have falsified it. Repo-local docs describe intent; the owning
  component's config describes capability, and capability wins.
- **Never launder relayed authority into direct confirmation in the brain.** An
  agent reporting "the principal authorized X" is evidence that the agent
  believes it, not that it happened. Record the claim with its provenance — who
  said it, through which channel — and keep the gate. The brain is read by
  future sessions as settled fact, so a provenance error there becomes a
  permission the principal never granted. Scale the scepticism to the blast
  radius: routine sequencing can ride on a relay; data-access scope and
  destructive operations need the principal in a channel he uses himself.
- **Treat contradicting evidence as falsifying, not as trivia.** Factory's run
  list carried `source: "github"` in plain sight and Chief reported it twice as
  a curiosity while continuing to assert Linear-only dispatch. When observed
  data disagrees with the model being reported, stop and chase it.
- **Verify a CLI flag against the installed binary, not the source repo.** Chief
  started passing `agent-relay cloud session --reveal-token` because relay's
  `main` carries it. The binary on this machine is 11.2.0, relay `main` is
  11.4.0, and 11.2.0 rejects the flag outright — so every hosted Cloud call
  failed on `unknown option`, taking out the doctor's cloud check and, behind
  it, integrations, factory, and senses. Reading source proves a flag exists
  somewhere; only `--help` on the installed binary proves Chief may pass it.
- **A live supervisor pid is not a live mount.** The doctor called senses OK
  because a process was alive, while the mount had been stopped for four days
  with an expired credential — the supervisor stays up retrying a mint
  RelayAuth keeps refusing. Chief then read a four-day-old `senses/` projection
  as current external truth. Check the thing Chief actually reads through (the
  mount, the credential), never the supervisor around it. Same shape as the
  `broker` OK lesson above; a health check must assert the capability, not the
  process.
- **`lastSeen` is not purely a measurement — infrastructure batch-writes it.**
  Chief reported 25 agents "dying in the same second" at 2026-08-06T13:00:19Z.
  Two independent lanes falsified it: Relaycast's `inventory.sync` handler calls
  `reconcileInventory`, which stamps `status:'active'` and a fresh `lastSeen` on
  every existing inventory item, so ONE frame gives N agents one timestamp.
  Confirmed by a second instance the same day — a fleet WS disconnect at
  17:55:15Z stamped **106** agents with an identical `lastSeenAt`. A shared
  timestamp across many agents is therefore evidence of a stamp event, not a
  death event, and those agents were already dead well before it. The rule that
  every other flag over-reports still holds, but `lastSeen` is a weaker signal
  than the brain claimed: **the only trustworthy probe is to send a message to a
  specific agent and watch its own `lastSeen` move.** Population-level timestamp
  analysis measures the transport, not the agents.
- **`lastSeen` advancing proves life; `lastSeen` static proves nothing.** Chief
  correctly learned that every other flag over-reports, then over-applied it and
  treated a few minutes of no movement as death — replacing four lanes on that
  basis. Two of the "dead" lanes had already delivered complete work, and a
  third woke after twenty minutes of silence. A lane that is heads-down is not
  consuming messages and is indistinguishable from a corpse by this signal.
  Replace only a lane that has **never once** advanced *and* has produced
  nothing, and prefer asking to assuming — a duplicate lane in a shared worktree
  costs more than an idle one.
- **A liveness filter and a scope widening are one change, not two.** The org
  chart read the node-local agent list, so it showed 27 rows of which 25 were
  dead and hid every always-on production agent. Filtering alone left 2 rows;
  widening alone would have returned 813. Shipping either half would have looked
  like a regression and been reverted. When a feed is both too narrow and too
  permissive, the fix is a single change or it is nothing.
- **Categorising on a field is not filtering on it.** Chief once proposed hiding
  agents with no `nodeId` and correctly retracted it — 37 live agents, including
  production automation, carry none. But the same field cleanly separates
  standing cloud agents from fleet-placed ones, and using it that way is sound:
  liveness still comes from `lastSeen` alone, and `nodeId` only chooses which
  style a row that already passed the liveness gate receives. A field that is
  wrong as a gate can be right as a label.
- **Curl proves nothing about a client-rendered page.** Byte count, grep hits and
  a 200 all passed while the demo chart rendered a single row: the app hydrates
  client-side and the tree collapses on first paint. The served HTML is the
  shell, not the artifact. Render it in a browser, expand it, and assert both
  that the right thing appears and that the wrong thing does not — and expect
  any content health check written against the shell to be counting the shell.
- **A handoff is a snapshot and decays immediately.** An incoming Chief was told
  the demo runbook was the largest open risk, asked for six times and never
  delivered; it had landed seven minutes before the handoff was read. Verify the
  top item of any handoff against the world before acting on it, or you will
  dispatch a lane to do finished work.
- **Correct your own brief the moment the ground moves.** Chief told a lane that
  "no second level" would be an acceptable answer, then found 44 of 56 agents
  reporting to another agent; and told the same lane to discriminate on `source`,
  which stopped being true once the feed widened. Both were caught and corrected
  before the lane built on them. A brief is a claim about the world, so it
  inherits the world's falsifiability — reissue it rather than letting a lane
  discover the error downstream.
- **A mutation count is not coverage — an early failure hides every assertion
  behind it.** A lane mutated production code, saw 6 of 8 restart cases fail,
  and reported that as proof the tests bite. Two reviewers then found the
  headline assertion was tautological: it compared the test's own
  `relaycast.register` mock to itself and could not fail. The lane proved the
  mechanism empirically — under mutation the test died on its *first* assertion
  (the workspace key), so the address assertion never ran; deleting the earlier
  assertions and re-running showed it passing. So mutation-testing production
  code is necessary and not sufficient: **an assertion whose expected value
  comes from the same fixture that produced it stays green under any production
  mutation.** Require the report to name which assertions ran, not how many
  tests went red, and check every assertion in a file for that self-referential
  shape rather than only the flagged one.
- **Do not generalise from a test fixture to production.** Arguing that
  `--require-unified` was an invented check, a lane cited main's `workspace
  active` fixture (`relaycast: 'rc_ops'` against `relayfile/relayauth:
  'rw_ops'`) as evidence the convergence invariant is not real. The live
  workspace resolves all three to an identical `rw_7ccfea89`. The fixture is
  arbitrary test data nobody thought about. Same class as reading a stale state
  file as current state, and the stakes are higher: had "the convergence
  invariant is not real" been recorded, a future session could have stopped
  enforcing this repo's first platform priority. **When a canonical fixture
  contradicts an invariant, one of them is wrong — find out which.** Changing
  the fixture to make the assertion pass, which is what happened here, is the
  move to catch.
- **Check whether `main` already covers it before dispatching a harvest.** Chief
  sent a lane to move #1402's tests onto `main` on the belief AR-448 had landed
  untested. #1429 had shipped it *with* 224 lines of coverage. One `git show
  --stat` would have prevented the whole branch, its review cycle, and a lane's
  day. The cost was recoverable and the lane surfaced two real corrections on
  the way, but the check is free and belongs before the dispatch, not after.
- **Workspace convergence is necessary and not sufficient for agent identity.**
  AR-448 concluded that "agent identity needed no separate fix — Relaycast
  returns the existing agent when a name is re-registered in a workspace it
  already belongs to." That premise was recorded here as settled on 2026-07-31
  and it is wrong twice over. Relay `main` replaced that behaviour with a
  fail-closed admission gate (`b4b96dfb3`): a name collision is **rejected**
  unless the caller proves same-work-unit via a SHA-256 identity key compared
  against the incumbent's metadata, with a node's own restart proving it from a
  hash of its persisted state directory (`5c2ad8ee3`). The gate's own doc
  comment names the rejected alternative "exactly the AR-448 duplicate-agent
  class this gate exists to stop."
  Two consequences. First, **identity has two halves** — one durable workspace,
  *and* an admission decision on the name — and AR-448 only ever addressed the
  first. Second, the old "returns the existing agent" behaviour is a hand-over:
  it is the same defect as [[a-name-based-roster-lookup-makes-the-name-the-identity]],
  where adopt-on-match turns a naming coincidence into a silent takeover.
  Found by a dispatched lane that was asked to adapt a test and escalated a
  falsified premise instead — which is the behaviour to keep rewarding.
- **A state file carries no timestamp in the reader's head — check the one it
  carries on disk.** Chief read `~/.agentworkforce/relay/fleet-node.json`,
  saw `handlers: [… workflow:run]`, and reported to Khaliq that the node claimed
  a capability the fleet denied it — suggesting the Sage gate was nearly met.
  The file was written 2026-06-19, seven weeks earlier: `connected: false`, a
  dead pid, a broker URL on an abandoned port. The live control plane says zero
  of 397 nodes advertise `workflow:run`. Third instance of one failure this week
  (the four-day senses projection, the stale RelayAuth blocker, this): **Chief
  keeps reading persisted artifacts as current state.** The habit to build is
  mechanical — before quoting any local state file, read its `updatedAt` and
  check its pid or connection is live, or prefer the live query outright.
- **A recorded blocker is a claim about the present tense, so re-test it before
  you honour it.** Chief carried "RelayAuth cannot mint, waiting on the gated
  #2857 D1 recovery, needs Khaliq's explicit grant" for five days. On 2026-08-07
  one doctor run showed every plane green, and cloud#2857 had been closed
  `NOT_PLANNED` three days earlier — so the authorization Chief was holding for
  had become unaskable, and the capability it was gating had already returned.
  The failure mode is specific and comfortable: a blocker justifies not working,
  so nothing in the day's flow re-examines it, and it decays into an excuse with
  a citation. Same shape as the handoff-snapshot lesson, applied to Chief's own
  memory rather than someone else's. Verify the top blocker at session start,
  and prefer the cheap live probe over the recorded state.
- **A contract that exists only in a message dies with the mailbox.** Three of
  six Cloud area leads delivered on 2026-08-06; two wrote PRs and one sent its
  custody/token-authority contract as a Relay DM only. The DM is the most
  detailed of the three and the least durable — unreadable to any future
  session, ungreppable, and gone when the inbox rolls. Require an artifact for
  any deliverable meant to bind future work; a rollup message reports that the
  contract exists, it is not the contract.
- **Upgrading a binary is not upgrading the one that runs.** Chief installed
  relay v11.4.2 specifically so the restart would exercise the new admission
  gate, restarted, and got a **10.6.7** broker — because the node's
  `WorkingDirectory` is this repo and `node up` resolves the broker from local
  `node_modules`, where a transitive `@agent-relay/fleet@10.6.7` shadows the
  managed 11.4.2 binary. The upgrade was real and it upgraded a file nothing
  executes. Same family as verifying a flag against source instead of the
  installed binary, one level further out: there, the wrong *version* was read;
  here, the wrong *copy*. The habit is to check the running process's own path
  and self-reported version (`ps` on the pid, the doctor's `brokerBinary`), never
  the version of what was just installed. Corollary worth its own line: **when a
  fix fails to appear after an upgrade, suspect resolution before you suspect the
  fix.**
- **Editing a launchd plist does not change the running job.** The `kjg-laptop`
  rename was written into `com.agentworkforce.chief.node.plist`, the node was
  restarted, and it came back named `chief` — launchd keeps the definition it
  loaded and the file on disk is only a template for the next `bootstrap`.
  `launchctl print` shows the in-memory `arguments`, and that is the thing to
  read; the plist is a persisted artifact, which puts this in the same class as
  every other stale-file-read on this list. A restart that does not reload the
  job proves nothing about the change it was run for.
- **A test that passes on the wrong build is not a pass.** AR-448 criterion 3
  came back green — resident kept its address across a real restart — and the
  workstream had predicted a *failure* on any released broker for want of
  `5c2ad8ee3`. Both facts together mean the green came from the old permissive
  re-registration path, i.e. from the impersonation behaviour the gate exists to
  remove. **A result that contradicts the prediction is a finding about the
  setup, not a bonus.** Reconcile the surprise before recording the pass, or a
  vulnerability gets written into the brain as a passing acceptance criterion.
- **A diff-based review gate is blind to new files, so it passes hardest on the
  code that needs it most.** `veto_diff_review` reads `git diff HEAD`, which
  excludes untracked files. Run against T3's fleet-picker candidate it reviewed a
  README, a TOML and a `package.json` description — 67 lines of prose — while the
  entire feature, 670 lines across four new untracked files, was invisible to it.
  A clean verdict there would have been reported in good faith and meant nothing.
  The failure is self-selecting: a *new* capability is exactly the change that
  arrives as untracked files, so the gate is weakest precisely where the risk is
  highest. **`git add -N` before any diff-based review**, and when a report says a
  gate passed, ask what the gate actually read. Same family as
  [[a-gate-nobody-invokes-is-not-a-gate]] — there the gate was never called; here
  it was called and saw nothing. A gate that launders an unreviewed change as
  reviewed is worse than no gate at all.
- **A missing row is not a dead thing — an enumeration can be non-deterministic.**
  `agent-relay fleet nodes` returns a *subset* of live nodes that varies between
  calls seconds apart. Eight samples at 12s intervals, written to disk and
  byte-counted to rule out truncation, came back as complete well-formed JSON at
  three exact sizes: 4 nodes, 3-without-`sf-mini`, 3-without-`finn-mini`. Every
  node that appeared read `online`/`live`/`handlersLive`; none ever appeared as
  offline; and both "missing" nodes were heartbeating throughout on a ~60s
  cadence. Chief and a dispatched lead each concluded a node had died, each
  briefed the other on it, and *both corrections were also wrong* — inside eleven
  minutes. The existing rule (every liveness flag over-reports, only `lastSeen`
  measures) covers rows that are *present*; this is its blind spot. **Absence is
  not evidence.** Test the specific thing — read the named node's own
  `lastHeartbeatAt` across ≥2 beats — rather than inferring state from whether it
  showed up in a list. Same family as the stale-state-file reads: the artifact in
  hand was treated as a complete picture of the world.
- **A fail-closed gate takes hostages, so ask what it costs when it fires on
  you.** The brain spent days wanting the 11.4.2 admission gate shipped, because
  without it a stranger could claim `chief-khaliq` and be handed Chief's mailbox.
  The gate landed, works, and was verified by probe — and the first thing it did
  was permanently burn the node's own name `chief`, because the broker does not
  deregister on SIGTERM and the reclaim key is never persisted. The security
  property and the outage are the *same mechanism* seen from two sides. Chief
  had reasoned about the gate purely as protection and never asked what happens
  when the legitimate owner cannot prove ownership either. **When arguing for a
  fail-closed control, work out the recovery path for the honest caller before
  it ships, not after it strands you.**
- **A restart can pass every assertion and still not answer the question.** Rows
  1 and 4 of the verification passed — gated broker, identity preserved — and
  the script's own text invited recording criterion 3 as closed. But the same
  state directory that proved ownership of the broker's children failed to prove
  ownership of the broker itself, and that asymmetry is unexplained. A pass
  whose mechanism contradicts a failure sitting beside it is one observation of
  an unknown system, not two. This is the third consecutive restart on this
  machine where the headline result was true and the conclusion drawn from it
  would have been wrong; the habit that keeps working is to reconcile every
  surprise in the run before writing the verdict, including the surprises the
  script did not think to check for — the node's name changed under a script
  that asserted it would not.
- **A dispatch gate must fail closed.** AR-448 was duplicated because the
  writeback that releases the claim depends on Relayfile, Relayfile was down,
  the failure was non-fatal, and the run proceeded — leaving the issue looking
  ready with a PR already open. If the claim cannot be written, abort the
  dispatch; a queue that silently re-offers claimed work is worse than a queue
  that stalls.
