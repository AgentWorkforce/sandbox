---
status: active
owner: unassigned
previous_owner: trajectory-lead-0811v3
reports_to: agent-coordination-lead-0811
updated: 2026-08-18
repos: [cloud, relayhistory, relaycast, relayfile, factory, relay]
---

Goal: every human intent maps to a complete, queryable trajectory of agent
activity — from the sentence that expressed it to the runtime behaviour of the
feature it produced — so that planning a new feature can read the full history of
the component it touches.

## Now — 2026-08-18 — retention is a pricing tier, which dissolves the replay blocker

**Khaliq's decision, 2026-08-18:** relaycast pruning becomes **tiered**. A
customer paying premium prices gets a longer retention window and an **optional
never-prune tier that moves to cold storage**. Retention stops being a
per-workspace operational override and becomes an attribute of the plan.

This supersedes the three-way choice recorded below (null override / copy the
slice at PR time / accept a 30-day bound). **Replay reaches back as far as the
plan's retention** — a sentence that belongs in pricing rather than in an
engineering decision log.

**The engine already implements this; nobody is using it.** `workspaces.retention`
is a per-workspace JSON column (`WorkspaceRetentionSettings`) carrying
independent `messageTtlDays`, `deliveryTtlDays`, `messageLogTtlDays` and
`workspaceEventTtlDays`, and **`null` disables pruning for that table** — exactly
the never-prune tier. The 30 days is not a limit; it is a deployment-wide default
passed at one call site in the Workers cron,
`pruneExpired(db, { defaults: { messageTtlDays: 30 } })`, and per-workspace
overrides are honoured inside `pruneExpired`. **There is no engine work in this.**

**What is missing is a plan → retention mapping and a writer for that column.**

**The gating dependency is attribution, not retention.** A workspace row carries
no notion of which customer owns it, so a tier cannot be applied or enforced.
That makes **relaycast#339** a prerequisite rather than a reporting nicety — and
two of its six open review threads concern a `CHECK` constraint that permits a
classification with **no provenance for the classification**, which is precisely
the field a billing tier would key on. Land it properly; do not merge it to move.

**Cold storage target is R2, not D1.** D1 is at 1.99 GB and is the component
under strain in the 2026-08-18 incident. Unplanned convergence: the Cloudflare
file adapter is gaining R2 object lifecycle now (to unblock workspace reaping),
so the archive has a home rather than needing a new subsystem.

**Consequence for workspace bloat:** a free tier with a short TTL, combined with
`workspaces.expires_at` from relaycast#338, expires abandoned workspaces **by
policy and continuously** — replacing the one-off backfill over a hand-written
"inert" predicate that Chief had proposed for the 25,014 inert rows.

**Still required regardless of tier:** the replay surface must **display the
retention boundary**, so a truncated replay announces itself instead of reading
as complete. A pointer to a conversation that has aged out is worse than no
pointer — this workstream's own named failure mode, and no pricing tier fixes it.

## Now — 2026-08-14 — replay of completed sessions is this workstream's new consumer

