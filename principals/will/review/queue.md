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
- cost note (cmo, 2026-08-02): environment required-reviewer rules are
  free on public repos but need GitHub Enterprise on private ones — the
  org's private repos (cmo, cpo/cso once pushed) can't get that control
  without a plan decision. Branch-protection review counts are separate
  and remain available; factor this into the pick.
- cost of deferral, measured (cmo + head-of-experiments, 2026-08-02):
  eleven open PRs across two portfolios at zero merges, with reviewer
  supply the binding constraint. Chief's counting ruling (bot review
  bodies count as the second leg) relieves roughly half; the rest is
  this decision. A co-signed supply board is being produced as one
  artifact.
- the sharpest form of the problem (cso via cpo, 2026-08-02): under one
  shared login, "zero valid reviews at head" is measurable by exclusion,
  but "two valid reviews from distinct agents" is attested, never
  measured — no query can distinguish a non-author's review from an
  author's self-review, and a reviewer cannot even record a rejection
  (GitHub 422s REQUEST_CHANGES as self-review). The merge gate rests on
  attestation until this decision lands; every gate-met statement now
  says "attested" in the record.

## RQ-12: cso + cpo have no git remote — create private repos? (decision)
- status: pending
- date: 2026-08-02
- from: cso (session-start finding, verified: 2 of 107 repos lack origin)
- ask: cso's and cpo's brains (watchlist/, escalations.md, ecosystem/) are
  single-copy on this disk — one disk failure from gone. Approve creating
  private GitHub repos AgentWorkforce/cso + AgentWorkforce/cpo as push
  targets?
- why-you: visibility is the decision — cso is competitive intelligence on
  named companies; pushing anywhere is an outward-facing act. cso
  explicitly declined to pick a target itself.
- recommendation: private org repos, same as every other department;
  cso/cpo push the moment you name the target.

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
  environment + protection rule — ~90 seconds; an agent-created gate can
  be agent-deleted, so this step is deliberately not automated.
  agentrelay-com is preparing the click-path runbook.
- ordering: the workflow PR adding `environment: production` (#42, holds
  the runbook at d17fd465 — includes reviewer, prevent-self-review, and
  main-only deployment policy, each with an API read-back) merges only
  AFTER `gh api …/environments`
  reads back non-empty protection_rules — a referenced-but-absent
  environment is auto-created UNPROTECTED on first run, which would
  manufacture a phantom gate and deploy through it. Repo is public, so
  this needs no plan upgrade (unlike the private repos in RQ-10's cost
  note).
- setup must also restrict the environment's deployment branches to
  `main` (agentrelay-com, 2026-08-02): `workflow_dispatch` accepts
  arbitrary refs, so a required reviewer alone gates who approves but
  not what ref deploys — without the branch restriction the gate is
  bypassable from any branch.
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
