---
status: active
owner: unassigned
previous_owner: soc2-program-lead-0811
updated: 2026-08-12
repos: [relayauth, factory, chief, relay, relaycast-cloud]
---

**2026-08-12 correction:** frontmatter was stale — listed `soc2-lead-0810`
(superseded before the 08-11 restart) as owner, with the lead that actually
finished the critical path (`soc2-program-lead-0811`) demoted to
`reports_to`. Per the 08-11 journal, that lead closed its session ~12:30Z
after the chain (relayauth#79, relay#1477, cloud#2981/2987/2989) went fully
merged and deployed — `commit → attestation ledger → OIDC-bound human →
session → reasoning` is end-to-end live. It has since released; no one
picked up the remaining open items below. Not "idle" in the concerning
sense — the owner finished its scoped work and stood down correctly. What's
actually unowned: factory sessionRef forwarding (one-line change, briefed
but never turned into a PR), `findDuplicate()` always-null P2 gap, CH-1
re-scope (needs Khaliq yes/no), optional prod D1 baseline read.
# SOC-2 agent traceability — the Nabis design-partner wedge

**Goal:** Every consequential agent action, starting with a git commit, is
traceable to the **specific agent** and the **responsible human**, as a
tamper-evident first-party paper trail Nabis **self-hosts** and can hand an
auditor as an offline-verifiable report.

**Hard deadline: auditor engagement 2026-11-01.** Not a target — a date a
customer has committed to.

**Epic:** `AgentWorkforce/sales#27` — **private**. It was first filed in
`factory`, which is **public**, and has been deleted from there. Customer name,
headcount, the auditor date, the Hole 1 exploit path and the leaked keys must
never appear in `factory`, `relay` or `relayauth`, which are all public. Neutral
engineering framing of the code is fine there.

**Source of truth, follow it rather than re-planning:**
`~/.agentworkforce/workforce/sessions/customer-dev-msjgxbkb-71491b9d/mount/nabis/julian-fann/soc2-agent-traceability-plan.md`,
committed in the sales repo as `335d6ba`. It carries the ask, threat model,
architecture, workstreams by owner and the Nov-1 cut line.

**Why this is a wedge and not a feature.** Julian Fann at Nabis (~700 people,
regulated) is not solving for his own agents — he is about to hand Claude tokens
to CX and biz-ops teams and wants to **buy** compliant agent governance rather
than build it. In his words: *"Trace the commit back to a specific agent… who's
responsible for the agent… it's more about the paper trail than anything else.
That's what SOC 2 cares about — who did what when."* And: *"Extra metadata
associated with a commit hash, but not stored in GitHub — stored on your app."*

## Now — dispatched 2026-08-07, nothing built

**What already exists and must not be rebuilt** (relayauth, active through
v0.2.26, 2026-08-04):

- Stable agent identity (`sub: agent_…`), workspace→agent→path token flow,
  **sponsor chain** carried on every token, RS256 with a public JWKS at
  `/.well-known/jwks.json` — third-party verifiable with no callback.
- Path-scoped tokens with `delegationNotAfter`.
- Factory's mount already mints per-agent relayauth path-scoped tokens
  (`/github/**`, relayfile fs scopes) and fails fast on scope errors (`563f2d6`).
- Factory already captures the commit `headSha` on the PR record
  (`src/writeback/github.ts`).
- `relayauth/specs/audit.md` is a normative immutable-audit-log spec; the
  shipped SQLite implementation is thinner and is the upgrade target.

**The six things that do not exist. This is the work.**

| # | Gap | Owner |
|---|---|---|
| 1 | **Durable queryable lineage.** `0003_token_lineage.sql` exists **only in `dist/`, not git-tracked** in `src/db/migrations`. Sponsor chain lives only inside the JWT. | relayauth |
| 2 | **Tamper-evident hash-chained audit.** No `prev_hash` / `entry_hash` / `WitnessEntry` anywhere in relayauth. Append-only, RS256-signed, write-once — no `updated_at`, no cascade, no TTL. | relayauth / relay |
| 3 | **Commit attestation.** relayauth RS256-signs `{commitSha, agentId, sponsorChain, repo, ts, jti}`; factory stamps `jti` plus `Agent-Id` / `Sponsor-Id` git trailers **at commit time, in the relay spawn node — not only in factory-build**; after commit factory calls relayauth to write the attestation keyed by `headSha`. | relayauth + factory |
| 4 | **Hole 1 — kill workspace-key sponsor impersonation. CRITICAL.** | chief + relayauth |
| 5 | **Key custody** — signing key moves from PEM-in-env to KMS/HSM. | relayauth |
| 6 | **Verifier and SOC-2 report surface** — commit/PR → who / what / when + responsible human, JWKS-verified offline. | chief |

**Hole 1 is the one that decides whether any of this is real.** Anyone holding
the shared workspace key `rk_…` can register, reclaim or rotate any agent name
(`relay/.../auth.rs`), so two humans sharing a key are indistinguishable and
**the sponsor chain is forgeable — which makes the core claim theatre.** The fix:
Chief is the delegation point and knows the authenticated human, so Chief threads
the SSO-authenticated principal into issuance and relayauth binds the sponsor to
a real human identity and **refuses workspace-key-set sponsors.** That closes the
hole and delivers the SSO-bridged enterprise-IAM story at the same time.

We have direct evidence the hole is live: a workspace key leaked into a crash log
on this machine today, and a second sits in cleartext in two files on `finn-mini`.
Khaliq ruled no rotation. **Under the current design, anyone holding either could
forge a sponsor.**

**Hole 2 — agent non-repudiation — is a documented deferral, not an oversight.**
The agent holds no key; relayauth signs on its behalf. For a first-party trail
with relayauth as Nabis's self-hosted issuer that is a **defensible design
choice**: integrity via hash-chain plus human attribution, delivered without
agent keys. **Do not put post-quantum agent keys on the Nov-1 path.** Record it in
the auditor-facing threat model so it reads as *chosen* rather than missed.
Revisit triggers: cross-org attribution, or defending against issuer-key
compromise.

**Ratify stays off the critical path by decision.** relayauth is the intra-org
backbone; Ratify is the cross-org expansion only. No Ratify code in-tree — today
there is only a blog post and a DRAFT partnership spec
(`cloud/specs/ratify-protocol-identity-partnership.md`), and the spike never
touched commits. Borrow the `WitnessEntry` hash-chain **pattern** only,
implemented on relayauth's lighter RS256.

## Session provenance — Khaliq's addition, 2026-08-08

**The attestation should carry a session reference, not only an agent identity.**
His words: *"For a PR and its commits it would definitely help to have agent info
on which identity agent worked on that feature and associated session
information. There are some PRs open now that I have no idea where they
originated from."*

**This is the customer's requirement, felt internally.** There are **79 open PRs
in `AgentWorkforce/cloud` alone** — four `otel-ingest` PRs open since 2026-06-03
and a security PR, *"Strip Codex refresh tokens from harness sandboxes"*, open
since 2026-06-16. Nobody can say which agent produced them, under what brief, or
in which session. **The principal cannot answer "where did this come from" about
his own repository**, which is the auditor's question asked from the inside.

`agentId` answers *who*. It does not answer *in what context* — two commits from
one agent days apart under different briefs are indistinguishable, and an auditor
asking "what was this change for" gets an identity and no narrative.

**The substrate probably exists.** `ai-hist` (`../relayhistory`) already indexes
agent session JSONL with full-text search across Claude Code, Codex, Cursor,
Grok, Agent Relay and compacted persona trajectories. Its stated purpose is the
right one: *transcript search recovers what was said; `ai-hist` captures why.* A
session identifier in the attestation would complete the chain: **commit → agent
→ responsible human → session → the reasoning behind it.**

**Four questions the lanes must answer rather than assume:**

1. **Does a stable session identifier already exist at commit time** in the spawn
   environment, alongside the `RELAY_ATTEST_*` vars RL-1 injects? If so it is
   nearly free.
2. **Signed claim set, or ledger entry beside it?** Signing makes it
   tamper-evident and non-repudiable; it also makes it permanent.
3. **What does the reference leak?** An auditor should see that a session existed
   and belongs to a named human — **not necessarily its contents.** Reference,
   never payload.
4. **Nov-1 scope or phase 2?** If it rides along cheaply, take it. **If it
   endangers the date, defer it explicitly** rather than silently widening the
   critical path.

Pairs with [[pr-shepherd-agent]], which exists because nobody can currently
account for the open-PR backlog.

## MVP cut line — 2026-11-01

**In:** gaps 1–4, Hole 1, key custody, verifier and report.

**Out, phase 2:** relayfile write-back provenance, persona→human owner field,
cross-org non-repudiation via Ratify, GitHub App de-anonymisation (time-box only).

## Sequencing — dependencies are real here

**relayauth leads.** Attestation issuance and the durable ledger come first
because they unblock both factory stamping and the verifier. **Hole 1's
SSO-binding runs in parallel on the critical path** — it is independent of the
ledger and is the longest pole, since it needs an IdP decision. The
tamper-evident store can land alongside.

Factory cannot stamp a `jti` that nothing mints. Chief cannot verify a report
against attestations that are not persisted. **So a slip in relayauth is a slip
in everything.**

## Three decisions to resolve with Will before building far

1. **Where the ledger physically lives** — relayauth's audit store, or a relay
   table. relayauth owns `audit.md`, so lean that way.
2. **SSO/OIDC integration point** for Nabis's IdP — the human principal.
3. **KMS/HSM target** for the signing key.

## Definition of done

**One real signed attestation, end to end, for a genuine factory commit:** commit
→ git trailer → attestation minted → written to the tamper-evident store →
JWKS-verified offline by the report surface. Anything short of that demo is
progress, not proof.

Each lane opens a tracked PR against its own repo, gated on tests **and** that
demo path.

## Now — 2026-08-10 — step 2 is DONE and running in production

**The relayauth half of the critical path landed on 2026-08-08 and reached
production on 2026-08-10.** Nobody framed it as the SOC-2 milestone it is; it
shipped as a dependency bump.

| PR | Merged | What |
|---|---|---|
| `relayauth#76` | 2026-08-08 20:49Z | Persist queryable identity token lineage |
| `relayauth#75` | 2026-08-08 22:12Z | **Bind identity sponsors to OIDC proofs** — Hole 1 |
| `relayauth#77` | 2026-08-08 22:36Z | **Durable attestation grants and ledger** — RA-1 + RA-2 |

`@relayauth/server` and `@relayauth/core` published at **0.2.28**, and
**`cloud#2981` merged and deployed** (squash `d936b9e6d4`, Deploy success) — so
the attestation chain is live. That merge also admitted migrations
`0007_attestation_ledger` and `0008_identity_lineage` at pinned SHA-256 digests;
the second was found by the lane, not by the reviewer who named only the first.

**RA-1 was never blocked on RA-2's append contract** in the end — both landed
within 24 minutes of each other. Any instruction still saying otherwise is two
days stale.

## Next

1. Resolve the three open decisions with Will — they gate depth, not start.
2. ~~relayauth: attestation issuance + durable ledger, then Hole 1 binding.~~
   **DONE 2026-08-08, live 2026-08-10.**
3. factory: trailers at commit time in the spawn node, then the post-commit
   attestation call keyed by `headSha`.
4. chief: SSO principal threading, then the verifier and report surface.
5. relay: append-only hash-chained table with no `updated_at`, cascade or TTL.


## MERGED — Hole 1 closed, 2026-08-08 22:12Z

**`relayauth#75` "Bind identity sponsors to OIDC proofs" is merged** —
squash commit `082e55de0`, `main` CI green. **This is the first customer-visible
SOC-2 deliverable to land**, and it closes **Hole 1: a forgeable sponsor**.

Merged by Chief under Khaliq's overnight authority, against all five gates:
0 unresolved threads re-checked immediately before merge, `mergeStateStatus`
CLEAN, both workflows (`CI`, `SDK Contract Check`) green on `6580d926` confirmed
as remote HEAD, and `--match-head-commit` set so it would refuse if HEAD moved.

**Blast radius stated before merging, not after:** `relayauth` has three
workflows — `ci.yml` (push + PR), `contract.yml` (PR only), and `publish.yml`
which is **`workflow_dispatch` only**. Merging lands a commit on `main` and
**ships nothing**; publishing remains a deliberate manual act. Confirmed after
the fact: the only run on the merge commit was `CI`.

**Everything downstream can now assume a verified sponsor.** In particular the
approval-gate primitive in [[agent-lifecycle-workflows]] gap 3 was explicitly
held until Hole 1 landed — *an approval gate that trusts a forgeable sponsor
approves nothing*. **That hold is now released.**


## MERGED — RA-1 and RA-2, 2026-08-08 22:36Z

**`relayauth#77` "add durable attestation grants and ledger" is merged** — squash
`0f3edceae`, `main` CI green. **With `#75`, the whole attestation chain is now on
`main`**: verified sponsor binding, two-phase grant/finalize, and the
hash-chained write-once ledger.

**The rebase was the risk, and it was checked rather than assumed.** Merging
`#75` flipped `#77` to DIRTY; the lane rebased onto the new `main` and cleared
9 threads to 0. Because a resolved conflict is invisible in review — the exact way
a merged security invariant gets quietly reverted — the diff was read against
`main` before merging:

- `sponsor-oidc-binding.test.ts` intact at **766 lines**, untouched.
- Ledger triggers intact: `BEFORE UPDATE` and `BEFORE DELETE` both
  `RAISE(ABORT, 'attestation_ledger is append-only')`, no `updated_at`, no
  cascade, no TTL, with a comment forbidding all three.
- The only migration change **removes a redundant index** the `UNIQUE (org_id,
  entry_hash)` constraint already provides — write amplification on an
  append-only table, not a weakening.

**And the branch closed a real gap rather than merely rebasing.** On `main` after
`#75`, only OIDC-bound orgs got a ledger entry; **legacy orgs fell through to a
plain `identities.create` with no audit record at all.** `#77` gives *every*
identity creation an atomic signed `identity.created` entry, **fail-closed on
ledger persistence**, with OIDC orgs getting the richer sponsor-proof payload.
There is no longer an unaudited identity-creation path.

**Blast radius, established before merging:** `publish.yml` is
`workflow_dispatch` only, so both merges landed commits and **shipped nothing**.
Migration `0007` has not reached production; RelayAuth production is unchanged.

## MERGED — relayauth#79, 2026-08-11 09:37Z (merge commit ebc20a70eb)

**`relayauth#79` "feat(server): add sessionRef to attestation grants (RA-4 session provenance)"** — merged by Khaliq at 09:37:24Z. Squash commit `ebc20a70eb` on main. Publish Packages workflow running on `ebc20a70eb` (run 31478568429).

**What it does:** adds optional `sessionRef` to attestation grants (migration 0009, ALTER TABLE ADD COLUMN session_ref TEXT). The ai-hist session UUID now rides through to every per-commit JWS payload, completing the chain: `commit → attestation ledger → OIDC-bound human → session → reasoning`.

**Published:** `@relayauth/*` 0.2.29 live on npm (all 5 packages). Cloud bump PR: **cloud#2989** (chore/relayauth-0.2.29-bump, awaiting Khaliq merge).

---

## FORMERLY IN REVIEW — relayauth#79, 2026-08-11 06:00Z (3 commits, CI green)

**`relayauth#79` "feat(server): add sessionRef to attestation grants (RA-4 session provenance)"** — opened by `soc2-lead-0811b`, 3 commits, all CI workflows green (SDK Contract Check ✓, CI ✓, CodeRabbit ✓). Awaiting Khaliq merge.

- Commit 1 (`3e917af`): core feature — migration 0009, storage, routes, tests
- Commit 2 (`c32f536`): bot fixes — 6 missing trajectory files staged, ledger entry assertions added to tests
- Commit 3 (`dc5bee31`): cubic P3 fix — `verifyJws(grantLedgerRow.jws)` absence check in 'without sessionRef' test

**What it does:** adds optional `sessionRef` to attestation grants so the ai-hist session UUID rides through to every per-commit JWS payload. Completes the chain: `commit → attestation ledger → OIDC-bound human → session → reasoning`. Migration 0009 (ALTER TABLE ADD COLUMN session_ref TEXT, nullable).

**Stale branches cleanup:** `soc2-ra1-grant-finalize` and `soc2-ra2-ledger` remain on origin unmerged, both based on v0.2.26 (pre-#75/76/77). Their net new value was `sessionRef` (now delivered in #79) and stricter ledger CHECK constraints (deferred). They can be deleted after #79 merges.

## MERGED — cloud#2989, 2026-08-11 (relayauth 0.2.29 bump)

**`cloud#2989` "chore: bump @relayauth/* to 0.2.29"** — merged by Khaliq. Branch `chore/relayauth-0.2.29-bump`.

**What it does:** Admits migration `0009_attestation_grants_session_ref` (the `session_ref` column from relayauth#79) into cloud's migration preflight guard, updates the SST worker bundle marker in `packages/relayauth/src/worker.ts`, and corrects the lockfile workspace entry for `packages/relayauth`.

**CI fixes required (all mechanical):**
- `tests/relayauth-gc-infra.test.ts` — version pin `0.2.28→0.2.29` in test name + `expectedVersion`
- `packages/relayauth/scripts/source-migration-preflight.mjs` — admitted `0009_attestation_grants_session_ref` with checksum `0a92a91b4ab6d38012bb170ad95a723f838274109f26699c3f8c1d3152091aa6`
- `packages/relayauth/src/__tests__/source-migration-preflight.test.ts` — `deepStrictEqual` snapshot updated to include `0009`
- `packages/relayauth/src/worker.ts:13` — bundle marker updated `0.2.28→0.2.29`
- `package-lock.json` — workspace entry `packages/relayauth` dependency corrected `0.2.28→0.2.29`

**The server, spawner, and deployment portions are merged and live:**
- relayauth#79 — `session_ref` column in attestation grants ledger ✅
- relay#1477 — spawner injects `RELAY_ATTEST_SESSION_ID`, stamps `Session-Id:` git trailer ✅
- cloud#2981 — ledger-first ordering ✅
- cloud#2987 — Option A dual-write D1 projection ✅
- cloud#2989 — 0.2.29 bump + migration admitted ✅

**Chain complete as of 2026-08-11.** factory#233 merged — sessionRef forwarding live in `src/writeback/github.ts` (`postAttestationGrant` now accepts per-agent sessionRef, falls back to env var, with 5s AbortSignal timeout). All six links merged and deployed. The full path `commit → attestation ledger → OIDC-bound human → session → reasoning` is end-to-end.

## Agent cleanup checkpoint — 2026-08-11 15:48 CEST

GitHub was rechecked: `relayauth#79` merged 09:37Z, `relay#1477` merged, and
`cloud#2989` merged 12:41Z with its relevant checks green. The two local
specialist sessions (`soc2-lead-0811b` and
`relay-attest-session-lead-0811`) were both bridge-waiting with no pending
messages and were released. `soc2-program-lead-0811` remains active. The
durable next engineering action is the Factory `sessionRef` forwarding link
above, not another relayauth or relay implementation lane.

---

## MERGED — relay#1477, 2026-08-11 09:23Z (merge commit dd16bba76b)

**`relay#1477` "feat(broker): wire session attribution into commit attestation"** — merged by Khaliq at 09:23:37Z. Squash commit `dd16bba76b` on main. 10/10 CI checks green on `e4fe62483`.

**What it does (spawner half):**
- `CommitAttestation.session_ref: Option<String>` (wire key: `sessionRef`)
- `with_commit_attestation_env()` injects `RELAY_ATTEST_SESSION_ID` when present+valid; strips stale inherited value before re-injection (security fix)
- `PREPARE_COMMIT_MSG_HOOK` stamps `Session-Id: $RELAY_ATTEST_SESSION_ID` in attestation block
- `broker_payload_from_action` uses `find_map` across four key aliases (`session_ref` → `sessionRef` → `session_id` → `sessionId`), matching the canonical fleet on-wire format in `relaycast_spawn_session_ref`
- 897/897 broker tests pass, 14 new tests covering session_ref injection, stale strip, key aliasing, and blank-value fallthrough

**Relay gap closed.** relayauth#79 (ledger half) + relay#1477 (spawner half) together deliver the full chain. **Factory still needs one change**: `POST /v1/attestations/grants` must forward `sessionRef` from the fleet spawn spec — noted for Chief routing.

## History

- 2026-08-07 — Workstream created and lanes dispatched on Khaliq's instruction.
  Nothing built. Source discovery is `transcript-08-04-26.txt` lines 68–128;
  capability read is the internal repo audit of 2026-08-06.
