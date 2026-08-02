#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  LEGACY_CONFIG_PATH,
  TEAMS_PATH,
  migrateLegacyRoster,
} from "./lib/chief-runtime.mjs";

const write = process.argv.slice(2).includes("--write");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

if (!existsSync(TEAMS_PATH)) {
  throw new Error(`No active roster at ${TEAMS_PATH}`);
}

const roster = readJson(TEAMS_PATH);
if (roster?.principal) {
  console.log(`Chief roster is already v2: ${TEAMS_PATH}`);
  process.exit(0);
}
if (!existsSync(LEGACY_CONFIG_PATH)) {
  throw new Error(
    `Legacy roster requires ${LEGACY_CONFIG_PATH}; no files were changed.`,
  );
}

const migrated = migrateLegacyRoster(roster, readJson(LEGACY_CONFIG_PATH));
console.log(`Legacy Chief configuration is migratable for ${migrated.principal.name}.`);
console.log(`Resident Chief: ${migrated.agents.find((agent) => agent.role === "chief of staff")?.name}`);
console.log(`Senses preserved: ${migrated.senses.remotePaths.join(", ")}`);
console.log(`Workspace preserved: ${migrated.workspace.name}`);
console.log(
  `Unified data-plane requirement preserved: ${migrated.workspace.requireUnifiedDataPlaneId}`,
);

if (!write) {
  console.log("Check only; no files changed. Add --write to migrate teams.json.");
  process.exit(0);
}

const backup = `${TEAMS_PATH}.v1.backup`;
if (!existsSync(backup)) copyFileSync(TEAMS_PATH, backup);
writeJsonAtomic(TEAMS_PATH, migrated);
console.log(`Migrated ${TEAMS_PATH}; rollback copy: ${backup}`);
console.log(`${LEGACY_CONFIG_PATH} was left untouched for rollback.`);
