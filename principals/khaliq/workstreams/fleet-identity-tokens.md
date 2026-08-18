---
status: active
owner: relaycast-311-identity-0818
reports_to: chief
updated: 2026-08-18
repos: [relaycast, relay]
---
# Fleet identity and token eviction

Goal: an agent's identity survives its session, and a name collision cannot
silently evict a live holder.

## Now — 2026-08-18 — one `token_hash` per agent row is the defect

**relaycast stores exactly one token per agent** —
`packages/engine/src/db/schema.ts:63`, `tokenHash: text('token_hash').notNull().unique()`
— and authentication is a lookup on that column. So **any** re-registration
under a name overwrites the hash and instantly invalidates whoever held the
previous one. No grace window, no second slot, no versioning.

**Four SDK registration methods disagree about what a collision means**
(`packages/sdk-typescript/src/relay.ts`):

| call | on collision | outcome |
|---|---|---|
| `agents.register` | throws `agent_already_exists` | incumbent untouched — correct |
| `registerAgent({strict:true})` `:473` | delegates to the above | correct |
| `registerAgent({strict:false})` `:482` | retries `name-<suffix>`, ≤5 | a near-duplicate agent |
| `registerOrRotate` `:485` | `agents.get` then `agents.rotateToken` | **hands over the incumbent's id and evicts its token** |

`registerOrRotate` **verifies nothing**. The name string alone takes over any
agent record in the workspace. Callers choose between these by method name, with
nothing signalling that the choice is a security decision.

Issues: **relaycast#311** (the design defect, open 2026-08-07, alongside #309 and
#310) and **relay#1333** (the symptom report, open 2026-07-18, trigger
unattributed for 4 of 5 cases). **relay#1546 shipped a broker-side guard in
v11.7.1 and does not cover this** — we run the newest client against an unfixed
server design.

### What it cost on 2026-08-18

- `relaycast-usage-attribution-0818` died with `agent_token_invalid`, could
  neither send nor receive, and left PR #339 untouched for seven hours.
- **sf-mini accepted every spawn and confirmed none** —
  `Last read error: Invalid agent token` — while reporting `RUNNING`,
  `CONNECTED`, `online/live=True` and advertising all four `spawn:*`
  capabilities. **A node can register and hold a websocket while unable to
  complete an authenticated read**, so every health signal was green. Two config
  hypotheses (`--no-spawn`, an inert `--config` provider) were investigated and
  disproven first; the error text was one dispatch away the whole time.
- **Chief's own token died five times in twenty minutes**, each recovery a
  `register_agent` call which — if it routes to `registerOrRotate` — is itself an
  eviction, possibly looping against another caller.
- `attach` and `release` both time out through the CLI; releases must go through
  the broker's HTTP `DELETE /api/spawned/<name>`.

### Next

1. **Khaliq's decision, and it gates everything: is a name collision recovery or
   an attack?** The server says recovery, the CLI says attack. Until that is
   settled any patch picks a side silently. Note relay#1570 — every agent's token
   is readable in `ps` — so "recovery on the name alone" currently means anyone
   who can read a process list can take any identity.
2. `relaycast-311-identity-0818` is scoped to a **written proposal on #311, then
   stop**. No auth change ships without Khaliq: this touches authentication for
   every agent in the workspace, and a wrong move locks out the fleet rather than
   one lane.
3. Establish whether the MCP `register_agent` tool routes to `registerOrRotate`.
   That single fact decides whether recovery and attack are the same code path.
4. Any proposal must state what it does to a **legitimate** recovery after a
   crash. A fix that only considers the attacker locks out honest callers — that
   failure mode bit us twice on 2026-08-18.

## History

- **2026-08-18** — root cause named and workstream opened. sf-mini left
  unusable pending a reissued node token; Chief re-registered five times,
  verifying each time that the name came back as `chief` rather than rebinding to
  a successor, which would forfeit Chief's address under CLAUDE.md §7.
