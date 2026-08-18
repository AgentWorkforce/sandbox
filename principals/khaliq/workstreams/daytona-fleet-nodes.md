---
status: active
owner: daytona-overnight-fix-0813
previous_owner: daytona-mount-proof-0811
reports_to: chief
updated: 2026-08-13
repos: [cloud, relay, sandbox]
---

## 2026-08-16 — RESTATED BY KHALIQ, AND IT KEEPS BEING MISSED: sandbox nodes are JIT

**Sandbox nodes are brought up ON DEMAND. There is no live Daytona node, and
there is not supposed to be one.** Khaliq, 2026-08-16, prefaced with "I've said
this many times" — so this is a repeat correction, not new information.

The absence of a running Daytona node is the **designed state**. It is not a
blocker, not a gap to close before work can start, and not evidence that
anything is broken. A sandbox is provisioned when work needs it, serves that
work, and goes away.

**Two rules that follow, and every future acceptance bar must satisfy both:**

- **Uptime is the wrong criterion.** Any bar phrased as "a node stays up for N
  hours" is measuring the persistent-node model that was overturned on
  2026-08-13. The right criterion is whether a sandbox is **attachable within
  its own lifetime**, between provision and teardown.
- **`daytona-fleet-proof-0811` is a relic, not a starting point.** Offline
  since 2026-08-13 on broker 11.4.1. Do not revive it, and do not report its
  absence as a finding.

**The real question, reframed correctly:** the broker version requirement is
real but it attaches to the *provisioning path*, not to a node. Terminal
transport landed in 11.6.7 and drive needs 11.6.9, so the load-bearing question
is whether a **freshly provisioned** sandbox comes up on a current broker — if
the image bakes something older, every on-demand sandbox is unattachable by
construction. Read the version off the running process, not off what the image
claims to install.

**Why this entry exists at all.** Chief filed `relay#1538` on 2026-08-16 with
"there is no live Daytona node" as blocking item 1 and "a live Daytona fleet
node" as definition-of-done 1 — having *already read and quoted* the
2026-08-13 fresh-per-agent correction earlier in the same document. A corrected
preamble sat above uncorrected acceptance criteria. **Reading a correction is
not the same as letting it govern the document: check the acceptance criteria
against the stated model before publishing.** The issue body has been rewritten
and the error recorded on the issue rather than deleted.

## 2026-08-13 ~22:00Z — architecture correction, stated directly by Khaliq: fresh sandbox per agent, not one reused box

Khaliq: Daytona should provision a **fresh sandbox per agent**, not reuse one
long-lived box. This overturns the model every entry below was written
against — the whole 24h-heartbeat-continuity acceptance bar (see "Done when"
below) was designed for a persistent node, and a liveness/uptime check is
the wrong criterion for an ephemeral-per-agent model.

**Practical effect**: the identity-reclaim gate (`relay#1499`, draft, not
merged) that's been blocking `daytona-fleet-proof-0811`'s restart may be
solving a problem that mostly goes away under this model — a brand-new
sandbox each time has no stale identity to reclaim. `provisionFleetSandboxNode()`
(`packages/web/lib/fleet/sandbox-bridge.ts:464` in `cloud`) is already a
complete, tested function with **zero production callers** — it may be
exactly the mechanism this model needs; it was simply never wired to
anything (see the mechanism-map section below, still accurate).

**Dispatched `daytona-overnight-fix-0813` on finn-mini (2026-08-13 22:07Z)**
to investigate and implement against this corrected model overnight, no live
supervision. Explicitly told NOT to restart the old `daytona-fleet-proof-0811`
sandbox — that's the model being moved away from. Told to reason in writing
about whether `relay#1499` is still needed at all under this model rather
than assume either way. Report via send_dm to "chief" at checkpoints.

