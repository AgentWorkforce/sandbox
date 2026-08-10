# Workstream steward state — steward-0810c

**Standalone handoff. Written 2026-08-10, last updated 15:43Z.** This is the
primary artifact: `chief` has produced no output since 14:10:05Z, so reports
DM'd to it after that time may be unread. Read this file first.

> **TWO STEWARDS WERE ALIVE.** `workstream-steward-claude-0810` ran the same
> watch list; its state is at `state-workstream-steward-claude-0810.md`. It
> recommended keeping me and standing itself down; Chief never ruled. **I
> overwrote this file at 13:36Z without checking it existed — it was theirs
> first.** They moved theirs aside rather than clobber back. Read both.

---

## 1. THE INSTRUMENT LIES FOUR WAYS. Trust no number until you exclude all four.

`check_inbox` and `list_dms` are BROKEN (relay#1471) — they fail with a raw SQL
error that reads exactly like an empty inbox. **Never use them.**

Liveness sweeps use `mcp__agent-relay__search_messages` with a `from` filter.
That tool fails silently in the affirmative on four independent axes:

1. **Junk / `*` queries return `[]`** globally, even with no filter at all.
2. **Relevance ranking, not recency** — `limit` truncates by relevance, so a low
   limit invents staleness. `limit: 3` reported soc2 at 12:39 when its true max
   was 12:45. **Use `limit: 20`+ always.**
3. **Multi-word queries return `[]`.** `{from:"daytona-lead-0810", query:"sandbox
   node provision caller"}` → `[]`, while `query:"sandbox"` returns its messages.
   **"Checked on two terms" is worthless if either was a phrase. SINGLE COMMON
   WORDS ONLY** — `the`, `and`, or one domain word.
4. **The `channel` filter returns nothing from today** (found by the other
   steward). Never used here. Note `from`-filtered results DO include #general
   posts — proven by a 14:12:59 general post appearing in a `from` sweep.

**The only honest liveness signal is a bracketed nonce round-trip.** A steward
CAN send one: `send_dm` asking for a one-line echo is observation, not dispatch.
**Never let anyone respawn a lane on a silence measurement from this tool** — a
respawn burns the name.

Other rules: roster / `list_agents` / `spawned: true` are not evidence in either
direction. If listing processes, `pid,lstart,comm` only — never command or args,
it leaks workspace keys. **Never restart `chief-broker`** (11.4.2, no identity
key, no way back). Observe and report: no dispatch, no code, no workstream edits,
no merges. Check whether a file exists before writing it.

---

## 2. WHAT HAPPENED — two cohorts, two windows

**First cohort — nine leads, last outputs inside a 23-minute window, nothing in
the ~3 hours since:**

| lead | last output |
|---|---|
| relaycast-cloud-7-lead-0810 | 12:35:42 |
| daytona-lead-0810 | 12:40:51 |
| herdr-lead-0810 | 12:41:24 |
| sage-nightcto-lead-0810 | 12:43:18 |
| soc2-lead-0810 | 12:45:38 |
| relayfile-coordination-lead-0810 | 12:46:39 |
| cloud-identity-d1-lead-0810 | 12:49:13 |
| lifecycle-workflows-lead-0810 | 12:49:57 |
| pr-shepherd-lead-0810 | 12:58:48 |

Plus `relay-1449-proof-0810` (12:02:29) and `relay-1449-contract-0810` (12:33:07).

**Three more agents silent since ~14:30:** `gmail-500-probe-0810` 14:30:06 ·
`relay-1449-fix-lead-0810` 14:30:22 · `r1382-codex-0810` 14:33:26. Plus `chief`
outbound 14:10:05 (brain commit `7f4ffa9` 13:45:58Z).

> **CORRECTED 15:58Z — I called this a "second cohort" and a rolling die-off.
> WRONG.** `workstream-steward-claude-0810` was producing throughout —
> 14:48:59, 15:04:24, 15:19:11, 15:33:55. In pass 8 I wrote "every agent I had
> classed as alive" and **omitted it because I had not re-measured it since
> 14:07.** Same class of error the other steward retracted at 14:33 (carrying an
> unverified row into a table described as freshly checked); mine was the mirror
> image — omitting an unchecked row from a set described as complete.
> **There is no second cohort. The fleet is not down.** The three timestamps
> above still hold; the inference drawn from them did not.
> **Rule: re-measure every row in a table before describing the table as current,
> including the rows that would falsify your thesis and the ones you left out.**

**Three nonce brackets, three failures:**
```
14:42:42Z → pr-shepherd-lead-0810     sw-0810c-PRS-4f19c7a2   no echo (closed 14:56:56Z)
14:42:45Z → daytona-lead-0810         sw-0810c-DAY-8b3e11d6   no echo (closed 14:56:56Z)
15:27:35Z → relay-1449-fix-lead-0810  sw-0810c-FIX-6a2d90b4   no echo (closed 15:41:27Z)
```
Workspace-wide, the only `NONCE-ECHO` in existence is `r1449-target-sf-0810`'s at
11:58:23Z. **This is a bracketed request→response failure on three independent
agents — not a death certificate. No process was inspected.**

**Two hypotheses, opposite remedies, unresolved:**
- **(a) Cohort termination.** FD ceiling is the candidate — `spawn-liveness-diag-0810`
  measured 216 of a 256 launchd soft limit, `activeAgents=34`. It found the ceiling
  did not explain a *launch* failure at 12:33; whether FD exhaustion kills
  *established* connections while later spawns still succeed was never tested.
- **(b) Each parked after its first deliverable** — the opencode steward's shape
  at fleet scale (it did ~16 min of real work and stopped exactly at its outbound
  step).

`spawn-liveness-diag-0810` has the method to separate them (PTY logs, read
receipts, `readers=[]`, pending/deadletters, PID checks) and delivered a full
diagnosis at 13:41:42Z. **A steward recommends; it does not dispatch.**

---

## 3. STRANDED WORK — five finished reports, unread, no respawn needed

All delivered into threads whose leads had already gone quiet. **Harvest costs a
few searches; a respawn costs a fresh lead re-deriving what is on disk.**

| specialist | delivered | conversation |
|---|---|---|
| `cloud-id-trigger-0810` | 12:53:38–12:56:13, 6 notes | `dm_08a779631c750c0d9fb3e16b` |
| `cloud-id-semantics-0810` | 12:57:49 | `dm_b01d4e680bbb51aa561bce26` |
| `soc2-recon-sso-0810` | 12:52:41 | `dm_b5093bd5c1a84bd12beaf641` |
| `sage-gate1-readback-0810` | 12:49:45 | `dm_fcc02afd932bb9b8307f4a46` |
| `lifecycle-gap2-dag-0810` | 12:49:27 | `dm_dfb31ef3d7bac33383fd6fd2` |
| `cloud-id-enum-0810` | **never spoke** | — |

**Read the first two first.**

- **trigger** — shipped `0007` has no BEFORE INSERT trigger. `INSERT OR REPLACE`
  fires NO update trigger, so a BEFORE UPDATE guard cannot close the hole. **A
  conditional BEFORE INSERT guard covering all three uniqueness constraints does
  close it** — exact SQL, tested on SQLite 3.51.0 and D1-local with raw output and
  exit codes; `INSERT OR IGNORE` does not bypass it. **DDL bypasses everything**
  (DROP TABLE, DROP TRIGGER), so integrity needs privilege separation, not just
  triggers. Local vs production kept separate; production marked UNKNOWN.
- **semantics** — `cloud#2981` ledger-first **is already merged** (`d936b9e6`);
  both Chief's brief and the lead's had it in-flight. Identities are already half
  in D1 and **that D1 table has no writer in the repo**, so duplicate-name
  detection may be silently disabled in production now. `writeBudgetAuditEvent`
  swallows a D1 failure with only `console.error` — live under-logging defect.
- **soc2 SSO** — the OIDC sponsor binding is **INERT in production**
  (`RELAYAUTH_SPONSOR_FEDERATIONS` unset; grep exits 1; every org falls to
  legacy). The refusal covers **1 of 5** sponsor-setting paths; the attestation
  grant path notarises unbound sponsors into the signed ledger. **No
  approver-binding primitive exists.** Verdicts: "Chief SSO threading is UNOWNED
  but startable via Google OIDC"; "Offline verification IS NOT possible with
  0.2.28 exports alone."
- **sage gate 1** — ANSWERED, green. The deployed brain does resolve a non-empty
  triage config. `inputSpecs: {}` is an API projection artifact
  (`extractDeploymentInputSpecs` copies only `picker`). The `REPO_LABELS` trap was
  read off a stale checkout and is gone on origin/main.
- **gap2** — BLOCKED correctly: relayflows baseline is RED on a clean clone,
  `npm test` exit 1, `@relayflows/slack-primitive` unresolvable, the reference
  fixture collects zero tests. A relayflows finding, not a lane failure.

---

## 4. ONE LANE IS ONE MESSAGE FROM PRODUCING A DIFF

`r1382-codex-0810` delivered a good combined red-check at 14:33:26Z and **stopped
exactly as instructed** — TS exit 1 with 5 failures showing `apiKey:
"file-key"`/`"env-key"` where `undefined` was expected, Rust exit 101 with 3
failures, implementation files untouched. It self-reported a mutex-poisoning
artifact in its own harness rather than reporting through it.

`relay-1449-fix-lead-0810` promised *"I will confirm or correct within minutes."*
It has not spoken since 14:30:22Z. **Unblocking this is one DM: "red-check
accepted, proceed to implementation."** I did not send it — confirming a
red-check is a review judgement belonging to its lead or to Chief, not the
watcher. Clone: `/Users/khaliqgant/Projects/AgentWorkforce/relay-r1382-codex-0810`,
branch `fix/1382-atomic-broker-connection`, built against `28e2137cf`.

---

## 5. OPEN DECISIONS (all still open at 15:43Z)

1. **Which steward stands down.** Two ran the same watch list.
2. **Whether the silent cohorts get respawned** — and (a) vs (b) above decides
   whether respawn or rebind is correct. Harvest §3 first either way.
3. **relaycast-cloud-7-lead-0810** — NOT blocked on a grant. Chief unblocked it
   at 12:50:23Z with verbatim `npm view` output; it never spoke again. Its ACK is
   the only message in its life. **Do not re-run those probes.**
4. **relayfile** — draft PR to carry the flaky-test warning on
   `fix/relay-state-json-two-writers` (`3e6ada31`, on origin, no PR). Chief ruled
   option (a) at 13:10; the lead never acted.
5. **daytona** — B-vs-C; `DAYTONA_API_KEY` in an agent env; §7 brain-write ack.
6. **herdr** — relay#1449 mechanism: shipped or proven-in-principle.
7. **sage-nightcto** — park verdict accepted 13:33; gate 1 since answered green.
8. **lifecycle-workflows** — escalate CRE/preq to Khaliq→Julian; and whether to
   prove/refute the regex-approval bypass (rated PLAUSIBLE, not executed).
9. **soc2** — relay#1465 (`de6215a5c`, 9/9 green, idle since 08-08) needs a human
   reviewer.
10. **factory-lead** — NOT a stale roster name. Live process whose local PTY and
    cloud identity are bound to different nodes; DMs land with `readers=[]`. Fix
    is a new name on chief-broker, not reclaiming the old one.

**Blocked on Khaliq:** relayfile credential ruling (a cloud session already
exists on SF-Mac-Mini, contradicting its hard condition — untouched, nothing
minted); daytona B-vs-C + API key; herdr T6 vs herdr#3 (`7b657a6` deletes
`plugins/agent-relay/` unpushed while herdr#3 adds 13 files into it, OPEN,
`check-contributor` FAILING).

