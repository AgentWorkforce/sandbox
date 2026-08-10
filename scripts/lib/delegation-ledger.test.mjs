import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertProjectLead, buildAgentIdentity } from "./delegation-identity.mjs";
import {
  applyLedgerIdentity,
  claimFanOut,
  readLedger,
  recordDispatch,
  releaseDispatch,
  verifyIdentityLanded,
  writeLedger,
} from "./delegation-ledger.mjs";

const scratch = () =>
  join(mkdtempSync(join(tmpdir(), "chief-delegation-ledger-")), "ledger.json");

const identity = (overrides = {}) =>
  buildAgentIdentity({
    project: "chief-delegation-governance",
    workstream: "dispatch-contract",
    role: "worker",
    reportsTo: "chief-delegation-governance-dispatch-lead",
    runId: "run-1",
    ...overrides,
  });

test("a missing ledger reads as empty, and a claim survives the round trip", () => {
  const path = scratch();
  assert.deepEqual(readLedger(path).agents, {});

  recordDispatch(path, { name: "w1", identity: identity(), spawnedAt: "2026-08-06" });
  const reloaded = readLedger(path);
  assert.equal(reloaded.agents.w1.status, "claimed");
  assert.equal(reloaded.agents.w1.identity.project, "chief-delegation-governance");
  assert.equal(reloaded.agents.w1.identity.reportsTo, "chief-delegation-governance-dispatch-lead");
});

test("a corrupt ledger throws rather than reading as empty", () => {
  const path = scratch();
  writeFileSync(path, "{ not json");
  // Reading a corrupt ledger as empty would silently un-appoint every lead and
  // re-open every claimed dispatch — the AR-448 shape exactly.
  assert.throws(() => readLedger(path), /unreadable/);
});

test("a ledger from another version throws rather than being half-understood", () => {
  const path = scratch();
  writeFileSync(path, JSON.stringify({ version: 99, agents: {} }));
  assert.throws(() => readLedger(path), /version 99/);
});

test("a name already claimed cannot be claimed twice", () => {
  const path = scratch();
  recordDispatch(path, { name: "w1", identity: identity() });
  assert.throws(
    () => recordDispatch(path, { name: "w1", identity: identity({ runId: "run-2" }) }),
    /already claimed/,
  );
});

test("a released name can be claimed again", () => {
  const path = scratch();
  recordDispatch(path, { name: "w1", identity: identity() });
  releaseDispatch(path, "w1", { reason: "spawn failed, worker reaped" });
  assert.equal(readLedger(path).agents.w1.status, "released");

  // Re-claiming after a release is the normal retry path and must work.
  recordDispatch(path, { name: "w1", identity: identity({ runId: "run-2" }) });
  assert.equal(readLedger(path).agents.w1.status, "claimed");
});

test("a claim without an identity is refused", () => {
  const path = scratch();
  assert.throws(() => recordDispatch(path, { name: "w1" }), /built identity/);
  assert.throws(() => recordDispatch(path, { identity: identity() }), /agent name/);
});

// ------------------------------------------------------------------- overlay

test("the ledger makes the lead gate work while the platform cannot carry metadata", () => {
  const path = scratch();
  const leadIdentity = buildAgentIdentity({
    project: "chief-delegation-governance",
    workstream: "dispatch-contract",
    role: "lead",
    reportsTo: "chief-khaliq",
  });
  recordDispatch(path, {
    name: "chief-delegation-governance-dispatch-contract-lead",
    identity: leadIdentity,
  });

  // What the live workspace actually returns today: only the platform's own
  // fleet block, no identity at all.
  const roster = [
    {
      name: "chief-delegation-governance-dispatch-contract-lead",
      status: "active",
      metadata: { fleet: { nodeId: "node_x" } },
    },
  ];

  assert.throws(
    () => assertProjectLead("chief-delegation-governance", roster),
    /no accountable lead/,
    "without the overlay the gate correctly refuses — the record declares nothing",
  );

  const overlaid = applyLedgerIdentity(roster, readLedger(path));
  const resolved = assertProjectLead("chief-delegation-governance", overlaid);
  assert.equal(resolved.inferred, false, "a ledger claim is declared, not guessed");
  assert.equal(
    resolved.lead.agent.name,
    "chief-delegation-governance-dispatch-contract-lead",
  );
});

test("an agent record that declares its own identity wins over the ledger", () => {
  const ledger = {
    version: 1,
    agents: {
      w1: { status: "claimed", identity: identity({ workstream: "stale-workstream" }) },
    },
  };
  const roster = [
    {
      name: "w1",
      status: "active",
      metadata: {
        organization: "AgentWorkforce",
        project: "chief-delegation-governance",
        workstream: "authoritative",
        role: "worker",
      },
    },
  ];
  // The record is the contract; the ledger is only a stand-in for a record
  // that cannot yet be written.
  assert.equal(applyLedgerIdentity(roster, ledger)[0].metadata.workstream, "authoritative");
});

test("a released claim is not overlaid back onto the roster", () => {
  const ledger = {
    version: 1,
    agents: { w1: { status: "released", identity: identity() } },
  };
  const roster = [{ name: "w1", status: "active", metadata: {} }];
  assert.deepEqual(applyLedgerIdentity(roster, ledger)[0].metadata, {});
});

test("verifyIdentityLanded reports the interim path honestly", () => {
  // Today: false for every agent, which is the standing evidence that the
  // relay-side change is still needed.
  const today = [{ name: "w1", status: "active", metadata: { fleet: { nodeId: "n" } } }];
  assert.equal(verifyIdentityLanded("w1", today), false);

  // After the relay change lands, the same call starts returning true and the
  // ledger can be deleted.
  const later = [
    {
      name: "w1",
      status: "active",
      metadata: { organization: "AgentWorkforce", project: "cloud", role: "worker" },
    },
  ];
  assert.equal(verifyIdentityLanded("w1", later), true);
  assert.equal(verifyIdentityLanded("missing", later), false);
});

// ------------------------------------------------------------------ fan-out

test("a fan-out claims every worker before any of them is spawned", () => {
  const path = scratch();
  const plan = {
    dispatches: [
      { name: "w1", identity: identity() },
      { name: "w2", identity: identity() },
    ],
  };
  assert.deepEqual(claimFanOut(path, plan), ["w1", "w2"]);
  const ledger = readLedger(path);
  assert.equal(ledger.agents.w1.status, "claimed");
  assert.equal(ledger.agents.w2.status, "claimed");
});

test("a fan-out that cannot claim every worker claims none of them", () => {
  const path = scratch();
  // Someone else already holds w2.
  recordDispatch(path, { name: "w2", identity: identity({ runId: "other-run" }) });

  const plan = {
    dispatches: [
      { name: "w1", identity: identity() },
      { name: "w2", identity: identity() },
      { name: "w3", identity: identity() },
    ],
  };
  assert.throws(() => claimFanOut(path, plan), /already claimed/);

  const ledger = readLedger(path);
  // w1 was claimed then rolled back; a half-claimed fan-out is the one state
  // worse than no fan-out at all.
  assert.equal(ledger.agents.w1.status, "released");
  assert.equal(ledger.agents.w2.identity.dispatch.runId, "other-run", "not stolen");
  assert.equal(ledger.agents.w3, undefined, "never reached");
});

test("writing then reading preserves the ledger shape exactly", () => {
  const path = scratch();
  const ledger = { version: 1, agents: { w1: { status: "claimed", identity: identity() } } };
  writeLedger(path, ledger);
  assert.deepEqual(readLedger(path), ledger);
});
