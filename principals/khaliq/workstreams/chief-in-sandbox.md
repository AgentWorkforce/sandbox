---
status: active
owner: unassigned
reports_to: chief
updated: 2026-08-14
repos: [chief, relay, cloud, sandbox]
---

Goal: Chief runs as an agent in a long-lived cloud sandbox, rotating its own
session every two hours under the same canonical name, attachable by Khaliq and
Will from any machine.

## The architecture, decided by Khaliq 2026-08-14

**A long-lived sandbox, a short-lived session.** The sandbox persists; Chief
hands off and respawns roughly every two hours to stay context-fresh, and
**keeps the name `chief` across every rotation**. This resolves the tension
between Khaliq's fresh-sandbox-per-agent correction in
[[daytona-fleet-nodes]] and a resident Chief: freshness is bought by cycling
the *session*, not the box.

It is consistent with `CLAUDE.md` §7 as written — a handoff replaces a session,
never Chief's address, and it is complete only when a process is running under
the exact `teams.json` name and has answered a liveness probe through that
identity. What changes is the cadence: what was an occasional manual event
becomes a scheduled loop running ~12 times a day.

**That cadence is what makes the current token defect a blocker rather than a
nuisance.** The rotation is a name-reacquisition loop, and name reacquisition
is exactly what broke this morning: the token for the record named `chief` was
invalidated while its session was still live, and three fallback records
(`chief-sf-mini`, `chief-sfm-v2`, `chief-sfm-final`) were created in a
three-minute window at 06:01–06:03Z — the signature of a reacquisition attempt
failing and retreating to new names. Twelve rotations a day against a broken
reclaim path produces twelve burned names a day. `chief-token-rootcause-0814`
(finn-mini) is therefore on this workstream's critical path, not off to one
side.

The mechanism is already partly located: restart-reclaim lives in
`crates/broker/src/relaycast/auth.rs` in `relay`; `relay#1499`
(`fix/legacy-identity-reclaim-0813`, draft) is operator recovery for pre-gate
identity records; and per [[active-lanes]] there is an **unowned, uncommitted
fix** to that same file on sf-mini at
`~/Projects/AgentWorkforce/relay/ws-unknown-fix` (branch
`agent/fix-broker-node-workspace`) covering workspace-id resolution on token
rotation during restart-reclaim, with no PR and no owner. That worktree must
get an owner before anything resets it.

**Requirements the loop has to satisfy, each with a reason:**

- **Make before break.** Do not tear down the outgoing session until the
  incoming one has answered a liveness probe *through the canonical name*. §7's
  fail-safe is explicit: if the name cannot be reacquired, keep the existing
  resident online and page Khaliq. Degrading to a stale-but-live Chief is
  correct; degrading to no Chief is not.
- **One brain writer at a time.** The overlap window puts two Chiefs briefly
  alive, which is the exact condition §7 forbids for brain writes. The handover
  needs a defined instant where write authority transfers, not a polite
  convention.
- **Flush before handing off.** Continuity across rotation is carried by the
  brain, so an un-committed durable fact is a fact lost every two hours. The
  outgoing session commits before it stands down.
- **Rotate the agent, never the node.** Restarting a fleet node kills every
  agent on it, because spawned agents are children of the node broker. A Chief
  rotation must not touch the broker, or it takes every delegate lane with it
  twelve times a day.
- **Do not drop in-flight DMs.** Messages arriving during the swap must land
  with the incoming session, not into the gap.

**Prior art to assemble from rather than invent** — `workforce` already ships
the proactive persona runtime, where a persona plus `defineAgent({ schedules,
triggers, onEvent })` deploys **the same artifact local or cloud**. A two-hour
rotation is a schedule. Check it, and `relayflows`, before building a bespoke
rotator (see [[agent-lifecycle-workflows]]).

## Now

Architecture decided (above), nothing built. This is priority 3 of Khaliq's
stated four (2026-08-14) and had no workstream until today; it existed only in
conversation. Nothing has been dispatched or proven.

Chief today runs on `chief-broker` — Khaliq's MacBook (`Khaliqs-MBP.home`) —
as a PTY agent under the local broker, with the brain on that machine's disk.
Every dependency below is a real blocker, not a formality.

**Depends on, in order:**

1. `daytona-fleet-nodes` — a sandbox node that survives long enough to host a
   resident. Khaliq's 2026-08-13 correction (fresh sandbox per agent, not one
   reused box) is the model this must be designed against, and that model has
   not been implemented yet. A per-agent-ephemeral sandbox and a long-lived
   resident Chief are in obvious tension; whoever picks this up must resolve
   that tension explicitly rather than assume one of the two.
2. `cross-node-attach` — attach works to fleet-node agents, but only ever
   proven with Khaliq's own credentials. Will attaching is the acceptance
   proof there, and it is the same mechanism this workstream needs.

**Constraints already known from expensive experience — do not rediscover:**

- **Fleet enrollment is browser-session-only.** No CLI and no agent can enroll
  a node; the failure surfaces as a 403 that falsely blames org role. This has
  already killed two overnight agents. A sandbox Chief cannot self-enroll its
  own node; a human has to.
- **Restarting a fleet node kills every agent on it** — spawned agents are
  children of the node broker. A Chief that lives on a shared node dies with
  every unrelated restart.
- The Daytona sandbox measured a hard **2GB memory ceiling** while `free -h`
  reported the host's ~377GB. Size the Chief harness against 2GB, not against
  what the sandbox claims.
- **The brain is a git repo, and only one writer may hold it.** The resident
  body rule in `CLAUDE.md` §7 exists because two writers corrupt continuity. A
  sandbox Chief needs a defined answer for where `principals/khaliq/` lives,
  who commits, and how a local maintenance shell is prevented from writing at
  the same time.
- `teams.json` and `factory.config.json` are **per-machine copies** of the
  committed `*.khaliq.*` files. A sandbox Chief needs its own resolved copies,
  not the laptop's.
- **A handoff replaces a session, never the Chief's address.** Moving Chief to
  a sandbox is a handoff: it is complete only when a process is running under
  the exact `teams.json` name and has answered a liveness probe through that
  identity. A renamed successor is not continuity.

## Next

1. **Unblock name reacquisition.** `chief-token-rootcause-0814` must answer
   whether a new process can take over the canonical name `chief` without
   burning it, and if not, what has to be built. Nothing else here can proceed
   on a broken reclaim path. Give the orphaned `ws-unknown-fix` worktree an
   owner in the same pass.
2. Decide where the brain lives and who commits it when Chief is remote, and
   what marks the instant write authority transfers between rotations.
3. Check `workforce`'s scheduled-persona runtime for whether the rotation loop
   already exists before writing one.
4. Only then dispatch an implementation lane.

## History

### 2026-08-14 — architecture decided: long-lived sandbox, two-hour session rotation

Khaliq: Chief lives in a long-lived sandbox but hands off and respawns every
two hours to stay fresh, keeping the same name. Recorded above with the
requirements that follow from it. The consequence worth naming: this converts
the open token defect from an incident into a critical-path blocker, because
the rotation *is* a name-reacquisition loop and reacquisition is what is
currently broken.

### 2026-08-14 — workstream opened

Khaliq named this priority 3 of four in conversation with Chief. Confirmed by
survey that no workstream, owner, or Next existed for it anywhere in the brain.
Opened with the dependency chain and the known constraints so the next owner
starts from what is already known rather than from zero.
