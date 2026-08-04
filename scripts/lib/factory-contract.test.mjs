import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createFactoryContract,
  loadFactoryContract,
  requireFactoryContract,
  requireIssueSource,
  resolveFactoryConfigPath,
} from "./factory-contract.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("onboarding generation produces the Chief-owned active contract", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "chief-factory-generation-"));
  const recipes = {
    default: "single",
    labels: {
      single: "agent:single",
      workflow: "agent:workflow",
      team: "agent:team",
    },
  };
  const contract = createFactoryContract(
    { recipes },
    {
      cloneRoot,
      workspaceId: "workspace-1",
      repos: { names: ["chief"] },
    },
  );

  assert.equal(contract.workspaceId, "workspace-1");
  assert.equal(contract.issueSource, "github");
  assert.equal(contract.repos.cloneRoot, resolve(cloneRoot));
  assert.deepEqual(contract.repos.names, ["chief"]);
  assert.equal(contract.safety.requireLabel, "factory");
  assert.equal(contract.mergePolicy, "never");
  assert.deepEqual(contract.recipes, recipes);
});

test("the explicit Chief path wins over stale repo and clone-root contracts", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "chief-factory-resolution-"));
  const targetRoot = join(cloneRoot, "relay");
  const chiefRoot = join(cloneRoot, "chief");
  mkdirSync(targetRoot);
  mkdirSync(chiefRoot);
  writeJson(join(targetRoot, "factory.config.json"), {
    issueSource: "linear",
  });
  writeJson(join(cloneRoot, "factory.config.json"), {
    issueSource: "linear",
  });
  const activePath = join(chiefRoot, "factory.config.json");
  writeJson(activePath, {
    issueSource: "github",
    repos: { org: "AgentWorkforce", names: ["relay"], cloneRoot },
    safety: { requireLabel: "factory" },
    mergePolicy: "never",
  });

  const contract = loadFactoryContract("relay", {
    cloneRoot,
    configPath: activePath,
  });

  assert.equal(contract.path, activePath);
  assert.equal(contract.repo, "AgentWorkforce/relay");
  assert.equal(contract.routesRepo, true);
  assert.equal(requireIssueSource(contract), "github");
});

test("the active contract fails closed when its repos maps omit the target", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "chief-factory-unrouted-"));
  const activePath = join(cloneRoot, "factory.config.json");
  writeJson(activePath, {
    issueSource: "github",
    repos: { org: "AgentWorkforce", names: ["chief"] },
  });

  assert.throws(
    () => requireFactoryContract("relay", { cloneRoot, configPath: activePath }),
    /does not route AgentWorkforce\/relay/u,
  );
});

test("a missing active path fails without suggesting location search", () => {
  const cloneRoot = mkdtempSync(join(tmpdir(), "chief-factory-missing-"));
  const activePath = join(cloneRoot, "chief", "factory.config.json");

  assert.throws(
    () => requireFactoryContract("cloud", { cloneRoot, configPath: activePath }),
    (error) => {
      assert.match(error.message, /active Factory contract is missing/u);
      assert.match(error.message, /will not guess a surface or search target repositories/u);
      assert.doesNotMatch(error.message, /nearest|then/u);
      return true;
    },
  );
});

test("the resolver requires Chief to pass the active path explicitly", () => {
  assert.throws(
    () => resolveFactoryConfigPath(),
    /must pass its repo-owned factory\.config\.json explicitly/u,
  );
});
