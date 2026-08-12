# Design Note: DO-to-D1 Identity Migration
**cloud-identity-d1 workstream — 2026-08-11**
**Author: cloud-identity-lead-0811v3**
**Status: First deliverable — design note, no code**

---

## 1. What the DO provides today — and what D1 does not

### Single-writer serialization per identity
Each `IdentityDO` instance is one Cloudflare Durable Object = one process = one identity ID.
Concurrent requests to the **same identity** are serialized by the CF runtime before they reach
application code. No row-level locks, no retry-on-conflict, no MVCC overhead.

D1 provides no per-row locks. Concurrent creates or updates for the same identity ID under D1
would require either:
- A `UNIQUE` constraint + application-level retry loop, or
- A wrapping transaction that locks the row and re-checks before committing.

Neither matches the DO's zero-code serialization. This is real: the `create()` path calls
`assertCreateInput()`, then `applyBudgetPolicy()`, then `save()`. These must be atomic per
identity or a race can produce two identity rows with the same ID.

### `blockConcurrencyWhile()` on schema migration
The DO constructor calls `ctx.blockConcurrencyWhile(async () => { this.sql.exec(SCHEMA_SQL) })`.
No request is served until the schema is present — unconditionally, on first access. D1
migrations require an explicit, externally-coordinated step.

### In-process budget auto-suspend
`applyBudgetPolicy()` runs inside the DO `create()` / `update()` call. The budget-exceeded
check and the status mutation happen in the same async frame, with the same locked execution
context. Under D1, these would be two statements; without a transaction they can race.

### DO-local KV for `budgetUsage`
`syncBudgetUsage()` writes to `ctx.storage.put("budgetUsage", ...)` — DO-local KV, no network
hop. The `retention-gc` cron reaches this via the DO fetch interface. Under D1 this would be a
separate column on `identities` with normal D1 read-write latency.

### Location-aware routing
CF routes each DO instance to the colo nearest to its first accessor. D1 has global replication
but write routing is CF-managed. This is unlikely to affect correctness but is worth noting for
latency-sensitive callers.

---

## 2. All readers and writers of IDENTITY_DO — enumerated, not sampled

### Callers via `CloudflareIdentityStorage` (packages/relayauth/src/storage/cloudflare/identities.ts)

All of these call `requestIdentityDurableObject()` which does:
`IDENTITY_DO.idFromName(id)` → `IDENTITY_DO.get(doId)` → `durableObject.fetch(...)` with
`x-internal-secret` auth.

| Method | identities.ts line | DO path | DO method |
|---|---|---|---|
| `get()` | 131 | `GET /internal/get` | `IdentityDO.get()` |
| `create()` | 149 | `POST /internal/create` | `IdentityDO.create()` |
| `update()` | 165 | `PATCH /internal/update` | `IdentityDO.update()` |
| `delete()` | 178 | `DELETE /internal/delete` | `IdentityDO.delete()` |
| `suspend()` | 184 | `POST /internal/suspend` | `IdentityDO.suspend()` |
| `retire()` | 197 | `POST /internal/retire` | `IdentityDO.retire()` |
| `reactivate()` | 214 | `POST /internal/reactivate` | `IdentityDO.reactivate()` |

### Callers that go to D1 directly (bypassing the DO entirely)

| Method | identities.ts line | D1 table |
|---|---|---|
| `list()` | 111 | `identities` |
| `findDuplicate()` | 228 | `identities` |
| `loadOrgBudget()` | 241 | `org_budgets` |
| `listChildIds()` | 265 | `identities` |
| `listChildren()` | 278 | `identities` |
| `getStatusCounts()` | 291 | `identities` |

### Cross-store writes originating inside the DO

`IdentityDO.writeBudgetAuditEvent()` (identity-do.ts:379) writes
`INSERT INTO audit_events (...)` directly against `this.env.DB` (or `DB_CANDIDATE` when
target = "candidate"). This is a D1 write from inside the DO — it does NOT go through
`CloudflareIdentityStorage`. It is fire-and-forget with a `try/catch` that swallows errors.

