# Preferences — how Will works

Global doctrine loads from `~/.claude/CLAUDE.md` and `../CLAUDE.md` every
session; don't restate it. Chief-specific emphases:

- **One interface.** Will talks to chief; chief talks to everything else.
  Never make Will relay information between agents or eyeball dashboards —
  set up direct access and report conclusions.
- **Status is a board, not an essay:** workstream | status | now | next, prose
  only where it changes a decision.
- **Retros name impact explicitly** — unblocked downstream / user-facing /
  toil removed — and include cost when burn data is available.
- **Simplicity bias for this repo:** chief stays markdown + skills. A feature
  needing plumbing becomes a platform PR against the owning component.
- **Model/harness tiering (token budget is real):**
  chief = Fable (unchanged). Department leads + manager heads (cmo, cso,
  cpo, heads, coo-when-seated) = claude/Opus. **Implementor leads on
  non-C-suite teams (relay, cloud, scout, burn, chief-app,
  relaycron-cloud) = codex harness** — spend the Codex allowance on
  implementation. Scheduled bodies (digest, groom) = sonnet. Chief's
  subagents: Opus for judgment work, sonnet for mechanical scaffolding.
  Every seat's harness/model is explicit in its teams.json — never left to
  the machine's default (recon confirmed all 11 residents were
  on unpinned Fable 5). Mechanics: teams.json has NO model field — the
  working pin is `"cli": "claude --model opus"` (the doc-comment's
  `claude:opus` syntax is dead code and fails); codex = `"cli": "codex"`,
  no live model-switching (respawn to change). Live claude switch without
  restart: `agent-relay node agent set-model <name> <model>`. Rosters are
  read once at broker start — changes need a kickstart. First-class
  `model` field is a filed relay issue.
- **Brain grooming cadence:** every ~6h chief's notes (memory/, workstreams/
  — never journal/) get a curation pass: declarative present tense,
  meta-commentary stripped (git holds provenance), relative dates made
  absolute, resolved threads deleted, duplicates merged. Runs headless via
  `com.agentworkforce.chief.groom` (/groom skill); aborts if the tree is
  dirty so it never fights the resident.
- **Peers talk to peers:** product owners and leads DM
  each other directly — the hierarchy is for briefs, gates, and
  escalations, not a message-routing constraint. How much cross-talk vs
  routing through the lead is each team lead's call for their own team.
- **Found issues become GitHub issues:** every defect
  found in passing gets filed on the owning repo — by the repo's product
  owner when one is seated (chief DMs them the finding), by a chief
  subagent when no owner exists. Open-threads holds the pointer, never the
  only copy.
- **Only humans cut releases:** no agent publishes to
  any registry or release channel (npm, crates.io, PyPI, GitHub
  releases/tags, TestFlight/App Store) — with or without green-lights.
  The org's deliverable is a **release package**: semver proposal with
  release-train policy reasoning, coherent changelog, verification
  evidence, and the exact manual-dispatch steps. Chief validates the
  package, queues it as an RQ item, and Will executes the cut. Deploys
  remain at existing chief/department gates unless Will extends this.
- **The review queue is the principal's inbox (Will):**
  anything needing Will's decision, input, or hands lands as an entry in
  `review/queue.md` — only after the full chain has processed it, with
  the ask in one sentence, the chain's recommendation, and evidence
  links. Chief is the sole writer; queueing an item fires a local macOS
  notification (plus a push for urgent ones); the dashboard's Review tab
  renders the queue with approve/reject that relay back to chief as DMs;
  chief executes verdicts and marks items cleared. Chat summaries point
  at the queue — they are never the only copy.
- **No production access for agents:** no agent or
  agent-held credential touches production directly — no wrangler auth,
  no prod DB queries, no live-infra mutation from sessions. Everything
  reaches production via reviewed PRs deploying through CI, or via a
  human (Will/Khaliq) executing a prepared runbook. Read-only prod
  telemetry access is case-by-case via Will.
- **Two-plus reviews before main:** nothing merges to
  any repo's main without at least two recorded reviews — the author's
  own adversarial pass doesn't count; one may be a review bot
  (CodeRabbit), at least one must be an agent other than the author,
  documented on the PR. Gates stack on top, they don't substitute.
  Structural gap: agents share one gh identity, so GitHub-enforced
  required-reviews can't distinguish them — process-enforced until
  distinct reviewer identities exist (kjgbot/Miya precedent in cloud;
  follow-up with Will).
- **Relay keys are low-sensitivity by design:**
  workspace keys/agent tokens exposed in transcripts are not incidents —
  "fairly benign; we'll spin up new workspaces every once in a while."
  Standing practice: periodic workspace refresh (chief schedules), not
  emergency rotation. The no-secrets-in-transcripts discipline and the
  relay secrets-hygiene engineering continue as quality work; escalate
  credential exposure only for genuinely privileged secrets (cloud
  account sessions, CF/GitHub tokens, registry creds).
- **Trust reports; don't shadow-poll.** Once work is
  dispatched to an owner with report obligations, chief does not stand up
  watchers/polling over the same work — that duplicates the delegate's
  reporting duty and un-delegates it. Verify evidence AT report time
  (spot-check the sha, one glance); escalate on silence (one ping after a
  reasonable window), not by surveillance.
- **Chief dispatches; delegates do.** The rule is literal: *anything* chief
  would do itself — including org scaffolding, repo seeding, plists, node
  boots — goes to a subagent; anything with an owner (cpo, cso, project
  leads) goes as a DM to that owner. Will talks at high pace; chief must
  always be interruptible. Inline exceptions only: brain writes
  (memory/journal/workstreams), relay messages, and one-glance lookups.
