# Projects

- **Agent Relay** — agent-team infrastructure. The product story is teams over
  individual tools: one front-door agent coordinates specialized agents.
- **Chief** — Khaliq's front door. The active profile is this directory.
- **Relay workspace invariant** — one Agent Relay Cloud workspace resolves a
  durable Relaycast, Relayfile, and RelayAuth data-plane identity. Restarting a
  broker must not create a new Chief or lose its mailbox/history.
- **Relayfile senses** — Chief can read and write Linear, read GitHub, and read
  digests. This enforces Linear for humans and GitHub for agents.
- **Cloud Factory** — the gated bridge from expressed work to agent-owned
  GitHub branches and PRs. **Factory is surface-agnostic** (Khaliq,
  2026-07-31): it works from Linear, Notion, GitHub, or any future surface, and
  reconciles back to whichever one the task came from. Chief works *with*
  Factory and must not treat Linear as the definition of dispatchable work —
  Linear is simply the surface Khaliq drives today. Live evidence: Factory runs
  already carry both `source: "linear"` and `source: "github"`.
- **Chief owns one active Factory contract at `<chief>/factory.config.json`**,
  a per-machine copy of `factory.<principal>.config.json`. Factory resolves
  exactly `--config`, otherwise `./factory.config.json` in its cwd; it never
  searches target repos or walks to the clone root. Routing scope is declared
  inside the active contract's `repos` maps. `issueSource` selects the surface,
  and the same file carries `safety` (`requireLabel`, `requireTitlePrefix`,
  `requireTeamKey`), `linear.states`, `mergePolicy`, `terminalState`,
  `batchSize`, `babysitter`, `models`, `slack`, and `capabilities`. Three
  documented entry modes (`factory/README.md`): Linear-native; **GitHub-native**
  (`issueSource: "github"` — lifecycle comments and labels stay on the GitHub
  issue); and **GitHub-mirror**, where
  a `factory` label on a GitHub issue is mirrored into a `[factory]` Linear
  issue and dispatched through the Linear flow. Legacy per-repo files still
  exist but are independent configs selected only by cwd or an explicit path;
  their coordinated retirement is AgentWorkforce/chief#11.
- **Chief's former `work.factory` block was a Linear-shaped reimplementation
  of Factory's contract.** It was removed so the active Chief-owned contract is
  the only definition Chief reads. Keeping two definitions of "dispatchable"
  is how Chief came to assert a Linear-only model that the platform never had.
- **YC demo, 2026-08-06 — happened.** Agent Relay was demoed as a working agent
  *team*, using the product on our own workforce rather than a synthetic
  scenario. The live org chart was the centrepiece, rendering one real hierarchy
  — org → project → workstream → worker — with expandable top-level rows, IDs in
  metadata, and readable worker labels. Khaliq demoed variant 07 from the
  production Cloud dashboard, not the local `tools/orgchart/` tool. See
  `workstreams/yc-demo-org-chart.md` for what shipped and how it was verified.
- **Agent naming convention (Khaliq, 2026-08-06):** spawns are normalized at
  dispatch to `<project>-<workstream>-<role>`. Names like
  `codex/notion-portable-fleet-mount-20260806` are the pattern this replaces —
  they carry project, task, and date fused into one opaque string, which is why
  the org chart cannot place them in a tree. Inferring readable labels for
  existing agents is a compatibility shim, not the destination.
- **Watchdog** — prospective/design partner in Norway for an early proactive
  agent team deployment.
- **"Skip" — a customer-facing Chief-like persona (2026-08-13, from Khaliq
  directly).** Built for one of our customers, designed to live entirely
  cloud-hosted rather than needing a local machine presence the way Chief
  does. Its iMessage surface lives in the sibling `cloud` repo but is meant to
  be a **thin client only** — the actual Chief-equivalent logic/brain stays in
  the `chief` app, not duplicated into `cloud`. Continuity requirement: a
  customer starting a chat with Skip in cloud, continuing via Slack, then
  moving to a local surface should be one continuous session throughout, not
  three disconnected conversations — the same relayhistory continuation
  mechanism (computed internal relay session ID + jsonl transcript uploaded to
  relayhistory-cloud) is meant to carry this, working across both harness and
  machine. See `workstreams/relayhistory-continuity-proof.md` for the
  engineering effort proving this mechanism.
- **Full rebrand underway: "Chief" → "Skip" (2026-08-13 decision; build started
  2026-08-14 on Khaliq's explicit instruction).** This is the same product
  direction as the customer-facing Skip persona above: a Relayfile-native,
  cross-surface control plane backed by deterministic agents and a small cheap
  planning model pocket. It is registered at
  `workstreams/skip-deterministic-harness.md`. The harness contracts and
  dogfood supervision loop land before package/launch-label/external-copy rename
  mechanics, so the running Chief deployment remains compatible during the
  migration. The custom resident now combines five-minute workstream sweeps
  with one durable mostly deterministic agent per conversation thread; every
  confirmed agent dispatch carries a separate five-minute evidence follow-up.
  The cheap OpenCode/DeepSeek model is only an ambiguity pocket, not Skip.
- **Cloud dashboard information architecture, stated directly by Khaliq
  (2026-08-13):** Chief owns workstreams, and agents live nested *under*
  their workstream — not a flat list. Each agent entry in that nested view
  should be attachable/driveable directly. This means `cloud#3016`'s
  session-listing/attach-command feature (currently rendering on a separate
  `/dashboard/fleet` page) should integrate into the Chief page's
  workstream/agent hierarchy, not live disconnected on its own. Also reframes
  the "891 agents" flat/cluttered Organization tree found the same night — it
  needs restructuring around workstream grouping, not just a staleness/polling
  fix. Real prerequisite, not yet resolved: whether the data model has a real
  workstream field to group by, or whether this depends on the
  registration-metadata-write-path work already identified (agents need to
  publish their actual workstream at spawn time — see
  `workstreams/relayhistory-continuity-proof.md`'s cloud-dashboard entries).
