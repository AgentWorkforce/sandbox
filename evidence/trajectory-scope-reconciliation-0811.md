# Trajectory scope reconciliation — 2026-08-11

**Author:** trajectory-lead-0811v3  
**Filed per:** overnight-2026-08-11-contract.md §4 (findings go to evidence/, not DMs)

---

## 1. The two workstreams and their distinct questions

| Workstream | Question answered | Substrate |
|---|---|---|
| `soc2-agent-traceability` | *Who did this and can an auditor verify it?* — attestation, tamper-evidence, custody | relayauth ledger, factory trailers, OIDC sponsor chain |
| `intent-trajectory-lineage` | *Why does this code exist and what was learned building it?* — context for the next implementer | relaycast (cross-node), trail (per-repo), ai-hist (per-node), Linear (human surface) |

These are distinct questions over shared substrate. They must not be built as one ledger, and they must not duplicate each other's infrastructure.

---

## 2. The SOC-2 spine — what already exists (live as of 2026-08-10)

`relayauth` 0.2.28 + `cloud#2981` merged and deployed:

- **Attestation ledger** (`0007_attestation_ledger`): hash-chained, append-only, write-once, RS256-signed entries. Fields: `agentId`, `sponsorChain` (OIDC-bound human), `commitSha`, `repo`, `ts`, `jti`.
- **Identity lineage** (`0008_identity_lineage`): queryable token lineage in `src/db/migrations`.
- **Hole 1 closed** (`relayauth#75`): workspace-key sponsor forgery is patched; every sponsor is now OIDC-bound.

The chain that exists today: **commit → agent → responsible human (OIDC).**

What it does NOT carry: session reference (the reasoning context), work-unit id (the originating intent), or runtime tracking.

---

## 3. The join point: session provenance

Khaliq added session provenance to the SOC-2 scope on 2026-08-08:

> *"For a PR and its commits it would definitely help to have agent info on which identity agent worked on that feature and associated session information."*

SOC-2 has four open questions on session provenance (see workstream §"Session provenance"). Trajectory-lead's answer to question 1:

**Q1: Does a stable session identifier already exist at commit time?**  
**A:** Yes. `ai-hist` assigns a stable session UUID per Claude Code / Codex session. The session UUID is already in the local index (182,381 entries verified). It is the right identifier — it is stable, already indexed, and searchable via `ai-hist session <uuid>`.

**The join:** if factory stamps the `ai-hist` session UUID alongside `RELAY_ATTEST_*` vars at commit time, the attestation entry gains a `sessionRef` that allows:
- Auditor path: commit → attestation → OIDC-bound human (SOC-2)
- Intent path: commit → sessionRef → ai-hist search → full conversation context → Linear issue pointer (trajectory)

This is additive, not duplicative. Trajectory-lead specifies the `sessionRef` concept; SOC-2 / factory stamps it. One field, two consumers.

**Unverified:** whether `RELAY_ATTEST_*` env vars are already injected at spawn time alongside the session UUID. SOC-2 workstream question 1 asks this — it needs a factory read, which is out of trajectory-lead's scope. Flagging to soc2-lead and Chief.

---

## 4. Scope boundary — what trajectory-lead does NOT own

Do not build:
- The attestation ledger (relayauth owns it, live)
- Hash-chain tamper-evidence (relayauth owns it, live)
- OIDC sponsor binding (relayauth owns it, live, Hole 1 closed)
- Factory commit trailers (factory owns it, in progress — SOC-2 gap 3)
- Verifier / report surface (Chief owns it — SOC-2 gap 6)

---

## 5. Work-unit identity — proposal for Chief ruling

**The decision:** what is a work unit and what is its stable id?

**Proposed definition:**  
A work unit is a declared human intent, bounded by a lifecycle (open → active → done/abandoned), that produces a traceable artifact sequence. It is surface-agnostic: the same work unit arrives through Linear today, through GitHub issues or Notion tomorrow. The work-unit id is stable across the work unit's lifetime and does not change when a PR is opened, merged, or deployed.

**Today's projection:** the Linear issue id (e.g., `ENG-123`).  
- Stable: yes (Linear issue ids do not change)  
- Writable by agents: yes (via the `/linear` Relayfile projection Chief already uses)  
- Readable cross-surface: yes (Linear API, also embeddable in PR descriptions)  
- Lifecycle: yes (open → in-progress → done)

