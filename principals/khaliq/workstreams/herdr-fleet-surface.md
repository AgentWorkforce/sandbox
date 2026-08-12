---
status: retired
owner: herdr-lead-0810
updated: 2026-08-11
repos: [herdr-relay-bridge, herdr, relayfile, relay, sandbox, cloud]
---
# Herdr fleet surface

**Goal:** Herdr becomes the terminal surface for the Agent Relay stack — panes
attached to Chief subordinates locally, to agents on the mac-mini fleet nodes,
and to cloud sandbox terminals, all against a live Relayfile mount with nothing
cloned. The plugin that carries this is also the marketplace entry point into
Relay, Chief, and Cloud.

**Now:** The bridge plugin exists, is live-verified, and is staged for its own
public repository. It forwards Herdr agent status into a Relay channel and
registers a read-only `herdr.session_summary` action. Against the live Chief
workspace that action is registered next to `factory.lifecycle` and returns real
Herdr state, so Herdr already appears to Chief as a peer capability. The
attach-a-Chief-subordinate-into-a-pane path is now **proven end to end**: a Herdr
pane opened on the Chief project and running `agent-relay node agent attach`
streams the live Claude TUI, and `pane.report_agent` gives that pane a correct
Herdr agent status. Screen detection alone does not work there — see T3.

**Merge gate cleared. Verified against each repository's own state 2026-08-10 —
every artifact except T6 is merged.**

| Task | State, verified at source |
|---|---|
| T2 latency | **relayfile#405 MERGED** 2026-08-08T19:58:40Z · issue **#406 still OPEN** |
| T3 fleet picker | **herdr-relay-bridge#1 MERGED** 2026-08-07T12:41:31Z |
| T4 Herdr as placement target | **herdr-relay-bridge#2 MERGED** 2026-08-07T16:15:48Z |
| T5 cloud sandbox panes | **herdr-relay-bridge#3 MERGED** 2026-08-08T20:51:10Z — **acceptance NOT claimed**, see below |
| T6 retire fork copy | **NOT DELIVERED** — see below |
| T7 multi-host mount skill | **skills#94 MERGED** 2026-08-07T18:22:08Z as `265f50a` |

CI green on `herdr-relay-bridge` `main` at `4e9435c`, per-workflow via
`gh run list --branch main`, not a rollup.

**T5 shipped code but did not prove the capability, and said so.** PR #3 adds a
`cloud` entrypoint that warms a Daytona box in Relayfile mode and opens its
broker as a pane, reusing the T3/T4 pane model. `npm test` 65 passed / 1
Windows-only skip / exit 0. Its author explicitly declined the acceptance:
the live probe reached Cloud auth, a real box and its broker endpoint, but the
host's coding credentials were expired and **Herdr is not installed on it**, so
the visible-pane-plus-local-edit proof was never taken. That probe is what found
the missing required-mount guard — hosted Cloud marked a box ready while
`/workspace` was unavailable — fixed by **cloud#2957, MERGED 2026-08-08T19:59:26Z
and present on cloud `main`**. So the code dependency is satisfied and only the
live proof is outstanding.

**T6 is recorded as done and is not.** `plugins/agent-relay/` still exists on
`AgentWorkforce/herdr` `origin/master`. Commit `7b657a6` deletes it but sits
unpushed on local `feat/agent-relay-sdk`, which has diverged from its own remote
(6 ahead, 1 behind). Worse, **herdr#3 is OPEN against `master`** and would add
thirteen files *into that same directory* — the trusted Relay Room and Relayfile
work, replayed onto master because herdr#2 merged into the feature base instead.
Its `check-contributor` leg is FAILING. T6 and herdr#3 are contradictory
intentions on one path and only Khaliq can pick.

T1's marketplace topic remains deliberately unapplied — verified: the repo is
public, not a fork, and `repositoryTopics` is null, so it is still unlisted.
`herdr-lead` stood down 2026-08-07; a new lead took the workstream 2026-08-10.

