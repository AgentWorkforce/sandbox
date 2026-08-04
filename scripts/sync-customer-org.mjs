#!/usr/bin/env node

import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_ORG_CHART_PATH = join(REPO_ROOT, "tools/orgchart/org.json");
const WATCHDOG_PRINCIPAL = "Watchdog";
const WATCHDOG_CHIEF = "chief-watchdog";

function readJson(path, label) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }

  try {
    return { contents, value: JSON.parse(contents) };
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} at ${path}: ${error.message}`);
  }
}

function teamMembers(team, teamPath) {
  if (!Array.isArray(team?.members)) {
    throw new Error(`${teamPath} must contain a members array`);
  }

  const members = [];
  const seen = new Set();
  for (const member of team.members) {
    if (typeof member !== "string" || member.length === 0 || member.trim() !== member) {
      throw new Error(`${teamPath} members must be non-empty, trimmed strings`);
    }
    if (member === WATCHDOG_CHIEF) {
      throw new Error(`${teamPath} must not list ${WATCHDOG_CHIEF} as its own report`);
    }
    if (seen.has(member)) {
      throw new Error(`${teamPath} contains duplicate member ${member}`);
    }
    seen.add(member);
    members.push(member);
  }
  return members;
}

function titleFor(member) {
  return member
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function managedAgents(customerAgentsRepo, members) {
  return [
    {
      name: WATCHDOG_CHIEF,
      title: "Watchdog Chief",
      reportsTo: WATCHDOG_PRINCIPAL,
      repo: customerAgentsRepo,
      status: "unseated",
    },
    ...members.map((member) => ({
      name: member,
      title: titleFor(member),
      reportsTo: WATCHDOG_CHIEF,
      repo: customerAgentsRepo,
      status: "unverified",
    })),
  ];
}

function managedStatus(existing, fallback) {
  return typeof existing?.status === "string" && existing.status.trim().length > 0
    ? existing.status
    : fallback;
}

export function mergeWatchdogOverlay(org, customerAgentsRepo, members) {
  if (!org || typeof org !== "object" || Array.isArray(org)) {
    throw new Error("Org chart must be a JSON object");
  }
  if (!Array.isArray(org.overlays)) {
    throw new Error("Org chart must contain an overlays array");
  }

  const matchingIndexes = org.overlays
    .map((overlay, index) => ({ overlay, index }))
    .filter(({ overlay }) => overlay?.principal?.name?.toLowerCase() === "watchdog")
    .map(({ index }) => index);
  if (matchingIndexes.length > 1) {
    throw new Error("Org chart contains more than one Watchdog overlay");
  }

  const overlayIndex = matchingIndexes[0];
  const existingOverlay = overlayIndex === undefined
    ? { principal: {}, agents: [] }
    : org.overlays[overlayIndex];
  if (!Array.isArray(existingOverlay.agents)) {
    throw new Error("Watchdog overlay must contain an agents array");
  }

  const agents = existingOverlay.agents.map((agent) => ({ ...agent }));
  const indexesByName = new Map();
  for (const [index, agent] of agents.entries()) {
    if (typeof agent?.name !== "string" || agent.name.length === 0) {
      throw new Error("Watchdog overlay agents must have non-empty names");
    }
    if (indexesByName.has(agent.name)) {
      throw new Error(`Watchdog overlay contains duplicate agent ${agent.name}`);
    }
    indexesByName.set(agent.name, index);
  }

  for (const managed of managedAgents(customerAgentsRepo, members)) {
    const index = indexesByName.get(managed.name);
    if (index === undefined) {
      indexesByName.set(managed.name, agents.length);
      agents.push(managed);
    } else {
      agents[index] = {
        ...agents[index],
        ...managed,
        status: managedStatus(agents[index], managed.status),
      };
    }
  }

  const watchdogOverlay = {
    ...existingOverlay,
    principal: {
      ...existingOverlay.principal,
      name: WATCHDOG_PRINCIPAL,
    },
    agents,
  };
  const overlays = [...org.overlays];
  if (overlayIndex === undefined) overlays.push(watchdogOverlay);
  else overlays[overlayIndex] = watchdogOverlay;
  return { ...org, overlays };
}

function writeAtomic(path, contents) {
  const mode = statSync(path).mode & 0o777;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function syncCustomerOrg({
  customerAgentsRepo,
  orgChartPath = DEFAULT_ORG_CHART_PATH,
}) {
  if (!customerAgentsRepo) {
    throw new Error("--customer-agents-repo <path> is required");
  }

  const resolvedCustomerRepo = resolve(customerAgentsRepo);
  const resolvedOrgChartPath = resolve(orgChartPath);
  const teamPath = join(resolvedCustomerRepo, "customer-success/team.json");
  const { value: team } = readJson(teamPath, "customer-success team");
  const members = teamMembers(team, teamPath);
  const { contents: currentContents, value: org } = readJson(
    resolvedOrgChartPath,
    "org chart",
  );
  const nextOrg = mergeWatchdogOverlay(org, resolvedCustomerRepo, members);
  const nextContents = `${JSON.stringify(nextOrg, null, 2)}\n`;
  const changed = nextContents !== currentContents;
  if (changed) writeAtomic(resolvedOrgChartPath, nextContents);

  return {
    changed,
    customerAgentsRepo: resolvedCustomerRepo,
    memberCount: members.length,
    orgChartPath: resolvedOrgChartPath,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--customer-agents-repo") {
      options.customerAgentsRepo = argv[index + 1];
      index += 1;
    } else if (argument === "--org-chart") {
      options.orgChartPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = syncCustomerOrg(parseArgs(process.argv.slice(2)));
    const verb = result.changed ? "Updated" : "Already current";
    console.log(
      `${verb}: ${result.orgChartPath} ` +
      `(Watchdog Chief + ${result.memberCount} customer-success agents)`,
    );
  } catch (error) {
    console.error(`Customer org sync failed: ${error.message}`);
    process.exitCode = 1;
  }
}
