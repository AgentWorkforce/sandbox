import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_SUBSTITUTION_CLAUSE,
  absolutePathsIn,
  assertDispatchCoherent,
  assertProjectLead,
  buildAgentIdentity,
  findProjectLead,
  inferProjectFromName,
  normalizeAgentName,
  planFanOut,
  readAgentIdentity,
} from "./delegation-identity.mjs";

const live = (name, metadata = {}) => ({ name, status: "active", metadata });
const gone = (name, metadata = {}) => ({ name, status: "offline", metadata });

const leadMetadata = (project, workstream = "dispatch-contract") => ({
  organization: "AgentWorkforce",
  project,
  workstream,
  role: "lead",
  reportsTo: "chief-khaliq",
});

// --------------------------------------------------------------------- naming

test("the common case is the bare convention, with no suffix", () => {
  assert.equal(
    normalizeAgentName({
      project: "chief-delegation-governance",
      workstream: "dispatch-contract",
      role: "worker",
    }),
    "chief-delegation-governance-dispatch-contract-worker",
  );
  // Free-text parts are slugified rather than rejected.
  assert.equal(
    normalizeAgentName({ project: "cloud", workstream: "YC demo", role: "Impl" }),
    "cloud-yc-demo-impl",
  );
});

test("a partial identity cannot produce a name", () => {
  assert.throws(
    () => normalizeAgentName({ project: "cloud", role: "worker" }),
    /needs a project/,
  );
});

test("a collision adds a short suffix, and only then", () => {
  const parts = { project: "cloud", workstream: "yc-demo", role: "worker" };
  const base = normalizeAgentName(parts);
  assert.equal(base, "cloud-yc-demo-worker");

  const suffixed = normalizeAgentName(parts, {
    taken: [base],
    discriminator: "run-1",
  });
  assert.notEqual(suffixed, base);
  assert.match(suffixed, /^cloud-yc-demo-worker-[0-9a-f]{8}$/);
});

test("the suffix is deterministic for the same dispatch and distinct across dispatches", () => {
  const parts = { project: "cloud", workstream: "yc-demo", role: "worker" };
  const taken = ["cloud-yc-demo-worker"];

  const first = normalizeAgentName(parts, { taken, discriminator: "run-1" });
  const again = normalizeAgentName(parts, { taken, discriminator: "run-1" });
  const other = normalizeAgentName(parts, { taken, discriminator: "run-2" });

  assert.equal(first, again, "same dispatch must reproduce the same name");
  assert.notEqual(first, other, "a different run must not collide");
});

test("a suffix that is itself taken rehashes rather than giving up", () => {
  const parts = { project: "cloud", workstream: "yc-demo", role: "worker" };
  const first = normalizeAgentName(parts, {
    taken: ["cloud-yc-demo-worker"],
    discriminator: "run-1",
  });
  const second = normalizeAgentName(parts, {
    taken: ["cloud-yc-demo-worker", first],
    discriminator: "run-1",
  });
  assert.notEqual(second, first);
  assert.match(second, /^cloud-yc-demo-worker-[0-9a-f]{8}$/);
});

// ------------------------------------------------------------------- identity

test("identity is a typed bag with the four keys the consumer reads at the top level", () => {
  const identity = buildAgentIdentity({
    project: "chief-delegation-governance",
    workstream: "dispatch-contract",
    role: "lead",
    reportsTo: "chief-khaliq",
    runId: "run-7",
    normalizedName: "chief-delegation-governance-dispatch-contract-lead",
  });

  assert.equal(identity.organization, "AgentWorkforce");
  assert.equal(identity.project, "chief-delegation-governance");
  assert.equal(identity.workstream, "dispatch-contract");
  assert.equal(identity.role, "lead");
  assert.equal(identity.reportsTo, "chief-khaliq");
  // Provenance is nested so it cannot collide with the platform's own
  // `metadata.fleet` block on the same record.
  assert.equal(identity.dispatch.runId, "run-7");
  assert.equal(identity.dispatch.schemaVersion, 1);
});

test("an identity missing its accountability is an error, not a default", () => {
  const base = {
    project: "cloud",
    workstream: "yc-demo",
    role: "worker",
    reportsTo: "some-lead",
  };
  assert.throws(() => buildAgentIdentity({ ...base, reportsTo: "" }), /reportsTo/);
  assert.throws(() => buildAgentIdentity({ ...base, role: "director" }), /role must be/);
  assert.throws(() => buildAgentIdentity({ ...base, workstream: "" }), /workstream/);
});

test("declared identity is distinguishable from an inferred guess", () => {
  const declared = readAgentIdentity(live("x", leadMetadata("cloud")));
  assert.equal(declared.source, "declared");
  assert.equal(declared.project, "cloud");

  // A pre-convention agent: the shim recovers a role hint and nothing else,
  // and says plainly that it guessed.
  const inferred = readAgentIdentity(live("cloud-chief-yc-demo-delivery-lead"));
  assert.equal(inferred.source, "inferred");
  assert.equal(inferred.role, "lead");
  assert.equal(inferred.project, null);
});

