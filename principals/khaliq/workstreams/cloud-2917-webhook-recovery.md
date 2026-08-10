---
status: done
owner: cloud-2917-recovery-3
updated: 2026-08-10
repos: [cloud]
---
# Cloud #2917 — webhook queue and Nango schedule recovery

> **CLOSED 2026-08-09T08:27:27Z.** The lane merged seven `incident-2917` /
> `recovery` PRs (`#2974`-`#2980`) between 05:07Z and 08:18Z, ran the production
> snapshot at 08:24Z, and closed the issue three minutes later. Its process then
> exited.
>
> **Chief swept this as an open incident for ~12 hours after it closed**,
> reporting "no new checkpoints" every cycle. That was true and useless: the
> question was never asked. See `memory/learnings.md`.
>
> **Two things were never reconciled and are the honest residue:**
>
> 1. **`Incident 2917 observability recovery` FAILED** at 2026-08-09T08:19:40Z,
>    five minutes before the successful snapshot and eight before closure. This
>    document's own closure gate blocks while *"required monitoring is
>    unhealthy"*, and the queue-health cron readback was **RED** at the last
>    recorded inventory. The issue was closed with that arm red and nobody said
>    why that was acceptable.
> 2. **The last checkpoint comment on the issue is 2026-08-08T21:49Z** — before
>    the final seven merges. The rule below is "evidence checkpoints post there
>    after **every** production phase, not at the end." The last day of work is
>    not on the durable record.
>
> **Neither is an emergency**: no `Deploy` has failed, and `cloud` main is
> healthy through three further merges on 2026-08-10. But closure rests on a gate
> whose monitoring arm was red, and **closed is a status field, not evidence.**
> If the queue and Nango closing conditions matter, verify them directly rather
> than inferring them from the issue state.

**Goal:** Safely restore webhook delivery and the intended Nango schedules, drain
or explicitly disposition every backlog, and close `cloud#2917` **only** when the
production closure criteria are genuinely satisfied.

**Issue:** https://github.com/AgentWorkforce/cloud/issues/2917 — the durable
record. Evidence checkpoints post there after **every** production phase, not at
the end.

## Now — dispatched 2026-08-08 08:58Z, autonomous, production-authorised

`cloud-2917-recovery-lead` (codex, on `barry`) owns this end to end. **Khaliq
authorised production mutation** within written bounds: implement fixes, open
PRs, satisfy review, merge once gates pass, deploy, and execute the bounded V3
amendment.

**Explicitly NOT authorised:** purging queues, deleting unreviewed events,
removing the rollback D1, exposing secrets, or expanding production mutation
beyond the written amendment.

**State to verify rather than assume** — RelayAuth and its replacement D1
healthy; capacity-counter and long-running GitHub/Gmail forwarding fixes
deployed; queue health monitoring deployed and reaching NightCTO/Slack; the
customer-scoped Watchdog alert and recovery path proven; **main queue and DLQ
protected and paused**; last observed main backlog **12,486 messages**; Nango
last recorded at **108 PAUSED and one SUCCESS**.

**Previous queue amendments are spent and must not be reused.**

## The shape of the recovery

**Snapshot first, mutate second.** A read-only production snapshot — queue and
DLQ depth and settings, worker versions, RelayAuth health and JWKS, capacity
settings, D1 size and growth, error rates, Nango schedule states, alert health —
before anything changes.

**Reconstruct the Nango manifest from durable evidence and live state, never by
guessing**, stored encrypted with immutable request bodies and pinned digests.
Connection identifiers and credentials never go anywhere public.

**`#2917-QUEUE-CANARY-V3`**, written as an issue comment before use, specifying
exact mutations, time bounds, success gates, rollback triggers and restoration
commands. DLQ stays paused. Batch size 10, concurrency 1, dormant admission gate
capped at exactly 10. **Poll the durable admitted count to exactly 10 or a
bounded timeout — a five-second resume is not assumed to deliver ten messages.**
Every admitted event observed through acknowledgement, retry, or DLQ
disposition. Automatic restore of captured settings on failure.

**Then a progressive drain with bounded checkpoints, not an indefinite unpause.**
Stop and contain on elevated 5xx, abnormal D1 growth, mint pressure,
timeout/retry amplification, unexplained DLQ movement, or **loss of
observability**.