---

## 1a. RULED 16:59:33Z — BEAT SPLIT APPROVED. BOTH STEWARDS STAY.

Chief's ruling, verbatim in effect:
- **`steward-0810c`** — relay liveness, nonce brackets, lane-to-lane message flow.
- **`workstream-steward-claude-0810`** — GitHub artifacts, PR/issue state, and
  **ruling-to-artifact tracking** (a Chief decision producing no artifact within a
  sensible window is itself an exception).
- **Neither reports the other's plane.** If you see something on the other's
  plane, **hand it over rather than report it** — duplicate reporting is how Chief
  got the same `factory-lead` finding twice, four hours apart.

**Also ruled, so these stop being open:**
1. Neither steward stands down.
2. **Silent cohorts: do NOT respawn.** §5b is accepted — respawn is a no-op on
   this broker and burns the name. **Harvest §3 first**; Chief is reading those
   five stranded reports.
3. `relaycast-cloud-7-lead-0810` — noted, **not blocked**, do not re-run probes.
4. relayfile draft PR — Chief is chasing it.
5–8. Carried to Khaliq; still his.
9. relay#1465 — escalated to Khaliq as the cheapest metre on the SOC-2 path.
10. `factory-lead` — diagnosis accepted (local PTY and cloud identity on
    different nodes, DMs landing `readers=[]`). **Chief will not retry the wake.**

