#!/usr/bin/env node

import { loadConfig, CONFIG_PATH } from "./lib/chief-runtime.mjs";

const config = loadConfig();
console.log(`Valid Chief config: ${CONFIG_PATH}`);
console.log(`Principal: ${config.principal.name}`);
console.log(`Agent: ${config.agent.name}`);
console.log(`Brain: ${config.brainRoot}`);
console.log(`Workspace: ${config.workspace.name}`);