**DLQ events are reviewed before disposition and evidence is preserved.** Replay,
deduplicate or retire is decided on **current provider state and idempotency —
not merely age**.

**Nango resumes in waves of 5 / 10 / 20 / 30 / 43**, each pinned and gated before
and soaked after, repausing that exact wave automatically on red. **All 108
paused schedules accounted for as restored or intentionally retired, with an
audit record.**

## The closure gate is automated, and refuses

It blocks completion while either protected queue remains unintentionally paused
or undispositioned, an originally-active schedule is neither restored nor
intentionally retired, required monitoring is unhealthy, or the soak has not
completed.

**Closing conditions:** RelayAuth healthy under restored load; queues drained or
dispositioned; schedules accounted for; D1 growth, mint rate, retries and
workflow failures within documented thresholds **throughout the soak**;
NightCTO/Slack alert delivery **human-visible**; automated gate passes.

## Live production inventory — 2026-08-08 21:50Z, run `31280246824`

**Read-only, inventory-only, no mutation.** Artifact digest
`0b20bbb00b092cf1ec017a1c7e3def76f92be94d51602a840dd76f929df4eabc`.

**The zero-consumer finding is FALSIFIED.** Main queue consumer:
`endpoint=1, queue-detail=1, observationConsistent=true`, topology **GREEN** —
one worker, `cloud-production-webhookworkerscript-mbehwvfu`, batch 50, retries 5,
DLQ `webhook-events-dlq`. **The drain path is intact; the queue can drain when
unpaused.** The earlier `Expected one main Queue Worker consumer, found 0` was an
observation artifact, caught by exactly the two-source consistency gate the lane
added rather than by trusting the first number.

**Live state:**

| | value |
|---|---|
| Main queue | **14,938 messages** / 250 MB, `delivery_paused=true` |
| DLQ | **373 messages** / 8.3 MB, `delivery_paused=true`, consumer present |
| RelayAuth | health 200, JWKS 200, keys=1 |
| Replacement D1 | 39.6 MB, +8 KB over 10 s; **36 rollback D1s** |
| Capacity gate | `enabled=false`, limit 200, window 60 s |
| Admission gate | available, `enabled=false` |

**Two new findings that change the plan:**

1. **Nango has drifted from the hardcoded reference — `match: false`.** Live is
   `schedules=109, connections=28, paused=91, active=18` against the reference
   `109 / 30 / 108 / 1`. Schedules match exactly, but **17 more schedules are
   already ACTIVE than expected and two connections are gone.** The wave plan
   assumed 108 paused and one active; it must be rebuilt against live state, and
   the two missing connections need an explanation before any resume.
2. **Queue-health cron readback is RED.** Monitoring is not healthy, so the
   closure gate cannot pass and a drain would run partially blind. **An absent
   alert is not a healthy alert** — this is that hazard, measured.

**Backlog grew** from the 12,486 recorded at dispatch to 14,938 — the queue is
still accepting while paused.

## Standing hazards this lane carries

**Do not declare success because code deployed.** Report by exit code and read
production state back; an absent error is not a success. **An absent alert is not
a healthy alert** — verify the path is live before trusting its silence.

**Veto:** run `veto_diff_review` before every merge. If Veto is unavailable, say
so explicitly and run equivalent checks. **Never claim a Veto pass that was not
obtained.**

**The fleet kills agents in synchronised batches** — 121 in one second on
2026-08-07, and four further clusters overnight took every lane including the
monitor. So: **production must never be left in a temporary state across a gap in
the lane's own liveness.** Before any mutation the restore path must already be
captured and executable by someone who is not this agent. See [[active-lanes]].

## Next

1. Read-only snapshot and the reconstructed Nango manifest.
2. Write `#2917-QUEUE-CANARY-V3` as an issue comment before executing it.
3. Canary, then progressive drain, then Nango waves.
4. Close only through the automated gate.

## History

- 2026-08-08 21:50Z — First successful protected inventory. Zero-consumer
  finding falsified; Nango drift and RED queue-health cron found. `cloud#2964`
  merged with `[skip ci]` and **no Deploy fired**. No production mutation.
- 2026-08-08 — Dispatched autonomously on Khaliq's instruction with production
  authority inside written bounds. Nothing executed yet.
