# relay#1467 investigation notes

Branch: `fix/relay-1467-dm-delivery` (pushed from `origin/main`)

## First source finding

- The MCP `send_dm` handler in `packages/cli/src/cli/mcp/messaging-tools.ts` returns the created Relaycast message record verbatim. Its description explicitly promises only the record/message ID; it does not report whether the recipient consumed or even received the delivery.
- `wait` versus `steer` is preserved into the broker delivery. In `crates/broker/src/pty_worker.rs`, a wait delivery can remain blocked while the recipient CLI reports an auto-suggestion, whereas steer bypasses that blocker and sends the escape sequence before injection.
- Reader state is not an enqueue acknowledgement. `crates/broker/src/runtime/worker_events.rs` marks the Relaycast message read only after `MessageDeliveryConfirmed`; therefore an empty reader list is the expected observable for queued/unconsumed delivery, but the current MCP result does not label it as such.
- The sender-side mode descriptions are vague: MCP says only `Delivery mode`; CLI says `wait or steer`. The richer distinction exists only in a README example.
- `relay#1466` is not the same local resolution path: no mention tokenizer was found in this repository's broker/CLI/SDK source. Channel text and the server-populated `mentions` receipt are passed through the Relaycast API. Continue #1467 first; #1466 likely needs Relaycast service work, though Relay can add receipt validation if desired.

## Planned red checks

- A `send_dm` result must identify the exact requested recipient and explicitly state queued/unconfirmed delivery for both modes.
- A default/wait receipt must explain idle-boundary behavior; a steer receipt must explain immediate interruption behavior.
- An empty `get_message_readers` result must carry an explicit unread/queued signal; a non-empty result must report read.
- SDK direct-message normalization must preserve the requested recipient in `target` so the send receipt can be asserted against the request.

## Tooling limitation

The lane exposes neither Veto MCP tools nor a local `veto` executable. Repository discovery was performed manually with `rg`; repository-native tests, review/security checks, and per-workflow GitHub Actions status will be recorded before handoff.

## Implemented contract

- MCP `send_dm` and CLI `message dm send` preserve the created message fields and add a `delivery` receipt with `queued_unconfirmed`, effective mode, exact requested/resolved recipient, recipient-match boolean, and an explicit statement that reading is not confirmed.
- MCP and CLI `get_message_readers` responses preserve the reader list under `readers` and add a `delivery` signal: `read` when non-empty, `queued_or_unread` when empty.
- MCP and CLI resolve recipients independently from the workspace directory with a full exact-name match before sending; no request or response target echo is trusted as delivery evidence.
- Mode semantics are documented in MCP input descriptions, CLI help/README, TypeScript SDK docs, Python SDK README, and both Relay skill copies.
- #1466 remains outside this local implementation path. A defensive receipt test proves a provided resolved-recipient mismatch is surfaced as `recipient_mismatch`, but this branch does not claim to fix the upstream Relaycast mention tokenizer.

## Evidence so far (exit codes)

- Red regression check before implementation: exit 1, 4/4 new tests failed.
- MCP/CLI regression suite after implementation: exit 0, 28/28 tests passed.
- SDK messaging test: exit 0, 20/20 passed.
- SDK typecheck: exit 0.
- CLI lint: exit 0, 0 errors (76 existing warnings).
- Full SDK suite with lane telemetry variables removed: exit 0, 163/163 passed. The first unclean-env run exited 1 only because 12 telemetry assertions saw lane-injected identity metadata; 151 other tests passed.
- Root monorepo typecheck: exit 0.
- Broker wait-mode auto-suggestion gate test: exit 0.
- Broker steer-mode bypass test: exit 0.
- `git diff --check`: exit 0.
- TruffleHog verified-secret scan over every changed file: exit 0, zero verified secrets.

## Review follow-up

Automated review correctly identified that the first implementation treated the requested SDK target as if it were an independently resolved recipient. The follow-up removes that inference: MCP and CLI now list the workspace directory first, require a full exact agent-name match before sending, and pass that independent resolution into the receipt. The receipt helper reports `recipient_unresolved` instead of echoing the request when no resolver is available. New tests cover hyphenated full names, an exact name that is also a strict prefix, a missing exact name, a mismatched resolution, and unavailable resolution. The SDK request-echo target change was removed.

Follow-up validation: changed MCP/CLI tests exit 0 (32/32), full SDK tests exit 0 (163/163), root typecheck exit 0, CLI lint exit 0.

## Second review follow-up

- An unresolved receipt now removes a raw response `target` rather than exposing an untrusted echo. The regression supplies a misleading raw target and asserts it is absent.
- The CLI `message inbox get_readers` path now returns the same explicit `queued_or_unread` signal as MCP.
- The changelog entry is split into three short, impact-first bullets. The heading remains `[Unreleased - Patch]` because the repository AGENTS.md explicitly requires that heading for the first pending patch entry.
- Focused tests exit 0 (32/32), root typecheck exit 0, CLI lint exit 0 (0 errors, 76 existing warnings), formatting/diff checks exit 0.
- Remote head confirmed as `49f8ba3b2980a86abd982cac05aba7dab1008a71`; `gh run list --commit` shows all 11 triggered Actions workflows completed successfully: CI, E2E Tests, Fleet E2E, Large File Check, Node.js Compatibility, Package Validation, Prettier Auto-Format, Relay Evals, Security Scan, Stress Tests, and Test.
- PR-only workflow files absent for this SHA due their event/path conditions are not counted as passing: Codegen Models, Test Build Scripts, Test Install Script, Rust Auto-Format, and Cancel PR Jobs on Merge. External CodeQL and CodeRabbit checks pass; Cubic is still in progress.
- Cubic completed successfully and left one valid P3: the shortened changelog bullets needed the exact command/API names. Documentation-only commit `3698f0f7` fixes that; remote HEAD matches, formatting/diff and verified-secret checks exit 0, and exact-SHA Actions revalidation is in progress.
- Final exact-SHA gate: all 11 triggered Actions workflows on `3698f0f7f6a34fae69d6cf3d81097fb1dc74b0f5` completed successfully; `gh pr checks` reports no pending or failing checks. Worktree clean; local and remote HEAD match.