**T2 falsified the claim it was sent to measure.** "Sub-200ms end-to-end" is
false for realistic change sets: **repo-shaped (11 files, ~14KB) median 216.7ms**
against **small-file 20.2ms**, and that is a LAN best case with the server on the
sender. It also retired the hedge that protected the claim — a 25-pair instrument
control at median 1.225ms proved the harness was never slower than the signal —
and established the root cause: receive-side materialization is **sequential per
file**, so cost scales with file count, ~19ms marginal per file at 4.5ms RTT. The
hosted topology remains **unmeasured**, and the PR makes no product claim in
either direction. Provenance found separately: the original sub-200ms figure was
a 315.5ms round-trip median **halved**, never a measurement.

**T4 proved the pane model without touching node identity.** A placement
targeting `chief-broker` + `spawn:claude` returned `surface=herdr-pane`,
confirmed in both `node agent list` and `herdr agent list`. Its worker found that
the only routes to a separate Herdr node were renaming the live `chief-broker`
or an unauthorized `cloud enroll`, and **escalated rather than renaming a
production node to make its brief work** — the destructive path was available and
would have "succeeded". Chief ruled capability-carried Herdr-ness instead. One of
its tests is named `serving never renames live node`.

**Next**, in priority order. The workstream is alive: the previous Next emptied
because the merge gate it described cleared, not because the work finished.

1. **Prove T5, or retract it.** cloud#2957 is merged, so the only thing between
   herdr-relay-bridge#3 and its acceptance is a run on a host that has Herdr
   installed and a healthy coding credential. Take the proof its author refused
   to fake: a Daytona sandbox agent visible as a drivable Herdr pane, and a file
   edited locally appearing inside the sandbox with no clone and no push. This
   Mac is the only known Herdr host. Until it is taken, T5 is code, not a
   capability.
2. **Resolve the `plugins/agent-relay/` collision on the herdr fork — Khaliq's
   call, and it blocks T6.** Either retire the directory on `master` (T6 as
   written, requiring `7b657a6` be rebased onto `master` and pushed, not left on
   a diverged feature branch), or land herdr#3 and formally retire T6 because the
   fork copy is now a *different* plugin. Do not do both, and do not push either
   until Khaliq picks. herdr#3's failing `check-contributor` leg needs an answer
   in the same decision.
3. **Re-scope T3's local-only limitation against relay#1449.** Chief reports
   cross-node attach proven live. The fleet picker was built local-only on the
   verified premise that `attach` resolves only a project-scoped local
   `connection.json`, and it *names that limitation in its own UI*. If #1449
   changed the premise, that UI text is now a lie and the picker can reach the
   minis and `barry`. Confirm the new mechanism with Chief before designing to
   it — this is Chief's workstream and must not be duplicated here.
4. **T9 is undispatched and has zero code anywhere.** Verified: no occurrence of
   `herdr-trial` or `herdr/agent/relay-bridge` on `HEAD` in relay, cloud, or
   herdr-relay-bridge. The zero-signup funnel is live with no trial ceiling and
   no attribution behind it.
5. **T1 listing** stays parked on Khaliq's call, with the description rewrite in
   the T1 section to be decided at the same time.

Not this workstream's to close: **relayfile#406** (serial receive path) is open
and belongs to relayfile; **relay#1449** is Chief's.

Two residues disclosed in PR #2 remain untracked: an inert `herdr` tag on the
live node record, cleared by the next honest re-registration, and a plugin link
pointing at a temporary worktree whose durable destination is the main checkout.

## Repository decision

One new repository is required: **`AgentWorkforce/herdr-relay-bridge`**, public.

The reason is not preference. The Herdr marketplace indexer excludes forks —
`workers/plugin-marketplace/src/index.ts:261-262` rejects any repo where
`archived` or `fork` is true, and the published docs confirm it: *"Forks and
archived repositories are excluded from the list."* `AgentWorkforce/herdr` is
`isFork: true` (parent `herdrdev/herdr`), and GitHub preserves fork lineage
through a rename, so renaming the fork cannot work. The GitHub topic
`herdr-plugin` is the only other signal and cannot override the fork exclusion.

Everything else in this workstream lands in existing repositories.

## Already done — do not redo

- Bridge plugin: status forwarding with per-pane dedupe, idempotency keys,
  rollback on delivery failure; `herdr.session_summary` action; token persistence
  and reconnect; single-instance lock with stale-PID reclaim; 0600 state and
  config enforcement; snapshot-polled subscription rebuild.
