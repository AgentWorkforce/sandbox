**PR opened — not merged.** https://github.com/AgentWorkforce/relay/pull/1402

Branch: `feat/ar-448-durable-workspace-identity`

## Root cause

`node up` resolved a workspace from an explicit key, then the project pin, then
nothing. A start with no pin fell through to the broker, which mints a
brand-new messaging-only workspace (`startup_single_session_set_from_sources`,
`crates/broker/src/relaycast/auth.rs`). The machine-global canonical workspace —
the one `agent-relay workspace switch` sets — was never consulted.

The failure was silent by construction: the node came up, the resident agent
registered, everything looked healthy. Only the delivery address changed.

Agent identity needed no separate fix. Relaycast returns the existing agent when
a name is re-registered in a workspace it already belongs to, so a stable
workspace is sufficient for a stable `khaliq-chief` address.

## Fix

`node up` now resolves: explicit key/env/node-token → project pin → **machine-global
canonical workspace** → mint. The resolved key is pinned to the project
afterwards, so no key is copied by hand. A machine with no canonical workspace
set behaves exactly as before.

## Acceptance

- **One data-plane ID, proven.** `workspace active --json` emits a `dataPlane`
  object (`unified`, the shared `workspaceId`, per-plane IDs, and the names of
  any that diverge), plus `--require-unified` for a hard gate. Verified live
  against `default`: unified on `rw_7ccfea89`, exit 0. Human output now also
  prints the Relaycast ID it had been omitting.
- **No manual key copying.** Covered in `core.test.ts` — both the canonical
  fallback and the pin-wins-over-store precedence.
- **Stop/start regression test.**
  `packages/cli/src/cli/lib/workspace-identity-restart.test.ts`. Each start is a
  fresh CLI process over one persistent checkout and `AGENT_RELAY_HOME`. Six
  cases, including a negative control proving a checkout with no canonical
  workspace is a different node entirely.
- **No credentials in status or logs.** Asserted against raw workspace keys,
  node tokens, `ot_live_` tokens, and `?token=`-style URLs. The canonical
  fallback logs only its source. `node status` now prints the durable
  `Workspace:` ID for restart comparison.
- **Documented.** `specs/workspace-identity.md` covers the invariant, resolution
  order, secret handling, and migration for existing local nodes.

## Tests

Targeted suites: 146 passed. Full `packages/cli` + `packages/cloud`: 1095
passed, 20 skipped, 0 failed. `typecheck` clean, `lint` 0 errors.

One pre-existing environmental failure (`integration-relayfile-contract` — the
sandbox cannot invoke `lsof`) reproduces identically on a stashed clean tree.

## For review

A node with no project pin now joins the canonical workspace instead of minting.
That is the fix, but it moves that node's resident agents onto the canonical
workspace — any address recorded from a previous throwaway workspace stops
resolving. It was already invalid after the next restart. Documented in the
migration section.

Merge gate held closed; the principal owns the merge.
