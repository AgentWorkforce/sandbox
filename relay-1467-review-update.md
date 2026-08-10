Review follow-up is pushed at [`49f8ba3b`](https://github.com/AgentWorkforce/relay/commit/49f8ba3b2980a86abd982cac05aba7dab1008a71), confirmed as the remote branch head.

- Unresolved receipts now discard an untrusted raw response target; a target is emitted only from the independent exact directory resolution.
- CLI reader output now carries the same explicit `queued_or_unread` / `readConfirmed: false` signal as MCP.
- The changelog entry is split into short impact-first bullets. Its `[Unreleased - Patch]` heading is retained because the repository AGENTS.md explicitly requires it for the first pending patch entry.

Focused regressions, root typecheck, CLI lint, formatting/diff checks, and verified-secret scan all exit 0. GitHub Actions verification for this exact SHA is in progress. No merge was attempted.
