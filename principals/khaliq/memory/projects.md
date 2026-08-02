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
- **Factory's real contract is `factory.config.json` at the target repo root**,
  not anything Chief defines. `issueSource` selects the surface and the repo's
  own file carries `repos`, `safety` (`requireLabel`, `requireTitlePrefix`,
  `requireTeamKey`), `linear.states`, `mergePolicy`, `terminalState`,
  `batchSize`, `babysitter`, `models`, `slack`, and `capabilities`. Three
  documented entry modes (`factory/README.md`): Linear-native; **GitHub-native**
  (`issueSource: "github"` — lifecycle comments and labels stay on the GitHub
  issue, as `hoopsheet/factory.config.json` does); and **GitHub-mirror**, where
  a `factory` label on a GitHub issue is mirrored into a `[factory]` Linear
  issue and dispatched through the Linear flow. Repos with the file today:
  `factory`, `hoopsheet`, `pear`, `pear-residual`, `pear-wt-417-harness`,
  `factory-e2e-demo`.
- **Chief's `work.factory` block is a Linear-shaped reimplementation of that
  contract** and should be replaced by reading the target repo's
  `factory.config.json`. `chief` has no `factory.config.json` of its own.
  Keeping two definitions of "dispatchable" is how Chief came to assert a
  Linear-only model that the platform never had.
- **Watchdog** — prospective/design partner in Norway for an early proactive
  agent team deployment.