- `setup` entrypoint: creates a Relay workspace with **no account or signup**
  (verified — `AgentRelay.createWorkspace()` needs no credentials), registers the
  bridge agent under the name the bridge will reconnect as, creates the channel,
  writes 0600 config, auto-detects the workspace allowlist. Honours
  `HERDR_RELAY_WORKSPACE_KEY` to join an existing workspace instead, and
  `HERDR_RELAY_CHANNEL` to pick the channel. Refuses to overwrite an existing
  config.
- Windows entrypoint bug fixed (`file://${argv[1]}` string concat replaced with
  `pathToFileURL`); the old guard never fired on Windows or on any path needing
  URL escaping.
- Live end-to-end verified twice: an isolated throwaway workspace, and the real
  Chief workspace. 15 tests, 14 pass, 1 Windows-only skip.
- Competitive position established (see Findings).

## Dispatch

Every task states its working directory. Paths are absolute.

### T1 — Publish the plugin repository — DONE except listing

- **repo:** herdr-relay-bridge
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/herdr-relay-bridge`
- **state:** pushed at `4f0cf1f`, public, `main`, working tree clean. CI green on
  ubuntu, macos and windows — the Windows leg exercises the `pathToFileURL`
  entrypoint test that is skipped elsewhere.

**Deliberately not done:** the `herdr-plugin` topic is NOT applied, so the plugin
does not appear at herdr.dev/plugins. That topic is the only signal the indexer
uses, so a public repo without it stays unlisted. Apply it only when the listing
should go live:

```sh
gh repo edit AgentWorkforce/herdr-relay-bridge --add-topic herdr-plugin
```

Before applying it, reconsider the GitHub description — it becomes the
marketplace card subtitle and is the whole pitch on a crowded index. Current
value is *"Herdr agents as a fleet able to work as a team"*. A version that
leads with the uncontested differentiator: *"Make a Herdr session a member of
your Agent Relay workspace — status forwarding plus a queryable session_summary
action."*

**Acceptance for going live:** topic applied, and the listing appears within
~30 minutes (index refresh cadence).

**Do not** publish a claim URL anywhere in the README. There is no claim or
workspace-attach endpoint in Relay or Cloud today; inventing one is the single
easiest way to make the onboarding look broken.

### T2 — Replace the latency claim with a hard number

- **repo:** relayfile
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/relayfile`
- **hosts:** this Mac, `sf-mini`, `finn-mini` (SSH aliases, Tailscale)

The existing measurement (session `d87f25ee`, 2026-08-04) wrote a file locally
and polled the remote mount over SSH: four trials at **175–182ms**, always
caught on the first poll, against a pure SSH round-trip floor of **180–250ms**.
The harness is slower than the signal, so the true figure is unmeasured and only
bounded below ~100ms.

Re-run with **in-box timestamping** instead of SSH polling: have a process
already resident on the receiving mini watch the mount path and record the
arrival timestamp locally, with clocks compared via NTP offset rather than
assumed equal. Report median and p95 across at least 20 trials, for a small file
and for a realistic repo-sized change set.