### Tests that reference IDENTITY_DO

All test references are mock/stub harnesses — they do not constitute production readers/writers:
`identities.test.ts`, `test-helpers.ts`, `emergency-source-mints.test.ts`,
`retention-gc.test.ts`, `service-telemetry.test.ts`, `post-auth-mint-capacity.test.ts`,
`identity-do.test.ts`, `cloudflare-entrypoint.test.ts`.

---

## 3. Grep confirmation: `INTO identities` (outside node_modules)

Run 2026-08-11 against `packages/relayauth/src`:

```
grep -rn "INTO identities" packages/relayauth/src --include="*.ts"
```

**Result: ZERO hits.** Confirmed. The D1 `identities` table is never written to by application
code. `list()` and other D1-direct methods query it, but nothing INSERTs into it from this
repo. This is consistent with the D1 cutover design: the `identities` table in the candidate
D1 is populated by the migration process (the `RelayAuthD1CutoverGateDO`-managed data
transfer), not by normal application writes.

**Consequence:** In the current "source" (DO-primary) mode, `list()` returns data from a D1
`identities` table that is either empty (pre-migration) or a migration snapshot (post-cutover).
Cross-identity list queries do not reflect live DO state unless the D1 cutover has been applied
to production.

---

## 4. Migration path, and reversibility at each step

The D1 cutover is fully scaffolded in this repo (`RelayAuthD1CutoverGateDO`, d1-cutover.ts,
infra/relayauth-d1-cutover-config.ts). Key elements of the path:

1. **Prepare candidate D1**: Provision a new D1 database, apply all `@relayauth/server`
   migrations. This gives the `identities` table its schema.
2. **Bind candidate**: Set `RELAYAUTH_D1_CANDIDATE_DATABASE_ID` → infra binds `DB_CANDIDATE`.
3. **Canary window**: The `RelayAuthD1CutoverGateDO` runs a timed evidence window (5–10 min,
   `EVIDENCE_WINDOW_MIN_MS` / `_MAX_MS`). During this window it tracks mutation generation
   and produces evidence hashes. **This step is time-bounded and reversible** — if it fails or
   the window expires without attestation, `rolledBackAt` is set and the gate resets.
4. **Attest**: Operator signs the evidence envelope. The attestation is stored in DO KV with
   a 10-minute TTL (`ATTESTATION_MAX_AGE_MS`). After that window it cannot authorize a switch.
5. **Switch**: `RELAYAUTH_D1_REQUEST_TARGET` is flipped to "candidate". All DO operations now
   read/write D1 candidate as the target. The DO instances still exist.
6. **Confirm and promote**: Once the candidate is confirmed stable, it becomes the pinned
   primary (`relayauthPinnedPrimaryDatabaseIdForStage`).

**Reversibility at each step:**
- Steps 1–3: Fully reversible. No production data has moved. The candidate is empty.
- Step 4: Reversible. Attestation TTL expires in 10 min. Gate has `rolledBackAt` field.
- Step 5 (target flip): Reversible while DO data is still intact. The DO instances are NOT
  deleted at this point. Rolling back = flip target back to "source".
- Step 6 (promote): Reversible only if DO instances survive. Once DO instances are purged
  (they are not automatically purged — this would be a separate operator action), rollback
  means rebuilding from D1 → DO, which is possible but untested in this codebase.

**Critical warning on irreversibility**: The existing DO state must be explicitly preserved
(not deleted) through the full confirmation period. There is no automated DO purge in the
current infra — the operator would have to delete the DO namespace binding explicitly.

---

## 5. Does D1 actually deliver the atomicity we want, or is ledger-first needed regardless?

**Short answer: D1 delivers true atomicity post-migration, but ledger-first is needed
regardless during the transition.**

### Post-migration (D1 as primary identity store)

Once identities live in D1, `D1.batch()` CAN cover both the identity row and the ledger entry
in a single transaction:

```ts
await db.batch([
  db.prepare("INSERT INTO identities ...").bind(...),
  db.prepare("INSERT INTO attestation_ledger ...").bind(...),
]);
```

