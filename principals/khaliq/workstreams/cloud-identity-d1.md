---
status: active
owner: unassigned
previous_owner: cloud-identity-lead-0811v3
reports_to: soc2-program-lead-0811
updated: 2026-08-11
repos: [cloud, relayauth]
---
# Cloud identity of record — Durable Objects to D1

**Goal:** cloud can commit an identity and its SOC-2 attestation ledger entry
**atomically**, so no identity can exist without a ledger entry — the property an
auditor actually asks about.

## Now — appointed 2026-08-09 on Khaliq's instruction

**The two stores are split and the guarantee cannot be a transaction.**

- `CloudflareIdentityStorage.create()` (`packages/relayauth/src/storage/cloudflare/identities.ts:147`)
  forwards to the **`IDENTITY_DO` Durable Object**.
- `IdentityDO.save()` (`durable-objects/identity-do.ts:292`) writes **DO-local SQL**.
- Repo-wide grep for `INTO identities` outside `node_modules` returns **zero
  hits** — nothing in cloud ever writes an identity row to D1.
- The attestation ledger **is** a D1 table (migration `0007_attestation_ledger`,
  shipped inside `@relayauth/server`).
- **`D1.batch()` is one transaction over D1 only.** It cannot cover the DO write.

`relayauth`'s reference SQLite implementation gets atomicity free because both
live in one database (`sqlite.ts:2592`, `beginSqliteTransaction`).

**The interim, already in flight and not this lane's to touch.**
`cloud-attestation-storage-0809` is landing **ledger-first ordering** on
`cloud#2981`: append the ledger entry, create the identity only if that
committed. That yields **no unlogged identity** — the binding property — and
leaves **orphan ledger entries** as a visible, reconcilable residual. Chief
approved it explicitly over atomicity theatre.

## The discipline this workstream must not skip

**Establish why Durable Objects were chosen before proposing to leave them.**
DOs give single-writer serialization and locality; someone chose that
deliberately and the reasons may still hold. **A migration that discovers the
reason afterwards is how a live identity store is lost.**

## Next

**First deliverable is a design note, not code:**

1. What the DO provides today — serialization, read-your-writes, locality,
   contention — and which of those D1 does not.
2. Every reader and writer of `IDENTITY_DO`, **enumerated, not sampled**.
3. Migration path for existing identities, and whether it is reversible at each
   step.
4. **Does D1 actually deliver the atomicity we want, or is ledger-first needed
   regardless?** If the latter, this workstream buys less than assumed and that
   must be said early.
5. What the auditor needs precisely. **Over-logging is defensible; under-logging
   is not.**

**Concluding "do not migrate" is an acceptable outcome** and must be stated
plainly rather than avoided.

**No production migration or schema change without Khaliq's explicit approval.**
A `cloud` merge fires a full-SST production deploy.

## History

- 2026-08-11 cleanup checkpoint — the design note and full reader/writer
  enumeration are durable. `cloud-identity-lead-0811v3` was explicitly idle,
  waiting 156 minutes with zero pending messages, and was released. The next
  action remains Khaliq's migration-readiness/backfill ruling; no production
  migration was performed.
- 2026-08-09 — Opened and given a lead on Khaliq's instruction, after
  `cloud-attestation-storage-0809` flagged the split store while implementing
  `attestations` for `@relayauth/* 0.2.28`. See [[soc2-agent-traceability]].
- 2026-08-11 — `cloud-identity-lead-0811v3` appointed after prior placement
  failures (sf-mini dropped 3x, local v2 received no task brief). First
  deliverable: design note at `chief/evidence/cloud-identity-d1-design-note-0811.md`.
  Key findings: (1) cloud#2981 MERGED 2026-08-10, ledger-first already landed.
  (2) DO serialization rationale established — single-writer per identity, no
  row locks needed, `blockConcurrencyWhile()` for schema safety. (3) IDENTITY_DO
  readers/writers enumerated: 7 DO paths (get/create/update/delete/suspend/retire/
  reactivate), 6 D1-direct paths (list/findDuplicate/loadOrgBudget/listChildIds/
  listChildren/getStatusCounts), plus DO-internal D1 write (audit_events).
  (4) D1 delivers true atomicity post-migration via D1.batch(); ledger-first
  needed regardless during transition. (5) Migration is reversible through
  step 5 (target flip) while DO instances survive. (6) Zero `INTO identities`
  hits confirmed — D1 identities table populated only by migration process.
  Awaiting Khaliq approval for next step: assess whether D1 migration readiness
  criteria are met or a full backfill is required.
