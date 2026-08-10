# pr-shepherd V2 architecture — webhooks maintain, a timer evaluates

**Status: DESIGN ONLY. No code written. Awaiting review.**

Khaliq's direction: drive the shepherd from GitHub webhook events the way
`agents/review` does, not by polling. This is how that works for an agent whose
job is detecting **absence**.

---

## 0. The problem this must solve first

`agents/review` reacts to **things happening**. A PR opens, a review lands, CI
finishes — the event *is* the trigger and the work.

This agent detects **staleness: the absence of things happening.**

> **There is no webhook for "nothing has happened for seven days."**

So a purely event-driven shepherd cannot exist. What events actually buy is
**fresh state without crawling** — the evaluation still needs a clock. Hence two
halves, and they must not be confused:

| | maintained by | answers |
|---|---|---|
| **The ledger** | webhook events | *what happened to this PR, and when, and who did it* |
| **The evaluation** | a cron tick | *which PRs have now been silent too long* |

The expensive half — enumerating and reading every PR in 41 repos — stops
happening on a schedule. The classification gets *more* accurate, because each
event is seen as it lands rather than inferred from a timestamp afterwards.

---

## 1. What the events give us, and what they do not

Triggers to declare (mirroring `review/agent.ts:75-98`, extended for lifecycle):

```
pull_request.opened / .closed / .reopened / .synchronize
pull_request.ready_for_review / .converted_to_draft
pull_request.labeled / .unlabeled
pull_request_review.submitted
pull_request_review_comment.created
issue_comment.created
check_run.completed
```

Three facts inherited from the reviewer, so they are not rediscovered:

- **No synchronous `event.payload` in v4** — `(await event.expand('full')).data`.
- **The payload is not authoritative.** `review/agent.ts:45` says so explicitly:
  it does not carry author, labels or state on every trigger, and
  `check_run.completed` carries none of them.
- **`check_run.completed` sometimes arrives with `pull_requests: []`** and must
  be skipped and logged, never crashed on (`review/agent.ts:158-162`).

That third fact drives the central split:

> **Events are reliable for ACTIVITY (who acted, when). They are not reliable
> for STATE (is it open, is it draft, does it conflict).**

So the ledger stores activity history — which is exactly what staleness needs —
and never pretends to hold authoritative state.

---

## 2. The rule this design breaks, and how it is repaid

My own standing rule, stated repeatedly all day:

> *A live daemon is not a fresh projection. Never read a persisted state file as
> current state.*

**A ledger-driven evaluator reads a persisted state file as current state.** That
is the whole idea. Pretending otherwise would make this design dishonest.

**The repayment: separate evaluating from asserting.**

1. **Evaluate from the ledger.** Cheap, no crawl. This decides which PRs are
   *candidates* to speak about — typically a handful, not 302.
2. **Verify each candidate against GitHub before saying anything about it.** One
   fetch per item we are about to name.

The facts gate becomes a **live confirmation**, not a ledger lookup — so
*"never post a number you cannot resolve from authoritative facts"* holds
exactly as before. **Cost now scales with what we SAY, not with what we WATCH.**

This also fails safe: a ledger that has drifted produces a *candidate* that
verification then rejects. Drift causes silence, not a false alarm.

---

## 3. Seeding, and the PR no event ever mentions

Webhooks only describe PRs that move *after* we start listening. Twelve open PRs
are over 60 days old; the oldest date to 2026-05-31. **They will emit nothing.**
Those are precisely the PRs this agent exists to catch, so seeding is not a
detail.

**Bootstrap:** a one-time backfill enumerates every open PR in every readable
repo and writes a ledger row with the activity facts available at that moment —
the same read the current live run already does. After that, events maintain it.

**What happens to a PR that no event ever mentions?**

- **Seeded and then silent** → its row keeps its backfill timestamps, ages
  normally, and is caught. **This is the core case and it works** — silence is
  the signal, and a row that stops being updated is precisely what staleness
  looks like.
- **Never seeded and never mentioned** → **invisible.** This is the real residual
  risk, and it has three causes: a repo whose webhooks were never wired, a repo
  created after the backfill, and a PR opened while delivery was down.

