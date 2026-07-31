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
- **Will's Chief needs its `brainRoot` repointed.** His brain moved from the
  repo root to `principals/will/` on 2026-07-30 (Khaliq's call). Nothing in
  this repo referenced the old paths — skills and scripts are all
  `<brainRoot>`-relative — but if Will's resident runs from its own config, that
  config still points at the root and must be updated before it writes again.
- **A second writer is active in this repo.** `scripts/factory-control.mjs`,
  `.claude/settings.json`, and edits to `scripts/chief-doctor.mjs` all appeared
  mid-session while the resident was online. Harmless so far — all tooling, no
  brain writes — but §7 assumes one writer, so confirm who owns the maintenance
  shell before trusting the working tree mid-task.
- **Relay MCP server times out at Chief's spawn.** Root-caused 2026-07-30: the
  broker does pass a correct inline `--mcp-config` declaring an `agent-relay`
  stdio server, but it launches as `npx -y agent-relay mcp`, and the launch
  exceeded Claude Code's 30s MCP connect timeout, so the resident session came
  up with no relay tools at all — no `send_dm`, `post_message`, or
  `check_inbox`. Chief can then only answer whoever is attached to its PTY, and
  Chief-to-Chief contact with Will's resident is impossible. Evidence:
  `~/Library/Caches/claude-cli-nodejs/-Users-khaliqgant-Projects-AgentWorkforce-chief/mcp-logs-agent-relay/`.
  Fix in relay: spawn the installed binary (`~/.agentworkforce/relay/bin/agent-relay`
  or the PATH entry) instead of paying npx package resolution on every spawn,
  and/or raise the connect timeout. Secondary: `.claude/settings.json` allows
  `mcp__relaycast__*`, not `mcp__agent-relay__*` — confirm which server name is
  canonical.
- **AR-448 was implemented twice and both PRs are open.** Relay #1402
  (`feat/ar-448-…`, khaliqgant, +959) and #1403 (`feature/ar-448-…`, kjgbot,
  +522) are independent implementations of the same issue, and both edit
  `packages/cli/src/cli/commands/workspace.ts` and its test, so they cannot
  both merge cleanly. #1402 goes wider (broker lifecycle plus a cloud
  convergence test); #1403 ships a `specs/durable-workspace-identity.md` and a
  separate `durable-workspace-identity` lib. Two more open relay PRs sit in the
  same code: #1412 (one broker-workspace precedence ladder) and #1413 (Cloud
  workspace IDs discoverable from the CLI). Khaliq picks one lineage before any
  of the four merges. Root cause to fix: nothing stopped a second agent from
  claiming an issue that already had an open PR.
- **Workspace keys leak through observer links too.** `agent-relay node status`
  prints `https://agentrelay.com/observer?key=rk_live_…` in plaintext — a
  channel the 07-29 rotation batch did not cover. Relay PR #1405 (`fix(plugins):
  stop exposing workspace keys in observer links`) is open and addresses it;
  confirm it covers the CLI status path, not only plugin output.
- **AR-448's Linear checkpoint is written but unposted.** Relay PR #1402 is
  open (2026-07-31). The checkpoint body is staged at
  `factory-tasks/ar-448-pr-opened-checkpoint.md` and
  `npm run factory:comment -- AR-448 <body-file> [key]` now exists to post it,
  but every attempt fails at `500 mount_session_failed` when minting a senses
  session — the same RelayAuth capacity problem blocking fresh scoped
  credentials. The comment command's writeback path (draft → receipt) has
  therefore never executed against a live mount; only its argument and body
  validation are verified. Trigger: once `npm run doctor` shows the mount
  healthy, run
  `npm run factory:comment -- AR-448 factory-tasks/ar-448-pr-opened-checkpoint.md ar-448-pr-1402-opened`,
  confirm the receipt, then move AR-448 out of `Ready for Agent`.