**The id Chief needs to rule on:** is the work-unit id the Linear issue id itself (`ENG-123`), or does trajectory-lead mint a separate opaque id (`wu_xxxx`) that maps to the Linear issue id? 

Arguments for using the Linear id directly:
- Zero new minting infrastructure
- pr-shepherd already needs to link to Linear issues
- Auditor can look it up
- Factory already routes by Linear issue

Arguments for a separate opaque id:
- Surface-agnostic by construction (no Linear dependency baked in)
- Works if the same work arrives through GitHub or Notion with no Linear issue
- Allows the work unit to outlive the Linear issue if Linear is deprecated

**Trajectory-lead's recommendation:** use the Linear issue id as the `work_unit_id` value today, with the field name `work_unit_id` (not `linear_issue_id`) and a `work_unit_surface` field set to `"linear"`. When Factory routes from GitHub, `work_unit_surface = "github"` and `work_unit_id = "org/repo#123"`. This preserves surface-agnosticism in the schema without minting a new id type. Chief ruling needed before the pointer contract is written.

---

## 6. Pointer contract — draft for Chief ruling

A pointer is a durable reference from the Linear issue back to an artifact produced during its trajectory.

**Proposed shape:**
```json
{
  "work_unit_id": "ENG-123",
  "work_unit_surface": "linear",
  "pointer_type": "conversation|pr|commit|deploy|runtime",
  "target_ref": "<relaycast-message-id|github-pr-url|commit-sha|deploy-id|posthog-event-id>",
  "target_system": "relaycast|github|relayauth|posthog",
  "written_at": "<ISO timestamp>",
  "written_by": "<agent-name>"
}
```

**Where it is written:** as a comment on the Linear issue, formatted as a machine-readable block alongside human-readable text. Chief owns the write path via the `/linear` Relayfile projection.

**Durability guarantee:**  
- `relaycast` targets: durable while the workspace retention policy is null (default). A pointer to a relaycast message is only as good as the workspace's retention setting — this is the gap the workstream names ("a pointer to a conversation that has aged out is worse than no pointer").  
- `github` targets: permanent (GitHub PRs and commits do not expire).  
- `relayauth` targets: hash-chained, append-only — permanent by design.

**Minimum viable pointer:** the first pointer (conversation) is the most important and the hardest. If relaycast retention is not set to null explicitly, the target can age out. **Before writing any pointer contract, verify the live workspace's `workspaces.retention.message_ttl_days` setting in relaycast.** If it is non-null, the pointer is fragile.

---

## 8. Pointer write format — decided (no Chief ruling needed)

**Decision: HTML comment appended to PR body. Decided 2026-08-11 by trajectory-lead.**

Option 3 (relay DM) ruled out by overnight contract: DMs don't survive restart.
Option 2 (PR label) ruled out: 100-label-per-repo cap, accidental deletion.

**Format:**
```
<!-- trajectory: work_unit_id={id} work_unit_surface={surface} session_ref={uuid} -->
```

Appended as the last line of the PR body, blank line above it. trajectory-lead writes it via `PATCH /repos/{owner}/{repo}/pulls/{number}` (body append, never replace). pr-shepherd reads it from `pull_request.body` in the webhook payload using regex `/<!--\s*trajectory:\s*(.*?)\s*-->/`. Missing fields = null in ledger. Value of `work_unit_id` pending Chief ruling on format.

---

## 9. Session UUID in RELAY_ATTEST env vars — probed

**Finding: session_id exists in the relay spawn spec but is NOT in the RELAY_ATTEST_* env vars today.**

`relay/crates/broker/src/spawner.rs` injects: `RELAY_ATTEST_JTI`, `RELAY_ATTEST_AGENT_ID`, `RELAY_ATTEST_SPONSOR_ID`. The `prepare-commit-msg` hook stamps those three as `Agent-Id:`, `Sponsor-Id:`, `Relay-Attestation:` git trailers.

`spec.session_id` (the Claude Code session UUID = the ai-hist session UUID) IS tracked on the relay agent record (`sessionRef`) and IS returned by `fleet.spawn()` to factory. It is NOT currently injected into the commit environment.

**Gap:** one additional env var (`RELAY_ATTEST_SESSION_ID`) in `spawner.rs::with_commit_attestation_env()` and one additional line in the `prepare-commit-msg` hook would complete the chain. This is a relay change, owned by soc2-lead or the relay team. Filing this finding to Chief for routing.

