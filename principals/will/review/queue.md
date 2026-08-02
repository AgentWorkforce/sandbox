# Review queue — items needing Will

One entry per item. Items enter ONLY through the chain (lead → head →
department → chief) after the team has fully processed them — an entry
means "the org has done everything it can; your call changes what happens
next." Chief is the sole writer; verdicts arrive as dashboard clicks
(relayed to chief as DMs) or in conversation, and chief executes + marks
cleared. Statuses: pending → cleared(approved | rejected | answered).

## RQ-1: Cloudflare re-auth (unblock)
- status: cleared(rejected) 2026-07-30 — Will: no production access for
  agents or this machine; anything needed happens via CI/review process.
  D1 mitigation routes through reviewed PRs deploying via CI, or through
  Khaliq (human, owns the durable fix). Cloud's cred-contingent sweep
  pre-auth is void.
- date: 2026-07-29
- from: cloud → chief (live prod incident)
- ask: run `wrangler login` (browser, ~2 min) — every CF credential on
  this machine is dead.
- why-you: only you can OAuth.
- on-done: unblocks D1 fill telemetry + the pre-authorized emergency
  sweep for the relayauth capacity incident; also PostHog MCP OAuth as an
  optional second.

## RQ-2: GitHub integration reconnect on rw_7ccfea89 (unblock)
- status: pending — exact steps sent to Will via voice 2026-08-02 (login →
  `workspace join rw_7ccfea89` → `integration connect github` → verify;
  full command sequence in the voice thread)
- date: 2026-07-29
- from: burn → cpo → chief
- ask: repair/reconnect the GitHub relayfile integration on the "Default"
  Relay workspace (~3 min browser).
- why-you: workspace owner; agent identities are forbidden from SDK
  reconnect.
- on-done: burn's factory issue-discovery loop goes live — label an issue
  `factory` and it runs to a reviewed PR.

## RQ-3: relayfile provisioning retry (unblock)
- status: pending
- date: 2026-07-29
- from: cso/senses-mount → chief
- ask: `relayfile login --provision-messaging-only` then
  `relayfile integration connect slack` (retry on 500 — it flaps in
  ~5-min windows until the D1 capacity fix).
- why-you: browser OAuth.
- on-done: cso's watchlist seeds from #research-market; chief's GitHub
  senses follow; gmail/granola connects become possible.

## RQ-4: Granola plan tier (decision)
- status: pending
- date: 2026-07-29
- from: chief (granola-senses research)
- ask: upgrade Granola to Business (API keys → full transcript pipeline +
  push phase) or stay free-tier (MCP fallback: 30-day window, pull-only,
  no dogfood)?
- recommendation: upgrade if cost is tolerable — meetings/self-notes are
  chief's biggest blind spot and the push phase only exists on that path.

## RQ-5: Interview-prep facts (input)
- status: pending
- date: 2026-07-29
- from: coo workstream (YC decision due by 08-28)
- ask: three facts only you hold — the Tailwind ARR figure that shipped
  in the application ("eight-figure" vs "~$7M"), the "agents" metric
  definition (active vs created), runway (bank + monthly spend).
- on-done: answers land in coo's interview-prep file, not chief's brain.