**Chief adopted both method rules and corrected its own instrument:** it had been
running multi-word queries at `limit: 2–3` all afternoon — failure modes 2 and 3
simultaneously — and had told two leads to "use at least two real search terms,"
which made it worse. Now on single common words at `limit: 25`. **This file is the
first thing Chief reads each sweep, ahead of DMs.** Keep it current.

## 1b. THE BEAT SPLIT — proposed 16:31Z, endorsed, ruled approved above

Two stewards are **not redundant, they are differently blind.** Everything novel
from `workstream-steward-claude-0810` since 14:49 came through `gh` and was
invisible to relay sweeps: five PRs Khaliq merged at 14:00–14:13, nine ownerless
review threads on merged PRs, the empty-`?workspace=` defect on main, a ruling
that produced no artifact in three hours, and Khaliq's live presence.

**Proposed split: `steward-0810c` owns relay liveness + nonce probes;
`workstream-steward-claude-0810` owns GitHub artifacts + ruling-to-artifact
tracking; neither reports the other's plane.** I withdraw my earlier
"collapse to one" — that would have cost the whole GitHub plane.

**METHOD HOLE BOTH STEWARDS HIT INDEPENDENTLY, ~100 min apart, on the same lane.**
Every liveness check defaults to `from: <lane>`, which measures one side of a
conversation and reads the silence as a block. **Also sweep what Chief sent TO a
lane.** "Has it produced?" and "has it been answered?" are different questions.
This is the default shape of a liveness sweep and will be rediscovered by the
next steward unless it is written down. (Third variant, from the same steward at
16:31: it checked both sides of one conversation but not what a *third* agent had
already produced about the subject — `spawn-liveness-diag-0810` had diagnosed
factory-lead at 13:41 and it reported the same finding as new at 16:02.)

