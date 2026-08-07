---
status: active
owner: khaliq-chief
updated: 2026-08-07
repos: [chief, relay, cloud]
---
# Workspace convergence

**Goal:** One Agent Relay Cloud workspace durably identifies Khaliq's Chief and
team across Relaycast, Relayfile, and RelayAuth, including broker restarts.

**Now: most of AR-448 is already in `main`, and it did not arrive through
either AR-448 PR.** Verified 2026-08-07 with `git merge-base --is-ancestor`:

- `4acdd97d4 fix(cli): resolve the broker workspace through one precedence
  ladder` — **in main**. This is the substance of acceptance criterion 2.
- `5c2ad8ee3 fix(broker): reclaim a node's own registration across restart,
  hash the identity proof` — **in main**. Durable identity across restart.
- `492515a20 feat(cli): … (AR-448)` and `27494c862 fix(node): …` — **not in
  main**; they exist only on #1403's branch.

Both landed through PR #1429 (`fix/node-up-enrollment-precedence-and-spawn-reliability`)
while the two AR-448-branded PRs sat untouched. The invariant holds live today:
`default` resolves Relaycast, Relayfile, and RelayAuth to one `rw_7ccfea89`.

**So the lineage question has changed shape.** It is no longer "which of #1402
and #1403 do we merge." Both are 7–8 days stale against
`packages/cli/src/cli/commands/workspace.ts`, which #1429 has since rewritten,
and both still edit it. The real question is what either still adds that `main`
lacks. On inspection that is mostly **#1402's test evidence**:
`workspace-identity-restart.test.ts` (+341), `workspace-convergence.ts` (+74)
and its test (+58), plus a `specs/workspace-identity.md`. #1403 is mainly a spec
and a smaller test.

**Still genuinely unmet:** acceptance criterion 3, a stop/start regression proof
that the resident agent keeps its address and mailbox. Nothing in `main` proves
it, and it cannot be self-tested — stopping the broker kills the resident Chief,
so it needs Khaliq at the keyboard.

**Next:** Khaliq decides between harvesting #1402's restart/convergence tests
onto current `main` as a fresh PR (Chief's recommendation) and merging either PR
as-is. Then a real broker stop/start on this machine closes criterion 3. The
RelayAuth prerequisite is **gone** — minting works again as of 2026-08-07.

## History

- 2026-08-07 — Established that AR-448's outcome largely shipped through PR
  #1429, not through either AR-448 PR, by testing each commit for ancestry in
  `origin/main` rather than reading PR titles. Chief had reported the lineage
  decision as blocking for eight days without ever checking whether `main` had
  moved underneath it. The same failure as the stale RelayAuth blocker recorded
  the same morning: a decision was held open against a world that had changed.

- 2026-08-04 — The invariant still holds at boot: `default` resolves Relaycast,
  Relayfile, and RelayAuth to one `rw_7ccfea89` identity, broker CONNECTED with
  the resident attached. Both AR-448 PRs are still open and untouched, so the
  lineage decision is five days old and nothing has been merged into it.

- 2026-07-31 — Implemented AR-448 and opened relay PR #1402 on
  `feat/ar-448-durable-workspace-identity`. Root cause was single: `node up`
  never consulted the machine-global canonical workspace, so a start with no
  project pin fell through to the broker's mint-a-fresh-workspace path and the
  resident agent silently got a new address. Agent identity needed no separate
  fix — Relaycast returns the existing agent when a name is re-registered in a
  workspace it already belongs to. Merge gate held closed.
- 2026-07-30 — AR-448 passed the hosted Factory path: three agent invocations
  spawned in the canonical workspace, provider IDs reconciled, and the run
  completed with the merge gate still closed.
- 2026-07-30 — Created AR-448, `[factory] Make Relay workspace identity durable
  across node restarts`, as Chief's first platform task. It carries the Relay
  route and explicit Factory readiness label; dispatch awaits the Cloud owner
  fix in PR #2871.
- 2026-07-30 — Invariant holds at boot: all three planes resolve to one `rw_`
  identity under the `default` workspace. The restart verification is left for
  Khaliq to trigger — stopping the broker terminates the resident Chief, so it
  is not a self-service action.

- 2026-07-30 — Confirmed the canonical Cloud workspace carries one unified
  Relaycast/Relayfile/RelayAuth identity; made mismatch a blocking setup error.