This is a real D1 transaction: both statements succeed or both roll back. The auditor's
property — no identity without a ledger entry — becomes structurally enforced, not procedural.

### During migration (current: DO-primary + D1 ledger)

The ledger is D1. The identity is DO. `D1.batch()` covers D1 only. There is no primitive
that can atomically span DO-local SQLite and a D1 transaction. This workstream cannot change
that; it is a Cloudflare platform constraint.

The ledger-first ordering (cloud#2981, MERGED 2026-08-10) addresses this correctly: write the
ledger entry first, create the identity only if that succeeded. This yields:
- **No unlogged identity** (binding property for the auditor).
- **Orphan ledger entries** (an identity.created ledger entry with no live identity) as a
  visible, reconcilable residual.

Chief explicitly approved this over "atomicity theatre". The reasoning is sound: an orphan
ledger entry is a fixable discrepancy; an unlogged identity is an audit finding.

### Does this workstream buy less than assumed?

**Partially.** The workstream's stated goal is atomic identity + ledger commitment. That goal
requires D1 as the primary identity store, which requires completing the D1 cutover migration.
With the migration complete, `D1.batch()` delivers the atomicity and ledger-first ordering
becomes unnecessary.

Without the migration, no amount of work inside the existing architecture can provide true
atomicity. Ledger-first is the correct and currently-implemented interim.

**The workstream buys real value only if the D1 cutover migration completes.** If the migration
is blocked or deferred indefinitely, the deliverable value collapses to: confirming that the
current ledger-first approach is the best achievable without architectural change. That is a
valid outcome and should be said plainly.

---

## 6. What the auditor needs precisely

From the workstream context (SOC-2 agent traceability, relayauth#77):

**Requirement (RA-4 / CH-1 class):** Every identity creation produces a signed, immutable,
ordered ledger entry. An auditor must be able to prove: (a) no identity was created without
a ledger entry, and (b) ledger entries cannot be retroactively deleted or modified.

**What relayauth#77 (shipped in 0.2.28) delivers:**
- `prev_hash` / `entry_hash` hash chain — ordering and integrity.
- `BEFORE UPDATE` / `BEFORE DELETE` SQL abort triggers — immutability.
- No `updated_at`, no cascade, no TTL — no backdoor mutation.
- Every identity creation writes a signed `identity.created` entry, fail-closed.

**What ledger-first ordering (cloud#2981) adds:**
- Ensures the ledger entry is durable BEFORE the identity is created.
- If identity creation fails after ledger write, the orphan is visible and reconcilable.
- If ledger write fails, identity creation does not proceed — no unlogged identity.

**Over-logging vs under-logging:** The orphan entries produced by ledger-first are over-logging.
The auditor can account for them (identity.created without a corresponding live identity =
creation failed, identity was not live). Under-logging (identity exists, no ledger entry) is
the disqualifying finding. Current architecture produces over-logging, not under-logging.
That is defensible.

---

## 7. Concluding finding

**Do not migrate to D1 immediately.** The migration infrastructure is well-designed and the
cutover gate provides a safe, reversible path. But the migration is a production-level operation
(Khaliq's explicit approval required per workstream) and the current ledger-first arrangement
already satisfies the auditor's binding property.

**The workstream's value proposition is clear:**
- Ledger-first (DONE via cloud#2981) = interim fix, correct, auditor-defensible.
- Full D1 migration = structural fix, enables true `D1.batch()` atomicity.
- This workstream should confirm both of the above and define the migration readiness criteria.

**Next recommended step** (pending Khaliq's approval): Define what "D1 migration readiness"
looks like — specifically, does the D1 `identities` table currently receive live writes
anywhere, and does `list()` return correct results in production today? These questions
determine whether the migration is already partially live or needs a full backfill.

**No code changes in this deliverable.**

---

## 8. Migration-readiness assessment (2026-08-11, second pass)

This section was added after the design note was filed, following a code-level
investigation of the "promoted" D1 state and the G11 migration history.

### Is there any write path to D1 `identities`?

**No. There is no application code path — current or historical — that writes to the
D1 `identities` table.**

Verified by:
- Repo-wide grep for `INTO identities`, `INSERT.*identities`, `UPDATE identities`:
  ZERO hits in cloud source.
- `@relayauth/server` source (`sqlite.ts`): has `INSERT INTO identities` for the
  **local SQLite implementation only** (dev/test). Never deployed to Cloudflare.
- `CloudflareIdentityStorage.create()` has always routed to DO (confirmed in the
  earliest commit `22e692af7`).
- `selectRelayAuthD1Bindings()` swaps `DB` with `DB_CANDIDATE` for "candidate" mode.
  This affects D1-direct methods (list, findDuplicate, etc.) but NOT `create()`
  which routes to `IDENTITY_DO` regardless of `DB`.
- G11 D1 migration: FAILED CLOSED at line 4449 with "terminal postgate application
  tables drift from reviewed root-query contract" (2 tables in contract vs 15 in
  reality). No data was imported to the candidate D1. Nothing published.

### What does `RELAYAUTH_D1_PRIMARY_PROMOTED=true` mean?

It means the production relayauth Cloudflare Worker uses a pinned, SST-unmanaged D1
database (`75960af9-277a-4b30-a63c-0b24bc598682`) that predates SST ownership. It is
the "legacy physical database" referenced in `infra/relayauth.ts`.

Critically, it does NOT mean:
- D1 is the active write target for identities.
- The D1 cutover migration completed.
- The `RELAYAUTH_D1_REQUEST_TARGET` is set to "candidate" in production.

It means: skip the mint circuit breaker in production because the promoted database is
the legitimate primary, not a candidate being tested. Normal requests route to
`fetchRelayAuthApp()` with no cutover gate involved.

### Does `list()` return correct results in production?

**Unknown — requires Khaliq's go-ahead for prod D1 read.** But the code analysis
strongly suggests it does not, for the following reasons:

1. No write path to D1 `identities` exists in application code (see above).
2. The G11 migration that would have populated a candidate D1 FAILED with no data
   imported.
3. The promoted production D1 (`75960af9-...`) was created at product inception. Since
   `CloudflareIdentityStorage.create()` has always routed to DO (from commit
   `22e692af7`), the D1 `identities` table would have been empty from the start
   unless a separate backfill was run.
4. The `@relayauth/server` OSS refactor (commit `7bfd40c`) explicitly removed
   `IdentityDO` and D1 bindings from the published package. Before the refactor,
   `identity-do.ts` in cloud re-exported from `@relayauth/server`; cloud commit
   `0441194ee` "implement IdentityDO (was a 501 placeholder)" moved the implementation
   into cloud. The phrase "501 placeholder" is ambiguous but suggests the original
   `@relayauth/server` IdentityDO did not write to D1 `identities`.

**If D1 `identities` is empty, the following production endpoints are broken:**
- `GET /v1/identities` (list all identities for an org) — returns empty array
- Duplicate name check on create — always null, allows any duplicate name
- Child identity listing — always empty
- Status count aggregates — always 0/0

**This is an escalation-level finding.**

### Retention GC — does it enumerate DOs?

No. The retention GC (`retention-gc.ts`) scans `tokens` and `audit_logs` tables in D1 only. No DO enumeration path exists. The GC cannot serve as a seeding mechanism for D1 `identities`. Cloudflare provides no "list all DO instances" API — without an external index (which G11 would have built), DO enumeration for backfill is impossible.

### Cloud web UI identity fetch path — is `list()` user-facing?

The cloud web app has no user-facing page that calls `GET /v1/identities` (no hits in `packages/web/app`). The primary consumer of the list endpoint is `findRelayfileIdentityByName()` in `core/src/relayfile/client.ts:420` — a 5xx recovery path used when identity creates fail transiently.

**Critical: the codebase already knows and documents the split** (`relayfile/client.ts:397-403`):
> "Cloudflare identity create/get use the identity Durable Object while list/findDuplicate use D1. An empty list result therefore cannot prove that a write did not commit."

This was the INTENDED design for the G11 migration window: G11 would populate D1 from DO, then list/findDuplicate would use the populated D1. Since G11 failed closed, D1 is unpopulated and the recovery path is broken — but only on transient 5xx failures, not on normal creates.

**`findDuplicate()` on every create** (`routes/identities.ts:508-514`): With D1 empty, this always returns null → duplicate identity names are silently allowed per org. The DO has no name-uniqueness guard (keyed by ID, not name).

### Three concrete options for the post-cutover write path

**Option A — Dual-write projection (DO + D1 on every mutation)**
- After every DO `create()`/`update()`/`delete()`/`suspend()`/etc., write a projection row to D1 `identities` in `CloudflareIdentityStorage`
- D1 is the search index only; DO remains authoritative for point lookups
- Pros: Immediately fixes `list()` and `findDuplicate()`; no G11 dependency; implementable now; reversible
- Cons: D1 write latency added to every mutation; partial failure possible (DO commits, D1 write fails → identity temporarily invisible to list; retryable)
- Partial failure risk is acceptable: under-listing is less dangerous than under-creating. The write-through projection is eventually consistent.
- Reversibility: High

**Option B — Background sync (DO → D1 replication)**
- Blocked by DO enumeration: Cloudflare has no "list all DO instances" API. Without G11's initial index, this is not implementable.
- Verdict: Not the right first step. Dependency on G11.

**Option C — Full D1-primary (goal state)**
- After G11 populates D1: flip all mutations to D1; `D1.batch([INSERT identities, INSERT attestation_ledger])` delivers true atomicity; DO instances eventually retired
- Requires G11 repair: C12 fix + 15-table root-query contract populated
- D1 uniqueness guard: `UNIQUE(org_id, name)` index exists in `0001_local_bootstrap.sql` + app-level retry logic for concurrent creates
- Verdict: Correct end state; blocked on G11

**Recommended sequence: Option A → Option C**
Option A (dual-write projection) fixes the immediate production gaps without blocking on G11. Option C is the architectural end state. Option A is non-blocking on Option C — the D1 writes from Option A become the canonical path once Option C lands and the DO writes retire.

### Migration readiness verdict

The D1 cutover (DO → D1 as primary for identities) is **not ready** to proceed until:

1. The G11 import script is repaired: populate `RELAYAUTH_APPLICATION_ROOT_QUERY_CONTRACT`
   with all 15 tables (not 2). This is a security decision per the G11 memory — the
   contract is the reviewed allowlist; equality is the point.
2. The C12 anti-promotion coverage gap is closed (see G11 memory: "projection promoted
   to measurement" test case must reject C12 alone after artifact regeneration).
3. A write path for post-promotion identities is defined. Currently the DO write is
   always to DO-local SQL regardless of D1 target. Post-cutover, new creates must also
   land in D1, or `list()` remains blind to them.

Item 3 is an architectural gap: no code today writes a newly created identity to D1.
The cutover plan must specify how point 3 is addressed — either:
- The DO writes to D1 on create (new code, adds D1 latency to every create)
- A background sync job replicates DO → D1 (eventual consistency, lag)
- The DO is eliminated and creates go directly to D1 (structural fix, full migration)

**BLOCKED ON CHIEF: Is the D1 `identities` table empty in production today?** The code
analysis says it should be. If confirmed, `list()` is a live production bug to triage
immediately, independently of the DO→D1 migration question.

---

## Appendix: cloud#2981 state (verified 2026-08-11)

- Title: `chore(deps): bump @relayauth/* to 0.2.28`
- Branch: `chore/relayauth-0.2.28`
- **State: MERGED** (2026-08-10T03:11Z, all CI checks SUCCESS)
- Carries: identity sponsor OIDC binding (relayauth#75) + hash-chained write-once ledger
  with fail-closed `identity.created` entry (relayauth#77).
- Not in scope for this workstream to touch. Confirmed landed.