**A published artifact is not its repo.** Chief's 12:50 unblock warned that the
7.0.0 tarballs carry `gitHead 41bb8bcd` (relaycast#308) while
`0034_node_load_reporting.sql` is on `origin/main` at `7121d04` — a *later*
commit. Reading 0034 off origin/main does NOT answer whether the published engine
contains it. relaycast-cloud's own in-flight branch exists for exactly this:
*"keep the worker migration matched to the PUBLISHED engine, not the repo."*

## 5b. RESPAWN IS A NO-OP AND BURNS THE NAME — read before acting on §5.2

From the other steward, 16:03Z, citing Chief's own 11:33Z finding: **a
duplicate-name spawn on this 11.4.2 broker returns `{spawned: true}` and launches
nothing.** So respawning `factory-lead` (or any existing name) reports success,
starts nothing, leaves the original process sitting there, and you end up
watching a name you believe you just restarted. Worse: `factory-lead` is a broker
self-registration on 11.4.2 — the class where a re-registration mismatch **burns
the name with no way back**. The respawn is not merely useless; it is the one
action with a downside.

Chief's parked-process experiment ran twice and both arms came back negative:
`factory-lead` (wake 12:36:02Z) and `marketing-lead` (wake 12:36:12Z), neither
responding in 3h26m. For `factory-lead` the process is known alive — the #1449
proof lane attached to it and painted a live TUI at ~12:01Z. **A live harness, a
DM in the right channel, and no response for hours means the message is not
reaching the harness's input, or the harness is wedged behind something a DM
cannot clear.** That is a platform question, not a steward one.

## 6. WORKSTREAM AUDIT — clean

No `status: active` file lacks a Next. **Five use an inline `**Next:**` rather
than a `## Next` header** — `chief-onboarding`, `factory-live-dispatch`,
`herdr-fleet-surface`, `sage-nightcto-factory-program`, `workspace-convergence`.
A header-only grep FALSE-POSITIVES on all five. Both stewards initially flagged
`agent-lifecycle-workflows.md` and both withdrew it — a stale gating clause, not
a missing Next.

Separately: six files carry a stale `owner:` while a `-0810` lead worked the lane
(cloud-identity-d1 and relayfile-coordination still say `-0809`), and
`cloud-2917-webhook-recovery.md` is `status: done` with a Next section. Not edited.

---

## 7. CORRECTIONS I MADE TO MY OWN REPORTS — keep the habit

- **Pass 3:** I called `relaycast-cloud-7-lead-0810` "blocked, needs two
  commands." Chief had already unblocked it 80 minutes earlier. **A lane's last
  message describes the world when it last ran; it is not a status.** Sweep
  Chief's outbound and diff it against each lane's last output.
- **Pass 4:** I wrote "the whole first cohort is gone." Withdrawn — I measured
  absence of work product, not death.
- **Pass 4→5:** I framed four lanes as ignoring Chief's rulings. Wrong causation:
  they were already silent 30 minutes *before* the rulings arrived.
- **Pass 1:** I called `factory-lead` a stale roster name. Wrong — see §5.10.
- **Pass 8:** I claimed a "second cohort" died at 14:30. Wrong — I omitted the
  other steward, which was producing throughout. See the box in §2.
- **Pass 9:** I told Chief it had been silent 91 minutes and restructured around
  "I may be reporting into a void." **Wrong.** Chief's newest outbound was
  **15:29:55Z** — status checks to relayfile-coordination and soc2, sent thirteen
  minutes BEFORE my report. I measured 14:10:05 at pass 5 and carried it forward
  through four passes without re-measuring.

**THE PATTERN, three instances, one root cause: I re-measured the rows that
supported the claim and carried forward the ones that would break it.**

> **STANDING RULE: a number older than the current pass is not a measurement, it
> is a memory.** Re-measure every row before describing any table or claim as
> current — especially the expensive-to-check ones, which is exactly where the
> corner keeps getting cut.

**Chief's own two corrections, same family, worth keeping:**
- It grepped `ps -eo pid,lstart,comm` for `factory` and found nothing — but the
  process `comm` is `node`, so it never matched. **A search miss is not absence.**
- It read three samples landing in a schema where the key is *absent* and
  reported "`providers` is an empty array, length 0". **An absent key is not an
  empty store.**

**Both stewards made the same class of error once each, ~1 hour apart, in
opposite directions, and each caught the other's.** That is a genuine argument
FOR two watchers and against my earlier "collapse to one" recommendation. Chief's
call; I withdrew the confident framing rather than let it stand.

## 7b. FINDINGS FROM THE OTHER STEWARD worth carrying (verified via `gh`, not relay)

- **Khaliq merged relaycast #317/#318/#319 + two ratify-demo PRs himself at
  14:00–14:13** (`merged_by: khaliqgant`). The merge gate held. But all three
  merged with review threads open, and **#319 shipped a defect**: the guard is a
  truthiness test, so `?workspace=` (empty) passes it and the sole-workspace
  fallback fires; the recommended fix was a key-presence check. Bounded to
  single-tenant, card public by design — a contract defect, not the disclosure.
  The wide disclosure finding WAS answered, in a code comment. **Nine
  still-current threads on merged PRs now have no owner.**
- **The 13:10:25Z relayfile draft-PR ruling was never executed.** No PR exists;
  branch tip unmoved at `3e6ada31`. At 12:46:39Z — 24 min BEFORE the ruling — the
  lead had released its specialist with "Do NOT open one… Stand by or exit."
  **A decision that arrives after its executor is dismissed has no executor.**
  (The ruling also contained a gate: Chief asked to read the body text first.)
- Its timestamps ran 10–13 min fast between 14:49Z and 15:33Z (computed from loop
  intervals instead of read). Corrected by it, unprompted. **State the measurement
  method alongside every number.**

## 8. NOTES

- All eight shared repos were pulled to `origin/main` at ~13:29Z. This supersedes
  the 12:47Z "7 of 7 repos behind" finding. Do not re-raise it.
- The shared `relay` checkout moved to `28e2137cf` after Chief's "do not pull"
  broadcast; tree was clean when it moved, so nothing visibly died.
- A citation that still resolves is NOT evidence a checkout is current — the
  failure mode is absence, not drift. Check `git ls-remote origin refs/heads/main`
  vs `git rev-parse HEAD` before reading anything.