**Acceptance — MET 2026-08-07, and the holding instruction below is RETIRED.**
The committed result file exists at
`relayfile/docs/evidence/mount-latency-20260807/` (PR relayfile#405): methodology,
raw trials, clock-offset handling with per-trial interpolation, median and p95.

**No number from it is quotable in a deck without a caveat, and that is the
finding rather than a failure of the run.** Measured: small ~300B file E2E median
**20.2ms**; repo-shaped 11 files/~14KB E2E median **216.7ms** — so cost scales
with *file count*, not bytes, because receive-side materialization is sequential
per file (relayfile#406). Both figures are a LAN best case with the server on the
sender, so only one leg crossed a network; **the hosted path remains unmeasured**
and the PR makes no product claim in either direction.

**The old holding instruction is withdrawn and must not be reinstated.** It read:
*"until it exists, the public claim stays 'sub-200ms end-to-end including
measurement overhead that exceeds the signal'."* Two things killed it. The
measurement condition was satisfied, so it stopped being a hold and became a live
directive to publish a retired hedge. And the hedge itself was **falsified** — a
25-pair instrument control returned median **1.225ms**, roughly 6% of the
small-file signal, so the harness was never slower than the signal it measured.

**Provenance, which is the durable lesson:** the original "sub-200ms" figure was
never a measurement. Someone took a 315.5ms *round-trip* median from 2026-07-26
and halved it. It reached no public surface — verified workforce-wide across
~150 repos — but the same habit put **"0ms Latency Overhead"** into the investor
deck, which did.

**Standing rule:** that wording must never appear again **as a live claim**.
Quotation inside evidence files, changelogs and post-mortems is correct and
must survive — an audit trail needs the wrong thing kept next to why it was
wrong. Positioning direction, agreed with `marketing-lead`: retire the latency
number entirely rather than replacing it with a better one. Lead on *"your agents
work on the live tree, nothing is cloned"* — a capability gap no competitor
closes with faster hardware, and one no follow-up measurement can falsify the way
one just falsified a number.

### T3 — Chief fleet picker

- **repo:** herdr-relay-bridge
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/herdr-relay-bridge`
- **depends on:** T1

Add a plugin entrypoint that lists broker agents and opens each as a Herdr pane.

**Scope limit — this picker is local-only, and that is not a shortcut.** `attach`
resolves a project-scoped *local* `connection.json`; only `fleet spawn` takes
`--node` (see T8 / relay#1449). So the picker can open panes for agents on this
machine's broker and cannot reach `herdr-lead` on `barry` or anything on the
minis. Build it for the local broker, name the limitation in its UI rather than
failing opaquely on a remote agent, and revisit once T8 lands.

Mechanism, all verified except the final attach:

- `agent-relay node agent list` returns JSON with `name`, `current_state`, `team`,
  `channels`, `runtime: "pty"`.
- The broker connection is **project-scoped** — it resolves
  `.agentworkforce/relay/connection.json` relative to cwd. Panes must therefore
  open with cwd set to the Chief project, and the plugin pane API supports a cwd
  override.
- `agent-relay node agent attach <name> --mode view|drive|passthrough` is an
  ordinary TTY-owning process, so a Herdr pane running it *is* a subordinate pane.
  **Verified 2026-08-07:** the real Claude TUI streams into the pane intact.
- **Herdr's screen detection does NOT recognise these panes, and the plugin must
  report status explicitly.** Herdr sees the pane's foreground process as
  `agent-relay`, not `claude`, so it never classifies the pane as hosting an agent
  and the manifest rules never run — the pane reads `agent_status: unknown` and is
  absent from `herdr agent list`, even though the detection buffer contains the
  Claude prompt box verbatim.

  The fix is `pane.report_agent`, verified working on a live attach pane:

  ```json
  {"method":"pane.report_agent","params":{"pane_id":"w5:p1","source":"fleet-picker",
   "agent":"claude","state":"idle"}}
  ```

  After that call the pane reports `agent_status: idle` and appears in
  `herdr agent list`. So the picker should read authoritative state from
  `agent-relay node agent list` (`current_state`) and project it onto each pane,
  rather than relying on screen detection. This is the better design anyway —
  broker state is authoritative where screen-scraping is inference.

  Mind the enum mismatch: `PaneAgentState` accepts `idle|working|blocked|unknown`
  (no `done`), so map broker states accordingly.

Prefer `sh <chief>/scripts/chief.sh` for the resident Chief specifically: it
`cd`s to its own repo, starts the broker via launchd, spawns the agent if
missing, then execs attach. With no `voice` agent in `teams.json` it targets the
chief-of-staff in `drive` mode; `brain` as the first argument reaches the
resident Chief directly.

**Acceptance:** one command opens a Herdr workspace with one pane per live broker
agent, each attached and each carrying a reported agent status that tracks the
broker's `current_state`. Include the failure path — broker down must produce a
readable message, not the raw `could not locate broker connection`.

**Status polling:** the broker is the source of truth, so the picker needs a loop
that re-reads `agent-relay node agent list` and re-reports changed states. Keep
the cadence modest; `pane.report_agent` is cheap but every reported change becomes
a Relay message via the bridge.

**Note:** the launchd service `com.agentworkforce.chief.node` was not installed
when this was written, so `chief.sh` could not start the broker itself. If that
recurs, run `npm run install:services` in
`/Users/khaliqgant/Projects/AgentWorkforce/chief`, or `agent-relay node up` from
that directory.

### T4 — Herdr as an enrolled fleet node

- **repos:** herdr-relay-bridge, relay
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/herdr-relay-bridge`, then
  `/Users/khaliqgant/Projects/AgentWorkforce/relay`
- **depends on:** T3

Relay already has the placement primitive — `placement.spawn({ capability, node,
repo, ttlMs, failFast })`, `nodes.list/get`, `workspace.fleetNodes.get/set`. The
minis already enrol and advertise `spawn:claude`, `spawn:codex`, `spawn:gemini`,
`spawn:opencode`, `release`, `relay:delivery-cursor-v1`.

Register the Herdr host as a node whose capability is *spawn an agent as a Herdr
pane*, and accept placements by creating a pane and starting the agent in it.
Dispatch then flows both ways: Chief or Cloud places work and it materialises as
a local pane; work dispatched from Herdr runs on a mini or in Cloud.

**Precondition — verify the target node's mount is the live one.** A stale mount
directory is indistinguishable from a live one by inspection, and an agent placed
against it works on an old tree while appearing healthy. Observed on sf-mini
2026-08-07: `~/relay-dev-collab-mount` has 38 entries, no `.git`, and looks
mounted — but it is workspace `relay-dev-collab` in `mode: poll` with **8 outbox
writes stuck since 2026-08-05**. The live mount is a different path entirely,
`~/relayfile-dev-collab`, served by a running `relayfile-cli mount` process.
finn-mini had no mount directory at all, only a leftover log.

**A running process is not proof either** — corrected 2026-08-07 against the
`multi-host-live-mount` skill (PR skills#94), which measured a daemon up 3h06m,
`lag: 0s`, `pending: 0`, and all four `state.json` files rewritten within four
minutes, while the newest content was 1h31m old and `digests/today.md` was two
days stale. Every process- and state-file signal measures the daemon's own
activity, not the freshness of the bytes it serves.

So before placing, run that skill's content-level assertion
(`assert-mirror-current.sh`), which compares mounted content against current
cloud revisions. Confirm separately that the path being asserted is the path the
agent will actually use — on sf-mini two mount directories exist and the dead one
is the one carrying `.relay/state.json`.

**Acceptance:** `agent-relay node agent list` from the Chief project shows a
Herdr-hosted agent, and a `placement.spawn` targeting the Herdr node produces a
visible pane running that agent, in a verified-live mount.

**Note:** no node in the fleet currently advertises `workflow:run` (0 of 397 node
records as of 2026-08-07). Do not assume that capability exists.

### T5 — Cloud sandbox panes

- **repos:** cloud, herdr-relay-bridge
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/cloud`
- **depends on:** T4

`cloud/ARCHITECTURE.md:136` already describes a broker inside the sandbox for
real-time terminal streaming with the client connecting directly. Attach that
stream as a Herdr pane so a cloud agent is driven exactly like a local one, in a
Relayfile-mounted tree with nothing cloned.

**Acceptance:** a Daytona sandbox agent appears as a Herdr pane, is drivable, and
its working tree is the live mount — verified by editing a file locally and
seeing it inside the sandbox without a clone or push.

### T6 — Retire the duplicate copy in the herdr fork

- **repo:** herdr (the fork)
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/herdr`
- **branch:** `feat/agent-relay-sdk`

The plugin originally lived at `plugins/agent-relay/` inside the fork, with its
own CI workflow at `.github/workflows/agent-relay-plugin.yml`. That copy is now
superseded by the standalone repository and will drift. The working tree also
carries two uncommitted files — the `pathToFileURL` entrypoint fix and its test —
which are already in the standalone repo and verified green on all three OS legs.

Delete `plugins/agent-relay/` and `.github/workflows/agent-relay-plugin.yml` from
the fork, discarding the uncommitted changes rather than committing them.

**Acceptance:** the fork contains no copy of the plugin, and
`AgentWorkforce/herdr-relay-bridge` is the only source.

**Do not** open a PR against upstream `herdrdev/herdr` for any of this. Per the
repository's contributor guardrail, the acting account is not the maintainer, so
agents must not open issues or PRs there.

### T8 — Cross-node attach (filed, unowned, sequenced after T4)

- **repo:** relay (possibly cloud — see the issue)
- **issue:** relay#1449
- **depends on:** T4

**Do not assume T4 delivers this. It does not.** T4 makes the Herdr host a
*placement target* — work dispatched to it materialises as a pane. Khaliq asked
the reverse question on 2026-08-07: can I attach, from my laptop, to
`herdr-lead` already running on `barry`? The answer today is no, and nothing in
this workstream or in relay is building it.

Verified rather than assumed: `attach` lives in
`packages/cli/src/cli/commands/local-agent.ts`, resolves through
`resolveBrokerConnection` → a project-scoped local `connection.json`, and its
`--broker-url`/`--api-key`/`--state-dir` overrides all mean "a different *local*
connection file". Only `fleet spawn` takes `--node`. No relay branch or commit
has touched attach in the last week.

The consequence is a supervision hole: every off-machine appointment can be
dispatched but not watched, and the org chart correctly greys out Drive for
every remote row (`tools/orgchart/serve.mjs` separates presence from local
attachability on purpose).

The transport already exists — `cloud/ARCHITECTURE.md:136` streams a sandbox's
terminal with the client connecting directly, which is what T5 builds on. This
is that mechanism aimed at a fleet node.

### T7 — Document relayfile-on-a-fleet-node (the missing skill) — DEFERRED to T5

- **repo:** skills
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/skills`
- **status:** deferred. The minis are already mounted, so T4 does not need this
  written first. Revisit when T5 brings cloud sandboxes in, where mounts are
  created per run rather than standing. The T4 precondition below is the cheap
  substitute in the meantime.

Two skills exist and neither covers the thing T4 and T5 depend on:

- `skills/orchestrating-agent-relay/SKILL.md` (688 lines) covers fleet and
  placement properly — `fleet enable`, `node up`, `fleet nodes --all`,
  `fleet spawn --node`, enrolling a machine, `--state-dir` broker gotchas, and a
  placement proof that insists you spawn from a *different* host. It contains
  **zero** mentions of relayfile. It never says what filesystem a placed agent
  works in.
- `skills/setting-up-relayfile/SKILL.md` (466 lines) covers mounts, writeback,
  provider path conventions, and recovery — but single-host, and oriented at SaaS
  providers. Its "Pattern B: remote agent" is SDK access with **no disk mirror**,
  not a mounted tree on a remote machine.

So the composed capability — *place an agent on sf-mini and have it work in a
live-mounted tree with nothing cloned* — is documented nowhere, even though it
was proven on 2026-08-04. The artifact that described it,
`relayfile-sync-setup-prompt.md`, was session scratch and no longer exists.

Write it: mounting one workspace on multiple hosts, what the placed agent sees,
how repo content differs from provider surfaces, credential and scope handling
per node, and how to verify a remote mount is live rather than stale. The
verification matters most — a supervisor pid alive against a stopped mount
already caused a four-day-old projection to read as current (see
`chief-onboarding.md`, 2026-08-04).

**Acceptance:** an agent given only this skill can take a fresh machine to
"placed agent working in a live-mounted tree, nothing cloned", and can prove the
mount is current rather than assume it.

### T9 — Herdr-origin usage tagging, a lower trial ceiling, and the conversion moment

- **repos:** relay, cloud, herdr-relay-bridge
- **recipe:** `agent:team` — three repos, one contract between them
- **cwds:** `/Users/khaliqgant/Projects/AgentWorkforce/relay`,
  `/Users/khaliqgant/Projects/AgentWorkforce/cloud`,
  `/Users/khaliqgant/Projects/AgentWorkforce/herdr-relay-bridge`

`setup` creates a Relay workspace with no account, key or signup. That is the
funnel and it is deliberate, but it also means anonymous, unattributed users on
the standard free tier. This task tags them, gives them a much lower ceiling than
raw Relay usage, and turns hitting it into a registration prompt.

**Tagging is already possible — do not invent a field.** `origin_actor` is a path
`{app}/{type}[/{name}]` carried by `RelaycastTelemetryOptions`.
`AgentRelayCreateWorkspaceInput` extends that interface, so the plugin can set it
at workspace creation and on the client. Cloud already splits it into analytics
dimensions in `packages/relaycast/src/lib/telemetry.ts:40`
(`deriveOriginActorProps`). Use `herdr/agent/relay-bridge`.

**The lower ceiling should be a plan tier, not an origin branch.** Entitlements
resolve by table lookup on the workspace's plan
(`cloud/packages/relaycast/src/adapters/cloudflare/entitlements.ts`):

```ts
const plan = workspace.plan || 'free';
return PLAN_LIMITS[plan] ?? PLAN_LIMITS['free'];
```

So adding `PLAN_LIMITS['herdr-trial']` with a much lower `api_calls` and
persisting `plan: 'herdr-trial'` at creation needs **zero change to `getLimits`**.
Registration then just moves the workspace to a higher tier. The alternative —
persisting `origin_actor` on the workspace and branching inside `getLimits` —
mixes telemetry into billing and should be rejected.

For scale: `PLAN_LIMITS.free.api_calls` is currently `100_000`
(`@relaycast/engine`, `packages/engine/src/providers/static-entitlements.ts:8`,
published v5.0.5). At roughly one call per forwarded status that is far beyond a
trial, which is the whole reason a separate tier is worth having. Pick the
`herdr-trial` number for conversion, not for cost.

**The stopgap must be server-side; only the nudge may be client-side.**
`dist/bridge.mjs` is plain JavaScript on the user's disk — any counter in it is a
suggestion anyone can delete. The tier is the enforcement; the plugin's job is
only to make the moment legible.

Work, in dependency order:

1. **relay** — add the `herdr-trial` tier to `PLAN_LIMITS`. This is a published
   package (`@relaycast/engine`), so it needs a release, not just an edit; plan
   the version bump and cloud's dependency update together.
2. **cloud** — persist `plan: 'herdr-trial'` when a workspace is created carrying
   the herdr origin. Note `CLOUD_DEFAULT_PLAN = 'free'` and that
   `entitlements.test.ts:56` asserts unrecognised plans fall back to free — so an
   unreleased or misspelled tier fails **open**, silently granting the full free
   ceiling. Add a test that the tier resolves to its own limits, not the fallback.
3. **herdr-relay-bridge** — pass `originActor: 'herdr/agent/relay-bridge'` at
   `createWorkspace` and on the client; detect the plan-limit error specifically
   and print the registration path; emit one non-repeating nudge before the
   ceiling, reading remaining quota from the limit response rather than counting
   locally, so one number governs both and they cannot drift.

The bridge currently reports every delivery failure as
`could not forward a Herdr status update`. Left alone, hitting the ceiling reads
as a broken plugin rather than an invitation — fixing that is the point of the
task, not a detail.

**Nudge copy:** one line, once, in the pane. Include the registration path and a
star ask for `AgentWorkforce/relay` — the SDK repo, not the plugin repo, since
that is the product the funnel exists for. A nudge that repeats is the fastest
route to an uninstall and a public marketplace complaint.

**Acceptance:** a workspace created by `setup` is attributable as herdr-origin in
analytics; it resolves `herdr-trial` limits rather than free; the ceiling is
enforced server-side and survives editing `dist/bridge.mjs`; and reaching it
produces a readable registration prompt in the pane.

## Findings that set the strategy

**Do not integrate with AgentBox or Crabbox. Both were considered and rejected on
evidence.**

- **Crabbox** (1270★, largest plugin in the marketplace) is a remote *command*
  control plane — `crabbox run -- pnpm test`, lease a runner, sync, run, stream
  evidence, release. It self-identifies as `remote-test-runner` and lists AI
  agents as its *customers*. Not a competitor; a possible consumer.
- **AgentBox** (336★, and it already ships a Herdr integration) is the real
  overlap and the one to watch. Its sync splits: locally `git worktree add` +
  `mount --bind` with host stash and untracked replayed — excellent, near-free,
  and worth stealing for `sandbox/src/local/runtime.ts`. Remotely it is an in-box
  **`git clone`** (`AGENTBOX_CLONE_URL` / `_BRANCH` / `_DEPTH`), which their own
  source documents as a "Deliberate non-unification" because the bind-mount path
  has no cloud analog. Remote therefore drops uncommitted work, requires a
  reachable authed remote, scales with history, and covers git-tracked files only.

Relayfile mounts the live tree — same daemon local and remote, path-scoped
`relay_pa_*` token, and it carries `/linear`, `/github`, `/notion`, `/slack`, not
just the repo. Partnering would replace a ~175ms live mount with a git clone on
exactly the surface where we are strongest.

**We already own both layers.** `sandbox` has working local, Daytona and E2B
adapters behind one port (`launch`, `uploadBundle`, `runScript`, `destroy`).
`cloud` runs Daytona sandboxes with SSH creds, an orchestrator sandbox,
`fleet-node-bootstrap`, and in-sandbox terminal streaming. The gap is not a
sandbox provider — it is a terminal surface, which is this workstream.

**Marketplace position.** 521 repos carry the `herdr-plugin` topic. Status
notification is the most saturated category — 25+ competitors including `collie`
(271★), `herdr-remote` (191★), `herdr-hail`, and several ntfy/Telegram bridges —
so the bridge must never be pitched as a notifier. Uncontested ground is the
team layer: named agents that message each other, a registry of callable actions,
and a Chief that dispatches and queries. Nothing in the 521 has it.

## History

- 2026-08-11 — **Retired.** Status corrected from `active` to `retired` — the
  frontmatter was stale; herdr was actually retired in a prior session
  (`91a8a17 docs(brain): herdr retired`), before tonight's run started. Caught
  during a full workstream status sweep at Khaliq's request.

- 2026-08-10 — **State audit after the lead went silent; workstream confirmed
  alive.** Every artifact re-verified against its own repository rather than
  against this file, because a change-detector cannot see termination. Findings
  that contradicted the record: T5 had *shipped* (bridge#3, merged 2026-08-08)
  while this file still called it undispatched, and T6 was recorded delivered
  while `plugins/agent-relay/` is still on the fork's `master` with the deletion
  commit unpushed on a diverged branch. Both corrected above.

  **A literal-string grep nearly produced a false regression report.** Chief
  asked that three rules from skills#94 survive. Grepping merged `main` for
  `followlinks` returns nothing, which reads as the symlink fix having been lost
  — it was not. The merged assertion abandoned `os.walk` entirely for a manual
  `scandir` walk with explicit `follow_symlinks=True` on both the dir and file
  legs, and it fails closed on cycles and read errors, which is stronger than
  what the rule asked for. All three rules are present and correct in `265f50a`:
  symlink-following coverage, projection mode (`full|on-demand`) validated
  *before* the freshness assertion, and `(workspace, mirror root)` as the
  identity unit. Grep the concept, not the string.

- 2026-08-07 — **PR #2 merged on Khaliq's gate** — squash `fd143a3a`, 16:15:48Z.
  The Herdr host now serves as a fleet node. Twelve review threads, including two
  that landed mid-work, all answered; zero unresolved at merge; `Test` green on
  ubuntu, macos and windows, verified per platform rather than from the rollup,
  and re-verified against `git ls-remote` immediately before merging with
  `--match-head-commit`. Two things the lane got right and worth keeping: the
  privacy audit went wider than the one flagged evidence file, catching host and
  workspace identifiers and live-looking key prefixes across docs and fixtures —
  a merged commit is permanent, so the wider pass was the only correct scope; and
  it *rejected* strict cross-client session attribution as unimplementable
  (`node agent new` exposes no placement identity either way) and documented the
  out-of-band limitation rather than faking the guarantee.


- 2026-08-07 — Bridge plugin built and live-verified end to end, twice. Against
  an isolated workspace: setup created workspace, channel and 0600 config with no
  signup; the bridge reconnected on setup's token leaving exactly one agent in the
  roster; two driven status transitions arrived in the channel; the action
  returned schema-valid Herdr state. Against the live Chief workspace:
  `herdr.session_summary` registered next to `factory.lifecycle` and returned real
  data, making Herdr a peer capability to Factory. Fixed a Windows entrypoint bug
  that would have made the pane exit silently on every Windows install. Rejected
  AgentBox and Crabbox integration after reading their source. Established that
  the marketplace excludes forks, so the plugin needs its own repository.
  Proved the attach-into-a-pane path against live Chief subordinates, and
  disproved the assumption behind it: Herdr's screen detection does not classify
  an attach pane, because the foreground process is `agent-relay` rather than the
  agent binary. `pane.report_agent` is the mechanism instead, verified live. The
  lesson generalises — a Herdr pane hosting an agent *through a wrapper* is
  invisible to detection, so any future surface that wraps an agent process must
  report status rather than expect it to be inferred. Established that the
  zero-signup onboarding needs a matching trial ceiling (T8): anonymous
  workspaces are already bounded by the free tier's 100k api_calls, but that is a
  cost ceiling, not a conversion moment, and the unattributed-user problem it
  leaves is the one worth solving.
