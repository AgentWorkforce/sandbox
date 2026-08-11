import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertWorkspaceConvergence,
  configuredIntegrationProviders,
  deriveConfig,
  factoryRuntimeEnv,
  loadConfig,
  migrateLegacyRoster,
  processIsAlive,
} from "./chief-runtime.mjs";

test("processIsAlive treats EPERM as alive, not dead", (t) => {
  // EPERM means the pid exists but is owned by another user; misreading it
  // as dead risks two live supervisors both winning the same lease.
  t.mock.method(process, "kill", () => {
    const error = new Error("kill EPERM");
    error.code = "EPERM";
    throw error;
  });
  assert.equal(processIsAlive(555), true);
});

test("processIsAlive treats ESRCH as dead", (t) => {
  t.mock.method(process, "kill", () => {
    const error = new Error("kill ESRCH");
    error.code = "ESRCH";
    throw error;
  });
  assert.equal(processIsAlive(999_999), false);
});

test("processIsAlive is true for the current live process", () => {
  assert.equal(processIsAlive(process.pid), true);
});

test("configured integration providers follow scoped senses paths", () => {
  assert.deepEqual(
    configuredIntegrationProviders([
      "/linear",
      "/github/repos",
      "/notion",
      "/digests",
      "/notion/pages",
    ]),
    ["linear", "github", "notion"],
  );
});

test("Factory runtime environment carries one explicit config and clone root", () => {
  assert.deepEqual(
    factoryRuntimeEnv({
      factoryConfigPath: "/tmp/chief/factory.config.json",
      cloneRoot: "/tmp/checkouts",
    }),
    {
      FACTORY_CONFIG_PATH: "/tmp/chief/factory.config.json",
      CLONE_ROOT: "/tmp/checkouts",
    },
  );
});

const legacyWillRoster = {
  team: "chief",
  autoSpawn: true,
  agents: [
    {
      name: "chief-will",
      cli: "claude",
      role: "chief of staff",
      task: "Keep Will's Chief online.",
    },
  ],
};

const legacyWillConfig = {
  principal: {
    name: "Will Washburn",
    handle: "willwashburn",
    timezone: "America/New_York",
  },
  agent: { name: "chief-will", displayName: "Chief" },
  brainRoot: "principals/will",
  workspace: { name: "org", requireUnifiedDataPlaneId: false },
  senses: {
    localDir: "senses",
    remotePaths: ["/github"],
    scopes: ["relayfile:fs:read:/github/**"],
    refreshBeforeSeconds: 600,
  },
  work: { humanSystem: "relay", agentSystem: "github" },
};

const convergedWorkspace = {
  name: "default",
  relaycastWorkspaceId: "rw_one",
  relayfileWorkspaceId: "rw_one",
  relayauthWorkspaceId: "rw_one",
};

test("v2 roster remains the only source of principal and senses", () => {
  const roster = {
    principal: {
      slug: "khaliq",
      name: "Khaliq Gant",
      timezone: "Europe/Oslo",
    },
    senses: {
      remotePaths: ["/linear"],
      scopes: ["relayfile:fs:read:/linear/**"],
    },
    recipes: {
      default: "single",
      labels: { single: "one", workflow: "flow", team: "team" },
    },
    team: "chief-khaliq",
    agents: [
      { name: "chief-khaliq", role: "chief of staff", cli: "claude", task: "Run" },
    ],
  };
  const config = deriveConfig(roster);
  assert.equal(config.configVersion, 2);
  assert.equal(config.principal.slug, "khaliq");
  assert.deepEqual(config.senses.remotePaths, ["/linear"]);
  assert.equal(config.workspace.expectedName, null);
  assert.equal(config.workspace.requireUnifiedDataPlaneId, true);
});

test("legacy Will config preserves identity, scopes, workspace, and agents", () => {
  const migrated = migrateLegacyRoster(legacyWillRoster, legacyWillConfig);
  assert.equal(migrated.principal.slug, "will");
  assert.deepEqual(migrated.senses.remotePaths, ["/github"]);
  assert.deepEqual(migrated.senses.scopes, ["relayfile:fs:read:/github/**"]);
  assert.equal(migrated.workspace.name, "org");
  assert.equal(migrated.workspace.requireUnifiedDataPlaneId, false);
  assert.deepEqual(migrated.agents, legacyWillRoster.agents);
});

test("compatibility reader accepts Will's non-unified org workspace", () => {
  const directory = mkdtempSync(join(tmpdir(), "chief-config-test-"));
  const teamsPath = join(directory, "teams.json");
  const legacyConfigPath = join(directory, "chief.config.json");
  writeFileSync(teamsPath, JSON.stringify(legacyWillRoster));
  writeFileSync(legacyConfigPath, JSON.stringify(legacyWillConfig));

  const config = loadConfig({ teamsPath, legacyConfigPath });
  assert.equal(config.configVersion, 1);
  assert.equal(config.workspace.expectedName, "org");
  assert.doesNotThrow(() => assertWorkspaceConvergence({
    name: "org",
    relaycastWorkspaceId: "rw_cast",
    relayfileWorkspaceId: "rw_file",
    relayauthWorkspaceId: "rw_auth",
  }, config));
  assert.equal(JSON.parse(readFileSync(teamsPath, "utf8")).principal, undefined);
});

test("legacy reader never silently switches the selected workspace", () => {
  const config = deriveConfig(legacyWillRoster, { legacyConfig: legacyWillConfig });
  assert.throws(
    () => assertWorkspaceConvergence(convergedWorkspace, config),
    /expects Agent Relay workspace "org"/u,
  );
});

test("v2 config rejects divergent data-plane identities", () => {
  const config = {
    workspace: { expectedName: null, requireUnifiedDataPlaneId: true },
  };
  assert.throws(
    () => assertWorkspaceConvergence({
      name: "default",
      relaycastWorkspaceId: "rw_cast",
      relayfileWorkspaceId: "rw_file",
      relayauthWorkspaceId: "rw_auth",
    }, config),
    /convergence invariant failed/u,
  );
});
