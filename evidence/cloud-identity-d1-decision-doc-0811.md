# Cloud Identity D1 — Decision Document for Khaliq
**Prepared by cloud-identity-lead-0811v3, 2026-08-11**
**For: soc2-program-lead-0811 → Chief → Khaliq**

This is a 2-minute read. Background detail is in `cloud-identity-d1-design-note-0811.md`.

---

## What you need to decide

**Two decisions, in order:**

1. **Is D1 `identities` empty in production?** (requires a prod D1 read)
2. **Which fix path to take** (depends on answer to 1)

---

## Decision 1 — Confirm production state

**Question:** Run `SELECT COUNT(*) FROM identities` against D1 database `75960af9-277a-4b30-a63c-0b24bc598682` (the relayauth production database).

**Why this matters:**
- If empty: two production gaps are live today (see below). Pick a fix path.
- If populated: the analysis changes. Report back to this workstream.

**Code analysis says it should be empty.** No application code has ever written to D1 `identities`. The G11 migration that would have populated it failed closed on 2026-08-01. But only a direct read proves it.

**This is a read-only query. No data changes.**

---

## What's broken if D1 `identities` is empty

| Gap | Severity | User-visible? | Description |
|---|---|---|---|
| `findDuplicate()` | Data integrity | No | Duplicate identity names silently allowed per org. Every create skips the name-collision check. |
| 5xx recovery | Reliability | No | If a create returns a 5xx after the DO committed, the recovery path can't find the identity by name. Affects transient failure paths only. |
| `GET /v1/identities` list | Audit surface | No | Returns empty for all orgs. No user-facing UI calls this today, but auditors and API clients do. |

**No empty list is being shown to users today.** The web app does not call the list endpoint.

---

## Decision 2 — Fix path

Three options. Pick one.

### Option A — Dual-write projection (fix now, no migration needed)

**What:** After every DO mutation succeeds (create/update/delete/suspend/retire/reactivate), also write a projection row to D1 `identities`. D1 stays the search index; the Durable Object stays the authoritative record.

**Fixes:** All three gaps above. Immediately.

**Risk:** If the D1 write fails after the DO write succeeds, the identity is temporarily invisible to `list()` until retried. Under-listing is acceptable — the identity still exists and is fully functional.

**No schema change. No migration. Additive only. Reversible.**

**What it doesn't fix:** The existing population gap — identities created before this lands won't appear in D1. A one-time backfill of existing identities would be needed separately (see note below).

**Requires:** Code change in `packages/relayauth/src/storage/cloudflare/identities.ts`. PR ready within hours of approval.

---

### Option B — Background sync (DO → D1 replication)

**Not feasible as a first step.** Cloudflare has no "list all DO instances" API. Without an index of existing DO IDs (which the G11 migration would have built), a background sync can't know which DOs to visit.

**Verdict: blocked. Skip.**

---

### Option C — Full D1-primary (structural fix, goal state)

**What:** Complete the G11 migration (populate D1 from DO), flip `RELAYAUTH_D1_REQUEST_TARGET` to "candidate", retire DO-as-primary over time. Identity creates go directly to D1. `D1.batch([INSERT identities, INSERT attestation_ledger])` delivers true atomicity — no ledger-first workaround needed.

**Requires:** G11 repair first:
- Close C12 coverage gap (see memory `project_relayauth_g11_c12_matures_at_attempt2.md`)
- Populate root-query contract with all 15 tables (currently 2 — security decision, not mechanical)

**Timeline:** G11 repair is not a quick task. Days of careful work.

**Verdict: right end state, not available today.**

---

## Recommended sequence

**Option A now → Option C when G11 is ready.**

Option A fixes the live gaps immediately. It is non-blocking on Option C — once G11 completes and Option C lands, Option A's D1 writes become the canonical path and the DO writes retire. No rework.

---

## The backfill question (separate from the above)

Even after Option A ships, identities that existed before the PR lands won't be in D1. If you want `GET /v1/identities` to return historical identities (pre-Option A), a one-time backfill is needed. This requires enumerating existing DO IDs — which requires a separately-maintained index (not currently available). G11 would produce this index as a side effect. Alternatively, if the identity population is small enough, a manual enumeration via the DO HTTP interface is possible.

**The backfill is not required to fix the `findDuplicate()` gap** (that's a forward-looking correctness fix). It is required only if full historical identity visibility via `list()` is needed before G11.

---

## Standing constraint reminder

No production migration or schema change without Khaliq's explicit approval. Option A is a code-only change with no schema change and no migration — it ships via a normal PR + CI + deploy cycle.
