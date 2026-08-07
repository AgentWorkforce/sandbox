---
status: active
owner: khaliq-chief
updated: 2026-08-07
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

**Next:** Ship the repo so the marketplace can index it, replace the
measurement-floor-bound latency claim with a hard number, then build the fleet
picker that turns broker agents into Herdr panes. Node enrollment and cloud
sandbox panes follow once the picker proves the pane model.

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

**Acceptance:** a committed result file with methodology, raw trials, clock-offset
handling, and median/p95 — quotable in a deck without a caveat. Until it exists,
the public claim stays *"sub-200ms end-to-end including measurement overhead that
exceeds the signal"*, never *"sub-100ms"*.

### T3 — Chief fleet picker

- **repo:** herdr-relay-bridge
- **cwd:** `/Users/khaliqgant/Projects/AgentWorkforce/herdr-relay-bridge`
- **depends on:** T1

Add a plugin entrypoint that lists broker agents and opens each as a Herdr pane.

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

So before placing: confirm a `relayfile-cli mount` **process** is running for the
intended workspace, confirm the path it serves matches the path the agent will
use, and confirm the outbox is draining rather than accumulating. Do not infer
liveness from the directory existing or from file count.

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
  report status rather than expect it to be inferred.
