# Identity storage: Durable Object vs D1

Ref: `639ec90c9d80ca7e5440ea6b1d765daac4678ba5` (verified, exit 0).
Real paths: `packages/relayauth/src/durable-objects/identity-do.ts`,
`packages/relayauth/src/storage/cloudflare/identities.ts`.

## Bottom line, stated first

**D1 does deliver the atomicity this workstream wants** — identity row and ledger
entry in one `batch()` — but the workstream still buys less than assumed, for
three reasons that matter more than the atomicity win:

1. The property SOC-2 actually tests is **already guaranteed** by ledger-first
   ordering, which is **already merged** (cloud#2981, `d936b9e6`, an ancestor of
   this ref — not "in flight"). What migration closes is *over-logging* (orphan
   ledger entries), which the code itself documents as "visible, reconcilable,
   and harmless to the 'no unlogged identity' claim".
2. The DO provides **per-identity read-modify-write serialization** that D1 does
   not provide at all. Four mutations depend on it. Migration means rewriting
   every one as a guarded conditional statement or losing updates silently.
3. There is a **live audit hole in the DO today** that neither ledger-first nor
   this migration addresses, and which is worth more attention than either.

## 0. The premise needs correcting first

Two scoping facts change the question.

**(a) Identities are already half in D1.** `CloudflareIdentityStorage` splits by
operation, not by store:

- DO path: `get` (L131), `create` (L149), `update` (L165), `delete` (L178),
  `suspend` (L185), `retire` (L198), `reactivate` (L215) — all via
  `requestIdentityDurableObject` (L307–343).
- D1 path: `list` (L116), `findDuplicate` (L228), `listChildIds` (L266),
  `listChildren` (L282), `getStatusCounts` (L292) — all `SELECT` against a D1
  table named `identities`.

So "move identities to D1" is not a greenfield migration. It is finishing a
split that already exists and is already load-bearing.

**(b) That D1 table has no writer in this repo.** Exhaustive survey at this ref:
zero `INSERT`/`UPDATE`/`DELETE` against `identities`, and no `CREATE TABLE
identities`. Every reference is one of the five SELECTs above. The schema ships
inside the `@relayauth/server` npm package — `packages/relayauth/scripts/
source-migration-preflight.mjs` pins `0007_attestation_ledger` and
`0008_identity_lineage` by checksum — so the table is real, but nothing in
`cloud` populates it.

If nothing outside this repo writes it either, then `findDuplicate` always
returns `null` and duplicate-name detection is silently disabled, and `list` /
`getStatusCounts` return empty. **I could not establish whether
`@relayauth/server` 0.2.28 writes it internally** — the package is not vendored
and `node_modules` is absent from a fresh clone. This should be checked before
anything else in this workstream, because it is a live correctness question that
does not depend on the migration decision at all.

## 1. What the Durable Object provides today

### One object per identity → single-writer serialization

`identities.ts:322` derives the object name from the identity id
(`IDENTITY_DO.idFromName(normalizedIdentityId)`). Each identity gets its own DO,
so serialization is per-identity, not global.

The implementation depends on this in a way that is not merely an optimization.
`SELECT_SQL` (L47–52) has **no `WHERE` clause** — it takes `ORDER BY updated_at
DESC, id DESC LIMIT 1`. `DELETE_SQL` (L60) is a bare `DELETE FROM
identity_records` with the comment "Each DO instance holds exactly one identity".
Both are only correct because the object boundary guarantees one row.

Four mutations are read-modify-write across that boundary:
`update` (read L185 → write L195), `suspend` (L203 → L217), `reactivate`
(L224 → L238), `retire` (L245 → L255). Each reads current state, computes the
next state in JavaScript, and writes it back. Correct only if no other writer
interleaves.

