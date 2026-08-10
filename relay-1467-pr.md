Fixes #1467

## Summary

- distinguish durable DM enqueue from delivery/read confirmation in MCP and CLI send receipts
- resolve the requested DM recipient independently from the workspace directory and require a full exact name match before sending
- turn an empty `get_message_readers` result into an explicit `queued_or_unread` signal
- document `wait` (on-idle) versus `steer` (immediate, possibly interrupting) at every public choice point
- add red/green unit, CLI, SDK, and MCP protocol regressions

`#1466` is intentionally not included: Relay's local broker/CLI/SDK has no mention tokenizer; mention resolution occurs in the upstream Relaycast service. The receipt helper does defensively flag a supplied recipient mismatch.

## Verification

- changed MCP/CLI tests: exit 0, 32 passed
- full SDK tests: exit 0, 163 passed
- root typecheck: exit 0
- CLI lint: exit 0, 0 errors
- broker wait and steer mode tests: exit 0
- Prettier and diff check: exit 0
- verified-secret scan: exit 0, 0 findings

The runtime dependency audit still exits 1 on 11 existing findings; this branch changes no dependencies. Veto was unavailable in the lane, so no Veto verdict is claimed. This PR is not merged.

## Review follow-up

The first revision echoed the requested SDK target as though it were independently resolved. Commit `0f9a6201` fixes that P2: MCP and CLI now resolve against the workspace directory before sending, exact matching handles hyphenated names and strict-prefix agents correctly, a missing exact name fails before enqueue, and an unavailable resolver reports `recipient_unresolved` rather than claiming a match.

Commit `49f8ba3b` closes the remaining receipt gaps found in review: unresolved receipts discard any untrusted response target, CLI reader output now carries the same `queued_or_unread` signal as MCP, and the changelog entry is split into short impact-first bullets.

Documentation-only follow-up `3698f0f7` restores the exact MCP and CLI interface names required by the changelog guidance. Remote HEAD is confirmed as `3698f0f7f6a34fae69d6cf3d81097fb1dc74b0f5`; all 11 Actions workflows triggered for that exact SHA completed successfully. Codegen Models, Test Build Scripts, Test Install Script, Rust Auto-Format, and Cancel PR Jobs on Merge were absent due their event/path conditions and are not counted as passing.