**Nothing in an event stream can detect its own absence.** So:

---

## 4. Reconciliation — because a ledger cannot audit itself

A low-frequency reconciliation sweep re-enumerates open PRs and diffs against the
ledger. **This is still polling. Claiming webhooks eliminate polling would be
false** — they demote it from every sweep to an occasional audit.

Its purpose is **drift detection, not classification**, and the distinction
matters: it must **report the delta, not silently repair it.** A ledger that
quietly heals itself hides a broken webhook indefinitely.

| Drift | Direction | Consequence |
|---|---|---|
| missed activity event | PR looks staler than it is | **false alarm** — verification in §2 catches it before posting |
| missed close/merge | row never retires | **worse** — we would speak about a finished PR; `pull_request.closed` normally retires it, verification catches the rest |
| PR absent from ledger entirely | invisible | only reconciliation finds it |

**Per-repo event coverage.** Track `lastEventAt` per repo. A repo that has
emitted nothing for N days is either genuinely quiet or has broken webhooks, and
**those two are indistinguishable from inside.** So it is reported as
`coverage: unverified` for that repo — never as "clean." That is
*assert coverage, never infer it* applied to an event stream, and it is the
event-driven equivalent of the unreadable-repo rule already in V1.

---

## 5. Two problems this genuinely fixes

**Bot masking largely dissolves.** Today the actor is inferred: fetch comments,
read `user.type`, hope the mount projects them. **Every relevant event carries
its actor directly** — `pull_request_review.submitted` and
`issue_comment.created` name who acted. Bot vs human becomes an ingest-time fact
rather than a post-hoc inference.

That also **removes the dependency on reading comments through the VFS mount** —
currently unverified, and sitting on a mount that fails for every repo but one.
Today's live run found 32 bot-masked PRs only because REST was available on this
host; the deployed path could not have found them. Events make that moot.

**The thresholds stop being guesses.** Every clock in the taxonomy — 30d, 3d,
24h, 3d, 2d, 2d — is a number I chose, validated against nothing, and I have said
so five times. **A ledger of real event timestamps is the dataset that closes
it:** after a few weeks it holds the actual distribution of time-to-first-review,
time-to-merge and time-to-abandonment, and the boundaries can be set from
measured percentiles. This is the first design in which that caveat has a path to
being retired rather than merely repeated.

---

## 6. What this does NOT fix

- **Mergeability still flickers.** GitHub computes it lazily and emits no
  "became conflicted" event. The held-transition guard stays.
- **`ci-red` still needs check state.** `check_run.completed` gives it per event,
  which is better than today's unfetched `unknown` — but a PR whose checks
  completed before seeding has no CI state until it next runs.
- **Reconciliation is still a crawl.** Rarer, not gone.
- **Seeding is a one-time full crawl.** Unavoidable.

---

## 7. Open questions for review

1. **Reconciliation cadence.** It bounds how long an unwired repo can stay
   invisible. Daily is my proposal; weekly is defensible if event coverage is
   demonstrably good, and "never" is not.
2. **Is the shepherd subscribed org-wide or per-repo?** Today's per-repo mount
   attempts fail for all but one repo. If subscription is per-repo and mounts are
   broken, event coverage will be partial from day one — and per §4 a partial
   event stream is indistinguishable from a quiet one.
3. **Ledger size.** One row per open PR, ~300 rows, retired on close. Bounded by
   open-PR count, as V1 already is. Confirm `ctx.files` is the right store at
   that size, given `ctx.memory` is disqualified.

---

# Part II — cloud and local: one escalator, many readers

Khaliq's requirement: the shepherd must serve both surfaces, under the standing
principle that **everything is managed from cloud and trickles down to local.**

The naive reading — "run it in both places" — produces two writers and double
escalation. That is **AR-448 in a new costume**: *a claim recorded in one
dispatcher's private state is invisible to every other.* This design is built to
make that specific outcome impossible.

## 8. Sole writer, by capability — not by discipline

"The local one shouldn't escalate" is a rule. Rules get broken by the next
person who edits the file. These are **structural**, so a local instance has no
code path to an escalation even if someone tries:

