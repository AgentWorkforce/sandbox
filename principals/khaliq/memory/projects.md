# Projects

- **Agent Relay** — agent-team infrastructure. The product story is teams over
  individual tools: one front-door agent coordinates specialized agents.
- **Chief** — Khaliq's front door. The active profile is this directory.
- **Relay workspace invariant** — one Agent Relay Cloud workspace resolves a
  durable Relaycast, Relayfile, and RelayAuth data-plane identity. Restarting a
  broker must not create a new Chief or lose its mailbox/history.
- **Relayfile senses** — Chief can read and write Linear, read GitHub, and read
  digests. This enforces Linear for humans and GitHub for agents.
- **Cloud Factory** — the gated bridge from ready Linear work to agent-owned
  GitHub branches and PRs.
- **Watchdog** — prospective/design partner in Norway for an early proactive
  agent team deployment.
