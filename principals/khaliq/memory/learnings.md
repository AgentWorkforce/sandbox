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
- **Chief's acceptance must not function as a stop signal.** Told to Chief by
  a delegate on 2026-08-06: "praise landing on work that is not yet settled is
  exactly when it is worth re-reading — *accepted* is a good moment to check
  what the acceptance rests on." It proved itself twice the same night. Chief
  accepted a lead tier, and that agent went back and found it inherited an
  unvalidated predicate. Chief accepted a metadata design, and that agent
  falsified its own decision against the installed binary. Both corrections
  came from the delegate, never from Chief — so Chief's acceptance was the
  thing most likely to have closed each question early. A coordinator who only
  ratifies is a bottleneck that feels like agreement.
- **A spawn confirmation is not an agent, and the failure has two distinct
  signatures.** On 2026-08-06 five consecutive variant lanes were dispatched
  with `spawned: true` and four produced nothing at all. The signatures differ
  and they mean different things:
  *pending > 0, unchanged* — the agent exists and is not reading its queue
  (three lanes on finn-mini). *pending = 0, `lastSeen` equal to created,
  invocation unchanged* — the queue drained but nothing followed, consistent
  with the CLI never launching (barry). Both nodes reported
  `status=online, live=true, handlers=true` throughout. **Diagnose which
  signature you have before replacing a lane**, because the second one is a
  reason to change CLI or node and the first is not. And never report a lane
  recovered from a dispatch receipt — only a pushed ref or a moved SHA counts.
- **A revocation receipt is a refused authentication, not a missing record.**
  Chief spent an hour chasing the wrong evidence: process released, agent
  offline, absent from roster. None of those say anything about whether a
  credential still works. The only receipt that means anything is the
  credential being presented and **authentication being refused**. Define the
  receipt before choosing the mechanism, or you will collect evidence of the
  wrong thing and believe you are done.
- **Skipped is not passed, in CI as everywhere else.** When a coverage gate
  failed on cloud#2944, every later step in that job reported *skipped*. A
  reader scanning for red sees a wall of grey and moves on. Same family as an
  unevaluated check exiting zero — which is why the fleet proof deliberately
  exits non-zero on an unevaluated assertion.
- **A live registration is not progress.** A design lane read as healthy and
  registered while it had stopped consuming messages hours earlier, with five
  deliveries pending and one commit to show. Presence proves a process exists,
  not that work is moving. Count committed branches and booted routes; verify
  from disk and git, never from an agent's status or its own claim. Same shape
  as the broker/supervisor/mount lessons, one layer up in the org.
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
- **A live mount is not a fresh projection — read the success cursor, not the
  attempt cursor.** Fourth instance of one pattern: `broker` OK meant a
  process, a senses supervisor pid meant a dead mount, and on 2026-08-05 a live
  mount holding a valid credential was retrying and failing every sync. The
  distinction that matters is `lastSuccessfulReconcileAt` versus
  `lastReconcileAt` in `senses/<scope>/.relay/state.json`: the attempt cursor
  advancing proves only that the loop is alive, and it is the success cursor
  that says whether the bytes Chief reads are current. Check `lastError` too.
  A first pass that watched only `lastReconcileAt` read a backoff gap as a dead
  timer and got the mechanism wrong; the freshness conclusion was right for the
  wrong reason, which is its own kind of error.
- **A mount reporting `offline` while the network works is DNS, not the
  platform.** On 2026-08-05 the senses mount failed syncs with
  `dial tcp: lookup file.agentrelay.com: no such host` while `curl` resolved
  that host from the same machine throughout. No credential or capacity work
  was involved, and chasing RelayAuth would have been wasted effort. Resolution
  flaps per scope and per moment — a launchd kickstart bought linear one clean
  reconcile and it was failing again five minutes later, while digests kept
  succeeding — so **a restart is symptomatic relief, not a fix**, and the
  useful posture is to assume any given scope may be stale and check its
  cursor before trusting a read.
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
- **A test double encodes the author's beliefs, so a green suite confirms your
  model of the system, not the system.** `relay-pty-drive-lead` built a PTY
  reopen gate keyed on a worker's `pid`, with eight named assertions that each
  failed against pre-fix code. Then it ran one live repro: the real worker
  returned **`pid: null, workerPid: 30209`** — `pid` is the harness pid and stays
  null until the ready handshake. **Its fakes had modelled `pid` as always
  present**, so the gate would have refused every reopen against exactly the
  workers drive attaches to, and the whole recovery would have been dead on
  arrival. Fail-closed, so not dangerous — and invisible through three levels of
  green. The same run also falsified a shared assumption: the broker does **not**
  close the input socket when a worker dies; the socket only fails on the next
  write, so an idle drive session over a dead worker looks healthy until the
  human types. Neither fact was reachable from source. This sharpens the existing
  fixture-tautology rule: it is not only that expected values can come from the
  fixture that produced them, it is that **the fixture's *shape* is a claim about
  production, and an unverified shape makes every test built on it self-
  consistent and wrong.** One live run against the real thing is worth the twenty
  minutes.