## RQ-6: URGENT — rotate leaked credentials (decision reversal)
- status: cleared(answered) 2026-07-30 — Will: "I'm generally not worried
  about exposing the relay keys. They are fairly benign. We'll spin up new
  workspaces every once in a while and it'll be fine." No rotation;
  periodic workspace refresh is the standing policy. Secrets-hygiene
  engineering (relay#1379/#1380) continues as product quality, not
  incident response.
- date: 2026-07-30
- from: relayfile + head-of-ecosystem + cpo (security escalations, overnight)
- ask: the deferred rotation batch is no longer deferrable — overnight,
  a live `rk_live_` workspace key + `at_live_` agent token were printed
  into a Codex tool transcript (third-party conversation store), and a
  `--reveal-token` probe separately captured the live `cld_at_` cloud
  session token. Approve immediate rotation.
- your-part: `agent-relay cloud login --force` (rotates cld_at_, one
  command) + approve chief running the coordinated rk_live_/at_live_
  rotation op (new key, re-seed all node state dirs, rolling restarts
  with pull-nudge protocol — plan ready, ~30 min fleet disruption).
- on-approve: chief executes the fleet rotation; vendor-retention
  question (OpenAI store deletion request) comes as a follow-up decision.

## RQ-7: Codex allowance — top up or re-tier (decision)
- status: cleared(answered) 2026-07-30 — Will reset the codex usage;
  tiering stands as-is. Relay's seat stays on its claude revival until
  the next natural respawn (roster remains codex). Burn tasked with the
  spend forensics.
- date: 2026-07-30
- from: chief (Will observed the spend; multiple codex seats frozen)
- ask: the codex allowance is ~exhausted (overnight autonomous work +
  the 15-min pull cadences — now retired in favor of watchdog-triggered
  nudges). Top up codex, or re-tier some implementor seats to
  claude/sonnet, or let codex seats idle until the quota resets?
- recommendation: retire cadences (done), keep seats idle today, top up
  if the price is right — and relay's seat temporarily back to claude to
  finish the release package if you want the terminal fixes shipped today.

## RQ-8: Test-drive Agent Relay Mobile (ready for you)
- status: pending
- date: 2026-07-30
- from: mobile → head-of-ecosystem
- ask: the verified runbook is on main —
  https://github.com/AgentWorkforce/mobile/blob/main/docs/RUNNING.md
  (clean clone → Xcode → Simulator; CI green at 14c2ddaf). Shell/design
  review only — no live account until the platform gaps close.

## RQ-9: Test-drive chief-app (ready for you)
- status: pending
- date: 2026-07-30
- from: chief-app → head-of-ecosystem
- ask: docs/RUNNING.md merged to main (bb8f785): fresh clone → XcodeGen
  → unsigned Mac build → launch; 89/89 tests + launch verified. Honest
  limitation: sign-in fails closed (device-session provisioning not yet
  composed) — no live chat with chief yet; UI/shape review only.

## RQ-10: Distinct GitHub identities for agent reviewers (decision, non-urgent)
- status: pending
- date: 2026-07-30
- from: chief (follow-up to the two-reviews law)
- ask: your 2+-review rule can't be mechanically enforced while every
  agent acts as willwashburn on GitHub — approvals from the author's own
  identity don't count, and branch protection can't distinguish agents.
  Approve creating distinct machine/bot accounts for reviewer agents
  (kjgbot/Miya precedent already exists in cloud), or accept
  process-enforcement indefinitely.
- recommendation: 2-3 bot accounts (reviewer pool) + branch protection
  requiring 2 approvals on main across the org's repos; also advances
  the mergedBy-attribution problem (relay#1388 family).
- cost note, REVISED TWICE (cpo + cmo measurements, 2026-08-02):
  branch_policy is VERIFIED free on private repos (notesnumber has one,
  org plan Free). Required reviewers: ZERO instances exist anywhere in
  the org — public repos included (relay is public with four
  environments, no protection rules on any) — so both the "free on
  public" and "needs Enterprise on private" claims are inferences with
  no known-positive; the first attempt to add one is the experiment,
  and a refusal is a finding, not a botched runbook. The plans-docs
  read still precedes any money moving. Also on the table, priced at $0: making a repo public buys the
  full mechanical gate — but publishing is irreversible where paying is
  not, so both options go to you together or the choice is rigged.
  BINDING meanwhile (cpo): where the protection cannot exist on the
  current plan, `environment:` must NEVER be attached to that repo's
  workflows — a referenced environment auto-creates unprotected, and
  there it would be permanent, not a sequencing step.
- cost of deferral, CORRECTED (cmo retraction, 2026-08-02): the earlier
  "reviewer supply is the binding constraint" was inference — measured,
  capacity existed (four cross-portfolio review asks accepted in twenty
  minutes); what was missing was permission to reach across portfolios,
  fixed by one ruling at no cost. The measured binding constraints on
  the ~16 open / 0 merged state are: (1) head churn — six review
  objects destroyed in ninety minutes by two *correct* fixes, only
  controlled by the pre-push-notice convention; (2) scope — nothing
  records what a review looked at (relayfile#390 reads 2/2 at head
  while the wider coverage died with earlier heads); (3) the silent
  author==requestee request drop. The identity decision here fixes (3)
  outright and makes (1)/(2) auditable. A three-portfolio board (with
  RQ-14's tiered load applied, not the raw count) is incoming from
  head-of-ecosystem.
- the sharpest form of the problem (cso via cpo, narrowed twice by
  head-of-ecosystem 2026-08-02): under one shared login, "zero valid
  reviews at head" is measurable by exclusion, but "two valid reviews
  from distinct agents" is attested, never measured. AND the
  unmeasurability is DIRECTIONAL — it disables merge authorization and
  leaves blocking authority fully intact (a P1 is a claim about the
  artifact, true regardless of who wrote it; every documented identity
  failure bites toward CLEARING a PR, none toward HOLDING one). So the
  accurate ask: per-agent identities do not unblock finding problems —
  they unblock concluding there are NONE. The org has been blocking
  correctly all day on the intact half; what it cannot do is show a
  clean bill mechanically. And the 422 is
  narrower and worse than first reported — measured: a non-author's
  COMMENT posts fine; ONLY the adverse event (REQUEST_CHANGES) is
  refused. The platform permits an agent to agree and refuses to let
  it disagree — a gate whose only machine-readable verdict is the
  favourable one is not a weak gate, it is a gate that can only ever
  pass. (APPROVE deliberately untested: neither measuring seat would
  fake a verdict to probe a gate — untested is not a negative result.) The merge gate rests on
  attestation until this decision lands; every gate-met statement now
  says "attested" in the record. Live demonstration on agentrelay.com#38:
  two valid, at-head, distinct non-author reviews, BOTH requesting
  changes, both forced to state COMMENTED — a mechanical gate prints
  GATE MET (2/2) on a PR two reviewers say must not merge. Second,
  opposite-pointing failure mode (relay#1405, 2026-08-02): a network
  retry loop posted nine identical non-deletable review objects in
  under two minutes — each at-head, non-empty, attributed — so a
  mechanical counter reads eleven reviews on a PR that has two.
  Identities fix neither alone: the gate needs body-read verdicts and
  dedupe-by-attributed-identity, both of which are human/process
  today.
- SEPARATE and NOT resolved by this decision (head-of-experiments via
  cpo — do not mark it done when identities land): our agents are
  countable and indistinguishable; bots are distinguishable and
  uncountable — so a mechanical gate can only ever confidently count
  the reviews it must EXCLUDE. Per-agent identities fix the first
  clause and leave the second exactly where it is; notesnumber#18/#19
  (two distinct real bot logins, every mechanical clause passing,
  countable zero) will still read as two-distinct-reviewers to any
  counter after identities ship.

## TOP — one interruption, two settings-page actions (~4 min total)
RQ-12 and RQ-13 are both "a human in a GitHub settings page for two
minutes," and both must be done by a human for the same reason: a gate
or repo an agent creates is one an agent can delete. Priority order
(cmo's argument, accepted): **RQ-12 first** — it protects a record that
already exists and is unbacked (cpo at 537 commits by 13:30Z, from 486
this morning,
today's entire cross-department reasoning stored nowhere else; every
local git signal reads healthy, so the failure is silent until total).
RQ-13 second — it creates a control that doesn't yet exist. Do both in
one sitting; each has a read-back verification step in its entry.

Also in front of you from the same morning (decision optional, default
in motion): the fleet's 17 node log files carried 71 lines of live
workspace/agent keys and were world-readable (installed plists predate
the code's /dev/null fix). Chief contained at 12:44Z — all 17 now
0600, nothing deleted. Under your standing key policy the rotation
(periodic workspace refresh) rides the chief#7 fleet boundary (next
relay patch upgrade or 2026-08-09). Say the word to pull it earlier;
cpo's position, on record: world-readable persistent disk files may be
a different containment boundary than the transcript class your ruling
covered — the world-readable half is now closed either way. Rotation
scope BOUNDED (cso derivation, 2026-08-02, counts only): the 71 lines
are THREE distinct rk_live_ workspace keys repeated across nodes —
zero agent/node/observer/enrollment tokens anywhere — so the op is at
most three workspace refreshes, and the boundary op starts with a
liveness check of the three values against the active stores (a dead
key needs no rotation; distinct-by-string could over- or under-count
by one if a rotation already happened).

## RQ-14: tier the two-review law by irreversibility? (decision)
- status: pending — flat-two (with the bot-body counting ruling)
  remains in force until you rule
- date: 2026-08-02
- from: cpo (ruling escalated as a change, with revert offered)
- ask (FINAL FORM 2026-08-02, durable in cpo's charter at 1c7ffde —
  two amendments in an hour told cpo the enumeration was the wrong
  shape, so the list is replaced by the axis): **ONE review for
  changes whose effects stop at the repo boundary; everything that
  leaves and gets acted on is TWO.** Illustrations, not the rule:
  publishes/releases/deploys/credential surfaces leave; charters and
  instruction files leave (agents read and act); published docs and
  advisories leave (users read and act — every credential advisory is
  a docs change); comments, tests, notes, non-executing config,
  descriptive prose stop at the boundary. All revert-able, which is
  exactly the trap — ask what the artifact REACHES, not what format
  it is in. Author never reviews; attribution unchanged.
- chief's recommendation: ADOPT AS AMENDED, with one remaining
  amendment of mine — keep your recorded "one may be a review bot"
  clause: on the two-review tier, a distinct-login bot's review body
  may still serve as the second leg (agent leg mandatory; the body
  must actually be read — a bot leg is countable only after its
  verdict is read, since a green check can wear a blocking body).
  cpo's original "bots never count" contradicts the law as you set it.
- FORMAL COUNTER-POSITION on the bot clause (cmo, 2026-08-02, raised
  as a challenge and preserved for your explicit ruling): a bot is
  identifiable but not ACCOUNTABLE — it cannot declare independence,
  cannot be asked what it covered, cannot be held to a scope
  statement, so a clearance-attestation from one is not an attestation
  by a principal. Evidence: Cubic reported pass while its own at-head
  body carried a blocking P1; two distinct-login bot reviews produced
  a countable zero on notesnumber#18 pre-ruling; unread bot bodies are
  unopened findings. cmo warns the bot leg will be reached for exactly
  when human review is scarce. Chief's disposition pending your call:
  the clause stands as your recorded law; any portfolio may run
  stricter locally (your "gates stack, they don't substitute").
  The earlier dissents (cmo's charter-effect argument, cso's
  published-content clause) are RESOLVED — cpo adopted both into the
  proposal above, each argued by a seat against its own interest.
- on-decide: cpo reverts to flat-two on objection; on adoption the
  co-signed cmo + head-of-experiments supply board shows the true
  remaining two-review load.

## RQ-12: cso + cpo have no git remote — create private repos? (decision)
- status: pending — ELEVATED above RQ-13, 2026-08-02 (cmo)
- date: 2026-08-02
- from: cso (session-start finding, verified: 2 of 107 repos lack origin)
- ask: cso's and cpo's brains (watchlist/, escalations.md, ecosystem/) are
  single-copy on this disk — one disk failure from gone. Approve creating
  private GitHub repos AgentWorkforce/cso + AgentWorkforce/cpo as push
  targets? (cpo measured 486 commits this morning; head-of-ecosystem
  re-measured 504 by midday — growing ~9 commits/hour, including today's
  verified-facts, holds, and identity findings, all existing nowhere
  else.)
- why-you: visibility is the decision — cso is competitive intelligence on
  named companies; pushing anywhere is an outward-facing act. cso
  explicitly declined to pick a target itself.
- recommendation: private org repos, same as every other department;
  cso/cpo push the moment you name the target.
- fourth consequence (cpo, 2026-08-02): scout's stale-base safety check
  (`git diff origin/main` before announcing a head) is unrunnable in a
  repo with no remote — the no-remote state disables a fleet safety
  rule, not just backup.
- the *when* argument (cmo via cpo, 2026-08-02): the push window is a
  resource currently being spent — today is the second consecutive day
  where "can we reach the remote" answered "some of us, sometimes,"
  and a disk-only repo has no margin the moment the window and the
  disk fail together. The decision is cheap now and may not be
  executable later.

## RQ-13: agentrelay.com production gate — confirm khaliqgant, run 90-sec setup (decision + tiny action)
- status: pending
- date: 2026-08-02
- from: cmo → chief (part of the #38 / merge=deploy work)
- ask: (1) confirm `khaliqgant` as the required reviewer on a new
  `production` environment for AgentWorkforce/agentrelay.com — your own
  identity is structurally void as a gate because every agent
  authenticates as `willwashburn` (the gate would be approvable by the
  thing it gates), and the `claws` team is four bot accounts; Khaliq is
  the only other human identity. (2) A human (you or Khaliq) creates the
  environment + protection rule — an agent-created gate can be
  agent-deleted, so this step is deliberately not automated. The
  click-path runbook is in #42. Expectations, updated (cmo sweep +
  agentrelay-com docs read, 2026-08-02): branch_policy verified free
  (org positive instance); required reviewers on a PUBLIC Free repo
  settled AVAILABLE by GitHub's official docs — agentrelay.com
  qualifies — though no org instance exists yet, so keep the
  stop-and-report step (a refusal now would be a bug, not an unknown).
  FOURTH mandatory step: disable admin bypass and read back
  `can_admins_bypass == false` — it is ON by default, the REST PUT
  does not expose it (UI only), and an admin-bypassable gate is void
  here because every agent holds the admin identity. The private-repo
  tier question stays open only for private repos (RQ-10 cost note).
- ordering: the workflow PR adding `environment: production` (#42, holds
  the runbook at 9611723a — reviewer, prevent-self-review, main-only
  deployment policy, each with an API read-back, plus the
  required-reviewer-may-refuse caveat) merges only
  AFTER `gh api …/environments`
  reads back non-empty protection_rules — a referenced-but-absent
  environment is auto-created UNPROTECTED on first run, which would
  manufacture a phantom gate and deploy through it. Repo is public, so
  this needs no plan upgrade (unlike the private repos in RQ-10's cost
  note).
- setup must also restrict the environment's deployment branches to
  `main` (agentrelay-com, 2026-08-02; sharpened by cpo): a required
  reviewer answers WHO, never WHAT — `workflow_dispatch` checks out the
  triggering ref, so an approval without a branch policy is a genuine
  human attestation whose subject is chosen by whoever triggered the
  dispatch. Worse than an unprotected environment. Three stages, in
  order, each read back: protect the environment → add the main-only
  deployment branch policy → only then merge the workflow that names
  `environment:` in its jobs.
- recommendation: confirm khaliqgant; run the setup when the runbook
  lands.
- reachability rider (cpo via head-of-ecosystem, 2026-08-02): a gate
  enforced by withholding approval is only as good as the approver's
  reachability — before naming khaliqgant sole approver, confirm with
  Khaliq what turnaround he can carry (or pair the gate with an agreed
  escalation for when he's unreachable). khaliqgant is verified live on
  GitHub (authors PRs, receives review requests) and is the one identity
  no agent can impersonate.

## RQ-11: Creator-partnerships material in cmo — yours? (FYI, non-blocking)
- status: pending
- date: 2026-07-31
- from: cmo → chief
- ask: 19 untracked files in cmo (1,109 lines: sponsorship playbook,
  scorecard, ICP tiers, templates, exclusions, plus a 78-account scored
  outreach sheet with contact emails) predate cmo's first session —
  authorship unknown, possibly yours. Chain ruling already executing:
  strategy docs commit to cmo; the 78-account list + any outreach become
  a scout campaign with contact data in scout's CRM store, never a
  committed CSV. Redirect only if you authored it and want it elsewhere;
  silence means proceed.
- recommendation: proceed as ruled; nothing blocks on this.
