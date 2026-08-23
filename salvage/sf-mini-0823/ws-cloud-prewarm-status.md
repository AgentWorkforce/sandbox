BLOCKED: Registry resolution — a release >0.10.46 containing PR #438 is required

## DoD Status Summary

| Item | Status | Evidence |
|------|--------|----------|
| 1. Registry resolves | **FAIL** | `latest`=0.10.46, `next`=0.10.28. PR #438 merged into main (2026-08-23 14:53 UTC, commit 4716a7d) but v0.10.46 was tagged 2026-08-22 (380bc0f) — PR is unreleased. |
| 2. Workspace converges | **PASS** | relaycastWorkspaceId, relayfileWorkspaceId, relayauthWorkspaceId all = `rw_7ccfea89`. Verified via `npm run doctor`. |
| 3. Must-fail control | **BLOCKED** | Depends on item 1. 0.10.46 exits 1 before auth as expected. |

## Remediation
1. Cut a new `relayfile` release from `main` (includes PR #438)
2. Publish to npm
3. Update `next` dist-tag to the new version (or document the pin if intentional)
4. Re-run verification after release

## Additional notes
- Workspace `rw_7ccfea89` is fully convergent across all three planes
- Cloud workspace UUID 50587328-441d-4acb-b8f3-dbe1b3c5de99 is a separate namespace, not a collision
- Broker was not running at time of investigation (shell 11.8.1)