---

## 10. Relaycast cloud retention — CRITICAL FINDING

**The live relaycast cloud deployment prunes messages after 30 days by default.**

Source: `relaycast-cloud/packages/relaycast/src/entrypoints/cloudflare.ts:137`
```typescript
pruneExpired(dbFor(env), { defaults: { messageTtlDays: 30 } })
```

Comment in-situ: *"Message retention is opt-in in the engine (default null), so we set a deployment-wide 30-day messageTtlDays default explicitly."*

Per-workspace `workspaces.retention` overrides (including explicit `null` = keep forever) are honored. The AgentWorkforce workspace's override is unknown — cannot query cloud D1 directly.

**Consequence for pointer contract:** a relaycast message ID is NOT a suitable 6-month-durable pointer target under the current deployment default. A pointer to a 31-day-old conversation resolves to nothing and reads as coverage.

**Revised pointer target for conversation pointers:**
- Instead of: relaycast message ID (expires in 30 days by default)
- Use: `ai-hist` session UUID — the local index is durable, does not expire, and can be pushed to relayhistory-cloud via `ai-hist push`. An auditor or implementer runs `ai-hist session <uuid>` to read the full conversation.
- The relaycast message ID can be included as a secondary field (useful while the message is live) but must not be the primary reference.

This revises the pointer schema from the earlier draft:
```json
{
  "work_unit_id": "...",
  "work_unit_surface": "linear",
  "pointer_type": "conversation",
  "target_ref": "<ai-hist-session-uuid>",
  "target_system": "ai-hist",
  "target_secondary_ref": "<relaycast-message-id>",
  "target_secondary_system": "relaycast",
  "written_at": "...",
  "written_by": "..."
}
```

**Action needed:** Chief to confirm whether the AgentWorkforce workspace has a `workspaces.retention` override of `null`. If yes, relaycast message ID is also durable and the secondary field is redundant. If no (or unknown), the ai-hist session UUID is the primary durable reference.

---

## 7. Rulings received and open items — updated 2026-08-11 ~06:52Z

**Item 1 — Work-unit id format: RULED by Chief 2026-08-11.**
`work_unit_id` is **never** borrowed raw from a surface. Mirror
`factory.config.json`'s `issueSource` pattern: `work_unit_surface` names
where the unit originated (`linear`, `github`, `relay`, …); `work_unit_id`
is a value scoped by that surface. When `work_unit_surface = "linear"`,
`work_unit_id` is that issue's own identifier (team key + number). When a
work unit originates elsewhere with no Linear issue, a **synthesized id is
minted**, never borrowed from Linear after the fact. Does not come back to
Khaliq. **Pointer contract: written in §11 below.**

**Item 2 — Relaycast retention for AgentWorkforce workspace: RESOLVED, 2026-08-11 ~07:14Z.**
Queried relaycast-cloud D1 via wrangler. Workspace is `rw_7ccfea89` (the
Relayfile workspace ID, not the Cloud UUID):
```sql
SELECT id, name, retention FROM workspaces WHERE name LIKE '%rw_7ccfea89%';
-- Result: id=rw_7ccfea89, name=rw_7ccfea89, retention=null
```
`retention: null` means **no workspace override** — the deployment-wide 30-day
default applies. Messages ARE pruned after 30 days.

**Consequence:** relaycast message IDs are NOT durable beyond 30 days for this
workspace. The ai-hist session UUID is the only 6-month-durable conversation
pointer target. The pointer contract's primary/secondary distinction is confirmed.

To keep relaycast messages forever for this workspace, set:
```sql
UPDATE workspaces SET retention = '{"message_ttl_days": null}' WHERE id = 'rw_7ccfea89';
```
This is a product decision for Khaliq/Chief, not a pointer contract decision.

**Item 3 — `sessionRef` stamping in factory: OPEN, routed to Chief for soc2-lead.**

**Item 4 (new finding, 2026-08-11 ~07:00Z) — ai-hist sub-path gap:**
Sessions spawned by the broker into `chief/claude-code-native-<harness-uuid>/` run in
a sub-path that ai-hist's standard scan does not index. Verified: trajectory-lead
session `c045615e-f3b9-4a60-b80d-5e28e048702d` returns "No entries" in ai-hist
despite being an active, live session. The session UUID is still the correct stable
identifier for `session_ref` — it is correct and durable. But it will not be
searchable via `ai-hist session <uuid>` until the scan config includes that sub-path.
Route to the ai-hist maintainer for a one-line scan path addition. Does not block the
pointer contract or the current dry-run test.