// ------------------------------------------------- multi-token project slugs

test("a multi-token project is recovered whole, not split at the first hyphen", () => {
  const known = ["cloud", "chief", "chief-delegation-governance"];
  // The bug this replaces read `cloud-chief-yc-demo-delivery-lead` as project
  // "cloud" by splitting at the first hyphen.
  assert.equal(
    inferProjectFromName("chief-delegation-governance-dispatch-contract-worker", known),
    "chief-delegation-governance",
    "longest match must win over the shorter project that prefixes it",
  );
  assert.equal(inferProjectFromName("chief-senses-doctor", known), "chief");
});

test("an unrecognised name infers no project rather than inventing one", () => {
  assert.equal(inferProjectFromName("cloud-chief-yc-demo-delivery-lead", []), null);
  assert.equal(inferProjectFromName("some-unrelated-agent", ["cloud"]), null);
  // A prefix that is not followed by a separator is a different word.
  assert.equal(inferProjectFromName("cloudflare-tunnel-worker", ["cloud"]), null);
});

test("a name built from a multi-token project round-trips through inference", () => {
  const parts = {
    project: "chief-delegation-governance",
    workstream: "dispatch-contract",
    role: "worker",
  };
  const name = normalizeAgentName(parts);
  assert.equal(
    inferProjectFromName(name, ["chief", "chief-delegation-governance"]),
    "chief-delegation-governance",
  );
});

test("the consumer's alias keys are read, though Chief writes only canonical ones", () => {
  const aliased = readAgentIdentity({
    name: "x",
    status: "active",
    metadata: {
      org: "AgentWorkforce",
      project_name: "cloud",
      task: "yc-demo",
      worker_role: "lead",
    },
  });
  assert.equal(aliased.source, "declared");
  assert.equal(aliased.organization, "AgentWorkforce");
  assert.equal(aliased.workstream, "yc-demo");
  assert.equal(aliased.role, "lead");

  // What Chief itself writes is the canonical form.
  const written = buildAgentIdentity({
    project: "cloud",
    workstream: "yc-demo",
    role: "lead",
    reportsTo: "chief-khaliq",
  });
  assert.deepEqual(
    Object.keys(written).sort(),
    ["dispatch", "organization", "project", "reportsTo", "role", "workstream"],
  );
});

// ----------------------------------------------------------------- lead gate

test("exactly one live declared lead resolves the project", () => {
  const roster = [
    live("cloud-yc-demo-lead", leadMetadata("cloud")),
    live("other-project-lead", leadMetadata("relay")),
    gone("cloud-stale-lead", leadMetadata("cloud")),
  ];
  const { lead, leads } = findProjectLead("cloud", roster);
  assert.equal(leads.length, 1, "an offline lead is not an accountable lead");
  assert.equal(lead.agent.name, "cloud-yc-demo-lead");
});

test("fan-out with no lead fails closed", () => {
  assert.throws(
    () => assertProjectLead("cloud", [live("cloud-yc-demo-worker")]),
    /no accountable lead/,
  );
});

test("two leads for one project fails closed", () => {
  const roster = [
    live("cloud-a-lead", leadMetadata("cloud")),
    live("cloud-b-lead", leadMetadata("cloud")),
  ];
  assert.throws(() => assertProjectLead("cloud", roster), /exactly one/);
});

test("an inferred lead is refused unless the shim is invoked explicitly", () => {
  const roster = [live("cloud-yc-demo-delivery-lead")];
  assert.throws(() => assertProjectLead("cloud", roster), /no accountable lead/);

  const allowed = assertProjectLead("cloud", roster, { allowInferredLead: true });
  assert.equal(allowed.inferred, true, "leaning on the shim must be visible");
  assert.equal(allowed.lead.agent.name, "cloud-yc-demo-delivery-lead");
});

test("a longer project's lead is not mistaken for a shorter project's lead", () => {
  // `chief-delegation-governance-dispatch-lead` must not answer for project
  // `chief` just because `chief-` prefixes it.
  const roster = [live("chief-delegation-governance-dispatch-lead")];
  const knownProjects = ["chief", "chief-delegation-governance"];

  assert.throws(
    () =>
      assertProjectLead("chief", roster, { allowInferredLead: true, knownProjects }),
    /no accountable lead/,
  );

  const owned = assertProjectLead("chief-delegation-governance", roster, {
    allowInferredLead: true,
    knownProjects,
  });
  assert.equal(owned.lead.agent.name, "chief-delegation-governance-dispatch-lead");
});

test("ambiguous inferred candidates fail closed even with the shim allowed", () => {
  const roster = [live("cloud-one-lead"), live("cloud-two-lead")];
  assert.throws(
    () => assertProjectLead("cloud", roster, { allowInferredLead: true }),
    /appoint one explicitly/,
  );
});

// ------------------------------------------------------------------- fan-out

