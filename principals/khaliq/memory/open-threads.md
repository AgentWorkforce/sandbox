# Open threads

- Verify `agent-relay node up` resolves the configured Cloud workspace after a
  full stop/start and preserves Chief's durable address.
- RelayAuth delegated token mint currently returns an upstream error. Chief's
  scoped senses use Cloud mount sessions until native delegation is repaired.
- GitHub integration sync health is degraded even though ingress events arrive;
  diagnose without disconnecting the working installation.
- Deploy the Cloud Factory brain persona, enable its reversible production
  flag, and prove one canary Linear issue reaches a GitHub-side agent run.
- Connect Khaliq's and Will's Chiefs in the same Relay workspace once Will's
  resident agent name is known.
- **Credential rotation batch (inherited from Will's 07-29 profile, still
  open).** Three live secrets were exposed and rotating them alone is not
  enough because the next boot re-leaks the new values: the broker API key
  (`br_…`, leaked by a raw `env` dump), and the workspace key (`rk_live_…`)
  plus agent token (`at_live_…`), which are passed in broker/claude process
  argv — world-readable via `ps` — and printed in plaintext into
  `~/Library/Logs/chief-node.log`. Needs a relay platform fix (pass secrets
  via env or file instead of `--mcp-config` argv, redact key values from
  node/broker logs) filed as an issue, then rotation. Owner: Khaliq's
  decision on whether this Chief files it or Will's already has.
- **Two brains in one repo.** Tracked top-level `memory/` + `journal/` is
  Will's pre-refactor profile; `principals/khaliq/` is the active brain. Decide
  whether Will's profile moves to `principals/will/`, is archived, or the repo
  splits — until then the boundary is convention only and a careless write
  corrupts the other principal's continuity.
- **Factory has no live instance.** Both registered instances (`AgentWorkforce
  cross-repo`, `factory`) have been offline/stopped since 07-23/07-24. Live
  dispatch is blocked on bringing one up, ahead of the persona/flag work.
- **Relay MCP tools are missing from the resident session.** The spawn brief
  says `mcp__agent-relay__send_dm` / `post_message` / `check_inbox` are
  available, but no `agent-relay` tools resolve in this session, so Chief
  cannot DM the broker, post to `#general`, or read its inbox — it can only
  answer whoever is attached to its PTY. Doctor reports `broker` OK with 1
  agent, so registration is fine and the gap is MCP wiring on the spawn path.
  This blocks Chief-to-Chief contact with Will's resident.
- **`principals/`, `schemas/`, `scripts/lib/`, and the new scripts are
  untracked.** The active brain has no git audit trail yet. Commit before
  treating any of it as durable.
