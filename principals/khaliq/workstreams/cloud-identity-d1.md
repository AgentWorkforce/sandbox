---
status: active
owner: cloud-identity-d1-lead-0810
updated: 2026-08-10
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

- 2026-08-09 — Opened and given a lead on Khaliq's instruction, after
  `cloud-attestation-storage-0809` flagged the split store while implementing
  `attestations` for `@relayauth/* 0.2.28`. See [[soc2-agent-traceability]].