test("a fan-out names every worker, points it at the lead, and never reuses a name", () => {
  const roster = [
    live("cloud-yc-demo-lead", leadMetadata("cloud", "yc-demo")),
    live("cloud-docs-worker"),
  ];

  const plan = planFanOut({
    project: "cloud",
    roster,
    runId: "run-9",
    dispatchedBy: "cloud-yc-demo-lead",
    workers: [
      { workstream: "docs", task: "write docs" },
      { workstream: "tests", task: "write tests" },
      // Same workstream as the first: the in-flight allocation must notice.
      { workstream: "docs", task: "more docs" },
    ],
  });

  assert.equal(plan.lead, "cloud-yc-demo-lead");
  assert.equal(plan.failClosed, true);
  assert.equal(plan.atomicSpawn, false, "spawn cannot carry metadata yet");

  const names = plan.dispatches.map((d) => d.name);
  assert.equal(new Set(names).size, 3, "names within one fan-out must be unique");
  // `cloud-docs-worker` is already on the roster, so the first docs worker is
  // suffixed; `tests` is free and stays bare.
  assert.match(names[0], /^cloud-docs-worker-[0-9a-f]{8}$/);
  assert.equal(names[1], "cloud-tests-worker");
  assert.notEqual(names[2], names[0]);

  for (const dispatch of plan.dispatches) {
    assert.equal(dispatch.identity.reportsTo, "cloud-yc-demo-lead");
    assert.equal(dispatch.identity.role, "worker");
    assert.equal(dispatch.identity.organization, "AgentWorkforce");
    assert.equal(dispatch.identity.dispatch.normalizedName, dispatch.name);
  }
});

// -------------------------------------------------------- dispatch coherence

test("a brief's absolute paths are found, and per-machine paths are not", () => {
  assert.deepEqual(
    absolutePathsIn("work in /Users/k/Projects/cloud-worktrees/yc-demo and report"),
    ["/Users/k/Projects/cloud-worktrees/yc-demo"],
  );
  // `~` resolves per machine, so it is not a claim about any particular one.
  assert.deepEqual(absolutePathsIn("check ~/Projects/relay"), []);
  assert.deepEqual(absolutePathsIn("just review the open PR"), []);
});

test("a brief naming a path without a pinned node is refused", () => {
  // Five workers were fanned out unpinned, relay spread them over four
  // machines, and the worktree path existed on one.
  assert.throws(
    () =>
      assertDispatchCoherent({
        task: "review /Users/k/Projects/AgentWorkforce/cloud-worktrees/yc-demo",
      }),
    /pins no targetNode/,
  );
});

test("a pinned path-bearing brief is allowed, and a path-free brief needs no pin", () => {
  const pinned = assertDispatchCoherent({
    task: "review /Users/k/Projects/cloud-worktrees/yc-demo",
    targetNode: "kjg-laptop",
  });
  assert.equal(pinned.pinned, "kjg-laptop");
  assert.deepEqual(pinned.paths, ["/Users/k/Projects/cloud-worktrees/yc-demo"]);

  // Nothing binds this to a machine, so relay may place it anywhere.
  assert.deepEqual(assertDispatchCoherent({ task: "summarize PR #24" }).paths, []);
});

test("a path-bearing brief always leaves with the no-substitution clause", () => {
  const roster = [live("cloud-yc-demo-lead", leadMetadata("cloud", "yc-demo"))];
  const plan = planFanOut({
    project: "cloud",
    roster,
    workers: [
      {
        workstream: "verify",
        task: "verify the fix in /Users/k/Projects/cloud-worktrees/yc-demo",
        targetNode: "kjg-laptop",
      },
      { workstream: "docs", task: "update the changelog" },
    ],
  });

  // The lead cannot produce a path-bearing dispatch without the clause.
  assert.match(plan.dispatches[0].task, /Do not clone, re-create, or substitute/);
  assert.equal(plan.dispatches[0].targetNode, "kjg-laptop");
  // A brief with no path is left alone; the clause would be noise.
  assert.equal(plan.dispatches[1].task, "update the changelog");
  assert.ok(!plan.dispatches[1].task.includes(NO_SUBSTITUTION_CLAUSE));
});

test("one incoherent worker invalidates the whole fan-out", () => {
  const roster = [live("cloud-yc-demo-lead", leadMetadata("cloud", "yc-demo"))];
  assert.throws(
    () =>
      planFanOut({
        project: "cloud",
        roster,
        workers: [
          { workstream: "docs", task: "update the changelog" },
          // Unpinned and path-bearing: the whole plan must fail, not just this one.
          { workstream: "verify", task: "verify /Users/k/Projects/cloud-worktrees/yc-demo" },
        ],
      }),
    /worker 1 names filesystem path/,
  );
});

test("the lead gate runs before any name is allocated", () => {
  // A project with no lead must produce a throw, not a half-built plan.
  assert.throws(
    () =>
      planFanOut({
        project: "cloud",
        roster: [live("unrelated-lead", leadMetadata("relay"))],
        workers: [{ workstream: "docs" }],
      }),
    /no accountable lead/,
  );
});