| | cloud persona | local resident |
|---|---|---|
| `triggers: { github: [...] }` | **yes** — sole ingestion point | **none declared** |
| cron schedule | **yes** — sole evaluator | **none declared** |
| `integrations.slack` | present, write-scoped | **absent entirely** |
| ledger credential | read **write** | read **only** |

Only the cloud instance can receive webhooks anyway — a local resident has no
public endpoint and GitHub cannot reach it. But the point is that **the local
persona does not merely decline to escalate; it lacks the wiring to do so.** No
Slack integration means no write path exists, not that a branch avoids it.

**The safety net if that enforcement ever fails:** the idempotency ledger *is*
the escalation record, and it lives in one shared store. So a second escalator
would **see the existing claim** rather than acting blind. AR-448 happened
because the claim was private; here it is shared by construction. Single-writer
is the enforcement; shared-claim is what saves us when enforcement is wrong.

## 9. Where the ledger lives — decision and the failure mode accepted

**Decision: cloud-side store, local reads over the API. Not the Relayfile
projection.**

The deciding question is not *"which is more available"* but **"which one makes
staleness impossible to misrepresent?"**

- **Relayfile projection** is reachable from both surfaces and fits the senses
  model. But its freshness signal has already been caught lying — a mirror found
  **three days stale while `factory status` returned clean JSON** — and the mount
  is currently broken for every repo but one. Its failure mode is a **silent
  correctness failure**: the local reader answers confidently from a three-day-old
  ledger and nothing in the response reveals it.
- **Cloud-side store** fails by becoming **unreachable**, which is loud,
  immediate, and unambiguous.

**Availability failures announce themselves. Correctness failures do not.** So I
trade availability for honesty.

**The failure mode I am accepting, stated plainly: during a cloud outage the
local reader answers nothing at all.** It cannot tell Khaliq what is stale. That
is a real loss of function and I am choosing it over the alternative, in which it
tells him something that used to be true.

**Even so, the store is not trusted to be fresh just because a fetch succeeded.**
Every read returns `{ data, asOf, writerHeartbeatAt }`, and **the reader cannot
render an answer without rendering `asOf` with it** — provenance is part of the
value, not a field someone remembers to log. A proxy or cache between local and
cloud therefore cannot make old data look current.

## 10. What the local reader says when it cannot be sure

Three cases, and the distinction between the last two is the useful part:

**Unreachable** —
> *"I cannot reach the ledger, so I do not know what is stale right now."*

It does **not** fall back to a previously-fetched copy. A cached answer is
exactly the failure this design rejected the projection to avoid; keeping a local
cache would reintroduce it through the back door.

**Stale — a current-state question.** `asOf` older than the tolerance and the
question is *"what is stale / what is waiting on me"*:
> *"My view of the ledger is 3 days old (asOf 2026-08-04). I will not answer a
> current-state question from it."*

**Stale — a historical question.** *"What did we ping about last week?"*
Answered, with the banner. **Staleness does not invalidate history**, only
current state — and refusing historical questions on stale data would be
performative caution rather than real caution.

**And it never escalates.** Asked to ping someone, it explains that cloud owns
escalation and declines — the honest answer, since it has no Slack wiring to do
it with.

## 11. Persona shape

- **Cloud**: `persona.ts` + `agent.ts` per `creating-cloud-persona`. `cloud: true`,
  `triggers: { github: [...] }`, the cron schedule, Slack write-scoped, ledger
  write credential.
- **Local resident**: same taxonomy and same classification modules — literally
  the same pure files, so the two surfaces cannot disagree about what "stale"
  means — with **no triggers, no schedule, no Slack, read-only ledger access**,
  and `relay: { inbox: ['@self'] }` so it is addressable.

Sharing `classify.ts` / `ladder.ts` / `timeline.ts` between the surfaces is
deliberate: two implementations of a taxonomy drift, and then cloud and local
give different answers to the same question, which is worse than either being
wrong alone.

---

# Part III — cloud decides, anyone executes

**Correction to Part II.** Khaliq's architecture: cloud is the **event plane, not
the execution plane.** It receives the webhook — which only it can — and then
dispatches the work to an agent over Relay. **Local nodes are the preferred
execution target; a cloud sandbox is the fallback.**