---

## 11. Pointer contract — FINAL (post Chief ruling, 2026-08-11)

This is the authoritative pointer contract. It supersedes the draft in §6.

### 11.1 Work-unit identity

| Field | Type | Value |
|---|---|---|
| `work_unit_id` | string | Surface-scoped id. When `work_unit_surface = "linear"`: Linear issue key (e.g. `ENG-123`). When surface is `github`: `org/repo#number`. When no surface ticket exists: synthesized id minted by trajectory-lead (e.g. `wt_<snowflake>`). |
| `work_unit_surface` | string | `"linear"` \| `"github"` \| `"relay"` \| `"notion"` — the surface where the work unit is expressed. |

**Rule: `work_unit_id` is never the raw Linear issue id by name — it is always
accompanied by `work_unit_surface = "linear"` and interpreted only in that
scope.** A work unit originating in GitHub carries `work_unit_surface = "github"`
and a GitHub issue ref, with no Linear id at all.

### 11.2 PR pointer (embedded in PR body)

```
<!-- trajectory: work_unit_id={id} work_unit_surface={surface} session_ref={uuid} -->
```

- Appended as the last line of the PR body, preceded by a blank line.
- Written by trajectory-lead via `PATCH /repos/{owner}/{repo}/pulls/{number}`
  (body append — trajectory-lead reads the current body, appends, never replaces).
- Read by pr-shepherd from `pull_request.body` in webhook payload via regex:
  `/<!--\s*trajectory:\s*(.*?)\s*-->/`
- Trigger: `pull_request` events `opened`, `synchronize`, `edited` (PATCH fires
  `edited`, not `opened`).
- Missing fields → null in pr-shepherd's ledger. Never clobber a non-null stored
  value with null from a later webhook event.

### 11.3 Session reference

`session_ref` is the `ai-hist` session UUID — the stable, durable, per-session
identifier assigned by the local `ai-hist` index. It is:
- Stable: does not change within a session.
- Durable: stored in the local ai-hist index indefinitely; pushable to
  relayhistory-cloud via `ai-hist push`.
- NOT a relaycast message ID (which expires at 30-day cloud default).
- In the relay spawn spec as `sessionRef` but NOT currently in RELAY_ATTEST_*
  env vars (one spawner.rs addition would close this — filed to soc2-lead).

### 11.4 Durability guarantees

| Target system | Durability |
|---|---|
| `ai-hist` session UUID | Permanent (local index, pushable to cloud, no expiry) |
| GitHub PR URL | Permanent (GitHub PRs and commits do not expire) |
| relayauth attestation hash | Permanent (hash-chained, append-only, write-once) |
| relaycast message ID | **UNVERIFIED — 30-day cloud default applies unless workspace has null override.** See item 2 above for the live check needed. Do not use as primary pointer target until verified. |

**Current stance:** use `ai-hist` session UUID as the primary conversation
pointer. Relaycast message ID is a secondary convenience field only, valid
while the message is live.

### 11.5 Linear write-back (pointer on issue)

When the work unit's surface is Linear, write a comment on the Linear issue
containing the pointer record. Format:

```
[trajectory-pointer]
work_unit_id: ENG-123
work_unit_surface: linear
pointer_type: pr
target_ref: https://github.com/org/repo/pull/456
target_system: github
session_ref: <ai-hist-uuid>
written_at: <ISO timestamp>
written_by: trajectory-lead-0811v3
```

Written via the `/linear` Relayfile projection Chief already uses. This is
Chief's write path — trajectory-lead requests the write, Chief executes it.

### 11.6 What trajectory-lead does NOT own

- The `work_unit_id` synthesized-id minting scheme (Chief defines the format
  for `wt_xxx` ids when no surface ticket exists).
- The Linear comment format (Chief may adjust the format above).
- The relaycast retention setting (Chief/Khaliq runs the D1 query — item 2).
- The SOC-2 session stamping (soc2-lead owns `RELAY_ATTEST_SESSION_ID`).
- The `mem_xxxx` id for Chief's memory (chief-memory-encoding.md workstream).
