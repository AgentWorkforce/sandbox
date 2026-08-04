#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personaPath = path.join(repoRoot, "personas/chief-khaliq/persona.json");
const contextBuilder = path.join(repoRoot, "scripts/build-chief-cloud-context.mjs");

execFileSync(process.execPath, [contextBuilder], {
  cwd: repoRoot,
  stdio: "inherit",
});

const args = ["deploy", personaPath, "--mode", "cloud", ...process.argv.slice(2)];
const result = spawnSync("agentworkforce", args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