So §8's table was over-constrained. The invariant was never about execution:

| | single-owner? | why |
|---|---|---|
| ledger **write** | **YES** | two writers = two claims that cannot see each other |
| escalation **decision** | **YES** | the same PR pinged twice by two deciders — AR-448 |
| escalation **execution** | **no** | delivering a decided message duplicates nothing |

**Decide once, execute anywhere.** It was never the execution that risked
duplication.

## 12. Claim before dispatch — and the ambiguity it creates

V1 claimed the ledger row before posting, so an at-least-once re-invocation saw
the claim and stayed silent. The post now happens on a **different machine**, and
that breaks the neat version:

```
cloud: claim → dispatch → executor posts → ack → cloud records receipt
                                    ↑
                          what if the ack is lost?
```

Cloud cannot distinguish **"never posted"** from **"posted, ack lost."** Both
look identical from here. Release the claim and a re-dispatch **double-posts**;
keep it and a genuinely failed escalation is **never retried**. This is the
distributed version of exactly the bug this agent exists to avoid, and no amount
of local bookkeeping resolves it — because the question is about a *remote*
side effect.

**Resolution: make execution idempotent at the destination.**

The rendered message carries its idempotency key, and the executor's first act is
to **look in the target channel for a message already carrying that key.**

- key present → report `already-delivered` with the existing ts. **Do not post.**
- key absent → post, then report the new ts.

This converts *"did I already post?"* from a question about private memory into a
question about **the destination, which is authoritative** — the same move as
§2's verify-before-assert. Re-dispatch becomes safe, so **ambiguity resolves
toward retry** instead of toward a coin-flip.

**Cloud renders; the executor only delivers.** The classification, the rung, the
wording and the key are all computed by the decider. An executor that re-rendered
could disagree with another executor about the same PR, and "decide once" would
be true only in name.

## 13. Dispatch, addressing, and a target that is not alive

One workspace, one address space — cloud and local agents addressable by name,
which is what makes this a *message* rather than an integration.

```
{ idempotencyKey, channel, text, replyToTs?, prRef, expiresAt }
```

`expiresAt` matters: a decision that could not be delivered for six hours should
**expire rather than arrive late**, because the state it described may no longer
hold. A stale escalation is a wrong escalation.

**When the named agent does not answer — absence is not evidence.** No ack does
not mean no post. So cloud does **not** release the claim on silence; it
**checks the destination for the key**, which is the only authoritative answer:

- key at destination → it landed. Record the ts, done.
- key absent → nothing landed. Safe to re-dispatch to the next target.

Fallback order: **preferred local → another qualified local → cloud sandbox.**
If *no* target qualifies, cloud does **not** silently swallow it: the item is
reported as **`escalation undeliverable`** in the digest, with the reason. A
shepherd that cannot deliver must say so — an undelivered alert that leaves no
trace is the failure mode of the entire product.

## 14. Placement — "available" is not "qualified"

A lead was placed on `barry` today with no filesystem access to its own brief.
**The node was healthy; the repo simply was not there.** Node liveness is not
capability, and this design must not repeat that.

**What escalation execution actually needs:** Slack write reachability, and the
rendered text — which arrives in the payload. **It does not need the repo at
all.** That is worth stating plainly, because it makes delivery robust to exactly
the failure that burned us: a node with no repo files can still deliver an
escalation perfectly well.

Backfill and reconciliation are the opposite — they *do* need GitHub read access,
via REST or a working mount.

So qualification is **per task type**, not per node:

| task | needs | verified how |
|---|---|---|
| deliver an escalation | Slack write | executor preflight, reported in the ack |
| backfill / reconcile | GitHub read (REST **or** mount) | executor performs a real read and reports |

**What the placement check actually verifies — stated exactly, because guessing
here is what caused the incident:**

- Cloud verifies **the agent is registered and answers**. That is agent liveness,
  not node capability.
- Cloud **cannot** verify from outside that a node has a given repo on disk, or
  that its mount works. `clonePath` and Relayfile mounts are properties of the
  agent spec and the host, invisible to the dispatcher.