**Khaliq's ask, relayed through `factory-lead`:** a PR that Factory creates
should carry a **replayable session** — `relay session replay <id>` — where the
id joins relayhistory (the agent's own turn/prompt history) with the relaycast
conversations between agents. Any teammate can then open a finished PR, replay
how the decisions were made, ask the agent about it, and understand how the fix
came to be. He framed it as *"similar to the attach work but using an
already-completed session"*. **The id must originate at the prompt** — from
Chief or from Khaliq directly — **and be carried through to the PR**, with the
replayable session linked on the PR.

**This is not a new capability. It is this workstream's follow-on
implementation, which has been `owner: unassigned` since 2026-08-11**, with
replay as a third consumer of the same spine. Chief routed it here rather than
letting it open as greenfield.

**Three distinct things, worth keeping separate** (`factory-lead`'s
distinction, and a good one): cross-node **attach** streams a terminal to a
*running* process (`relay#1484`/`#1495`); `relayhistory-continuity-proof`
**relocates** a running session to another machine; this ask **replays a
completed** session. Only the third is new.

**What is already settled and must not be relitigated:**

- **The PR pointer contract exists, is ruled, and was proven live** on
  `relay#1476` — see Decisions below. The replay id should almost certainly
  *be* the existing `session_ref` field, not a fourth field beside it.
- **Placement is ruled**: `@agent-relay/session` in the relay repo, per the
  `workforce#308` closure (turn-kit as the SDK layer, SessionActor identity
  model). `relay#1496` is merged and is the landing zone.
- **SDK-level, not cloud web app** — Khaliq, 2026-08-13 20:14Z, recorded in
  `relayhistory-continuity-proof.md`. The dashboard is one client. Same
  principle applies to replay.
- **v1 is a copy-pastable command with a copy button** — no xterm, no
  in-browser terminal.
- **The prompt → PR carry is already merged**, and is the SOC-2 chain, not new
  work: `relayauth#79`, `relay#1477` (spawner injects
  `RELAY_ATTEST_SESSION_ID`, stamps a `Session-Id:` git trailer),
  `cloud#2981`/`#2987`/`#2989`, and `factory#233`. Chief verified `factory#233`
  against the working tree on 2026-08-14: `factory/src/writeback/github.ts:246`
  prefers a per-agent `input.sessionRef` and falls back to the env var, then
  puts it on the wire at :472. Commit `9ba6bcf`, review fixes in `d1836cb`.

**Two recorded constraints that break the ask as stated. Both must be answered
in writing before implementation, not discovered later:**

1. **Relaycast prunes at 30 days** (cloud deployment default,
   `cloudflare.ts:137`; workspace `rw_7ccfea89` has no override, so the default
   applies). A replay of a PR older than 30 days **silently loses the entire
   cross-agent conversation half** and replays as though the agents never
   spoke. This is the workstream's own named failure mode: a pointer to a
   conversation that has aged out is worse than no pointer, because it reads as
   coverage. Three options, pick one explicitly: set a null retention override
   on the workspace, copy the relaycast slice into durable storage at PR time,
   or state that replay is 30-day-bounded.
2. **Relayhistory is per-node by construction**, so a multi-node trajectory
   read from it alone is silently incomplete. Multi-node is the *common* case,
   not the edge — the `relay#1518` fix on 2026-08-14 was built on `finn-mini`
   while Chief ran on `chief-broker`.

**A third tension to resolve, not a blocker:** Khaliq's SOC-2 constraint of
2026-08-08 is **"reference, never payload"** — an auditor should see that a
session existed and belongs to a named human, not necessarily its contents.
Replay is contents. Internal teammate is not external auditor, so these are
probably reconcilable, but the issue must say which it is choosing and why.

**Scope split agreed with `factory-lead`, 2026-08-14:** Chief takes the relay
side (the replay id and the relayhistory + relaycast join in
`@agent-relay/session`, including written answers to constraints 1 and 2);
`factory-lead` takes the factory side, scoped as *extending* the existing
pointer and the existing `sessionRef` forwarding, not as new carry plumbing.

**Operational constraint:** the relayfile workspace durable object is returning
`429 durable_object_overloaded`, root-caused to Factory re-enumerating the
whole issue tree every cycle (6,674 `listTree` calls, one subtree listed 67
times) and filed as `factory#259`. Option 1's "copy the relaycast slice at PR
time" adds workspace traffic and must account for this.

## Now — 2026-08-11 — Khaliq's doctrine, captured verbatim in shape; nothing built

**Provenance:** Khaliq stated this to a previous Chief and restated it to this
one on 2026-08-11. **A search of relay history and the whole brain finds no
record of the earlier conversation.** That absence is the argument for the
workstream: the doctrine describing how intent should become durable was itself
lost because it was only ever said. Treat this file as the record of record.

### The chain Khaliq described

1. **A human describes intent.** The agent logs it. Linear is the source of
   truth: the agent opens a Linear issue that **maintains the integrity of the
   human intent** — the issue preserves what was asked, not a paraphrase of it.
2. **The resulting conversation is stored via relayhistory**, pushed to cloud,
   and a **pointer** to that conversation is written back onto the Linear issue.
3. **The issue id travels with the work.** The agent hands the Linear id to the
   lead, who carries it and links each resulting agent conversation back by
   pushing another pointer onto the same issue.
4. **Conversation capture comes from relaycast, not relayhistory, when the work
   spans nodes.** Khaliq's own qualification, and it is the load-bearing
   technical judgement here: relayhistory is per-node, so **a multi-node
   trajectory recorded from relayhistory is silently incomplete**. Relaycast
   holds the cross-node record.
5. **Every GitHub PR registers to the Linear ticket.**
6. **After merge, the feature is traced through testing and review.** Review
   notes, change conversations, resulting PRs, and PR-review feedback all attach
   to the ticket.
7. **After deploy, the feature is tracked in runtime** — PostHog and equivalents.
8. **New features built on top reference the original feature trajectory.**

**The payoff, in Khaliq's words:** each feature and core component accumulates a
rich history of agent conversations, testing methodologies, and bug/testing
history, cross-referenceable when planning and implementing.

## What already exists — verified against installed binaries 2026-08-11

Survey complete. All rows below are verified against running code, not types.

| Piece | Substrate | Verified state |
|---|---|---|
| Trajectory record + CLI | `trail` 0.5.8 (not 0.6.1 — workstream had unverified version) | Persists: id, task.source (system+id+url), agents, chapters, commits, filesChanged, workflowId. Does NOT write back to Linear. Per-CWD storage (`.trajectories/`), not global. |
| Per-node conversation history | `ai-hist` (Python → Rust binary at `relayhistory/target/release/ai-hist`) | 182,381 entries indexed, 2026-01-02 to 2026-08-11. Fields: session UUID, source, project path, timestamp, first prompt. `link commit` links session → git commit. Per-node by construction — incomplete for multi-node work. |
| Cross-node conversation record | relaycast engine schema (`packages/engine/src/db/schema.ts`) | `messages` table: id, workspaceId, channelId, agentId, threadId, body, metadata (JSON), createdAt. All nodes write here. No trajectory_id or work_unit_id field — would go in metadata. **CRITICAL: cloud deployment prunes at 30 days default** (`cloudflare.ts:137`). Per-workspace null override keeps forever. |
| Intent as a first-class field | `personas.intent` in cloud DB | This is per-persona standing intent (who the agent is), NOT per-request human intent. Different concept — does not serve this workstream's need. |
| Commit → agent → sponsor attestation | relayauth 0.2.28, **live in production** | Hash-chained ledger, OIDC-bound sponsor, Hole 1 closed. Session UUID (ai-hist UUID) is in relay spawn spec (`sessionRef`) but NOT in RELAY_ATTEST_* env vars — not yet in commit trailers. One spawner.rs var + hook line away. |
| Linear read/write | `/linear` Relayfile projection | Available. No agent currently writes trajectory pointers back onto Linear issues. |

**The four gaps to close (from survey):**
1. Nothing writes a pointer back onto the Linear issue
2. No trajectory_id on relaycast messages (cross-node reconstruction requires out-of-band roster)
3. No addressable unit in Chief's memory for durable trajectory pointer targets (see `chief-memory-encoding.md`)
4. Verbatim intent in relaycast message bodies not extracted as first-class field anywhere

**Conversation pointer durability:** relaycast message IDs rot at 30 days (cloud default). Primary durable conversation reference is `ai-hist` session UUID — pushable to relayhistory-cloud, no expiry. Relaycast message ID is a secondary field only.

**Relationship to `soc2-agent-traceability`.** They share substrate and must not
be built twice. They answer different questions: SOC-2 asks *who did this and can
an auditor verify it* — attestation, tamper-evidence, custody. This asks *why does
this code exist and what was learned building it* — context for the next
implementer. **The lineage record SOC-2 builds is the spine this hangs off.**
Whoever leads this reads that workstream first.

## The hard parts, named up front

- **"Maintains the integrity of the human intent" is the whole difficulty.** An
  agent that summarises intent into a tidy issue has already lost the thing being
  preserved. The verbatim ask has to survive alongside any structured
  restatement.
- **A pointer is only as good as the retention behind it.** Scratchpads and DMs
  do not survive a restart — four finished deliverables were recovered by luck on
  2026-08-10. A pointer to a conversation that has aged out is worse than no
  pointer, because it reads as coverage.
- **Relayhistory is incomplete for multi-node work by construction.** Khaliq
  already flagged this. Any design that reads from relayhistory must state what
  it does when the trajectory crossed nodes.
- **Linear is a surface, not the model.** `CLAUDE.md` is explicit that Factory is
  surface-agnostic and that assuming Linear is the defect that a previous design
  replaced. The trajectory must key on the **work unit**, with Linear as today's
  projection of it — otherwise the same task arriving through GitHub or Notion
  starts a second, disconnected history.
- **Silent partial capture is the failure mode.** A trajectory missing its review
  round or its runtime data looks exactly like a trajectory that had none.
  Completeness needs to be asserted, not assumed.

## Decisions made — 2026-08-11

**Boundary with pr-shepherd-agent:** trajectory-lead owns the intent capture contract, pointer format/write-back, cross-node attribution, and work-unit identity decision. pr-shepherd owns the PR state ledger, staleness taxonomy, and attaching `work_unit_id` (received from trajectory-lead, never invented). Handoff: trajectory-lead emits `work_unit_id` + `session_ref` per work unit; pr-shepherd attaches both to every PR record and alert. Memory encoding standard: Chief owns it; neither lead defines the schema.

**Work-unit id field name and value format (RULED by Chief, 2026-08-11):** `work_unit_id` is never borrowed raw from a surface. `work_unit_surface` carries the surface name. When `work_unit_surface = "linear"`, `work_unit_id` is the Linear issue key (e.g. `ENG-123`). When surface is `github`, `work_unit_id` is `org/repo#number`. When no surface ticket exists, trajectory-lead mints a synthesized id (format TBD by Chief). Does not come back to Khaliq.

**PR pointer format (decided, no Chief ruling needed):**
```
<!-- trajectory: work_unit_id={id} work_unit_surface={surface} session_ref={uuid} -->
```
HTML comment appended to PR body (blank line above). Survives repo migration, no label quota, readable from webhook payload. trajectory-lead writes via GitHub API PATCH on body append; pr-shepherd reads with regex.

**Conversation pointer primary target:** `ai-hist` session UUID (not relaycast message ID). Relaycast cloud prunes at 30-day default; ai-hist is durable and pushable to cloud. Relaycast message ID is a secondary field.

**SOC-2 join point:** ai-hist session UUID is the thread connecting SOC-2 (commit → agent → human) to trajectory (intent → session → commit → runtime). One relay change (`RELAY_ATTEST_SESSION_ID` env var in `spawner.rs`) completes the chain. Routed to Chief for soc2-lead.

## Next

1. ~~**Appoint a lead.**~~ Done — trajectory-lead-0811v3.
2. ~~**Survey before designing**~~ — Done. See verified substrate table above and `chief/evidence/trajectory-scope-reconciliation-0811.md`.
3. ~~**Decide the identity of a work unit**~~ — **RULED by Chief, 2026-08-11.** Done. See Decisions section above and `evidence/trajectory-scope-reconciliation-0811.md §11`.
4. ~~**Write the pointer contract**~~ — **DONE, 2026-08-11 ~07:00Z.** Full contract in `evidence/trajectory-scope-reconciliation-0811.md §11`. The production retention query is also resolved: workspace `rw_7ccfea89` has no override, so the 30-day deployment default applies. Relaycast message ids are secondary, expiring references; the durable primary target is the ai-hist session UUID.
5. ~~**Pick the thinnest end-to-end slice**~~ — **DONE, 2026-08-11 ~10:51Z.** Trajectory pointer stamped on relay#1476 PR body. Pointer: `<!-- trajectory: work_unit_id=AgentWorkforce/relay#1476 work_unit_surface=github session_ref=unknown-session-v3b -->`. Wrong pointer (#1474 from trajectory-lead-0811v3) removed and replaced. `pull_request.edited` webhook fired; pr-shepherd extractor regex will match. Evidence: `chief/evidence/trajectory-pointer-proof-0811.md`.
6. ~~**Reconcile scope with `soc2-agent-traceability`**~~ — Done. See `chief/evidence/trajectory-scope-reconciliation-0811.md`. SOC-2 builds the spine (commit → agent → human); trajectory hangs the narrative off it (intent → session → [SOC-2 spine] → runtime).

7. **Answer the two constraints in writing** — the 30-day relaycast prune and
   relayhistory's per-node incompleteness — before any replay implementation
   starts. Owner: Chief (relay side).
8. **Decide reference-vs-payload for replay** and record which principle it
   chooses. Owner: Chief, with `factory-lead` folding the answer into the
   factory-side issue.
9. **Appoint a lead for the relay side.** The follow-on implementation has been
   unassigned since 2026-08-11; the replay ask is the trigger to staff it.
10. **`factory-lead` sends a draft scope to Chief before filing**, to be checked
    against the ruled pointer contract.

## History

- **2026-08-14** — Khaliq's replay-of-completed-sessions ask arrived via
  `factory-lead`, who was scoping it as a new capability across relay +
  factory. Chief read the brain and routed it here instead: the PR pointer
  contract was already ruled and proven live on `relay#1476`, the work-unit id
  format was already ruled, and the prompt → PR carry was already merged as the
  SOC-2 chain (`factory#233` verified against the working tree, not assumed).
  Chief supplied the two recorded constraints `factory-lead` did not have — the
  30-day relaycast prune and relayhistory's per-node incompleteness — plus the
  "reference, never payload" tension. Scope split agreed: Chief owns the relay
  side, `factory-lead` owns the factory side scoped as an extension of existing
  plumbing. Nothing filed yet; draft scope to come back to Chief first.
- **2026-08-11 cleanup checkpoint** — the production retention query confirmed
  the 30-day default. The pointer contract has no remaining design question;
  the ai-hist sub-path follow-up was routed to Chief for a relayhistory lane.
  `trajectory-lead-0811v3` was waiting 389 minutes with zero pending messages
  and was released. Follow-on implementation is unassigned.
- **2026-08-11 ~10:51Z** — trajectory-lead-0811v3b (backup) stamped first live trajectory pointer on relay#1476 PR body. Discovered trajectory-lead-0811v3 had already stamped a pointer at ~07:14Z but used `work_unit_id=AgentWorkforce/relay#1474` (the referenced issue, not the PR). Wrong pointer removed via PATCH; correct pointer (`#1476`) confirmed in body. `pull_request.edited` webhook fired for pr-shepherd extractor. Evidence at `chief/evidence/trajectory-pointer-proof-0811.md`. Session ref: `unknown-session-v3b` (placeholder; no ai-hist entry for fresh spawn).
- **2026-08-11 ~05:00Z** — Workstream opened by Chief. Khaliq restated the doctrine after
  finding it absent from the brain; no record of the original conversation with
  the previous Chief exists in relay history or the brain. Substrate inventory
  above assembled from the brain and a relay search, and was unverified against
  the running code.
- **2026-08-11 ~05:10Z** — trajectory-lead-0811v3 appointed (V3 after PTY injection defect workaround). Boundary agreed in writing with pr-shepherd-lead-0811v3. Substrate survey complete against installed binaries. SOC-2 scope reconciliation complete. Key findings: trail is 0.5.8 not 0.6.1; relaycast cloud prunes at 30 days; session UUID is in relay spawn spec but not in commit attribution env. All findings filed to `chief/evidence/trajectory-scope-reconciliation-0811.md`. BLOCKED ON CHIEF for work-unit id value format ruling.
- **2026-08-11 ~06:52Z** — Chief ruled: work_unit_id scoped by work_unit_surface, never raw-borrowed from surface. Pointer contract written (`evidence/trajectory-scope-reconciliation-0811.md §11`). Next: first live pointer stamp to verify end-to-end. Open: relaycast retention check (Chief runs D1 query for workspace `50587328-441d-4acb-b8f3-dbe1b3c5de99`).
