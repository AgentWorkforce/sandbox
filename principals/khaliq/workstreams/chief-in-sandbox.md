---
status: active
owner: unassigned
reports_to: chief
updated: 2026-08-14
repos: [chief, relay, cloud, sandbox]
---

Goal: Chief runs as an agent on a cloud sandbox node rather than on Khaliq's
laptop, and Khaliq and Will can both attach to it from any machine.

## Now

Not started. This is priority 3 of Khaliq's stated four (2026-08-14) and had no
workstream until today; it existed only in conversation. Nothing has been
built, dispatched, or proven. It is stated here so it stops being invisible.

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

1. Decide the hosting model against Khaliq's fresh-sandbox-per-agent
   correction: is Chief the one exception that gets a persistent node, or does
   Chief become resumable enough to be re-created per session? Write the answer
   down before any implementation — this choice determines everything else.
2. Decide where the brain lives and who writes it when Chief is remote.
3. Only then dispatch an implementation lane.

## History

### 2026-08-14 — workstream opened

Khaliq named this priority 3 of four in conversation with Chief. Confirmed by
survey that no workstream, owner, or Next existed for it anywhere in the brain.
Opened with the dependency chain and the known constraints so the next owner
starts from what is already known rather than from zero.