- Therefore **the executor preflights itself and reports `qualified` /
  `unqualified` with a reason in its ack.** The node is the only thing that can
  answer the question, so it is asked rather than assumed.
- **A dispatch may still land on an agent that turns out to be unqualified.** The
  ack is where that surfaces; cloud then re-dispatches. I am not claiming
  placement is verified in advance — it is verified *by the target, at the
  target*, one round trip in.

**And today specifically:** the Relayfile mount is failing for every routed repo
but one. So for any task that needs repo access, **the mount half of
qualification is not dependable right now** — such tasks should prefer a target
with REST access or a cloud sandbox, and the design must not assume the mount
will answer. Escalation delivery is unaffected, since it needs no repo.

## 15. Unchanged from Parts I–II

The absence-of-events problem, the one-time backfill, the seeded-then-silent PR,
reconciliation reporting drift rather than repairing it, per-repo `lastEventAt`
as `coverage: unverified`, the cloud-side ledger and its accepted failure mode,
and the local instance answering Khaliq's questions from the ledger — that role
was right, it was simply not the whole role.

---

# Part IV — the subscription is not flowing, and the liveness oracle

**Established before writing trigger code, because an event-driven agent with no
subscription fails silently.**

## 16. Live check: is the subscription actually absent?

Chief's broker message at 13:42Z said *"No integration event subscriptions are
active for this project."* Checked live rather than trusting that sentence:

```
$ agent-relay integration subscription list      # defaults to the active workspace
[]
```

**Zero subscriptions, confirmed live in workspace `rw_7ccfea89`.** Not an auth
error — an authenticated empty list. The 13:42Z report was not stale.

**The limit on that claim, stated because it matters:** this is the *relay
workspace* subscription layer. The broker's message said "for this project,"
which may be a Cloud-project scope — a different layer. `relayfile integration
list` requires a cloud login this node does not have, and `webhook list` requires
a workspace key (`rk_live_…`) it does not have either. **So: one layer confirmed
empty, a second layer unreadable from here.** Both would need to be non-empty for
events to flow, so the confirmed-empty one is already disqualifying.

## 17. What activates it — and the thing worth knowing

There are **at least three distinct layers**, and they are not the same knob:

| layer | mechanism |
|---|---|
| persona intent | `useSubscription: true` (review/persona.ts:73 has it; so does pr-shepherd) |
| relay subscription | `agent-relay integration subscription create <event>` / `integration subscribe <provider>` |
| provider→channel routing | `relayfile integration bind <provider> <path> --channel … --webhook …` |

**Declaring `triggers: { github: [...] }` in `agent.ts` does not create a
subscription.** The persona declares *intent*; provisioning is a separate act.
That is strong inference from the existence of explicit `subscription create`
and `integration bind` commands plus the absence of any claim in the skill that
deploy provisions them — **not** verified against the deploy code path, which I
cannot read from here. **Flagged as inference, not fact.**

**A hazard the skill already warns about, and it is our old friend:**
`creating-cloud-persona` :162 and :751 — *"launched by a lead/team dispatcher to
avoid duplicate subscriptions"*, *"do not subscribe team members to the same
provider events as the lead."* **Two subscribers means every event delivered
twice**, which is AR-448 at the subscription layer rather than the dispatch
layer. This design already has exactly one subscriber (cloud); now there is a
documented reason it must stay that way.

## 18. What arrives when it is active — unknown, and answered empirically

Chief is right not to assume the declared trigger list maps 1:1 onto delivered
events, and **I cannot determine the mapping without an active subscription.** So
it is answered by measurement, not assumption: **for the first period after
activation, log every received `event.type` and diff it against the declared
list.** Any declared trigger that never arrives is a gap; any arriving type not
declared is a surprise. Both belong in the first report.

## 19. The liveness oracle — why "no events" cannot be trusted to mean "quiet"

**The failure this prevents:** a subscription that is not flowing produces a
ledger frozen at its backfill state, and the ladder then reports a calm, healthy
backlog. **A silent false negative across ~250 PRs, indistinguishable from
"nothing needs attention."** Same shape as the three-day-stale mirror and the
typecheck that could not fail.

