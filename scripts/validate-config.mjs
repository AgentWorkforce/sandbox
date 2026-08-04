#!/usr/bin/env node

import {
  activeWorkspace,
  CLONE_ROOT,
  FACTORY_CONFIG_PATH,
  loadConfig,
  TEAMS_PATH,
} from "./lib/chief-runtime.mjs";
import {
  requireFactoryContract,
  requireIssueSource,
} from "./lib/factory-contract.mjs";

const config = loadConfig();
console.log(`Valid Chief roster: ${TEAMS_PATH}`);
console.log(`Principal: ${config.principal.name} (${config.principal.slug})`);
console.log(`Agent: ${config.agent.name}`);
console.log(`Brain: ${config.brainRoot}`);
console.log(`Senses: ${config.senses.remotePaths.join(", ")}`);
// Reported, not configured: agent-relay owns which workspace is canonical.
console.log(`Workspace: ${activeWorkspace(config).name} (resolved)`);

// Will's v1 two-file deployment remains readable during the migration window;
// it is not forced to acquire a new active contract merely by pulling Chief.
if (config.configVersion === 1) {
  console.log(
    "Factory: legacy v1 compatibility (contract validation begins after migration)",
  );
} else {
  const contract = requireFactoryContract("chief", {
    cloneRoot: CLONE_ROOT,
    configPath: FACTORY_CONFIG_PATH,
  });
  console.log(
    `Factory: ${contract.path} (${requireIssueSource(contract)}, ` +
    `merge ${contract.mergePolicy})`,
  );
}
