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
- **Watchdog** — prospective/design partner in Norway for an early proactive
  agent team deployment.
