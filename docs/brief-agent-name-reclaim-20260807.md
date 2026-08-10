# Brief for Chief — agent-name reclaim after the 11.4.2 admission gate

You are picking this up from a maintenance shell that diagnosed and restored the
node on 2026-08-07. It did not write the brain (§7 — you were online). Every
claim below was verified against the running system or the source on `main`, not
inferred. Do not re-derive it; verify only what you intend to act on.

## What happened

The node was down 09:26Z–09:47Z. Three stacked faults, only the first known:

1. `launchctl bootout` ran without `bootstrap` — the session doing it was running
   under the broker it killed. Second occurrence that day.
2. `node up`'s spawn path defaults `binaryPath` to `process.env.AGENT_RELAY_BIN`,
   which on this host pointed at the **CLI**. 11.x moved `init` into
   `agent-relay-broker`, so the broker died with `unknown command 'init'`.
   The `BROKER_BINARY_PATH` pin could never have worked: only `g5R()` reads that
   var, and the spawn path never calls it. Verified with and without the pin —
   byte-identical failure.
3. With the broker finally starting, the v11.4.2 admission gate (`5c2ad8ee3`,
   relay#1438, merged 2026-08-06) refused to return the name `chief`.

## Current runtime state — record this, it changed

- Node runs as **`chief-broker`** (agent id `211418990402400256`). The name
  `chief` is unrecoverable without a server-side fix.
- **Node id `node_5b46ac5e9f427fcedc07f77f95f642eb` is unchanged**; 61 agents
  still attributed. `--node chief` targeting anywhere must be updated.
- **`chief-khaliq` kept id `210283808172122112`** and `marketing-lead` kept
  `210364195033862144`. Nothing orphaned.
- launchd now runs `~/.agentworkforce/relay/bin/chief-node-supervisor.sh`, which
  traps SIGTERM and runs `agent-relay node down` before exiting. Without it,
  every `bootout` burns another name. The plist also has real log paths now
  (`.agentworkforce/relay/node-launchd.{out,err}.log`); it was `/dev/null`, which
  is why the outage was invisible for two hours.

## The finding that matters

**The gate is correct and must not be weakened.** It works: verified by clean
stop → same-name restart reclaim on both `chief-broker` and a throwaway probe.
A *clean* `node down` releases a name; SIGTERM flushes state but never
deregisters, which is what stranded `chief`.

Its one defect is that it has **no backfill**:

```rust
// crates/broker/src/relaycast/auth.rs — admit_agent_registration
let reclaims_same_work_unit = matches!(
    (identity_key, existing_identity),
    (Some(ours), Some(theirs)) if hash_identity_key(ours) == theirs
);
```

Pre-#1438 records carry no stamped `identity_key`, so `existing_identity` is
`None` and the arm is **unsatisfiable for every possible caller key**. No
`RELAY_AGENT_IDENTITY_KEY` value can recover `chief`. Confirmed empirically:

| agent | created | `identityKey` |
|---|---|---|
| `chief` | 2026-07-30 | none (metadata empty) |
| `chief-khaliq` | 2026-08-04 | none |
| `chief-broker` | 2026-08-07 | present |
| `restart-probe-0807` | 2026-08-07 | present |

The reclaim key is **not** an unpersisted secret — `stable_node_identity_key()`
derives it deterministically from the broker's state-directory path. Don't hunt
for the right key; there isn't one.

## Deliverable 1 — write the workstream

Create `workstreams/agent-name-reclaim.md` in the active brain: Goal, truthful
Now and Next, dated History. Also fold the runtime-state changes above into the
daily. Today's daily still carries a stale claim that `chief-khaliq` is "one
SIGKILL from the same fate" — **that is not supported**: it has no `identityKey`
either, was killed uncleanly at 09:26Z, and reclaimed its id twice (09:43Z,
09:47Z). Correct it.

## Deliverable 2 — dispatch three fixes. Do not implement them yourself.

File as issues in the **owning GitHub repo**, not Linear, and omit the readiness
label so filing does not auto-dispatch.

**A. relaycast — free a name without destroying history.** `deleteAgent`
(`packages/engine/src/engine/agent.ts:278`) issues a bare delete. Four FKs to
`agents.id` are bare `.references(() => agents.id)`, i.e. RESTRICT:
`channels.created_by` (`schema.ts:455`), `messages` sender (`:503`), `files`
(`:666`), `webhooks.created_by` (`:759`). Any agent that has ever spoken cannot
be removed — the escape hatch fails exactly when needed. **Do not fix with
`onDelete: 'cascade'`**; that deletes every message the agent sent. The unique
constraint is `(workspace_id, name)`, so rename to a tombstone
(`chief#released-<ts>`) and mark inactive: the name frees, FKs stay intact, no
schema migration. Smallest change, highest value — this alone makes the outage a
10-second recovery, and it is the only path to recovering `chief`.

**B. relay — close #1438's migration gap.** In `admit_agent_registration`, when
`existing_identity` is `None` and the incumbent is provably not live, adopt and
stamp the hash, converting legacy records to the protected form on first honest
restart. **Trap: do not gate on the `status` column.** `sweepStaleAgents` only
flips it after a threshold, so a freshly-killed agent still reads `active`. Use
`lastSeen` age plus absence of a live node connection. This touches the security
boundary #1438 just established — getting it wrong reopens AR-448, so it needs
the most review of the three.

**C. relay — the resolution bug.** Make the spawn path resolve through `g5R()`
rather than trusting `AGENT_RELAY_BIN`, or at minimum validate the resolved
binary before spawn and name the variable in the error. Open PR relay#1425
already touches `broker-lifecycle.ts` and is the natural home. This one will hit
every host upgraded from 10.x, not just this laptop.

**Watch item, not a fix:** open PR relay#1436 makes `register_agent` write
caller-supplied `metadata` through instead of discarding it. It predates the
gate. If it lands as-is, a workspace-key holder may be able to write
`identity_key` onto another agent's record and reclaim it — defeating #1438
entirely. Check the two against each other before either merges. Flag to Khaliq
if #1436 approaches merge first.

## Sequencing

A and C are independent and unblock recovery and recurrence respectively. B
deserves the most review. A is the prerequisite for ever getting `chief` back.

## Definition of done

Three issues filed in the owning repos with the evidence above attached; the
workstream written with a truthful Next; the daily corrected. Khaliq owns every
merge gate — no agent merges. Report back with issue numbers.

## Do not

- Do not weaken or revert the gate. It is doing its job.
- Do not attempt `agent-relay agent remove` as a recovery — it fails server-side
  on any agent with history; that failure is fix A.
- Do not run `launchctl bootout` on the node without going through the
  supervisor's clean shutdown, or you burn `chief-broker` too.