Platform basis: `blockConcurrencyWhile` "executes an async callback while
blocking any other events from being delivered to the Durable Object until the
callback completes" and "guarantees ordering and prevents concurrent requests"
(https://developers.cloudflare.com/durable-objects/api/state/). Input gates:
"While a storage operation is executing, no events shall be delivered to the
object except for storage completion events"
(https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/ —
Cloudflare's own engineering blog, not reference documentation; labelled as
such).

### Read-your-writes

`read()` (L275) is `this.sql.exec<SqlRow>(SELECT_SQL).one()` against the
object's local SQLite. Cloudflare states "SQLite storage operations are
synchronous and do not yield the event loop, so they execute atomically without
it" (https://developers.cloudflare.com/durable-objects/api/state/). `create`
writes at L168 and the caller can `get()` immediately; there is no replication
lag to reason about because there is no replica.

### The transactional storage API — used less than you would expect

`IdentityDO` never calls `ctx.storage.transaction()`. It relies on implicit
atomicity: "Any series of write operations with no intervening `await` will
automatically be submitted atomically"
(https://developers.cloudflare.com/durable-objects/api/storage-api/).

That condition is **not met** in the identity path. `create` (L168–169) and
`update` (L195–196) call `save()` and then `await syncBudgetUsage()`, which
writes a separate `ctx.storage.put("budgetUsage", …)` key (L303) — a different
storage system inside the same object, separated by an `await`. The SQL row and
the `budgetUsage` key are therefore **not written atomically together**. A
failure between them leaves the identity row updated and the budget-usage key
stale.

By contrast `RelayAuthD1CutoverGateDO` in `d1-cutover.ts` does use
`ctx.storage.transaction()` throughout (L800, L862, L900, L1053, L1130, L1287,
L1407). The identity DO is the one that does not.

### Locality and placement

"By default, a Durable Object is instantiated in a data center close to where
the initial `get()` request is made" and "Durable Objects do not currently
change locations after they are created"
(https://developers.cloudflare.com/durable-objects/reference/data-location/).

There is **no `locationHint` anywhere in the repo** (verified by grep);
`infra/relayauth.ts:171` binds `IDENTITY_DO` with no placement configuration.
So each identity's storage is pinned wherever that identity was first touched,
permanently, with no control and no relocation. For a global agent fleet this
means an identity minted from one region is read from that region forever.

### Contention and queueing

Contention is confined to concurrent operations on the *same* identity, which is
the desirable shape. The cost is that every DO cold start runs
`blockConcurrencyWhile` with `CREATE TABLE IF NOT EXISTS` (L67–69), blocking all
delivery until schema init completes.

### Failure modes — including one that is a live defect

**The input gate does not cover the D1 audit write.** `applyBudgetPolicy`
(L330–360) can call `writeBudgetAuditEvent` (L379–423), which does `await
…prepare(query).bind(…).run()` against D1 (L407–419). That await sits *between*
the read and the write of the read-modify-write. Cloudflare's rule closes the
input gate for storage operations; an external call is not a storage operation.
So on the budget-exceeded path a second request to the same identity can
interleave between read and save, and one update can be lost. Narrow — it needs
`autoSuspend` and a budget breach — but real, and it is exactly the guarantee
the DO is otherwise relied upon for.

**The audit write fails silently.** L420–422 catches any D1 failure from that
insert and only `console.error`s it. A budget-driven suspension can therefore be
persisted to the DO with **no corresponding `audit_events` row in D1**. That is
under-logging — the precise failure mode `attestations.ts` deliberately fails
closed to prevent ("An implementation that logged and continued would permit an
unlogged identity to exist, which is precisely the question the audit asks",
L149–152). Two files in the same package take opposite positions on the same
question. **This is a SOC-2-relevant gap that exists today and is untouched by
both ledger-first and the proposed migration.** I would put it above the
migration in priority.

**`create` silently overwrites.** `UPSERT_SQL` (L54–57) is `INSERT OR REPLACE`.
Creating an identity that already exists replaces it rather than failing.

## 2. Property by property: does D1 provide it?

| Property | D1 | Basis |
|---|---|---|
| Per-key single-writer serialization | **NOT provided** | D1 is single-threaded *per database* — "Each D1 database is inherently single-threaded, and processes queries one at a time" (https://developers.cloudflare.com/d1/platform/limits/). That serializes statement execution globally; it is not a per-key lock and does not make a JS-level read-modify-write atomic. |
| Atomic read-modify-write | **NOT provided** | "D1 operates in auto-commit" and "Batched statements are SQL transactions" over a *predetermined* statement list (https://developers.cloudflare.com/d1/worker-api/d1-database/). You cannot read, compute in JS, and write inside one transaction. |
| Read-your-writes | **Provided by default; NOT provided under read replication unless Sessions are used** | Replication is opt-in and asynchronous: "D1 asynchronously replicates changes from the primary database instance to all read replicas". Without the Sessions API replicas give no consistency guarantee; with it you get sequential consistency — "If you write to the database, all subsequent reads will see the write" (https://developers.cloudflare.com/d1/best-practices/read-replication/). |
| Multi-statement atomicity | **Provided** | `batch()` is a transaction; "If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence" (https://developers.cloudflare.com/d1/worker-api/d1-database/). |
| Locality / placement | **Different model, not equivalent** | D1 has a primary with optional read replicas; there is no per-identity placement. Not better or worse — a different axis. |
| Contention / queueing | **Global, not per-key** | One query at a time per database; six concurrent connections per Worker invocation; 1000 queries per invocation (https://developers.cloudflare.com/d1/platform/limits/). A hot identity no longer isolates itself. |
| Capacity | **Bounded** | 10 GB max database size on Workers Paid (https://developers.cloudflare.com/d1/platform/limits/). Per-identity DO storage does not share a single ceiling; a single D1 database does. |

The decisive asymmetry: **the DO gives per-identity mutual exclusion and no
cross-store atomicity; D1 gives cross-row atomicity and no per-key mutual
exclusion.** They are complements, not an upgrade path.

## 3. Does D1 deliver the atomicity — or is ledger-first needed regardless?

**D1 does deliver it, and ledger-first would become unnecessary for the create
path** — with one qualification that must not be skipped.

The ledger is a hash chain. `appendWithSequenceRetry` (L318–340) must read the
current tail (`readLastEntry`, L361–369) to compute `prev_hash` and `org_seq`
before it can build the entry. That read-modify-write cannot itself live inside
a `batch()`. The existing design handles it with optimistic concurrency: a
`UNIQUE (org_id, org_seq)` collision means another writer won, and it re-chains,
up to `LEDGER_APPEND_MAX_ATTEMPTS = 5` (L136).

With identities in D1 the create path becomes: read tail → compute chained entry
→ `batch([insert identity, insert ledger entry])`. The batch is one transaction,
so either both land or neither does, and a sequence collision aborts the
identity insert along with the ledger insert and retries. That genuinely
eliminates the orphan-entry asymmetry. The pattern is already proven in this
file — `createGrantWithLedgerEntry` (L238–247) does exactly this shape today for
grants.

So the honest answer to the question as asked: **yes, D1 closes the gap.**

But the workstream still buys less than assumed:

- **What it closes is the harmless half.** Ledger-first already guarantees the
  audited property: no identity exists without an `identity.created` entry. The
  residual is over-logging, which the code describes as "visible, reconcilable,
  and harmless" (L177–178) and detectable by reconciliation (L186–189).
  Migration converts a reconcilable discrepancy into no discrepancy. That is
  worth something to auditors, but it is not a control failure being fixed.
- **Ledger-first is still needed for everything that is not one batch.** Only
  operations expressible as a fixed statement list get batch atomicity. Any path
  that must read-then-decide still needs ordering discipline.
- **It costs the property D1 cannot replace.** All four read-modify-write
  mutations must be rewritten as single guarded statements — the pattern
  `REDEEM_ATTESTATION_GRANT_SQL` already uses, putting the precondition in the
  `WHERE` clause (L78–84, with the reasoning spelled out at L71–77) — or given
  an optimistic version column. Miss one and it fails silently as a lost update,
  which is the worst possible failure mode for an identity store.

### Why the DO was chosen — the honest answer

**The concurrency rationale is not recorded in this repo, and I could not
establish it.** What the history shows is weaker and different: the DO was
*inherited*, not selected on its merits here. Commit `0441194e` ("fix(relayauth):
implement IdentityDO (was a 501 placeholder)") records that the real
implementation previously lived in `@relayauth/server`, that the OSS refactor
(`relayauth 7bfd40c`) stripped Cloudflare dependencies from that package, and
that this repo then had to port it. `AGENTS.md:307–333` records the resulting
rule as a **repo-boundary** rule — Cloudflare-specific code lives in `cloud` —
not as a statement about serialization semantics.

That is not evidence that no reason existed. The original decision lives in the
`relayauth` repository's history, which is outside my ref and which I did not
read. **Before anyone migrates, someone should read it.** That is precisely the
"migration that discovers the reason afterwards" risk.

One data point cuts the other way and deserves weight: `attestations.ts:162–163`
notes that *"Unlike the reference SQLite backend, this cannot be one
transaction"*. The OSS reference implementation keeps identities and ledger in
one transactional store. The Cloudflare adapter is the outlier. Moving
identities to D1 would bring it back into line with the semantics the storage
interface was designed around — a real architectural argument, independent of
SOC-2.

### Recommendation

**Do not start the migration yet.** Not because it is wrong — the atomicity case
is sound and the convergence-with-OSS-semantics case is genuinely good — but
because three cheaper things must resolve first, and two of them may change the
answer:

1. **Determine whether anything writes the D1 `identities` table.** If nothing
   does, `findDuplicate`, `list`, `listChildren` and `getStatusCounts` are broken
   in production right now. That is a bigger live defect than orphan ledger
   entries, and it is free to check.
2. **Fix the silent audit-write failure** at `identity-do.ts:420–422`. An
   unlogged budget suspension is a real audit gap; ledger-first does not cover
   it and neither does this migration.
3. **Read the `relayauth` repo history for the original DO rationale.** If it
   was chosen for per-identity serialization, the migration needs an explicit
   concurrency design for all four mutations before any code moves.

If those clear and the migration proceeds, the per-identity read-modify-write
rewrite is the whole risk, and it should be designed before it is scheduled.

## What I could not establish

- **Whether `@relayauth/server` 0.2.28 writes the D1 `identities` table.** Not
  vendored; `node_modules` absent from a fresh clone. Unknown — and it is the
  single most important open question here.
- **Whether D1 read replication is enabled on the RelayAuth production
  database.** Requires production access, which is out of scope by instruction.
  If it is enabled, the read-your-writes column above changes and the five D1
  SELECT paths need Sessions. Unknown.
- **An explicit Cloudflare statement that interactive `BEGIN`/`COMMIT`
  transactions are unsupported in D1.** I checked the Worker API, D1 database
  API, SQL-statements and import/export pages and found none. The claim above
  rests on "D1 operates in auto-commit", `batch()` being described as the
  transaction primitive, and the absence of any interactive API — that is an
  inference from cited behaviour, **not a citation**, and is labelled as such.
- **The original design rationale for `IdentityDO`.** Not in this repo; lives in
  `relayauth` history, which is outside my ref.
- **Production behaviour of any kind.** Nothing here was measured. Every
  platform statement is from Cloudflare documentation as cited; every
  implementation statement is from source at the stated ref and line.
