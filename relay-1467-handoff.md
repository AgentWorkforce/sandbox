Implementation is pushed at commit [`3698f0f7`](https://github.com/AgentWorkforce/relay/commit/3698f0f7f6a34fae69d6cf3d81097fb1dc74b0f5) on `fix/relay-1467-dm-delivery`.

What changed:

- `send_dm` now returns an explicit delivery receipt instead of letting a message ID imply delivery. The receipt says `queued_unconfirmed`, names the effective `wait`/`steer` mode, includes requested and resolved recipient names plus `recipientMatched`, and explicitly says reading is not confirmed.
- MCP and CLI independently resolve the exact named recipient from the workspace directory before sending, so the send receipt can assert that the resolved recipient equals the request without trusting a request echo.
- `get_message_readers` keeps the existing `readers` array and adds a `delivery` signal: `read` for a non-empty list and `queued_or_unread` for an empty list.
- CLI send output exposes the same additive receipt. `wait` versus `steer` is documented in MCP schemas, CLI help/README, TypeScript and Python SDK docs, and both bundled Relay skill copies.
- A defensive regression proves a receipt that actually names `chief` for a `chief-khaliq` request reports `recipient_mismatch` rather than success.

Red/green evidence by exit code:

- New regression check before implementation: **exit 1** (4/4 failed).
- Changed MCP/CLI test set after review follow-up: **exit 0** (32/32 passed).
- Full SDK suite with lane-injected telemetry identity variables removed: **exit 0** (163/163 passed).
- Root monorepo typecheck: **exit 0**.
- CLI lint: **exit 0**, no errors (76 existing warnings).
- Broker wait-mode idle gate test: **exit 0**.
- Broker steer-mode immediate-bypass test: **exit 0**.
- Formatting and `git diff --check`: **exit 0**.
- TruffleHog verified-secret scan over every changed file: **exit 0**, zero verified secrets.
- Runtime dependency audit: **exit 1** on the repository's existing backlog (11 findings); this branch changes no dependencies.

`relay#1466` is not claimed here: repository discovery found no local mention tokenizer. Channel text and the server-populated mention receipt cross the Relaycast API, so that issue is a different resolution path. This branch only adds defensive recipient-mismatch signaling where a response supplies a different resolved recipient.

Veto MCP tools and a local `veto` executable were unavailable in this lane, so the equivalent repository-native type, lint, test, diff, and secret gates above were run manually. No merge was attempted.

Review follow-up commit [`0f9a6201`](https://github.com/AgentWorkforce/relay/commit/0f9a6201f11a179247220ee78ef43610fe207a2d) fixes the automated P2 about request-echo resolution: missing exact names now fail before send, directory-unavailable receipts say `recipient_unresolved`, and full hyphenated names win over existing strict prefixes by exact comparison.

Second review follow-up commit [`49f8ba3b`](https://github.com/AgentWorkforce/relay/commit/49f8ba3b2980a86abd982cac05aba7dab1008a71) strips untrusted raw targets from unresolved receipts, applies the queued-or-unread signal to CLI reader output, and shortens the changelog entry. Focused tests, root typecheck, lint, formatting/diff checks, and the verified-secret scan all exit 0.

Remote HEAD is confirmed as `49f8ba3b2980a86abd982cac05aba7dab1008a71`. All 11 Actions workflows triggered for that exact SHA completed successfully: CI, E2E Tests, Fleet E2E, Large File Check, Node.js Compatibility, Package Validation, Prettier Auto-Format, Relay Evals, Security Scan, Stress Tests, and Test. The PR-only workflows absent due event/path filters are not reported as passing: Codegen Models, Test Build Scripts, Test Install Script, Rust Auto-Format, and Cancel PR Jobs on Merge.

Final documentation-only follow-up [`3698f0f7`](https://github.com/AgentWorkforce/relay/commit/3698f0f7f6a34fae69d6cf3d81097fb1dc74b0f5) restores the exact MCP and CLI interface names in the shortened changelog bullets. Remote HEAD matches; formatting, diff, and verified-secret scans exit 0. All 11 triggered Actions workflows for this exact SHA completed successfully, and the PR has no pending or failing checks.