**The "Done when" criteria below (Phase 1's 24-hour continuous-uptime bar)
are now stale against this correction** — do not treat them as the
acceptance bar for new work until they're rewritten for the fresh-per-agent
model. Whoever picks this up next: rewrite "Done when" before trusting it.

## 2026-08-13 ~10:45Z — structural finding: sandbox `dedfeb9a` has a hard 2GB memory ceiling, not the ~377GB the host reports; this is what actually caused tonight's restart attempt to go sideways before the identity-reclaim gate was even reached

Dispatched to attempt the Daytona broker restart (11.5.6, containing relay#1484
+ relay#1495). Two real findings worth keeping independent of the
identity-reclaim entry below:

**1. `free -h` inside this sandbox reports the HOST's memory (377Gi total),
not the container's real limit.** The actual constraint is
`/sys/fs/cgroup/memory.max` = **2147483648 bytes (2GB), flat**. Baseline
usage before touching anything was already 2.08GB/2.15GB (97%) — driven by
the live broker, 3 old idle PTY sessions (`daytona-proof-worker-0811`,
`daytona-mount-audit-0811`, `daytona-mount-proof-v4-0811`, all confirmed dead
in worker-log output for 11h–2+ days via `stat`/`tail`), and the relayfile-mount
process. `npm install -g agent-relay@11.5.6` at that baseline got **OOM-killed
(exit 137)** twice, silently the first time (pipeline swallowed the real exit
code) — left the on-disk `agent-relay` CLI in a broken state (missing
top-level `package.json`/`dist`/`bin`, dangling global symlinks, at least one
incomplete transitive dependency). Repaired: killed the 3 confirmed-idle PTY
sessions to free memory (99.7% → 59.6% used), then a clean `npm install -g
agent-relay@11.5.6` succeeded with headroom (41–65% used throughout). CLI and
broker binary both verified at 11.5.6 afterward.

**Practical implication for anyone touching this sandbox**: `free -h`/`df -h`
give a false sense of headroom here. Check `/sys/fs/cgroup/memory.current` vs
`memory.max` before any memory-heavy operation (`npm install`, a build, a
broker restart bringing up two broker processes briefly). A full `npm install
-g` at >90% cgroup usage reliably OOM-kills. This plausibly also explains why
the on-disk 11.5.4 upgrade recorded at 2026-08-12 20:44Z never got its process
restarted that night — not just "supervision model not understood yet," but a
box with very little real margin for the operation.

**2. `npm pack <single-package>` is a safe, low-footprint alternative to `npm
install -g` on this box** — used successfully twice tonight (once for the
broker binary alone, once combined with `npm install -g` after freeing memory)
without triggering the OOM. Worth defaulting to for any future targeted
package fetch here rather than a full `npm install -g`.

**Broker restart itself then hit the identity-reclaim gate below** — this
memory finding is what got the CLI to a working state to even attempt that,
not the reason the restart ultimately didn't complete. Live broker (pid
315/325 before shutdown) and the relayfile-mount process (pid 90608)
confirmed undisturbed throughout all of the above; node identity/enrollment
files on disk confirmed unmodified since their original 2026-08-11 creation.

## 2026-08-13 ~11:15Z — identity-reclaim gate durable fix landed, unblocks Daytona's path back online

`relay#1498` (issue) + `relay#1499` (draft PR, not merged). Fixes the gate that
took `daytona-fleet-proof-0811` offline earlier tonight (see
[[cross-node-attach]] for the incident). Root cause confirmed entirely
client-side in the broker (`admit_agent_registration`,
`crates/broker/src/relaycast/auth.rs`) — relaycast-cloud has no server-side
`identity_key` knowledge at all. Design: automatic reconnect/collision path
left exactly as strict as today (no regression to the AR-448 hijack
protection); new deliberate, operator-invoked `agent-relay-broker
reclaim-legacy-identity <name>` command backfills the identity key on one
named record, refusing if already stamped or if the record shows `online`.
"Auto-grandfather None→allow" was considered and rejected — traced through
that it would let any workspace-key holder win a race to permanently hijack a
legacy name, strictly worse than today's unrecoverable-but-safe state. 928
broker tests passing, clean gates. **Once reviewed/merged, this is Daytona's
path back online**: `reclaim-legacy-identity daytona-fleet-proof-0811` before
attempting the broker restart again. Not merged yet — Khaliq's call.

## 2026-08-13 ~13:15Z — chief took ownership of cloud#2918; #2916 SDK bump verified, but it wasn't the real snapshot blocker

Chief (this session) took direct ownership of `cloud#2918` (Fleet production proof
tracker) now that `cloud#2916` (`@agent-relay/sdk` 10.0.0→11.4.1 app-level bump)
merged (`2cb14cd`, by Khaliq, confirmed on `origin/main@245a3719`). Posted a full
evidence-based update to the issue itself
(https://github.com/AgentWorkforce/cloud/issues/2918#issuecomment-5279546063).
Key correction to the record, verified from source rather than assumed:

- **The persistent Daytona fleet-node snapshot was already on relay SDK 11.4.1
  since 2026-08-04** (`769d32b1`, `chore(snapshot): promote
  relay-orchestrator-sdk-11.4.1-...`), via the rebuild workflow's own
  `sdk_version` dispatch input — decoupled from `package.json` by design.
  Read-only `query_nodes` against `daytona-fleet-proof-0811` right now confirms
  `"version":"relay-broker/11.4.1"` on the live broker. So #2916 does **not**
  touch or require rebuilding the fleet snapshot; that's why Phase 2 (cloud#2984,
  08-11) could already prove dispatch+execution on a Daytona node a full two days
  before #2916 existed.
- What #2916 actually fixes: cloud's own app-level `@agent-relay/sdk` dependency
  and the `SANDBOX_FALLBACK_DEPENDENCY_SPECS` fallback install list in
  `packages/core/src/bootstrap/launcher.ts`, used when an *ephemeral
  workflow-execution* sandbox (not a persistent fleet node) bootstraps the SDK
  at runtime. Real, correctly-scoped fix — just not the fix the issue's "known
  state" note implied.
- Re-checked #2655's three named missing pieces against current `main`:
  `@agent-relay/factory` is **still not baked into** `deploy/daytona/Dockerfile`
  (only `@agent-relay/sdk` is installed there) — unresolved, though not proven to
  block anything since Phase 2 didn't need it; the 10.x node model gap is
  **resolved** (mechanism B / `provisionFleetSandboxNode` is the live path,
  proven since cloud#2984/#2991); token injection at provision time is
  **resolved for node enrollment**, still open specifically for the Relayfile
  mount (see 09:37Z entry above — same 403 gate, unrelated to #2916).
- Read-only check only: `daytona-fleet-proof-0811` (`node_212862301507432448`)
  is currently `offline`/`handlersLive:false`, last heartbeat
  `2026-08-13T10:46:37Z`. **Did not restart it** — this is the exact
  legacy-registered node the identity-reclaim gate applies to.
- No mutating action taken (no snapshot rebuild, no fresh sandbox provisioned).
  Next concrete step — provisioning a *fresh* staging Daytona sandbox to run
  the still-outstanding 24h-heartbeat/restart-same-identity proof — is
  identified but held for Khaliq's explicit go-ahead, per tonight's no-mutation
  rule.

## 2026-08-13 ~09:37Z — cloud#3007 and cloud#3009 merged and deployed; live proof blocked at auth, not at the 524

**cloud#3007** (Daytona 524 fix — force `useSession: false` one-shot exec path,
plus a credential-file race fix) merged by Khaliq at `eb29f0f3`, deploy run
`31684477341` succeeded 08:58:37Z. **cloud#3009** (relayfile-mount-by-default
on new sandbox nodes) merged by Khaliq at `c32d58a2`, deploy run `31678696887`
succeeded 07:39:54Z. Both live in production.

**Live proof against the real sandbox (`dedfeb9a-8682-4b89-957f-5bd15603ee0c`)
attempted, blocked — but at a different layer than the 524 this PR fixes.**
`POST https://agentrelay.com/cloud/api/v1/fleet/nodes/sandbox/dedfeb9a.../relayfile-mount`
with `{"workspaceId":"50587328-441d-4acb-b8f3-dbe1b3c5de99"}` (the Cloud app
workspace ID, resolved server-side to `rw_7ccfea89`) returned **`403
Forbidden` in 1.02s** — before the rate-limiter, workspace-owner check, or any
Daytona/mount code ever runs. Root cause: `requireSessionAuth` on this route
(`route.ts:145-147`, gate at `request-auth.ts:149-153`) only accepts an actual
`agent_relay_session` browser cookie, `source: "session"`. A CLI-minted
`cld_at_…` token authenticates correctly everywhere else (confirmed via
`/api/v1/auth/whoami` — resolves to Khaliq, org owner, correct workspace) but
resolves to `source: "token"`/`subjectType: "cli"`, which this route rejects
outright. **Not new** — `relayfile-backend-fix-v3-0812` hit and documented the
identical 403 on 2026-08-12 18:10Z. The only invocation that ever got past
this gate (2026-08-12 20:04-20:06Z, the one that originally produced the 500
cloud#3001/#3007 were written to fix) was fired from Khaliq's own logged-in
browser, not any CLI/agent credential — there is no bearer→cookie exchange
endpoint in production.

**So the 524-vs-fixed question is still genuinely untested.** cloud#3007's
fix is deployed but has never been exercised by a request that got past auth.

**Pre-invocation sandbox state, confirmed via `daytona exec` (read-only):** no
`relayfile-mount` process running; `relayfile status` still returns `error:
cloud session expired. Run 'agent-relay cloud login' to sign in again.` —
unchanged from the historical broken state, consistent with nobody having
successfully invoked the repair since deploy.

**Deliberately not attempted**: extracting/simulating Khaliq's browser
session cookie (headless Chrome cookie decryption needs interactive macOS
Keychain approval — previously ruled unsafe for unattended use) and patching
the route's auth gate to accept CLI credentials (explicitly deferred by chief
on 08-12: "don't add bearer-auth support to the endpoint, that's real scope
beyond tonight"). Both remain out of scope for an invoke-only proof.

**Next, needs Khaliq specifically:**
1. Invoke the exact request above from his own logged-in browser (same as
   08-12 20:04Z), then have chief verify `relayfile status` on the sandbox
   afterward to close the loop — the fastest path to an actual answer.
2. Or authorize a reviewed, scoped change to accept an owner-scoped CLI/
   service credential on this specific route, if browser-only invocation is
   the wrong long-term shape for this endpoint.

Files: `packages/web/app/api/v1/fleet/nodes/sandbox/[sandboxId]/relayfile-mount/route.ts`,
`packages/web/lib/auth/request-auth.ts`, `packages/web/lib/workspaces/relay-workspace-binding.ts`.

## 2026-08-12 20:55Z — ../sandbox is the fix, not a diversion; also reopens E2B

Khaliq asked how much `../sandbox` (`AgentWorkforce/sandbox`) could help. It's
`@agent-relay/sandbox`, extracted from the internal codebase, published to npm
at `0.1.2`, and **already a dependency of `packages/web` and
`packages/daytona-runner`** in cloud. It has a real Daytona adapter
(`src/daytona/runtime.ts`) whose `runScript(handle, { useSession: false })`
calls `sandbox.process.executeCommand` directly — the exact one-shot fix
approved for cloud#3001's 524. It also ships `SandboxOrchestrator.startMount`,
a relayfile-mount-aware orchestration layer (`buildRelayfileMountStartShell`
etc.) that avoids the 524 shape by design (polled short execs, not one
blocking call), backed by a 1108-line Daytona runtime test file.

Grepped cloud#3001's `route.ts`: zero references to the package. It hand-rolled
`createSession`/`executeSessionCommand` calls instead of using the dependency
already in `node_modules`. Redirected `relayfile-backend-fix-v3-0812` via DM:
stop patching the route in place, replace its Daytona calls with
`@agent-relay/sandbox`'s `DaytonaRuntime`/`SandboxOrchestrator` instead — less
code, already tested upstream. Still: test live, open PR, hold for my review.

Side effect: the package's `E2BSandboxRuntime.launch()` (`src/e2b/runtime.ts`)
is also fully implemented, not stubbed. Earlier tonight I told Khaliq E2B
cross-attach needed a fleet-roster-provisioned node first — that's no longer
true for a sandbox *launch*; this package can launch an E2B sandbox directly
via the SDK, independent of fleet roster provisioning. Reopens E2B as a
lighter lift than previously scoped, pending Khaliq's go-ahead to start it.

## 2026-08-11 19:26Z — production deploy blocker CLEARED

Deploy run `31526176137` (headSha `935178de`) **succeeded**. Root cause of the
`TranscriptionWorkerServiceToken` failure (prior runs `31516360915`,
`31522436779`) was cloud#2994: the secret had no constructor default, so
`sst diff`'s read-only preflight (seed-sst-secrets disabled by design) threw
`SecretMissingError` before a deploy could even be evaluated — production had
never had `sst secret set TranscriptionWorkerServiceToken` run. Fix follows the
same pattern already used for `LinearWebhookSecret`: an "unset" placeholder
default so diff/plan always resolves, while the real deploy step still
unconditionally overwrites it from the GitHub Actions secret. No manual `sst
secret set` needed going forward.

**This clears the production blocker on the multi-host proof.** DM'd
`daytona-mount-proof-0811` (offline since 18:27Z but the underlying node
`daytona-fleet-proof-0811` / `node_212862301507432448` confirmed live/heartbeating
independently) to resume. Still outstanding, unrelated to this blocker: the
four read-only proof gates `daytona-mount-proof-0811` found in the merged
mount code (`/workspace` default unwritable for unprivileged Daytona, argv-order
env bug in the refresh loop, Relayfile token visible in mount argv, no
existing-sandbox retrofit path) and the stale-projection currency check
(`known-true-now`, `workspace-joined-not-created`, `cross-host-write-visible`,
etc.) from the 08-11 19:28Z closeout entry below.

## 2026-08-12 08:52Z — Relayfile 404 root-caused to backend, likely never-provisioned

`daytona-mount-proof-v5b-0812` went dead with no report (confirmed via direct
process check — no longer running in the sandbox); respawned as
`daytona-mount-proof-v6-0812`, alive within seconds. Its findings: mount
daemon runs stably against workspace `50587328-441d-4acb-b8f3-dbe1b3c5de99`,
local reads work, but every remote sync call including plain `relayfile
status` returns a clean 404 — 0 files ever synced, stuck at
`bootstrapping: 0/0 files`.

Independently, chief fixed a *different* Relayfile credential problem tonight
on workspace `rw_7ccfea89` (dead local daemon, expired delegated token) — but
even after that fix, `rw_7ccfea89`'s sync call got a 30s **timeout**, not a
404. The two failure shapes look like different bugs on the same
`file.agentrelay.com` backend: Daytona's clean 404-on-everything (including
status) matches "workspace never provisioned server-side" — consistent with
the standing finding that `provisionFleetSandboxNode()` in `cloud` had zero
callers — while `rw_7ccfea89`'s timeout looks like a workspace that exists
but has a hung reconcile loop. Flagged this distinction explicitly to
`relayfile-backend-fix-lead-0812` so a fix for one isn't assumed to cover the
other. Both leads coordinating directly now.

## 2026-08-12 20:44Z — session close for the night

**Daytona repair endpoint (cloud#3001)** — merged and deployed to
production successfully. Invoking it live (Khaliq's own browser session)
consistently fails with a real error, captured directly from a live
Cloudflare Worker log tail: `Request failed with status code 524` — a
Cloudflare edge timeout, meaning the Worker's own outbound call to
Daytona's API is timing out, even though the sandbox itself is
demonstrably alive and responds instantly to direct CLI exec. **Not yet
root-caused** — needs investigation into why the Worker's Daytona client
call (get/attach/runScript sequence) is slow/hanging server-side when the
same operations are fast from a direct CLI. No app-level timeout exists on
that call either (524 is Cloudflare's own limit kicking in, not ours).

**Separately, real infra problem found and partially fixed**: the Daytona
sandbox's root filesystem was completely full (100%, 5.0G/5.0G). Cleared
npm cache (~734MB) and orphaned files from a misdirected `sudo npm`
install (which silently wrote to an unused global root,
`/usr/lib/node_modules`, instead of the actual resolved nvm path) — now at
93%, healthy headroom. `agent-relay` CLI upgraded to 11.5.4 successfully.
**Not yet done**: the running broker (PID 325) still has the old binary
loaded in memory and needs a restart to take effect — deliberately not
attempted tonight. This sandbox's startup pattern
(`/usr/local/bin/relay-sandbox-entrypoint` → `agent-relay fleet serve`,
driven by env vars) is different from sf-mini's (`node up` +
`start-*-fleet-node` script) and wasn't understood well enough by end of
session to restart safely — there are 3 live PTY sessions (idle, not
actively working) whose identity/history could be at risk from a rushed
restart.

**Immediate next steps, in order:**
1. Root-cause the 524 timeout on the Worker's Daytona API call — likely
   the highest-value next step, since it blocks the actual mount proof
   regardless of the broker version.
2. Once safe, restart Daytona's broker to pick up 11.5.4 (same category
   of fix as sf-mini, needed for the cross-node-attach proof to work here
   too) — figure out the `fleet serve` restart mechanism properly first,
   don't rush it.
3. Re-run the credentials.json fix verification (server URL + node
   enrollment wiring, both already fixed earlier) once the 524 timeout is
   resolved, to confirm the mount actually completes end to end.

All investigating agents told to hold, no further mutating actions
overnight.

## 2026-08-12 10:53Z — both backend root causes found (3rd attempt, codex)

Two prior claude attempts (`relayfile-backend-fix-lead-0812`,
`relayfile-backend-fix-v2-0812`) went quiet for hours with nothing to show
and were respawned; the third, on codex (`relayfile-backend-fix-v3-0812`),
found real, git-history-backed root causes for both open bugs within ~20
minutes:

**Daytona 404 — actually solved, not just diagnosed.** The mounted
workspace ID `50587328-441d-4acb-b8f3-dbe1b3c5de99` was never a valid
Relayfile `rw_*` workspace ID — it's the Daytona sandbox's own app UUID.
`provisionFleetSandboxNode`'s original caller (commit `16f58648`) mounted
*before* the relay workspace was actually provisioned; a later commit
(`5c90d299`) fixed the ordering — enroll first, then mount with the real
returned `relayWorkspaceId` — but only when invoked with
`mountRelayfile:true`. This sandbox (`daytona-fleet-proof-0811`) was
provisioned under the old buggy path and has been pointed at an ID that was
never a real Relayfile workspace. **The fix is re-provisioning this specific
sandbox through the corrected flow, not a server-side patch** — coordinating
directly with `daytona-mount-proof-v6-0812` on execution.

**rw_7ccfea89 timeout — real architecture bug found.** Production's `POST
/v1/workspaces/{id}/sync/refresh` synchronously rebuilds the entire GitHub
issue index before responding — up to 10k issue meta files, R2-loaded 100 at
a time — with no timeout or async/queue boundary. That's structurally too
slow to fit inside a 30s client timeout; not a transient hang, an
architectural gap. Also noted: prod redeployed successfully at 10:10Z today
(unclear if related); a fresh post-deploy status check was requested.
Proposing a fix (async/queued rebuild) as a follow-up PR if time allows — no
merge/deploy without explicit chief authorization. **Khaliq's design question, answered from production source
(commit b2ee):** `handleSyncRefresh` calls `refreshGitHubIssueIndexes`
**unconditionally** on every `POST /v1/workspaces/:id/sync/refresh` with
`provider === "github"` — no cold-start/first-sync/dirty-repo gate. It
always SELECTs up to 10,000 issue meta rows and R2-loads them in 100-wide
batches; only the final `writeSystemFileIfChanged` write is idempotent
(skips rewriting an unchanged index), the scan/load cost is paid every
call regardless. **So "make it async" only fixes the 30s timeout symptom,
not the actual waste — the real fix needs a background queue and/or an
incremental dirty-repo set so unchanged repos skip the scan entirely.**
Lead asked to scope the fix that way, or at minimum document the exact
shape if it's too large to land tonight.

**Design proposed (not implemented — right call for tonight, touches DO
alarms/schema/production sync logic):**
1. Add a per-WorkspaceDO `github_issue_index_dirty` table keyed on
   `(owner, repo, issue_number)` + revision/action. Hook it into
   `handlers/ops.ts:recordMutations`'s existing `origin === provider_sync`
   branch — upsert dirty rows only on real provider changes (fs upserts
   already dedupe unchanged content).
2. Change `handleSyncRefresh`'s GitHub branch to return 202 for a
   persisted DO-alarm job instead of awaiting R2 synchronously. The alarm
   groups dirty rows by repo, loads only the changed issue metadata per
   affected repo, applies upserts/deletes, clears completed dirty rows.
3. For old workspaces with no dirty history: a separately persisted,
   cursor-backed bootstrap rebuild in alarm-sized batches, run once, never
   repeated on every refresh — also fixes the 10k-row cap for large repos.

Test shape proposed: unchanged refresh = zero canonical scan/R2 reads; one
issue update touches only its repo's index; delete removes the row; >10k
bootstrap yields/continues across alarms; failure retains dirty work for
retry. This eliminates both the client-side stall and the repeated full
reconstruction. **Filed as a design, not a PR — proper follow-up, not
tonight's scope.**

**2026-08-12 11:22Z — local verification attempted per Khaliq's ask, blocked
by an unrelated harness bug.** At clean production SHA `b2ee4b6036fd`, ran
the repo's prescribed `make gate1-e2e` / `make gate1-single` Miniflare
commands (after working around the host npm/Dropbox hang with an isolated
npm config). Both fail before any test runs: `Uncaught Error: No such
module "node:fs" imported from "api-worker.mjs"`. Traced to the generated
bundle — `@relayfile/adapter-github/dist/adapter.js` and adapter-core pull
in `node:fs`/`node:fs/promises`, which the local esbuild harness doesn't
polyfill/externalize for the Workers runtime. **This is a separate,
pre-existing defect in the local dev/test harness composition, unrelated to
the sync/refresh design above** — worth its own fix, but not tonight.
Correctly declined to implement the dirty-table/DO-alarm change without a
runnable test environment. No source changes, merge, or deploy made.
**rw_7ccfea89 thread closed out for tonight**: root cause found, fix design
documented, local verification genuinely attempted and blocked by an
unrelated bug — the right stopping point.

**2026-08-12 10:56Z — Daytona 404 theory self-corrected with better
evidence.** The lead checked the exact 404 response body and found it
matches **relaycast**'s worker error envelope
(`{ok:false,error:{code:not_found,...}}`, `packages/server/src/worker.ts:279-282`),
not relayfile-cloud's flat envelope shape — meaning the mounted client is
very likely hitting the **wrong base URL/service entirely** (relaycast
instead of file.agentrelay.com), independent of whether the workspace was
ever provisioned in Relayfile Cloud. Also surfaced: the mount was started
**manually** by the prior lane (`daytona-mount-proof-v5b-0812`), not
through the actual `POST fleet/nodes/sandbox` `mountRelayfile:true` path —
likely why its config ended up pointed at the wrong service. Confirming the
exact base URL with `daytona-mount-proof-v6-0812` now. The rw_7ccfea89
timeout finding stands unaffected by this correction.

**Confirmed 11:00:42Z**: `/home/daytona/.relayfile/credentials.json` had
`server: https://cast.agentrelay.com` (Relaycast), no
`RELAYFILE_SERVER`/`BASE_URL` override — the manual `v5b` mount really did
hit the wrong service, exactly matching the observed 404 envelope. **Root
cause fully closed: wrong client base URL, not workspace provisioning.**
Authorized the fix: update `server` to `https://file.agentrelay.com` and
restart the mount against the same workspace ID (no reprovisioning). Low
risk, single config field, reversible. Awaiting confirmation the 404s
actually clear before calling this done.

**2026-08-12 11:28Z — fix applied, but a second wiring gap found; real fix
is re-provisioning, not another config patch.** `daytona-mount-proof-v6-0812`
applied the server-URL correction (verified directly: `credentials.json`
now correct, mount daemon properly daemonized) then exited without
reporting. Direct `relayfile status` now fails differently:
`error: cloud session expired. Run 'agent-relay cloud login' to sign in
again.`

Traced directly: the sandbox has a proper **node-level device enrollment**
(`fleet-enrollments.json` + `workspace-key.json` — a real, long-lived
machine token, exactly what a fleet node should have), but **no
`agent-relay` cloud session directory exists in the sandbox at all.** The
manually-started mount (by `daytona-mount-proof-v5b-0812`, not the
automated `mountRelayfile:true` path) never wired the node's own enrollment
token into the `relayfile` process's environment — compare
`start-sf-mini-fleet-node`/`start-finn-mini-fleet-node`, which explicitly
export `RELAY_NODE_TOKEN`/`RELAY_WORKSPACE_KEY` from
`fleet-enrollments.json` before invoking the CLI. So `relayfile` falls back
to expecting a personal interactive login that was never established —
"expired" is a misnomer for "never existed."

**Both the base-URL bug and this credential-wiring gap trace to the same
root cause: the mount was started manually instead of through the
automated provisioning path.** The actual fix is re-provisioning this
sandbox's mount correctly (or exporting the node's own enrollment
credentials into the `relayfile` process env, matching the other fleet
nodes' pattern) — not another config patch. This is now an action to take,
not something left to investigate further.

**2026-08-12 11:42Z — real fix plan approved, implementation authorized
(not deploy).** Khaliq: "provision it via the correct automated path,
NEVER STOP." Checked the actual current-path endpoint
(`POST /api/v1/fleet/nodes/sandbox`) first — it's **create-only**, no
sandbox/node ID in its body, unconditionally calls
`provisionFleetSandboxNode()` → `orchestrator.provision()`. Calling it
against `dedfeb9a` would create a **second** Daytona sandbox — correctly
ruled out before acting, not after. No existing retrofit/attach route.

**Approved plan**: add a new, narrow, attach-only endpoint —
`POST /api/v1/fleet/nodes/sandbox/:sandboxId/relayfile-mount` — that
reuses existing tested primitives (`createFleetDaytonaRuntime(...).attachSandbox(sandbox,{owned:false})`,
the already-used `buildAutoRelayfileMountConfig`/
`installRelayfileTokenRefreshLoop` helpers in `sandbox-bridge.ts`) rather
than reimplementing token logic. Hard-guarded: validates the on-box
enrollment matches the expected `daytona-fleet-proof-0811` node before
doing anything; never creates/destroys a sandbox; never mints/redeems a
new node-enrollment token or re-enrolls the node; resolves/binds the
canonical `rw_*` relay workspace server-side and rejects anything else;
mints the Relayfile access+refresh pair server-side via
`RELAYAUTH_API_KEY` (bypassing the missing sandbox cloud session
entirely — this is the intended auth path, not a workaround); restarts
only the mount with `killExisting:true`; uses the existing writable
`/home/daytona/relayfile-workspace`, not the helper's `/workspace`
default; verifies `relayfile status`/daemon state without printing
tokens.

**Authorized: implement as a PR. Not authorized: merge or deploy** — this
is production Cloudflare Workers code; explicit sign-off required before
any deploy step regardless of how well-scoped the change is. Noted caveat:
this fixes Daytona's 404/auth/miswiring only — the independent rw_7ccfea89
sync/refresh 30s timeout (see above) may still reproduce afterward and is
correctly out of scope for this patch.

**2026-08-12 12:14Z — PR opened, reviewed in full, genuinely solid.**
[`cloud#3001`](https://github.com/AgentWorkforce/cloud/pull/3001)
(575+/18-, 4 files). Chief read the complete diff, not just the
description. Verified directly: the route hard-codes a single
`REPAIR_TARGET` (this exact sandboxId/nodeId/nodeName) and 404s any other
sandbox ID before auth even resolves; it cross-checks the *live* on-box
enrollment via a script that reads `fleet-enrollments.json` and returns
only public identity fields (explicit comment: never reads/prints the
long-lived node token); it cross-checks the proven `relayWorkspaceId`
against the workspace's own binding, 409ing on mismatch; the new
`startFleetSandboxAutoRelayfileMount` is a genuine refactor —
`provisionFleetSandboxNode`'s existing behavior is unchanged, just shared
rather than duplicated; a new PID-file guard kills the prior token-refresh
loop cleanly on repair instead of racing it; the failure path explicitly
never tears down the sandbox even if the refresh-loop install fails after
the mount starts. Tests cover reject-wrong-sandbox, the happy path with
exact call assertions, and the binding-mismatch case.

CI in progress (build/typecheck/Next.js build/Phase 0 tests), nothing
failed yet. **Holding for CI green, then Khaliq's explicit sign-off before
any deploy or live invocation** — standard production-deploy gate, PR
quality doesn't change that requirement.

**2026-08-12 12:37Z — CI went fully green (0 failed, mergeStateStatus
CLEAN, confirmed independently), Khaliq merged `62f89997` himself.**
Auto-deploy workflow triggered on merge, in progress as of this entry.
**Deploy landing is not the same as authorization to invoke the endpoint
against the live sandbox** — that remains a separate, explicit go-ahead
not yet given.

**2026-08-12 13:00Z — deploy succeeded, confirmed independently.** The
attach-only repair endpoint is now live in production. Nobody has invoked
it against `dedfeb9a-8682-4b89-957f-5bd15603ee0c` yet — waiting on explicit
Khaliq authorization for that step, same gate as the rest of tonight.

# Daytona sandboxes as live fleet nodes

**2026-08-11: PHASE 2 PROVEN. `cloud#2984` MERGED (`16f58648e`). Node `daytona-fleet-proof-0811` (`node_212862301507432448`) ONLINE. Full loop confirmed: Chief dispatched `daytona-proof-worker-0811` → agent landed inside sandbox `dedfeb9a-8682-4b89-957f-5bd15603ee0c` → replied from hostname matching sandbox ID, pwd `/home/daytona` → Claude process (PID 380) observed on-host via SSH. 24h heartbeat gate in progress (~2026-08-12T09:22Z).**

## Proof team dispatch — 2026-08-11 18:20Z

`daytona-mount-proof-0811` is registered on the exact existing node
`node_212862301507432448`; the placement receipt matched its handler and
dispatched node IDs. It must reuse sandbox
`dedfeb9a-8682-4b89-957f-5bd15603ee0c` and Relay workspace
`50587328-441d-4acb-b8f3-dbe1b3c5de99` without cloning, reprovisioning, or
creating a replacement workspace.

The lane is blocked before provider mutation. Cloud `#2991` merged as
`5c90d2994` but is not in production: run `31516360915` failed during `sst
diff` because the production SST secret `TranscriptionWorkerServiceToken` has
no value. A later GitHub repository-secret update does not itself seed SST, and
there is no later deploy run.

Read-only review found four additional proof gates in the merged code:

1. `/workspace` is the default mount root even though unprivileged Daytona uses
   `/home/daytona/workspace` and cannot create `/workspace`.
2. Refresh-loop variables are assigned after `node -e`, making them argv rather
   than environment; the mount would lose refresh around its first 55-minute
   tick.
3. The Relayfile token remains visible in the mount process argv.
4. The provisioning route has only a broad boolean full-workspace write mount
   and cannot retrofit the existing sandbox.

The source projection also fails the required `known-true-now` check: workspace
`rw_7ccfea89` returns 404 for merged Cloud PR `#2991` and its newest projected
PR is `#2873`. GitHub reports `healthy`/`lag: 0s` despite its last provider event
being about 203 hours old; Linear is about 285 hours old. Those scopes are
uncertified until content currency, not merely a green health label, is restored.

Fix, generated-shell execution tests, independent review, production deploy,
and a valid existing-sandbox attach path are prerequisites. The final proof
must still capture all named multi-host assertions plus dispatched-node and
on-target-process identity. The 24-hour node gate is not due until about
2026-08-12T09:22Z.

## Relayfile mount closeout — 2026-08-11 19:28Z

Replacement owner `daytona-relayfile-closeout-barry-0811` ran on Barry and
reused the exact existing Daytona node, sandbox, and Relay workspace; it did
not clone, reprovision, or mutate the historical worker. The original node
enrollment had no Relayfile mount. The owner verified that the authenticated
production route still returned HTTP 404 at 17:25:04Z, so mounting and the
downstream currency/write assertions were not attempted.

Production run `31516360915` reached the deploy target and failed because the
SST secret `TranscriptionWorkerServiceToken` has no value. A production admin
must set the correct GitHub Actions or production SST secret and trigger a new
production deploy. Until then, there is no honest full mount proof. After a
successful deploy, resume on the same resources and capture:
`workspace-joined-not-created`, `scope-declared`, `mirror-matches-cloud` with
coverage, `known-true-now`, `cross-host-write-visible` or the exact read-only
rejection, `placement-target-live`, `placement-executed`, and `nothing-cloned`.
The replacement owner was released after this blocker and evidence were made
durable. Chief owns reappointment after the production secret/deploy unblock.

**2026-08-10: `cloud#2963` merged (`52ebc1d8a1`) and `cloud#2946` merged and DEPLOYED (`639ec90c9d`). The cold-start toolbox defect is fixed: `buildWarmStepContext` no longer awaits `getUserHomeDir()` while a sandbox is `STARTING`, which had been burning the queue retry budget so the ten-minute polling loop never ran.**


Goal: make a provisioned Daytona sandbox behave as a sustained, live agent-relay
fleet node that Chief can place work onto, with the same reliability the Mac mini
nodes already demonstrate.

Spec: `cloud/docs/specs/2656-daytona-fleet-node-and-chief-placement.md` (217 lines,
verified against production fleet state 2026-08-06). Read it before starting —
it is unusually well-evidenced and it corrects a stale diagnosis that would
otherwise waste a lane's time.

Related: `cloud#2656`, `cloud#2683`, `cloud#2689` (decided), `relay#1328`, `relay#1446`.

## Now

**There is no pipeline to debug. Every enrollment mechanism in the repo is
disconnected at a different joint, and one of them is wired to a command that
was deleted.** "The wiring is merged and does not work" was wrong in a way that
mattered: nothing was ever connected, so H1/H2/H3 were ranked against a system
that does not exist. This is a design decision, not a measurement run.

All findings below verified 2026-08-10 at named refs — `cloud@639ec90c9d`
(origin/main tip) and `relay@v11.4.0`/`v11.4.1` (the pinned snapshot versions)
— in an isolated clone. The shared `cloud` checkout is **117 commits stale**
(at `7807ba35ba`); do not read facts from it.

## The mechanism map

Three enrollment mechanisms exist. Not two. None is connected.

| | Mechanism | Broken at | Evidence |
|---|---|---|---|
| **A** | `dev-stack/fleet-node-bootstrap/sandbox-node-bootstrap.sh` | No caller *by design* — it is an operator runbook | Referenced only by its own README and its own two tests |
| **B** | `provisionFleetSandboxNode()`, `packages/web/lib/fleet/sandbox-bridge.ts:464` | **Function with no caller** | Zero production call sites |
| **C** | `start_fleet_serve()`, `deploy/daytona/relay-sandbox-entrypoint.sh:11` | **Reader with no writer — and it calls a deleted command** | `AGENT_RELAY_FLEET_ENROLLMENT_TOKEN` is only ever read, never written |

Scope for both counts: `grep -rn` over the whole repo at `cloud@639ec90c9d`,
`--include='*.ts' --include='*.tsx'` for B and unrestricted for C, excluding
`node_modules/`, `dist/`, and `.git/`.

- **B is complete and tested, and nothing calls it.** `box-manager.ts:57-63`
  imports seven *other* symbols from `sandbox-bridge.ts` and pointedly not this
  one. The only references to `provisionFleetSandboxNode` outside its own
  definition are in `sandbox-bridge.test.ts`. It provisions, mounts Relayfile,
  mints a token, and runs the correct two-command flow — into a vacuum.
- **C is dead on arrival, not merely unwired.** It builds
  `agent-relay fleet serve --enrollment-token …`, but at both pinned versions
  (`relay@v11.4.0` and `v11.4.1`, `packages/cli/src/cli/commands/fleet.ts:24-77`)
  `fleet serve` is a **hidden stub that prints a migration message and
  `exit(1)`**. `allowUnknownOption(true)` means the old flags are swallowed
  without an argument error. Cloud's own source says so at
  `packages/web/lib/fleet/nodes.ts:281-286`; verified independently in `relay`.
  Worse, the entrypoint runs it as `nohup … &` and writes a PID file, so the
  exit code is discarded and the failure lands only in
  `~/.agent-relay/fleet-serve.log`. **A sandbox that took this path would look
  healthy and never produce a node.** That is the symptom this workstream has
  been chasing.
- C is additionally gated on `AGENT_RELAY_FLEET_SERVE` being truthy — a third
  unset variable. Three gates, all closed, in front of a broken command.

## Next

**The question is which mechanism is intended, and it is Khaliq's or the Cloud
owner's call — not a lane's.** Do not schedule a live run until it is answered.

1. **Decide the intended mechanism.** The evidence points hard at **B**: it is
   already built, already tested, already uses the supported `relay cloud enroll
   && relay node up` flow, and lives in the control plane where the token is
   minted. **C should be retired, not connected** — it targets a command that
   no longer exists. Recommendation: adopt B, delete C's `start_fleet_serve`
   enrollment branch, keep A as the manual proof harness.
2. **Answer the design question B leaves open: what calls it?** There is no API
   route, no dashboard action, and no Chief-facing command that provisions a
   fleet node. That missing caller *is* the work — Phase 1 cannot start without
   it. Options to weigh: a `POST /api/v1/fleet/nodes/sandbox` route; an
   extension of the existing cloud-agents box route; or a Chief-invoked script.
3. **Fix `autoStopInterval` before any measurement.** See the corrected
   enumeration below. No current call site is safe, and one can produce a
   **one-minute** auto-stop.
4. **Then, and only then**, re-derive H1/H2/H3 against the pipeline that
   actually exists. The current hypotheses are not salvageable as written.

**Blocked on Khaliq, independent of the above:** Daytona credentials are absent
from the agent environment (`packages/daytona-runner/src/auth.ts:11` needs
`DAYTONA_API_KEY`, or `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID`; all
unset). Phase 1 and Phase 2 are unschedulable until that is answered — it is a
question to ask, not a thing to work around.

## Key facts, so nobody re-derives them

- **The recorded 2026-08-04 diagnosis is false.** It blamed a pinned snapshot
  shipping agent-relay 10.0.0 against a >=10.6.0 heartbeat requirement. The node
  actually registered on broker **11.4.0** with the full capability set and did
  heartbeat. The version gate is not the problem, and the spec asks for that
  correction to be written down wherever the stale theory is recorded.
- **The failure moved**: not "never comes online" but **"comes online, then dies
  after ~39 seconds."** **FALSIFIED 2026-08-09 by `daytona-lead`, re-derived from
  source.** The heartbeat interval is **12s, not 30s** — `relay@v11.4.0
  crates/broker/src/node_control.rs:29`, `const HEARTBEAT_INTERVAL:
  Duration = Duration::from_secs(12)`. An explicit `NodeHeartbeat` fires at
  `:1606` *before* the interval is created at `:1614`, and tokio's first tick is
  immediate — so 39s holds roughly **five** beats (~0, ~0, 12, 24, 36), not one.
  Offline detection is a 45s TTL swept every 30s (`cloud
  packages/relaycast/src/durable-objects/node.ts:18,19`, handler `:869-877`), so
  offline lands **45–75s** after the last beat. **39s is inside the window where
  nothing should have been declared offline at all — it was never a clue.**
  H1's "most likely" ranking rested on this number and is now **unranked**.
  **The real behaviour has never been measured.**
- `finn-mini` and `sf-mini` are live with an **identical** capability set, and
  end-to-end placement onto `finn-mini` was proven on 2026-08-06. So the
  difference is not capabilities, not enrollment, not broker version.
- `maxAgents: 0` on the dead `cloud` record means *unlimited*, same as every
  healthy node. Do not chase it.
- **`autoStopInterval`: five distinct literals and three computed call sites.**
  Scope: `grep -rn 'autoStopInterval' --include='*.ts' --include='*.sh'` over the
  whole repo at `cloud@639ec90c9d`, excluding `node_modules/` and `dist/` — 22
  hits across 16 files. Literals **5** (`packages/core/src/cli-auth.ts:158,188`),
  **10** (four `tests/code-sync-bench*.ts`, `tests/code-sync-e2e.ts:88`), **15**
  (`packages/core/src/auth/sandbox-auth.ts:318`, `tests/check-sandbox.ts:3`,
  `tests/quick-sandbox.ts:16`), **30** (`workflows/optimize-sandbox-startup.ts:97`),
  **60** (`tests/orchestrator/launcher.test.ts:112,122`,
  `workflows/optimize-sandbox-startup.ts:234,245,254`). Computed:
  `packages/core/src/bootstrap/launcher.ts:1422` (60, or
  `normalizeSharedSandboxTtlMinutes(ttlMinutes)` in shared-sandbox mode);
  `…/box/box-manager.ts:2349` (`Math.ceil(DEFAULT_BOX_TIMEOUT_SECONDS / 60)`,
  which evaluates to 60 given `= 60 * 60` at `:73`); and
  `…/sandboxes/route.ts:181` (`Math.max(1, Math.ceil(body.timeoutSeconds / 60))`
  — caller-driven with a floor of **one minute**). *Correction to the 2026-08-09
  handoff, which listed four literals and missed **30**; and to the pre-08-09
  note above, which listed three.* Daytona's idle clock does not reset on
  outbound relay heartbeats, so **none of these is safe for a measurement run**:
  any of them can stop a healthy node mid-run and present as a sandbox-death
  event that is really our own misconfiguration.

## Done when

Phase 1 — a fresh sandbox appears `online`/`live` with `spawn:*`, stays online
**continuously for 24 hours** with `lastHeartbeatAt` advancing throughout,
survives a stop/start cycle without re-enrolling, and the root cause is written
into the PR with evidence. Criterion 2 is a **duration** test: a node that is
online when you look at it already passed that bar once on Aug 5 and was still
broken.

Phase 2 — Chief places work onto a Daytona node, verified **on the target host**
(broker pty and CLI process observed inside the sandbox), not merely from the
control plane's `dispatchedNodeId`. Control-plane dispatch and actual execution
are different claims.

## Explicit non-goals

- Hosting the Chief node itself on Daytona. Chief stays on local hardware.
- Making a node a second authority for delivery durability — `cloud#2689` decided
  a node is a placement target and nothing more. Postgres stays the single
  idempotency and reporting ledger; persist no delivery state on the node.
- Building a provider SDK.

## History

### 2026-08-11

- Lead passed to `daytona-lead-0811v3` after v1 and v2 both failed due to task-injection silence (brief dropped at spawn for local PTY agents — 1420-byte log files, raw banner only).
- **`cloud#2984` opened.** Three files changed:
  - `packages/web/app/api/v1/fleet/nodes/sandbox/route.ts` — new `POST /api/v1/fleet/nodes/sandbox` route that calls `provisionFleetSandboxNode()`.
  - `packages/web/lib/daytona-auth.ts` — new `createSharedDaytonaClient()` export shared across fleet routes.
  - `deploy/daytona/relay-sandbox-entrypoint.sh` — path C (`start_fleet_serve`, `truthy`) removed.
- **Design decisions recorded:**
  - `autoStopInterval: 0` — disables Daytona's idle timer for fleet nodes. Daytona auto-stop measures inactivity at the API level; relay heartbeats are outbound-only and don't reset the Daytona idle clock. Per Daytona SDK, `0` means no auto-stop. All existing call sites use 5–60 min values that would stop a healthy fleet node.
  - No relayfile mount at enrollment time — bare fleet nodes. Mount can be added post-enrollment via `startFleetSandboxRelayfileMount()`.
  - Path C confirmed dead: `agent-relay fleet serve` exits 1 at relay@v11.4.x; nohup discarded the exit code; `AGENT_RELAY_FLEET_ENROLLMENT_TOKEN` was never written; `AGENT_RELAY_FLEET_SERVE` was never set. Three closed gates in front of a broken command.
- CI queued (Smoke Sandbox Image + CI + Snapshot Impact Check). Awaiting Khaliq merge.
- **Next:** after merge, run Phase 1 proof: `POST /api/v1/fleet/nodes/sandbox` → poll roster → verify `online` + `spawn:*` → 24h liveness check with `lastHeartbeatAt` advancing. Credential availability confirmed (Daytona credentials are available on the web server; `createSharedDaytonaClient()` uses the same SST Resource path as existing cloud agents).

### 2026-08-10

- Lead handed to `daytona-lead-0810`. Acted on the previous lead's
  recommendation: **Next rewritten from a live-run plan into a design question.**
- Confirmed and sharpened the structural finding. It is **three** mechanisms,
  not two, and mechanism **C is dead on arrival** — it invokes `agent-relay
  fleet serve`, a hidden stub that `exit(1)`s at both pinned relay versions,
  under `nohup … &` so the exit code is discarded. Verified in `relay` itself
  rather than trusting cloud's comment about it.
- Corrected the `autoStopInterval` enumeration: five literals (the 08-09 handoff
  missed **30**) plus three computed sites, one with a one-minute floor. Scope
  stated with the count.
- Shared `cloud` checkout re-measured: **117** commits behind `origin/main`
  (was 115 on 08-09; `origin/main` also advanced to `639ec90c9d`). All work done
  in an isolated clone; the shared tree was not modified.

### 2026-08-13 20:19Z — relayfile#416 MERGED and being published

`081efd12ab2009b85e95027c22990ef45ec1afef`. This closes out the mount
bootstrap-stall root cause and fix (below). Note: 4 review-thread findings
from a later review round (from-scratch-bootstrap gap, weak regression test)
were being fixed in parallel by `relayfile-416-review-fix-0813` at merge
time — confirm those landed via a fresh GraphQL check before treating the
PR as fully clean, don't assume the merge alone closed them. Daytona itself
remains deprioritized as secondary tonight (sf-mini/finn-mini are primary),
so this fix is banked for whenever Daytona work resumes, not being
live-tested against the sandbox right now.

### 2026-08-13 ~10:35Z — mount bootstrap-stall bug fixed, draft PR up

`relayfile#416` (branch `fix/bootstrap-watchdog-progress-mtime`, draft, not
merged). Real root cause found and fixed for the `mount`-phase 500 discovered
earlier tonight (see 09:37Z entry above): two watchdogs stacked around the
bootstrap reconcile in `AgentWorkforce/relayfile`'s Go daemon
(`internal/mountsync/syncer.go`). The internal one
(`bootstrapProgress.touch()`) correctly sees per-file/per-page progress; the
external one (`AgentWorkforce/sandbox`'s `buildIdleWatchedCommand`, wrapping
every mount invocation) can only see the `--state-file`'s on-disk mtime,
which only updated once per fully-completed page. Against this workspace's
17,384 tracked files, a single page's downloads ran past the 60s watchdog
window while genuinely progressing — a false-positive cancel, exactly
matching the observed log. `sandbox`'s `orchestrator.ts` already had a
comment half-acknowledging this and mitigated by matching the two watchdogs'
timeout values, which only delays the same failure to a bigger page rather
than fixing the granularity mismatch.

**Fix:** `bootstrapProgress.touch()` now also does a cheap `os.Chtimes()` on
the state file every time it fires, not a full rewrite — best-effort,
no-op-safe on a fresh bootstrap. Two new tests
(`internal/mountsync/bootstrap_test.go`), both confirmed to fail pre-fix and
pass post-fix (not tautological): a direct unit test on the mtime refresh,
and an end-to-end repro seeding real persisted non-complete state and proving
the mtime advances mid-page. Full repo test suite (`go test ./...`, all 13
packages), `go vet`, `make build` (all 3 binaries), and `gofmt -l` all clean.
Worked in an isolated worktree, did not touch the shared `relayfile` checkout
or invoke the live Daytona endpoint. Waiting on Khaliq's review/merge.

### 2026-08-06

- Khaliq asked for the spec to be carried into the brain with a task to pick up
  after the YC demo. Queued, unassigned.