**Why a simple timeout does not work:** "no events for an hour" is exactly what a
quiet Sunday looks like. A fixed threshold either cries wolf or sleeps through
the outage.

**The oracle: reconciliation is what proves the event stream is alive.**

Reconciliation already re-enumerates open PRs (§4). Give it one more job:

> For every PR it reads, compare the PR's real last-activity timestamp against
> the ledger's `lastEventAt`. **If reconciliation finds activity that the event
> stream never delivered, the subscription is broken** — and now that is a
> measured delta rather than an inference from silence.

That converts an undetectable failure into a countable one: *"reconciliation
found 14 PRs with activity newer than any event we received."* Zero is healthy.
Non-zero is a fault, with a number attached.

Supporting state, all reported rather than merely stored:

- `lastEventAt` **globally** and **per repo**.
- **Learned baseline, not a constant.** The ledger accumulates the real event
  rate; the alarm is a statistically improbable silence against *observed*
  cadence — the same dataset that fixes the thresholds.
- **At bootstrap there is no baseline, so the honest initial state is
  `liveness: unverified` — never `healthy`.** A system that has not yet seen an
  event cannot claim the stream works.

**And the agent says so out loud.** Any answer sourced from the ledger carries
its `lastEventAt`; if that exceeds tolerance, the response leads with
*"I have received no events since X"* instead of answering as though current.
This is the §10 staleness rule applied to the event stream rather than the store.

## 20. Detecting a local executor that is not alive

Already designed in §13, restated because Chief asked directly:

**The ack is the detector.** Cloud dispatches with a timeout. No ack does not
mean no post — so cloud **checks the destination for the idempotency key**, which
is authoritative. Key absent → nothing landed → re-dispatch to the next target.
Fallback runs preferred local → other qualified local → cloud sandbox, and if
nothing qualifies the item is reported as **`escalation undeliverable`** with the
reason.

**The invariant: work never disappears quietly.** It lands, or it is reported as
undeliverable. There is no third outcome in which it silently does not happen.

---

# Part V — the mount is an event bus, and its health signal is not enough

**Correction from Khaliq: local agents CAN subscribe to events through the
Relayfile mount.** "Only cloud can listen" was wrong, and Parts II–IV were built
on it. Verified against source rather than relayed:

- **`factory/src/mount/relayfile-cloud-mount-client.ts:598`** —
  `subscribe(globs, onChange, opts): Subscription`, delegating to a
  workspace-scoped `RelayfileEventClient`. A local process subscribes to globs
  and receives change callbacks. **Confirmed.**
- **`factory/src/mount/local-mount-preflight.ts:13`** —
  `STATE_FILE = '.integrations/.relay/state.json'`. **Confirmed.**

## 21. What this changes

**The cloud/local split is a placement decision, not a capability boundary.**
Both surfaces can be event-driven; Khaliq's policy applies — prefer a local node,
fall back to a cloud sandbox only when no local node qualifies.

**What does not change, and is now more dangerous:** the ledger write and the
escalation decision stay single-owner. **The mount makes accidental double
subscription *easier*, not harder** — two local residents subscribing to the same
glob both get called, both decide, and neither can see the other's claim. That is
AR-448 with a lower barrier to entry. The single-decider rule is now load-bearing
in a way it was not when only cloud could listen.

## 22. `checkMountStaleness` — use it, but know what it proves

Chief said use the mount's own liveness signal rather than inventing one. Right —
but read for what it actually asserts (`factory/src/mount/relayfile-binary.ts`):

| condition | verdict |
|---|---|
| state file **missing** (`ENOENT`) | **`stale: false`** |
| unreadable / not an object | stale |
| workspace mismatch | stale |
| `lastReconcileAt` missing | stale |
| `lastReconcileAt` older than **15 min** (`STALE_RECONCILE_MS`) | stale, with the age |
| pid absent but reconcile fresh | not stale (documented) |
| pid not running | stale |

**Two things follow, and they decide the design.**

**(a) `ENOENT` → not stale is correct for factory and wrong for me.** Factory
calls this as a *preflight*: no state file means no mount to be stale, so start
one. A consumer asking *"is my event feed alive?"* must read a missing state file
as **`unverified`** — never healthy. Same function, different contract. I use it
with that translation, not as-is.