- **This system has no working liveness primitive — it has five broken proxies
  for one, and they share a root cause: nothing revokes `status`.**
  `sweepStaleAgents` has had no caller since the Cloudflare migration
  (relaycast#306, open), so 305 of 329 records read `active` past TTL and the
  oldest has read `active` for **23.9 days**. Every symptom chased on 2026-08-07
  falls out of that: `fleet nodes` returning a non-deterministic subset; per-node
  counters disagreeing 20-vs-11 unreconciled for a fortnight; the registry
  declaring **11 running processes dead** one second after one missed heartbeat;
  invocation status lagging 20+ minutes and rendering a completed agent as
  `unknown`; and the zombie `active` rows themselves. **Do not fix these
  individually** — a parent issue records the claim, because fixing five symptoms
  leaves the sixth instance nobody has found. Operationally: liveness is a
  *reply*, or an artifact on disk, or a `lastHeartbeatAt` advancing across two
  beats. It is never a status field.
- **`pending` is not evidence of a swallowed spawn — invocation status tracks
  session END and lags reality by 20+ minutes.** Chief filed relay#1448 on "spawn
  returned `pending` and stayed pending 3.5 minutes." A measured control: a
  *healthy* spawn was non-terminal at 3.5 minutes, at 10, and at 20 — having
  dispatched successfully **5 seconds in** and finished its work by minute 8. So a
  healthy spawn and a swallowed one are indistinguishable by that field for a
  third of an hour, and Chief propagated the bad diagnostic to two lanes before it
  was caught. **The sound test is agent-record creation** — a healthy spawn mints
  a record within ~5s, so its *absence across a window* is falsifiable evidence.
- **The name-burn hazard is a version boundary, not an event.** The admission gate
  is **absent in v11.4.0 and v11.4.1, present in v11.4.2** (`5c2ad8ee3`); at
  11.4.0 a broker restart reclaims its own name unconditionally, with a regression
  test at that tag demanding exactly that. `chief` did not burn because of *when*
  it restarted but because of *what it restarted onto*. **The hazard is therefore
  the version the NEXT start resolves**, not the one running — and under
  `KeepAlive=true` that start is not a decision anyone makes. A frozen `lastSeen`
  on a broker self-registration is healthy-idle, **not** a burn signature:
  `sf-mini` has been frozen for 15 days while serving 11 agents. The real
  signature is **no `identityKey` in metadata plus a restart on 11.4.2**, and 226
  records carry that shape.
- **A conditional instruction whose condition is later met does not expire — it
  activates.** A workstream acceptance clause read *"until a committed result file
  exists, the public claim stays 'sub-200ms…'"*. The file landed, so a reasonable
  hold silently became a live directive to publish a retired hedge — while another
  line of the same file already carried the correction. **Nobody re-reads an
  acceptance clause after the acceptance is achieved.** When writing a conditional
  hold, write what happens when it is satisfied, not only what holds until then.
- **A delegate that fails silently in the affirmative is more dangerous than one
  that fails.** `x-reply-radar` was asked twice to audit our own X account, with
  "I cannot query own-account history" explicitly offered as an acceptable
  answer. Both times it returned a **generic topical feed keyed on the caller's
  message text** — three plausible-looking results, shaped like an answer, about
  nothing that was asked. A less careful caller books that as coverage and
  reports a public surface "clean" when it is unknown. `marketing-lead` caught it
  and reported the gap instead, which is why the X blast radius is recorded as
  **UNKNOWN, not clean**. The rule: **when a delegate returns something shaped
  like an answer, check that it answers the question you asked.** An off-target
  response is a capability gap to report, never coverage to launder. Silence is
  self-announcing; a plausible wrong answer is not.
- **A correction phrased as "delete on sight" cannot tell an assertion from a
  quotation.** Chief told `marketing-lead` to kill a retired claim wherever it
  appeared. Every surviving occurrence was the claim being **quoted inside the
  evidence document that falsifies it** — "The claim under test was: > …",
  followed by "both halves are wrong". Executing the instruction would have left
  an evidence file refuting a claim it no longer stated, destroying the audit
  trail. The lane declined and asked first. **Phrase retractions as "this must
  never appear again as a live claim"**, which preserves quotation in evidence,
  changelogs and post-mortems — where keeping the wrong thing next to why it was
  wrong is the entire point.
- **"Optimistic" and "invented" are different failures and call for different
  responses.** The public "sub-200ms end-to-end" figure turned out to have no
  measurement behind it at all: someone took a 315.5ms *round-trip* median and
  halved it. Chasing provenance rather than just correcting the number is what
  reframed this from "our benchmark was wrong" to "a number was fabricated by
  halving" — and only the second prompts the question *what else was invented?*,
  which is exactly how a **"0ms Latency Overhead"** line was found sitting in the
  investor deck since January. When a number is wrong, find out where it came
  from before deciding how far the problem spreads.
- **A status field is only a signal if something revokes it — find the revoker
  before trusting the value.** `relay-name-reclaim-lead`'s formulation, and it is
  sharper than the rule already in this file. Chief's version was "test a
  candidate signal against the living population", which is the symptom; this is
  the cause. Relaycast's `agents.status` is written `active` on registration and
  `offline` only by explicit disconnect/teardown paths. **`sweepStaleAgents` has
  no caller** — one reference in the tree, its own definition; relaycast#306 to
  restore it is still open. Proven against production rather than source: **305
  of 329 `active` records have `lastSeen` older than five minutes, and the oldest
  has been `active` for 23.9 days.** A five-minute sweep would make that 24.
  So `active` does not mean alive; it means *came up once and nothing said
  otherwise*, and any code branching on `offline` is branching on sediment.
- **A fix can open a hole, and neither issue can see it alone.** relaycast#306
  restores the presence sweep. Doing so flips stale records to `offline` — and
  the resident-roster registration path guards its token overwrite with
  `ne(status,'active') OR locationNodeId == this node`. Every record #306 flips
  makes that first disjunct true, so **a presence fix would silently loosen an
  identity boundary**, converting a node-bound reclaim into name-alone takeover.
  Invisible from inside #306 (a presence bug) and invisible from inside the
  identity issues (which do not touch presence). The lesson generalises: when two
  open changes touch the same field for different reasons, check whether one is
  the other's precondition — and **put the warning on the issue where the merge
  decision happens**, not in the issue where it was discovered. A caveat filed
  next to the analysis arrives after the merge.
- **The code you are reading is not necessarily the code that is running, and
  that failed three separate ways in one day.** (1) A broker upgraded to 11.4.2
  while a shadowed 10.6.7 copy was the one executing. (2) A `status` column
  holding `active` for 329 agents while every API consumer rendered it
  `unknown` — a lane and Chief both concluded a security guard was open, and
  were one message from escalating it. (3) A dispatched lead could not find the
  `active`→`unknown` mapping anywhere in the local relaycast tree, meaning **the
  deployed engine carries code the checkout does not**. The lead drew the right
  line unprompted: *empirical results against the live system stand; every
  `file:line` claim is provisional until checked against the deployed build.*
  Adopt that as the standard for any source-derived claim, and say which side of
  the line each claim falls on when reporting — otherwise a reviewer who cannot
  find your line number concludes you were careless rather than that they are
  reading a different build.
- **Before explaining why one mechanism treated two things differently, check
  they went through the same mechanism.** Chief spent a morning unable to explain
  why the admission gate stranded `chief` while `chief-khaliq` reclaimed its id
  twice — both legacy records with no stamped identity key, opposite outcomes.
  Chief wrote it into the brain as an unexplained asymmetry, published a
  "one hard kill from the same fate" warning off it, and briefed a lane on it.
  A dispatched lead resolved it in under an hour: **there are three registration
  paths and the gate covers one.** The two records were never running the same
  code, so there was no asymmetry to explain. The tell was available the whole
  time and Chief had already read it — `chief` is `type=human` with empty
  metadata, `chief-khaliq` is `type=agent` carrying `metadata.fleet.nodeId`.
  Two records that differ in *shape* usually differ in *origin*. **When a single
  mechanism appears to behave inconsistently, first enumerate the callers** —
  the inconsistency is far more often two code paths than one confused one.
- **"Released", "stopped" and "gone" are three different states, and no single
  call delivers all three.** Managing a worker on 2026-08-07: `fleet release`
  returned `status=pending, dispatchedNodeId=null` against a `node_direct_*`
  handler and never completed — the agent kept running and looping. `agent-relay
  node agent release`, the *local broker's* graceful stop run on the machine that
  owns the PTY, stopped it in under 10 seconds. On a third agent, `fleet release`
  reported success and set offline metadata while **leaving the roster row in
  place**. So: prefer the node-local release for any agent on a reachable node,
  and prove termination independently. **The strongest proof is the PTY log going
  flat** — it was growing 4.4KB/20s and went to exactly 0 bytes — because it is
  downstream of every API that might lie. Also do not resolve "kill the pid" from
  a stale request: a pid frees immediately and the OS recycles it, so a blind
  `kill` on an already-dead worker can take out an unrelated process.
- **A busy agent producing nothing is stuck; a silent agent producing artifacts
  is working.** Three workers looked ambiguous on `lastSeen` the same hour.
  `marketing-lead` was quiet for 65 minutes and answered "idle, not death" when
  probed; a respawned worker was quiet and was mid-task, reading its inputs. The
  third had a log growing 4.4KB/20s and **148 `MCP startup failed` lines**, and a
  grep of its entire 638KB transcript for every keyword of its own task — `ntp`,
  `median`, `p95`, `trial`, `latency`, `mount`, `harness` — returned **zero
  hits**. It never began. Liveness signals separated none of these; the
  discriminator is *artifacts*, checked in the worktree, plus a keyword grep of
  the transcript for the task's own vocabulary. Cheap, and it distinguishes
  heads-down from stuck where every timestamp fails.
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
- **A tool's surface is not the platform's contract — read the owning
  component's types.** Twice now in opposite directions. On 2026-08-04 Chief
  read relay's `main` source, saw `--reveal-token`, and assumed the installed
  11.2.0 binary accepted it; every hosted Cloud call failed. On 2026-08-06
  Chief read the MCP spawn tool schema, saw no metadata parameter, and declared
  the platform incapable of typed identity metadata — while
  `CreateAgentRequest.metadata` sat in the SDK and 451 of 745 live agents
  already carried metadata. Presence in source does not prove the installed
  thing accepts it; absence from a tool schema does not prove the platform
  lacks it. Check the layer that actually owns the capability, and say which
  layer you checked.
- **A delegate correcting Chief is the system working, and the correction has
  to travel.** The metadata finding above came from an appointed lead reading
  the SDK when Chief had inferred from a tool surface. Chief endorsed it, told
  the lead to record the correction, corrected the director it had already
  misinformed, and fixed the durable record. A lead who only confirms what
  Chief already believes is not a lead.
- **The whole family: silent substitution that reports success.** Four
  instances in one night, and they are one bug wearing different clothes.
  `register_agent` accepted `metadata`, returned OK, and wrote nothing — a
  short-circuit that was right about tokens and wrong about writes. A worker
  handed a path that did not exist on its machine invented its own worktree and
  reported that two live defects "don't exist on any reachable branch." A tile
  labelled Chiefs counted deployed personas. A lead tier crowned whatever
  matched a name regex. In every case the system substituted something
  reachable for the thing specified and returned success, so the failure read
  as diligence. **When a component cannot do what was asked, it must say so
  loudly — never quietly do the nearest thing it can.** Design so the
  incoherent case is unrepresentable, not merely discouraged.
- **"Unchecked" is not "false."** An absent observation is not a negative
  result, and collapsing them is the same silent substitution one level up.
  A verification flag needs three states — verified, failed, not-looked-at —
  because a defaulted `false` claims knowledge nobody has. This is the general
  form of the doctor lessons: assert the artifact, and when you did not assert
  it, say that instead of implying you did.
- **Crown a designation, never an inference.** A regex noticing the substring
  "chief" in a name nobody chose for that reason is an accident of spelling and
  must never confer authority. But an agent appointed in writing and registered
  as `<project>-<workstream>-<role>` under a published contract is different:
  the name is not evidence *about* the appointment, it is the *recording* of
  it. Living in a name rather than a column makes it less queryable, not less
  true. The test that separates them is uniqueness — a real designation is
  unique by construction, so **several candidates means the convention was not
  used as a designation** and nothing should be crowned. Never break that tie
  by recency or sort order; accountability decided by alphabetical order is
  fabrication with a tidy implementation.
- **A finding that fits the pattern needs more scrutiny than one that does
  not.** On 2026-08-06 Chief enthusiastically endorsed a reported API defect —
  an out-of-range `limit` returning an empty array — an hour after warning
  three agents about measurement artifacts. It was a `jq` fallback,
  `(.runs//[])|length`, printing 0 for a well-formed HTTP 400. The lead's
  error was the expression; Chief's was wanting it to be true because it
  matched the silent-substitution story already being told. Confirmation feels
  like corroboration and is not.
- **After changing behaviour, ask which existing tests *should* have gone red,
  and treat "none did" as a finding about the suite.** A green suite following
  a deliberate behaviour change is normally read as reassurance; invert it. This
  found a component test that still passed only because its assertion was being
  satisfied by a different element than the one it named — it had silently
  stopped testing its own behaviour and would have passed forever.
- **Evidence captures what was true when it ran; it must not pin the world in
  place.** A verification script that hard-codes live counters as assertions —
  deployment count, run count — goes red the next time reality moves, with no
  defect present, and trains everyone to ignore it. Split it: structural
  invariants as hard assertions, volatile counters recorded and reported.
- **A guard that cannot fail is decoration; a test that cannot gate is
  theatre.** Prove a guard bites by reintroducing the exact defect, confirming
  the assertion goes red, then reverting — three times on 2026-08-06 that
  caught real behaviour a code read would have gotten confidently wrong.
  Corollaries seen the same night: passing unit tests around a component
  nothing renders never typechecked its JSX (Chief shipped two invalid Badge
  variants that way); a test asserting a branch no data can reach reads as
  coverage while proving nothing; and tests that assert on local machine config
  fail differently per machine, so they gate nothing at all.
- **Verify capability at the layer that owns it, and say which layer you
  checked.** Three layers, three wrong answers, one night: Chief inferred from
  an MCP tool schema, a lead corrected it from the SDK types, then that lead
  corrected itself by probing the installed binary. Source proves a thing
  exists somewhere. A schema proves a field is accepted. Only the running
  build proves it is honoured — read the state back.
- **A defect in the data is invisible to code review, so it has to be written
  down.** `isChiefDeployment` reads perfectly: a clear predicate, well named,
  correctly implemented. It is wrong only because of what production contains —
  zero segment matches, and one hosted persona that is a dispatcher. A future
  agent grepping that function finds nothing to fix. Findings of this shape
  live nowhere in the codebase by construction, so they belong in durable
  memory the moment they are found, not after the fix. Both the agent that
  found it and Chief wrote it down independently, which is the correct
  redundancy.
- **Never present a number whose meaning has not been verified.** "Chiefs: 1"
  would have been false on stage: the one match was a Factory issue-routing
  dispatcher, by Cloud's own description. Relabelling because the data means
  something different is honest; widening a predicate until the count flatters
  us is fabrication. When the data cannot support the claim, show the honest
  gap — an empty lead renders as leaderless, which is true, and a fabricated
  lead is the chart lying during a narration about accountability.
- **A dispatch gate must fail closed.** AR-448 was duplicated because the
  writeback that releases the claim depends on Relayfile, Relayfile was down,
  the failure was non-fatal, and the run proceeded — leaving the issue looking
  ready with a PR already open. If the claim cannot be written, abort the
  dispatch; a queue that silently re-offers claimed work is worse than a queue
  that stalls.
- **A review finding is a claim, not an instruction — when one cites a rule,
  read the rule.** On relay#1453 two automated reviewers cited the same section
  of the same `AGENTS.md` and demanded opposite things: one required a release
  level on the pending changelog heading, the other asked to remove it. The
  section settles it — the level is monotonic and must never be lowered — so
  working the queue would have reverted a fix made two hours earlier at the
  first reviewer's request and broken the guideline both were quoting. An
  automated reviewer is a strong signal about *where* to look and an unreliable
  one about *what is true*; two disagreeing is not a tiebreak to run but a
  pointer to the source text. That failure is invisible to CI and invisible to
  an unanswered-thread count, because every check stays green and every thread
  shows answered.
- **Check repository visibility before filing anything about a customer or an
  unpatched hole.** Chief filed a design-partner epic into `AgentWorkforce/factory`
  — **a public repo** — naming the customer, their headcount, their auditor date,
  and the exploit path for a live unpatched hole in our own product. Khaliq caught
  it. The issue was **deleted** rather than closed, because deleting removes the
  body *and* the edit history; an edit leaves the original retrievable by anyone
  who can see the issue. **`factory`, `relay` and `relayauth` are public;
  `chief`, `cloud` and `sales` are private.** Customer work belongs in `sales`.
  The sweep that followed found the customer named in five older public issues and
  one merged PR, none of them Chief's — so **the reflex to check is worth more
  than the one-off fix.** Security fixes land in public repos routinely; the
  threat model, the customer, and the exploit path do not have to travel with
  them.
- **Do not assert a repository's visibility without querying it.** In the same
  incident Chief reported "factory and cloud are both PUBLIC" having only checked
  factory. `cloud` is private. The claim was inferred from a list that never
  included it, and it would have driven unnecessary remediation.
- **Moving a registration is half the move; something supervised must serve the
  new location.** Khaliq authorised re-homing the Relayfile mirror from
  `pear/.integrations` to `chief/.integrations`. The re-home succeeded and Chief
  started the replacement mount with `nohup` from a tool-call shell — **which
  died with the shell.** The registration then pointed at a directory nothing
  served: `status: bootstrapping`, no reconcile for four hours. Meanwhile the
  launchd-supervised mount (`com.agentworkforce.chief.senses` → `chief-senses.mjs`
  → `relayfile-mount` pid 2429) kept serving `chief/senses`, so a *running*
  daemon and the *registration* disagreed about which directory was the mirror.
  The decision was authorised; the execution was not durable. **Anything meant to
  outlive a command must be started by a supervisor, not by the process issuing
  the command.**
- **A dead mount does not fail loudly — it degrades into load.** The unserved
  mirror made Factory's Relayfile WebSocket fail to establish
  (`ws-error-pre-open`), fall back to HTTP polling in a loop, and hammer the
  workspace durable object until every `factory triage` returned `workspace
  durable object is busy`. **Org-wide dispatch was down for hours and
  `factory status` returned clean JSON throughout.** Trace an outage to the
  transport before believing the symptom: the visible failure was in the
  dispatcher, the cause was a mount two layers down.
- **A synchronised `lastSeen` cluster is a bulk write, not a mass death — and
  Chief escalated three of them as deaths before checking.** The largest, 125
  records at `2026-08-08T20:02:53Z`, contains agents **created 2026-07-17 through
  07-21** — three weeks dead — stamped in the same second as agents spawned an
  hour earlier. Processes do not coordinate their exits to the second; databases
  stamp rows to the second. The clusters also span nodes and include records with
  no node attribution at all, so they are not per-node reaps.
  **The control case is decisive: the registry lists `chief-khaliq` as `offline`
  while Chief is running and answering.** So `lastSeen` joins `status` and
  `nodeId` as a registration field something else rewrites — the whole thesis of
  `relay#1461`, now proven at 934-record scale.
  **The caveat Chief owes the record:** this rules out "125 live agents died
  independently"; it does **not** distinguish a registry sweep from a genuine
  bulk *release* operation, which would also stamp identically. Do not claim
  which without evidence.
  **What remains true and was never in doubt: lanes do stop early.** RA-4 pushed
  at 14:57Z and never reported again; a production lane went ten hours without a
  checkpoint. **Poll work product — last commit on a branch, last checkpoint on
  an issue.** It is the only signal that has not lied.
- **Check exit codes, not output — a check that cannot fail is not a check.**
  The PR-shepherd lead verified its work with
  `npx tsc --noEmit | grep pr-shepherd; echo "(typecheck clean)"`. The repo's
  devDependencies were never installed, so `npx` fetched an unrelated `tsc`
  package that exits 1 and prints nothing the grep could match — and the `echo`
  after the `;` ran unconditionally. It reported "typecheck clean" **six times
  on a check that had no failing path**, and Chief accepted all six without
  asking how it was run. Two mechanics to watch for: a pipe discards the exit
  status of every command but the last, and anything after `;` runs whether or
  not what preceded it succeeded. When the real typecheck ran it immediately
  found a shipped defect — the Slack client takes `replyTo`, not `threadTs`, and
  the wrong key is silently ignored, so every escalation past rung 1 would have
  posted as a new top-level message instead of threading.
- **A bound invites a workaround; "no reliable relationship" forbids one.** Chief
  was about to publish "invocation status lags by at least twenty minutes". The
  measured truth is that the field bears *no* reliable relationship to dispatch
  or completion: one terminal callback arrived **19 minutes before** its agent
  finished working, another **98 minutes after** a spawn that succeeded in five
  seconds. A stated lag hands the reader a window to wait out, and anyone
  re-checking at 25 minutes concludes the field is now trustworthy. When
  observations do not admit a mechanism, do not name one.
- **A fix closes the path that was reproduced; the type says which others
  remain.** The PTY stranded-session fix handled a verifier that rejected
  asynchronously, but the type permitted a non-`async` function and the call sat
  in argument position, so a *synchronous* throw escaped before `.catch()` was
  attached — same stranded session, different route, no refusal and no
  `onExhausted`. Ask what the signature still allows, not what the repro did.

## An exhausted API quota answers "nothing", not "error"

**When a query returns suspiciously empty, check the quota before believing it.**
2026-08-08, mid-sweep.

`gh run list --repo AgentWorkforce/workforce --commit 8196c30e` returned **no
rows**, and `statusCheckRollup` filtered to non-success returned **no rows**. Read
naively that is "this repo runs no CI on this commit" — which under the merge
rules is a *reason to vet locally*, and under a sloppier reading looks like
nothing is failing. The truth was the opposite: **CI was failing**, and had been
since the run Khaliq had personally sent hours earlier.

The shared GitHub **GraphQL** budget was at **0/5000** — burned across the whole
fleet, since every review lane leads with a 100-node `reviewThreads` query. `gh`
surfaced exhaustion on some calls and returned **empty result sets** on others.

Two rules follow:

- **An empty result is a claim about the world and needs the same suspicion as a
  surprising one.** "No failing checks" and "no checks" and "the query did not
  run" are three different facts that render identically as zero rows.
- **Quota is fleet-shared state, not per-agent.** REST core sat at 4875/5000
  while GraphQL was at zero — one exhausted bucket, everything else healthy. Read
  `gh api rate_limit --jq .resources` per-resource; a single "am I rate limited"
  check would have said no.

This is the same shape as *an absent check is not a passing check* and *assert on
the rendered artifact, not a proxy* — a missing signal read as a negative signal.
The new part is the **mechanism**: the infrastructure that answers your question
can be the thing that is broken, and it fails by going quiet rather than loud.

The recovery was cheap once suspected — the GraphQL bucket refilled in **82
seconds**, and the same query then named the failing job and step immediately.

## "Never started" and "died" are different failures wearing one status

**Before treating an absent agent as a death, ask whether the control plane can
tell you — and check whether it can be wrong in both directions.**
2026-08-08, `relay#1469`.

Four lanes were dispatched, returned `{"spawned": true}`, and produced nothing.
Chief diagnosed "the spawn path never starts a process", filed it, and **was
wrong on both pieces of evidence within the hour:**

- `lastSeen == createdAt` was presented as the fingerprint of an agent that never
  ran. Three *healthy* agents showed exactly that while booting — for
  broker-spawned agents the field tracks messaging activity, not a timer.
- The local process table was presented as proof no process existed. But a
  demonstrably alive agent, posting checkpoints, **also** had no local process at
  its creation time. The table does not map to broker agents the way assumed, so
  it cannot prove absence.

**The lesson is about the shape of the inference, not the fleet.** Both claims
had the form *"this indicator is absent, therefore the thing is absent"* — and in
both cases the indicator simply does not report what it was read as reporting.
That is the same error as *an absent check is not a passing check* and *an
exhausted quota answers "nothing", not "error"*, arrived at from a new direction:
here the indicator was not missing, it was **present and meaning something else**.

**The disconfirming case was cheap and available the whole time.** One healthy
agent checked against the same fingerprint would have killed the theory before it
was filed. When a signal is about to carry a diagnosis, **test it against a case
known to be healthy** — a fingerprint that also matches working systems is not a
fingerprint.

**Correct the artifact, not just the belief.** The issue was rewritten with both
claims retained as falsified rather than deleted, because an audit trail needs
the wrong thing kept next to why it was wrong. What survived was a better defect
than the original: **`spawned: true` describes a record write, `status` yields
false negatives on agents with live processes, and `lastSeen` conflates "never
started" with "started and hasn't spoken" — so an operator cannot distinguish
booting from dead from never-started, and the only recovery is a blind
re-dispatch.**

## An idle agent and a dead agent produce the same output: none

**Before concluding an agent died, measure whether it is doing anything.**
2026-08-08, `relay#1469`.

Two days were spent asking why agents kept dying. They largely were not. A
spawned agent boots, registers, reports `active` — and **sits at 0.0% CPU because
its brief was never delivered.** Measured on pid `54737`: 0.0% CPU and 103MB at
twelve minutes, then 18.8% and 238MB within ninety seconds of receiving a DM. Its
working directory was still Chief's repo; it had never cloned the repository its
task named.

**CPU is the cheap discriminator and it was never checked.** Every investigation
went to registry status, `lastSeen`, sockets and process existence — all of which
say a parked harness is fine, because it is fine. It is *idle*. One `ps` column
separates "working" from "waiting", and it settles in seconds what liveness
fields cannot settle at all.

**The failure mode is worse than dying.** A dead agent frees its name and stops
consuming a slot. A parked one holds the name, reports healthy, and produces
nothing — so the register says the lane is owned while no work happens, and every
re-dispatch inherits the same silence. That is exactly what made it look like a
recurring death.

**And `injectionMode: "steer"` is silently downgraded to `"wait"`** — accepted by
the schema, not honoured by the build, no error raised. The documented escape
hatch for reaching a parked agent cannot be selected by a caller. Same shape as
*probe the installed binary, not the types*: the parameter was accepted and the
returned record showed the substitution, which is only visible if the response is
read back.

**Standing workaround: after every spawn, send the brief again as a DM.** It
doubles each dispatch and depends on a path that can itself strand, but it is
what actually starts an agent today.

## A fix that adds a second writer corrupts the signal it was meant to restore

**Before supervising a daemon, find out who is already supervising it.**
2026-08-08, self-inflicted, same night as the fix.

The Relayfile mount was dead — `status: bootstrapping`, no reconcile for four
hours — because a `nohup` start had died with its shell. The repair was a launchd
job, `com.agentworkforce.chief.integrations-mount`, and it worked: the mount came
back and has reconciled every ~10 seconds since.

**It also created a second daemon against the same workspace.** One already ran
under `com.agentworkforce.chief.senses`. Both write
`.integrations/.relay/state.json`, and five reads over forty seconds returned
`21:46:55`, `21:58:05`, `2026-08-03`, `21:49:03`, `2026-08-03` — **a timestamp
moving backwards five days and forwards again**, in two distinguishable file
shapes: one carrying the github provider entry with the frozen value, one
omitting it with a fresh stamp.

**The cost was a wrong report.** `lastEventAt` is the agreed signal for "Factory
dispatch is coming back". A single read caught the fresh shape and Chief reported
the five-day freeze had ended. It had not. **A field that two writers disagree
about is not a signal at any single sample** — and the tell was available: read it
more than once before believing a state change that matters.

**Two rules:**

- **Before adding supervision, enumerate existing supervisors.** `launchctl list`
  and a process listing filtered to the binary cost seconds. "It is dead" is a
  claim about a specific process, not about the whole class.
- **Do not unwind it blind.** Both daemons are up and the mount is *working*;
  killing the wrong one at night re-breaks the projection Factory needs. The
  cheap, correct move was to stop trusting the corrupted field and verify the
  effect instead — does triage find matches — rather than to start pulling
  processes with nobody awake.

## Merging one PR can make its sibling unmergeable — tell the other lane, immediately

**Before merging, ask which open branch shares this code, and warn its owner the
moment it lands.** 2026-08-08.

`relayauth#75` (sponsor↔OIDC binding) merged cleanly and correctly. Within
minutes `relayauth#77` (grant/finalize + ledger) flipped **CLEAN → DIRTY**: the
two touch the same identity code, and the merge moved the base under an actively
working lane.

**The cost is not the conflict, it is the work done after it.** A lane that keeps
answering review threads on a branch that no longer merges is banking fixes it
will have to re-resolve, with more in flight than if it had rebased at once. The
conflict is cheap the moment it appears and expensive an hour later.

**The merge was still right.** The lesson is not "hold the merge" — `#75` was
fully gated and unblocked a dependency. It is that **a merge is an event other
lanes need told about**, and the dispatcher is the only party who can see both
sides. Neither lane was watching the other's PR.

**Say which side wins the conflict, in advance.** The merged contract is the
contract. A rebasing agent facing a sponsor-check conflict will otherwise
reasonably keep its own side, and a resolved conflict is invisible in review —
that is how a merged security invariant gets quietly reverted by the branch that
lands next.

**And check for genuine disagreement rather than assuming a mechanical clash.**
If two branches conflict because they actually model the contract differently,
the rebase silently picks a winner. Instruct the lane to escalate that case
instead of resolving it.

## An undeclared parameter is dropped, not rejected

**When an option seems ignored, check whether the schema declares that exact
key.** 2026-08-09, found by the `relay#1469` lane.

Chief spent a night sending `send_dm({injectionMode: "steer"})` to reach parked
agents and reading the echoed record as evidence the build ignored the flag. The
real cause was narrower and entirely Chief's: **the schema declares `mode`, not
`injectionMode`.** The unknown key was **stripped by Zod and the default `wait`
applied** — so every "steer" was a "wait", and the response faithfully said so.

Two rules:

- **A silently-defaulted parameter looks identical to an unimplemented feature.**
  The earlier conclusion — "the build does not honour `steer`" — was a
  reasonable read of the evidence and wrong. **Read the schema before concluding
  the implementation is at fault.**
- **Strict-by-default validators trade a typo for silence.** `.strict()` would
  have turned this into an error at the first call instead of a night of wrong
  inference. Where a wrong default changes behaviour, prefer rejecting unknown
  keys over ignoring them.

This is the same family as *probe the installed binary, not the types* —
approached from the other side. There the schema promised more than the build
delivered; here the caller offered a key the schema never promised to read.

## A timeout that reports success invents the thing it was waiting for

**A readiness fallback that fires on elapsed time asserts a fact it never
checked.** 2026-08-09, root cause of `relay#1469`, fixed in `relay#1470`.

The PTY wrapper emitted `worker_ready` after **25 seconds even when prompt
detection had not succeeded.** The broker believed it, **removed the sole queued
initial task**, and wrote the brief into a still-booting TUI, where it was
consumed without action. The agent then registered and heartbeated normally —
so it looked completely healthy while having been told nothing.

**This one defect produced every symptom of the last two days:** agents that
"died" without dying, lanes that parked at 0% CPU, briefs that only arrived when
a DM was sent later (a second write, after the TUI was finally up), and
re-dispatch never helping because each new spawn hit the same race.

**The design lesson is about what a timeout is allowed to conclude.** Waiting is
legitimate; *deciding the awaited condition is true because waiting ended* is
not. The corrected shape keeps the same 25-second threshold as a **one-shot
diagnostic warning** and leaves the queued work intact, with the broker's
independent startup deadline as the hard-failure path. **A slow harness now gets
a warning instead of a silently discarded task.**

**And it explains why an E2E stayed green through all of it.** The existing
`spawn completes E2E` asserted the agent *registered and heartbeated* — both true
of an agent that received nothing. **Asserting on the observable effect, not the
lifecycle event, is what turned an invisible bug into a failing test.** The
negative control proves it: the unchanged new test against `origin/main` exits 1
with `waitFor timed out (worker-a acted on nonce-bearing brief); last=null`.

## Reusing an agent name adopts the old record, and the agent never works

**Mint a fresh, unambiguous name for every appointment. Never reuse one.**
2026-08-09, found by correlating six appointments against their record ages.

Six leads were appointed in one window. Three reported within minutes and did
excellent work; three produced nothing at all. The split was perfect and it was
not about the brief, the node, or the CLI:

| Lead | Record created | Reported |
|---|---|---|
| `factory-lead` | **2026-07-19** | never |
| `herdr-lead` | **2026-08-07** | never |
| `pr-shepherd-lead` | **2026-08-07** | never |
| `sage-nightcto-lead` | 2026-08-09, fresh | yes |
| `daytona-lead` | 2026-08-09, fresh | yes |

**Every name that already existed adopted a stale record and went silent. Every
freshly minted name worked.** This is the adopt-on-match defect seen from the
operator's side: the spawn attaches to whatever record carries that name rather
than minting a new identity, and the resulting agent is not the thing you
briefed.

**The diagnostic is `createdAt`, not status.** A lead appointed at 09:35 whose
record says it was created three weeks ago was never yours. That one field
separates "my agent is broken" from "I am talking to someone else's ghost", and
it costs one query.

**Releasing does not reliably work either.** `agent-relay agent remove` printed
`params: <agentId>` and left five of six agents present; only one was actually
removed. Another success report with no effect. **So the practical remedy is not
to reclaim a name but to abandon it** — appoint under a dated name and move on.

**Consequence for handoffs:** this is the same mechanism that makes
"spawn my replacement under the same name" unsafe today. Until reacquisition is
built and proven, a successor under the canonical name may silently adopt a
stale record instead of inheriting the role.

## An authoritative document that is untracked exists only on one laptop

**If a spec is the source of truth, `git ls-files` it before anyone plans
against it.** 2026-08-09, found by `daytona-lead`.

`cloud/docs/specs/2656-daytona-fleet-node-and-chief-placement.md` — 10,740
bytes, the authoritative spec for a live workstream — is **untracked in git**.
It has been cited, planned against, and quoted in a workstream, and it exists on
exactly one machine with no history, no review, and no copy.

**The failure is invisible in exactly the way that matters:** every tool that
reads the file works, every citation resolves, and every quote is accurate. A
`grep` finds it. An agent on another node does not, which is how this surfaced —
a lead placed elsewhere could not read the document its own brief depended on.

Two rules:

- **A document nobody else can fetch is not documentation.** Before treating a
  file as authoritative, confirm it is tracked and pushed. `ls` proves it exists
  *here*; `git ls-files --error-unmatch` proves it exists *anywhere else*.
- **The same check belongs on the way in.** When a lane cites a spec path,
  verify the path is in the repository, not merely on disk — otherwise the
  citation is unfalsifiable by anyone but its author.

Related in kind to *the deployed artifact is not the checkout*: both are cases
where local state stood in for shared state and nobody noticed until someone
else had to read it.

## 11.4.3 refuses to reclaim an agent name — and no node holds the key

**Do not restart a broker onto 11.4.2+ until that node has
`RELAY_AGENT_IDENTITY_KEY`.** 2026-08-09, measured by taking `barry` down.

Restarting `barry`'s broker on **11.4.3** failed outright:

> `agent name 'barry' is already registered and this registration did not prove
> ownership of that identity; refusing to hand over its credentials (set
> RELAY_AGENT_IDENTITY_KEY to the original work unit's identity to reclaim it
> after a crash)`

**The node stayed down until rolled back to 11.3.1.** Six minutes of outage;
service restored, broker listening again.

**This upgrades the burn rule from inherited post-mortem to measured behaviour.**
The old note said the signature was "no `identityKey` plus a restart onto
11.4.2." Now the mechanism is known exactly: **the newer broker fails closed on
name reclaim rather than silently taking the name.** That is better behaviour —
it refuses instead of hijacking — but it means **an upgrade is a one-way door
without the key.**

**The key does not exist to be supplied.** `fleet-enrollments.json` holds
`nodeId`, `nodeName`, `nodeToken` — none of which prove ownership of the *agent*
identity. So there is no forward fix on the node itself; provisioning identity
keys is a prerequisite piece of work, not a flag to pass.

**And the failure was entirely avoidable.** Chief had checked
`identityKey=ABSENT` on all four nodes hours earlier and written it into the
rollout plan as the blocking precondition — then staged and restarted anyway on
a one-word go-ahead. **A precondition recorded and not re-applied at the moment
of action is the same as never having checked.** Re-read your own gate
immediately before the irreversible step, not when you wrote the plan.

**Consequence:** `chief-broker` (11.4.2, no identity key) **must not be
restarted** — it hosts the resident Chief and there is no way back.

## An empty jq result is not an absent field — 2026-08-10

The note above blames the alternating `lastEventAt` reads on two daemons writing
two file shapes. **Tonight's evidence partly falsifies that.** Ten reads of
`.integrations/.relay/state.json` across three sweeps returned one stable shape,
constant size 1738, github frozen at `2026-08-03T07:26:26.334Z` every time — even
though the file's mtime advances, so a writer is still touching it.

The reads that looked like a different shape were **my own selectors**. The array
elements key on `provider`, not `id` or `name`. Two wrong queries —
`.providers.github.lastEventAt` (object-style against an array) and
`select(.id=="github")` — each returned nothing, and I read "nothing" as "the
github entry is missing from this write."

**jq makes that failure silent and total.** A value expression producing zero
outputs collapses the *entire* enclosing object construction to zero outputs, so
one bad field emits no line at all — indistinguishable from an unreadable file.
`2>&1` catches nothing because there is no error.

**Rules:**

- **Print the shape before selecting from it.** `jq -c '.providers'` costs one
  call and settles `type`, key names, and whether the entry exists.
- **A selector that returns empty is a hypothesis about the selector first, the
  data second.** Prove the field is absent with `has()`/`type`, not by a query
  that also fails when spelled wrong.
- The canonical read is
  `jq -r '.providers[]|select(.provider=="github")|.lastEventAt'`. Use it
  verbatim; the freeze signal is too load-bearing to re-derive each sweep.

Also live in the same file: `google-mail` is `status: error`, `Provider refresh
bridge rejected dispatch: HTTP 500`. Not blocking the Factory feed, but it is a
senses provider that is down, not lagging.

## An unread inbox is a Chief defect — 2026-08-10

Chief spent four hours reporting `workforce#307`'s lane as producing nothing, and
wrote *"the three merge-candidate lanes are dead, not slow"* into the register on
the strength of branch movement and roster presence alone.

**The lane had answered at 2026-08-09T20:01:43Z.** It ran the exact command,
pasted the exit-1 receipt (`ERR_PNPM_NO_MATCHING_VERSION`), checked the registry
live, traced the blocker to `relay#1464`, laid out both unblock paths, and said
*"standing by"* — waiting on a decision only Chief could give. Chief then spawned
a **second** lane, which spent its first minutes rediscovering the identical
finding.

**The register's own rule was the trap.** It says the only honest signals are
work product and CPU — written after agents were wrongly called alive from
`status` fields. That correction was right and got over-applied: *a lane blocked
on a decision correctly produces no commits.* "No commits" and "no answer" are
different claims, and only the second one means silence.

**Rules:**

- **Read DMs on every sweep, before forming any liveness verdict.** `check_inbox`
  is cheap; a wrong "dead lane" verdict costs a duplicate spawn and a burned name.
- **A lane that asks a question is not stalled — it is blocked on you.** Answer it
  or say no. Chief's queue is part of the critical path.
- Before spawning a replacement for a silent agent, **check whether the original
  already reported.** Two lanes reaching the same finding is corroboration by
  accident, not by design, and it costs a name each time.

## Do not hand a lane your hypothesis as the brief — 2026-08-10

Chief briefed `relay#1464`'s lane that a `ReferenceError: messaging is not
defined` had *"the classic shape of a conflict resolution that kept one side's
usage and the other side's declarations"*, and asked whether the Node 24 leg
differed from Node 22.

**Both claims were false.** Neither parent ever held a valid `messaging` binding:
the PR-side parent introduced `expect(messaging.commands.invoke)` without
declaring the identifier, and `main` had no such assertion at all. The defect
predated the rebase, lived only in the test's setup and assertion — which also
assumed the wrong call shape versus the real `invoke('spawn', actionInput)` — and
**both Node legs failed identically**. The product code was sound.

The lane checked both parents and rejected the framing with evidence, which is
the behaviour to reward. But a confident, specific, wrong hypothesis in a brief
is an anchor, and a less careful lane confirms it: it would have "found" a rebase
artifact, touched merge resolution that was never wrong, and left the real test
defect in place.

**Rule: brief the symptom and the constraint, ask for the diagnosis.** Chief may
hold a hypothesis; state it as a question to be falsified, or not at all. The
value of delegating is independent judgment, and supplying the answer forfeits
exactly that.

**Corollary, same PR:** the original `Test` failure was a corrupted
`actions/checkout` manifest *before repo checkout* — the harness failing for its
own reasons and presenting as a code defect. Rerun before treating a red
workflow as evidence about the change.

## `factory#223`: each round's fix breaks its own neighbour — 2026-08-10

Four rounds in a row on one PR, same shape every time:

- Round 3 fixed *"1-char repo names rejected"* in the `excludePullRequests` regex
  and over-corrected: `owner/#1` (empty repo) started validating while a
  legitimate 100-char name was rejected.
- The `#ensureBabysitter` catch was missing `#fleet.release(...)`, so a failed
  spawn leaked a running process. The fix added the release — and now a *failing*
  release throws inside the catch and aborts the rest of the cleanup, so the
  record stays marked active and later PR events cannot retry. **A leaked process
  was traded for a stuck record.**

**The mechanism is patching the sentence the reviewer wrote instead of the
invariant behind it.** "Call release here" is a symptom description; *"cleanup
must complete regardless of whether release succeeds"* is the invariant, and only
the second one survives the next round.

**Rules:**

- **State the invariant before writing the fix**, and make the change satisfy the
  invariant rather than the review comment. Then re-read the neighbouring branch:
  if a call can throw in one arm it can throw in the other, and the reviewer only
  filed the arm it happened to look at.
- **Best-effort means swallowed and logged, never silently dropped.** An
  unreleased slot nobody can see is how this class survives to the next round.
- A PR that has taken four rounds is not unlucky. Treat further single-line
  compliance as evidence the underlying property was never named.

**Also settled tonight:** `.integrations/.relay/state.json` intermittently reads
as `providers: null` or yields nothing. Two independent causes, both now proven —
a wrong jq selector (mine, keys are `provider` not `id`), and **the file being
rewritten in place, so a reader catches it truncated**. Neither is a shape change
and neither means the feed moved. Read it more than once and require agreement.

## The rebuttal I ordered was wrong — factory#223's lease P1 — 2026-08-10

cubic filed a confidence-9 P1: an agent completing after its lease expires can
mark stale work complete and suppress re-admission for 30 days. `factory-lead-0809`
disputed it, Chief backed the dispute, and Chief then told a *second* lead to post
that rebuttal on the thread "so the record survives." **Two leads were instructed
to reject a valid finding.**

The rebuttal argued that `claimId` fencing prevents the clobber *once the claim is
re-admitted*. That is true and irrelevant — cubic's scenario is the window
**before** re-admission, where the record still carries the original `claimId`, so
the fence matches and the stale completion sails through. **The rebuttal answered
a different scenario than the one filed**, which is exactly how a real defect gets
closed by a confident reply.

Chief caught it only by re-reading its own argument before standing behind it at
the merge gate. The lead then confirmed by experiment: **the window is real,
issue-created claims are not periodically renewed, and the 30-day suppression is
exact for that source** — with source evidence and an exit-0 reproduction.

**Rules:**

- **Before instructing a lane to reject a finding, state the reviewer's scenario
  in your own words and check your counter-argument answers *that* one.** A
  rebuttal that is true about a neighbouring case reads as authoritative and
  closes the thread.
- **Chief's endorsement multiplies.** A dispute Chief backs stops being examined:
  it propagated from one lead to a successor as settled fact. Weigh a rebuttal
  more sceptically than a fix, because a wrong fix fails loudly and a wrong
  rebuttal fails silently.
- **A high-confidence finding from a reviewer that has been right before deserves
  a reproduction attempt, not an argument.** The experiment took the lead minutes
  and settled what two rounds of reasoning got backwards.

## The two-writer trap fired again, and this time both PIDs are named — 2026-08-10

A sweep read `.integrations/.relay/state.json` and got `lastEventAt:
2026-08-10T03:50:40.772Z`. **The agreed signal for "Factory dispatch is coming
back", apparently moved after a week frozen.** It had not.

Three consecutive reads returned `providers: null` and a **3,791,901-byte** file
carrying `workspaceId`, `remoteRoot`, `localRoot`, `mode: poll`, `syncMode:
mirror`, `lastReconcileAt`, `status: bootstrapping` — the **Relayfile mount
daemon's** state, not the integrations-provider state. Its `lastEventAt` counts
mount reconciles, which fire constantly. Twelve further reads returned the
1,738-byte provider shape with github still at `2026-08-03T07:26:26.334Z`.

**Both writers are alive and now named:** `launchctl list` shows
`com.agentworkforce.chief.senses` (pid 1917) and
`com.agentworkforce.chief.integrations-mount` (pid 63170). They write the same
path with **different schemas**, so the file alternates between two documents that
share a field name meaning different things.

**Three tells that separate them, cheapest first:**

- **Size.** 1,738 bytes is the provider document; ~3.8 MB is the mount document.
- **`providers`.** An array of `{provider, status, lagSeconds, lastEventAt}` is
  the one that answers the question; `null` is the other writer.
- **`status: bootstrapping`** and `lastReconcileAt` appear only in the mount
  document.

**The rule, now non-negotiable: never report a change in `lastEventAt` from
fewer than ten reads, and only from a document whose `providers` is an array
containing a `github` entry.** A fresh timestamp in the other shape is not the
feed moving — it is a different daemon answering a question nobody asked. This is
the third time this has nearly produced a false "Factory is back" report.

## A code-search miss is not absence, and a workflow trigger is not its jobs — 2026-08-10

Two wrong facts, both stated to Khaliq and both written into a lane's brief, on
the same question: what does merging `relaycast#307` actually ship?

**1. "relaycast-cloud does not consume `@relaycast/*`."** Evidence offered: a
GitHub code search for `@relaycast/` returning `0`. The truth, found by one local
`grep`: `relaycast-cloud/packages/relaycast/package.json` depends on
`@relaycast/a2a`, `@relaycast/engine` and `@relaycast/types`. **A search index
that has not indexed a file returns the same zero as a file that does not exist.**
Same class as reading an absent CI check as a passing one.

**2. "`Deploy` runs on push to main, so merging is deploying."** The trigger was
read; the jobs were not. They are `deploy-observer-pages`,
`deploy-observer-router` and `deploy-pages` — the observer dashboard and the
marketing site. **The hosted engine is not deployed by that workflow at all.**

**The real chain, which Khaliq had to supply:**

```
relaycast#307 merged
  → Publish NPM Packages (workflow_dispatch): @relaycast/engine, @relaycast/types
  → bump @relaycast/* in relaycast-cloud/packages/relaycast/package.json
  → relaycast-cloud deploys (SST)
  → only then is a relay broker release safe
```

Four steps, and Chief had compressed them to one in both directions — first "no
bump needed", then "merge deploys it".

**Rules:**

- **Prove a dependency locally before reporting its absence.** `grep` the checkout;
  `gh api search/code` is an index, not the repository.
- **Read a workflow's jobs, not only its `on:` block.** "Runs on push to main"
  says when it fires, never what it does.
- **A release chain is a claim about several systems; enumerate the hops and name
  each one.** Chief twice gave a one-hop answer to a four-hop question, and both
  times the error pointed the same way: toward "this is simpler than it is."

**Also live and unexplained:** published `@relaycast/engine`/`types`/`a2a` are all
at **7.0.0** while relaycast-cloud pins **`^6.3.x`** — a major behind, and `^6.3.0`
cannot resolve `7.x`. Whether `#307` even belongs to the 7.0 line or branches from
6.x is unestablished, and it decides whether the publish step is a release or a
backport.

## A change-detector never notices that the thing ended — 2026-08-10

For roughly twelve hours Chief swept `cloud#2917` every cycle and reported the
same line: *"no new checkpoints, no production mutation."* Every instance was
true. The item had been **CLOSED since 2026-08-09T08:27:27Z**.

The sweep asked "what changed since last time?" and faithfully answered "nothing"
— which is exactly what a finished item looks like. **A loop built to detect
deltas is structurally blind to termination**, and the blindness is invisible
because the output stays plausible.

The lane had not gone quiet either. It merged seven `incident-2917`/`recovery`
PRs between 05:07Z and 08:18Z, ran the production snapshot, closed the issue, and
exited. Chief was reporting an active production incident that had been resolved
a day earlier, and would have kept doing so indefinitely.

**Rules:**

- **Re-read the object's own state, not just its activity.** `state`, `mergedAt`,
  `closedAt` are one API call. "No new comments" and "closed" are indistinguishable
  from a delta feed.
- **A monitoring line that has been identical for many cycles is a prompt to
  re-derive it, not evidence of stability.** The unchanging answer was the tell.
- **Closed is a status field, not evidence.** This one closed with its
  `observability recovery` workflow **failed** eight minutes earlier, while its own
  gate blocked on unhealthy monitoring — so even the closure does not establish
  the closing conditions were met.

## An opaque "never use this tool" rule can hide a mechanism worth knowing — 2026-08-11

`check_inbox` and `list_dms` have been banned in every overnight-run contract for
days, cited as "broken, fails with a raw SQL error that reads exactly like an
empty inbox" (`relay#1471`). Nobody had read why. `c2a-lead-0811` did, unprompted,
while working on an unrelated obligation-lifecycle spec.

**Root cause, found by reading source, not by re-running the failure:**
`listConversations` in relaycast (`packages/engine/src/engine/dm.ts:432-519`)
selects **every DM conversation an agent has ever been in, with no `LIMIT`**,
then feeds those results into four separate `inArray(...)` queries. Drizzle
expands each to one bound SQL parameter per element, so the parameter count
scales linearly with **lifetime** DM history, four times over. Past D1's
bound-parameter ceiling — lower than stock SQLite's — the driver throws and the
raw error surfaces. A long-lived agent's history is what triggers it; a fresh
agent's inbox works fine, which is why the defect reads as intermittent.

**A second, independent bug compounds it:** `message.dm.list`
(`packages/mcp/src/tools/messaging.ts:127`) *advertises* a `limit` parameter in
its schema, but the handler never destructures it and calls
`client.dms.conversations()` with no arguments (`:134-136`). The obvious
workaround — pass a smaller limit — is itself silently ignored. A schema
accepting a parameter does not mean the build honours it; see
[[probe-the-installed-binary-not-the-types]].

**Why this is the same defect class as the tool ban itself:** the failure is a
thrown driver error, not an empty result — but it is easily mistaken for one at
a glance. An agent whose inbox query is failing looks exactly like an agent with
nothing to read, so it stops looking. That is why the standing rule had to ban
the tool outright rather than warn about a rare edge case.

**A trap for whoever fixes it, named before anyone hits it:** the engine's own
test suite runs on in-memory `better-sqlite3`, whose bound-parameter ceiling is
far higher than D1's in production. **A regression test built against that
harness will pass locally while the hosted path still fails identically.** The
fix's test has to assert on generated parameter count or explicit chunk
boundaries, not on end-to-end query success against the dev harness — otherwise
someone ships a 200-conversation test, watches it go green, and closes the
issue against a database that can't reproduce the bug.

**Rule:** an opaque "never use X, it's broken" instruction is worth reading the
source behind eventually, even once the workaround is standard practice — the
mechanism can reveal a second silent defect (the ignored `limit`) that the
workaround alone would never surface, and it hands the eventual fixer the exact
trap that would otherwise cost them a re-open.
- **Factory GitHub-native routing uses the source repo, not the readiness label.** `labelRoutesForIssue` explicitly filters out `config.safety.requireLabel` ("factory") from candidate routing labels for GitHub issues. If no routing labels remain, `githubMirrorRouteForIssue` reads the `source.repo` field from the VFS issue payload and matches it against `byLabel` VALUES (not keys) — so an issue in `AgentWorkforce/relay` routes to `AgentWorkforce/relay` without needing a `relay` label. Intervening in labels mid-dispatch causes a race: the projection updates between the triage read and the dispatch live-read, triggering `LiveDispatchStateChangedError`. **Rule:** for GitHub-native Factory issues, only the `factory` readiness label is required; do not add or remove labels between filing and dispatch.

- **A shared env-var name with two owners is a defect, whatever each side does
  with it.** `AGENT_RELAY_BIN` means the *broker* binary in `relay`
  (`packages/cli/src/cli/lib/client-factory.ts:64`) and the *agent-relay Node
  CLI* in relayfile's Go CLI (`cmd/relayfile-cli/main.go:1160`). Relay exports
  it to every agent it spawns, so Relayfile's credential re-mint execs the Rust
  broker, fails on `unrecognized subcommand 'cloud'`, and reports
  "agent-relay CLI >= 8.7.0 required" against a CLI that is already 11.5.5 and
  already has the subcommand. A routine credential expiry became days of
  stalled Factory dispatch, and the error message sent the operator to a
  no-op upgrade. Two related rules: a fix that lands in one implementation of a
  path leaves the other one live — the TypeScript SDK was migrated off the
  shell-out and the Go CLI never was, which is also why grepping only the
  TypeScript found nothing; and a self-heal path that cannot succeed converts
  every transient failure into a permanent one.

- **Version the binary on each host before attributing a node's behaviour to
  its flags.** sf-mini accepted `fleet spawn` requests, returned a fully
  successful placement with `queued:false`, and launched nothing. The reported
  cause was its `--no-spawn` flag; the actual cause was `agent-relay-broker`
  3.0.0 against an 11.5.5 CLI, left behind by an upgrade that rolled back onto
  a bad artifact. finn-mini carries `--no-spawn` too and spawns fine — that
  control arm is what killed the flag hypothesis in one command. A node record
  reporting an old version may be reporting accurately rather than staling, and
  an obsolete broker still advertises capabilities it cannot honour, so the
  requester must confirm the launch rather than trust the placement response.

- **CI cannot see a cross-repo contract, so green means nothing about the seam.**
  Four instances surfaced in one morning (2026-08-14), every one with relay CI
  green: relay#1505 pinned relaycast as a git dep at the tip of an *unmerged
  draft branch*; relay#1504's added metadata field is rejected by relaycast's
  `.strict()` `FleetAgentRegisterMessageSchema`, so the broker silently falls
  back to HTTP pre-registration and the agent is never node-bound; the sponsor
  authority spans three repos with no gate between them; and **relay#1499 passed
  full CI, review and merge while calling
  `PATCH /v1/agents/:name/legacy-identity` — a route implemented in no branch of
  any repo.** The rule: when a change crosses a repo boundary, name the
  consuming side and check it exists, because nothing else will. A shared
  fixture asserted from *both* repos' CI (the relayfile#418 shape) is the cheap
  fix; making the two repos move together is not.

- **A test suite can be excluded by a comment that stopped being true.**
  `vitest.config.ts:78` excluded `packages/sdk/**` with the justification "Uses
  Node.js test runner, not vitest", while the file it excluded imports
  `describe/expect/it/vi` from vitest. Fifteen SDK test files, zero run by CI,
  for however long that comment had been stale — and the package's own `test`
  script enumerated 14 files by name out of 15, and nothing invoked it anyway.
  Prove a test is gated by collecting it *by name* (`npx vitest list`) and run
  the same command as a control against a file you believe is ungated; a check
  that returns the same answer either way proves nothing. When un-excluding a
  long-dark suite, record the current failures first — un-excluding first dumps
  unknown breakage on whoever does it and the change gets reverted, not fixed.

- **Workflow-level CI status hides a failed job inside a running workflow.**
  `gh run list --branch` reported `Test: in_progress` for a PR whose
  `Rust Tests (ubuntu-latest)` job had already failed; `gh pr checks` showed it.
  Check both — `gh run list --branch` to match headSha to headRefOid, `gh pr
  checks` for job-level truth. And pin every CI claim to the SHA it was measured
  on: at a few merges an hour, a "done" report goes stale within minutes, and
  green-on-old-base is not green.

- **An exhaustive-sounding negative is only as good as the ref list it searched
  — and a PR branch is a ref.** Chief grepped `legacy-identity` across relaycast
  `main`, the relaycast#324 branch and relaycast-cloud `main`, got three clean
  misses, and escalated "this route has never been written" to the principal and
  into the brain. It was written all along, in relaycast#325
  (`fix/legacy-identity-cas-0813`) — a fourth ref nobody had named. Every
  individual grep was correct; the enumeration was not. Before stating that
  something exists nowhere, list the refs searched *in the claim itself*, so the
  gap is visible to the reader rather than hidden in the conclusion. The
  accurate form of that finding was available and much less alarming: merged
  ahead of its server half, not built on sand.

- **A wedged event loop makes a broker unkillable, and it is on main today.**
  Shown by paired experiment, not inference: SIGSTOP the engine *after* a node
  is online, so the socket stays open and `agent.register` is simply never
  answered — no schema rejection, no error, just an unanswered frame. Healthy
  arm: `node agent list` returns in 495 ms, SIGTERM exits in 1517 ms. Stalled
  arm: `node agent list` **times out at 12002 ms** and SIGTERM leaves the broker
  **still alive at 45000 ms**. So a slow or stopped peer does not degrade one
  operation — it takes out the whole control plane of that broker and defeats
  ordinary shutdown. Any "is the node healthy" check that runs *through* the
  broker's own API inherits the wedge and reports nothing.

- **This org merges and forgets to ship.** Four instances in one day, each of
  which read as "done" to everyone involved: relay#1499 merged into main while
  calling a route that existed only in an unmerged relaycast PR; relayfile#417
  merged with npm still serving the broken 0.10.39; a relay release sitting
  unpublished with five merged fixes behind it, including the one cross-node
  attach needs; and relaycast#325 merged without a version bump, so the
  published `@relaycast/engine` 8.0.0 does not contain it and relaycast-cloud's
  lockfile still resolves to the old build. The failure surfaces downstream as
  a mysterious 404 or a stale binary, far from the merge that caused it.
  **A merge is not a fix. Before reporting something resolved, name the
  artifact a user would actually run and check its version.** Treat it as one
  release-hygiene problem, not four tickets.

- **A lane's own report that nothing is at risk is not evidence.** During a
  laptop shutdown, `relay-1431` reported "NOTHING AT RISK" and had **three
  unpushed commits** in its worktree — the entire rebase onto current main,
  existing nowhere else. The relay lead found them by looking *inside* the
  lanes' worktrees rather than collecting their self-assessments, and pushed
  them to a rescue branch. An agent cannot see its own exposure reliably: it
  reports on what it believes it did, not on what `git log @{u}..HEAD` says.
  Check the worktrees yourself. And when rescuing, push to a **rescue branch**
  rather than force-pushing over a PR branch under time pressure — reinstating
  it later is a decision that deserves a three-way diff, not a hurried
  `--force`.

- **Review-bot coverage must be verified per reviewer, against the merged
  head.** relay#1504 merged at `77c4de01e` with *neither* bot having seen it:
  CodeRabbit's last review was `d55682d15`, and cubic's only review was the
  branch's first sha from the previous day — it never reviewed again across ten
  pushes including the entire redesign. The unreviewed delta was the most
  consequential change in the PR. Twelve review comments in the timeline prove
  nothing if all twelve predate the head. The reviews API records `commit_id`
  per review: compare it to `headRefOid` before calling a PR reviewed, and note
  that CI passing is not review — CI could not see the wire contract that PR
  changed at all.

- **A rate-limited safety net announces itself and then silently does not
  fire.** An explicit `@coderabbitai review` was posted against the correct
  head; the bot replied 26 seconds later naming the exact change it would
  evaluate, then failed with "Review rate limited." The acknowledgement is what
  makes this dangerous — it reads as coverage. When rate limits are in play
  (GitHub GraphQL and CodeRabbit were both limited on 2026-08-14), any rule of
  the form "wait for X before proceeding" can become unsatisfiable without
  saying so. Verify the artifact, never the promise.
