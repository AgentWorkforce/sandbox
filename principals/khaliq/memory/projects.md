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
- **Watchdog** — prospective/design partner in Norway for an early proactive
  agent team deployment.