**(b) It proves the DAEMON IS RECONCILING, not that the DATA IS CURRENT.** The
15-minute reconcile check would have caught a `lastReconcileAt` three days old —
so the mount found three days stale while reporting healthy was almost certainly
**reconciling on schedule while serving stale content**. That is the senses-mount
pattern exactly: *lag=0, pending=0, a ticking state file, days-old data.*

> **A ticking daemon passes this check while delivering nothing.**

So it is **necessary and not sufficient**, and it cannot be the liveness oracle
for an event feed.

## 23. Two-layer liveness

| layer | question | signal | cost |
|---|---|---|---|
| transport alive | is the mount process reconciling? | `checkMountStaleness`, with `ENOENT → unverified` | free |
| transport **delivering** | are events actually arriving? | **§19 reconciliation delta** | one sweep |

Layer 1 catches a dead mount cheaply and often. **Only layer 2 catches a live
mount that delivers nothing** — by finding PR activity the event stream should
have reported and did not. That is why §19 stays: the mount's own signal cannot
answer the question that matters, and now there is a source-level reason rather
than a suspicion.

**The three states the agent must distinguish, and say out loud:**

```
nothing happened        events flowing, ledger fresh, no PR crossed a clock
I stopped listening     mount stale / state file absent / reconciliation delta > 0
I never started         liveness: unverified — no event has ever been received
```

**Silence is not a state.** It is the *symptom* of all three, and an agent that
cannot say which one it is in should not be reporting a calm backlog.

## 24. Prove it end to end before building

Chief is right that a mount subscription and a provider-side subscription are
different objects. Both must hold:

1. **Does the provider deliver into the scope?** — does `.integrations/github/repos`
   change when a real PR event happens?
2. **Does a local subscriber get called when it does?** — `subscribe(globs, …)`
   fires.

**The experiment:** open a throwaway comment on a routed PR, watch for the scope
to change and the subscriber to fire, and record the observed `event.type`
against the declared list (§18).

**`barry` cannot run it.** There is no `.integrations` tree on this node — I
searched. So this must run on a host with a working mount, and per `factory#218`
/ `#219` per-repo mounts currently fail for every repo but one. **Coordinating
with `factory-mount-fix-lead` rather than duplicating that work.**

Until that experiment passes, **the event-driven path is designed and unproven**,
and the honest bootstrap state for the whole agent is `liveness: unverified`.

## 25. A live specimen — measured on `barry`, 2026-08-07T18:14Z

§22 argued from source that the mount's health signal proves the daemon is
reconciling, not that the data is current. **Here is a live instance.**

`/Users/barry/relay-dev-collab-mount/.relay/state.json`:

```json
{ "workspaceId": "relay-dev-collab", "mode": "poll", "intervalMs": 30000,
  "lastReconcileAt": "2026-08-07T18:14:35Z",
  "providers": [ { "status": "healthy", "lagSeconds": 0, "deadLetteredOps": 0 }, … ] }
```

Reconciled **19 seconds** before I read it. Every provider healthy, zero lag,
zero dead-lettered ops. **`checkMountStaleness` returns `stale: false`** — it
passes every branch.

The same mount, same moment:

```
newest content file   2026-08-05T21:13:02Z   (~45 hours old)
digests/              empty, dir mtime 2026-08-04
```

**And here is the part that matters more than the staleness.** I cannot tell,
from inside, whether this mount is:

- **(a)** serving 45-hour-old content while reporting zero lag, or
- **(b)** perfectly healthy and genuinely quiet for 45 hours.

**Nothing in the health report distinguishes them.** That is not a limitation of
this investigation — **it is the defect.** A health signal that reads identically
whether the feed is dead or merely quiet conveys no information about which.

This is precisely the state an event-driven shepherd would be in while reporting
a calm, healthy backlog across ~250 PRs, and it is why §23's second layer is not
optional. **Only a delta against an authoritative source can separate (a) from
(b)** — the mount's own signal provably cannot, and now that is demonstrated on a
live host rather than argued from source.

Reproducible by anyone with access to `barry`, in one `cat`.
