#!/usr/bin/env node

import { activeWorkspace, loadConfig, TEAMS_PATH } from "./lib/chief-runtime.mjs";

const config = loadConfig();
console.log(`Valid Chief roster: ${TEAMS_PATH}`);
console.log(`Principal: ${config.principal.name} (${config.principal.slug})`);
console.log(`Agent: ${config.agent.name}`);
console.log(`Brain: ${config.brainRoot}`);
console.log(`Senses: ${config.senses.remotePaths.join(", ")}`);
// Reported, not configured: agent-relay owns which workspace is canonical.
console.log(`Workspace: ${activeWorkspace(config).name} (resolved)`);
