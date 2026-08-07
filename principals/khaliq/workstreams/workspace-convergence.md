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
so it needs Khaliq at the keyboard. **And it cannot pass on a released broker
at all:** the fix that makes a restarting node reclaim its own name rather than
collide with its stale registration (`5c2ad8ee3`) is in no release tag. A live
re-verify on 11.4.0 is expected to fail for that reason and is not evidence
against the harvested tests.

**AR-448's central premise is falsified, and this is the workstream's real
result.** AR-448 recorded that agent identity needed no separate fix because
Relaycast returns the existing agent on re-registration in a workspace it
already belongs to. Relay `main` replaced that with a fail-closed admission
gate: a name collision is rejected unless the caller proves same-work-unit via
a SHA-256 identity key, a node's own restart proving it from a hash of its
persisted state directory. So **workspace convergence is necessary and not
sufficient** — identity has a second half, the admission decision on the name,
which landed a week after AR-448 as its own fix. A consequence worth keeping:
two checkouts sharing one workspace is a supported state that AR-448 read as
identity-preserving and the gate now reads as an impersonation attempt.

**AR-448 is closed out. All three PRs are closed, none merged, and that is the
correct outcome.** #1402 and #1403 were stale against a file #1429 rewrote.
#1447 — Chief's harvest — was closed on Khaliq's decision because its premise
was wrong: #1429 shipped the ladder *with* 224 lines of coverage
(`broker-lifecycle.test.ts` +104, `node.test.ts` +66, `project-workspace-key.test.ts`
+54), so there was no untested behaviour to harvest evidence onto. What review
then removed from the remainder: a tautological headline assertion, a
convergence test that seeded two isolated stores with the same literal string,
and a `--require-unified` flag that duplicated the doctor's check and
double-exited on failure. Khaliq's read — "documentation I don't want and a
misleading flag" — was right before the evidence was in.

**The invariant itself is intact and holds live**, verified 2026-08-07:
`relaycast`, `relayfile`, and `relayauth` all resolve to `rw_7ccfea89`. A lane's
argument that the invariant might be invented rested on a test fixture, not on
production, and is falsified — see [[learnings]]. This matters because the
invariant is the repo's first platform priority.

**Next:** one salvage, authorized 2026-08-07 and not yet built — coverage
asserting that a key passed as `--workspace-key`, and the key the broker
returns, stay out of the logs. Neither is covered by main's existing assertions
(`broker-lifecycle.test.ts:643-644`, `:466`). Two tests, existing harness, no
production change. **Trap to avoid:** the harness returns `rk_test`, and
`maskSecret` emits only `rk_…` for a body of ≤8 characters, so
`not.toContain('rk_test')` passes without proving masking works — the test needs
a full-length `rk_live_…` key or it is inert.

**Criterion 3 is satisfied in outcome and unproven in mechanism, measured
2026-08-07 09:05:30Z.** The node restarted for real — it killed the session that
triggered it, and this Chief came up on the other side. Both decisive rows held:

- node id `node_5b46ac5e9f427fcedc07f77f95f642eb` — **unchanged**, so 61 agents
  of history and `--node` targeting survive.
- `chief-khaliq` agent id `210283808172122112` — **unchanged**. The resident kept
  its address and mailbox across a genuine broker stop/start.

**But it did not run on v11.4.2, so it proves the opposite of what was planned.**
The running broker is **10.6.7** — see the version finding below. `5c2ad8ee3`
was not in it. This workstream predicted a released broker would *fail* for want
of the restart-reclaim fix, and it passed anyway, which means the identity was
preserved by the **old permissive re-registration behaviour** — the same
behaviour `b4b96dfb3`'s doc comment calls the AR-448 duplicate class, and the
same one `open-threads` describes as an open impersonation path. So this run is
weak evidence *for* that thread, not against it. Criterion 3 needs re-running
once the broker actually carries the gate, and the expected pass then comes from
the hashed same-work-unit proof rather than from an unconditional hand-back.

**The rename to `kjg-laptop` did not take, and the node is still `chief`.** The
plist carries `--broker-name kjg-laptop` (written 11:04:34 local), but launchd's
loaded job was never unloaded, so its in-memory `arguments` are still
`{agent-relay, node, up}` — verified with `launchctl print`. Editing a plist does
not reload the job. The rename question therefore remains untested, and the
happy answer above about node identity was measured on the *unrenamed* node, so
it says nothing about whether a rename preserves it.

**The broker pin worked, and criterion 3 passed on a gated broker — measured
2026-08-07 09:46:59Z.** The `BROKER_BINARY_PATH` pin took: the running broker is
**11.4.2**, so `5c2ad8ee3` was in play for the first time. Both identity rows
held across the restart:

- node id `node_5b46ac5e9f427fcedc07f77f95f642eb` — unchanged, `createdAt`
  still 2026-07-30, so 61 agents of history survive.
- `chief-khaliq` agent id `210283808172122112` — unchanged, `lastSeen` moving.
  `marketing-lead` (`210364195033862144`) likewise.

**Do not read that as criterion 3 closed, because the mechanism contradicts the
outcome.** Three facts have to sit together:

1. The broker's *own* Relaycast name `chief` was **refused** on re-registration
   and is now permanently stranded — its record is frozen at `lastSeen`
   2026-08-07T09:05:32Z. The gate's refusal is the documented one: the broker
   flushes state on SIGTERM but never deregisters its name, and the reclaim key
   is not persisted locally, so the name cannot be recovered. The node runs as
   **`chief-broker`** only because a burned name forced a new one.
2. The broker's *children* were granted their ids back at 09:47:07Z, from the
   same state directory that could not prove ownership of the broker's own name.
3. An independent probe (register a throwaway name, then re-register it with no
   ownership proof) was **refused** — `Agent "…" already exists in this
   workspace` — and handed back no token. So the CLI registration path fails
   closed on 11.4.2.

So the gate demonstrably fails closed on two paths and demonstrably granted a
reclaim on a third, and **nothing here establishes which proof the spawn path
satisfied.** Until that is known, criterion 3 is *passing in outcome on a gated
broker* — strictly better than the 09:05Z run, which passed via the old
permissive hand-back — and still unproven in mechanism. The question to answer
is the asymmetry itself: why can a broker prove ownership for its children and
not for itself?

**Next:** resolve the asymmetry above (platform question, not Chief's to fix);
the credential-redaction salvage, still authorized and unbuilt (the `rk_test`
masking trap above still applies).

## History

- 2026-08-07 — Second restart, on the `BROKER_BINARY_PATH` pin. Broker is
  11.4.2 for the first time and `relay-version` cleared; the doctor is green on
  all thirteen checks. Node id and both resident agent ids preserved. The cost
  was the node's Relaycast name: `chief` is burned and unreclaimable, and the
  node now answers to `chief-broker`.

- 2026-08-07 — Ran the post-restart verification left pending by the session the
  restart killed. Node id and resident agent id both preserved; broker turned out
  to be 10.6.7, not the 11.4.2 the upgrade installed; the `kjg-laptop` rename
  never reached launchd. Two of the four things the restart was meant to prove
  were not exercised at all.
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
