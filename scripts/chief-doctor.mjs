#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  REPO_ROOT,
  activeWorkspace,
  cloudRequest,
  cloudSession,
  configuredIntegrationProviders,
  loadConfig,
  processIsAlive,
  publicWorkspace,
} from "./lib/chief-runtime.mjs";
import { credentialHealth } from "./lib/senses-health.mjs";
import { watchdogHealth } from "./lib/watchdog-health.mjs";

const config = loadConfig();
const results = [];

function result(name, status, detail) {
  results.push({ name, status, detail });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

let workspace;
let session;
try {
  workspace = activeWorkspace(config);
  result("workspace", "ok", publicWorkspace(workspace));
} catch (error) {
  result("workspace", "error", error.message);
}

try {
  session = cloudSession();
  result("cloud", "ok", {
    apiUrl: session.apiUrl,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
  });
} catch (error) {
  result("cloud", "error", error.message);
}

if (workspace && session) {
  try {
    const integrations = await cloudRequest(
      session,
      `/api/v1/workspaces/${encodeURIComponent(workspace.relayfileWorkspaceId)}` +
        "/integrations",
    );
    for (const provider of configuredIntegrationProviders(config.senses.remotePaths)) {
      const matches = integrations.filter((entry) => entry.provider === provider);
      const ready = matches.some((entry) => entry.status === "ready");
      const usable = ready || matches.some((entry) => entry.status === "degraded");
      result(
        `integration:${provider}`,
        ready ? "ok" : usable ? "warn" : "error",
        {
          connections: matches.map((entry) => ({
            status: entry.status,
            syncHealthy: entry.syncHealthy,
            ingressHealthy: entry.ingressHealthy,
            lastEventAt: entry.lastEventAt,
          })),
          blocking: !usable,
          next:
            ready
              ? null
              : usable
                ? `Run \`relayfile pull --workspace ${workspace.name} --provider ${provider}\`; reconnect only if the warning persists.`
                : `Run \`npm run setup\` interactively to connect ${provider}.`,
        },
      );
    }
  } catch (error) {
    result("integrations", "error", error.message);
  }

  if (workspace.cloudWorkspaceId) {
    try {
      const [deployments, factory] = await Promise.all([
        cloudRequest(
          session,
          `/api/v1/workspaces/${encodeURIComponent(workspace.cloudWorkspaceId)}` +
            "/deployments",
        ),
        cloudRequest(
          session,
          `/api/v1/workspaces/${encodeURIComponent(workspace.cloudWorkspaceId)}` +
            "/factory/runs?limit=5",
        ),
      ]);
      const hostedBrain = deployments.agents?.find(
        (entry) =>
          entry.deployedName === "cloud-factory-brain" &&
          entry.status === "active",
      );
      const legacyLive = factory.instances?.some(
        (entry) => entry.status === "online",
      );
      result("factory", hostedBrain ? "ok" : "warn", {
        hostedBrain: hostedBrain
          ? {
              name: hostedBrain.deployedName,
              status: hostedBrain.status,
              agentId: hostedBrain.agentId,
            }
          : null,
        legacyLiveInstance: legacyLive,
        legacyInstances: factory.instances?.map((entry) => ({
          name: entry.name,
          status: entry.status,
          lastHeartbeatAt: entry.lastHeartbeatAt,
        })) ?? [],
        recentRuns: factory.runs?.map((entry) => ({
          source: entry.source,
          repository: entry.repository,
          recipe: entry.recipe,
          status: entry.status,
          lastActivityAt: entry.lastActivityAt,
        })) ?? [],
      });
    } catch (error) {
      result("factory", "warn", error.message);
    }
  }
}

const brainRoot = resolve(REPO_ROOT, config.brainRoot);
const brainFiles = [
  "memory/people.md",
  "memory/projects.md",
  "memory/preferences.md",
  "memory/learnings.md",
  "memory/open-threads.md",
];
const missingBrain = brainFiles.filter((file) => !existsSync(join(brainRoot, file)));
result(
  "brain",
  missingBrain.length === 0 ? "ok" : "error",
  missingBrain.length === 0 ? brainRoot : { brainRoot, missing: missingBrain },
);

const supervisorPidPath = join(REPO_ROOT, ".agentworkforce/relayfile/supervisor.pid");
const supervisorState = readJson(
  join(REPO_ROOT, ".agentworkforce/relayfile/supervisor.json"),
);
let supervisorPid = null;
try {
  supervisorPid = Number(readFileSync(supervisorPidPath, "utf8").trim());
} catch {
  // A missing pid file is the normal pre-install state.
}
// A live supervisor pid is not a live mount. The supervisor stays up while it
// retries a mint that RelayAuth keeps refusing, so liveness alone reported OK
// on 2026-08-04 with the mount stopped since 07-31 and its credential four days
// expired — the projection under `senses/` was stale external truth read as
// current. Report the mount and the credential, which are what Chief reads
// through.
const sensesRunning = processIsAlive(supervisorPid);
const mountRunning = supervisorState?.status === "running"
  && processIsAlive(supervisorState?.mountPid ?? null);
const credentialExpiresAt = supervisorState?.credentialExpiresAt ?? null;
const credential = credentialHealth(credentialExpiresAt);
const sensesHealthy = sensesRunning && mountRunning && credential.healthy;
const sensesNext = sensesRunning
  ? (sensesHealthy
    ? null
    : "Senses are not projecting external truth; anything under senses/ is a " +
      "stale snapshot. Check `npm run senses:status` — a mint failing with " +
      "500 mount_session_failed is the RelayAuth capacity incident, not a " +
      "local fault.")
  : "Start the senses supervisor: `npm run senses`.";
result(
  "senses",
  sensesHealthy ? "ok" : "warn",
  {
    running: sensesRunning,
    mountRunning,
    credentialExpiresAt,
    credentialHealthy: credential.healthy,
    credentialProblem: credential.problem,
    localDir: resolve(REPO_ROOT, config.senses.localDir),
    state: supervisorState,
    next: sensesNext,
  },
);

const broker = spawnSync("agent-relay", ["node", "status"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});
const brokerOutput = `${broker.stdout ?? ""}\n${broker.stderr ?? ""}`;
const brokerRunning = broker.status === 0 && /Status:\s+RUNNING/u.test(brokerOutput);
const brokerDelivery = brokerOutput.match(/Node delivery:\s+([A-Z]+)/u)?.[1] ?? null;
const brokerAgents = brokerOutput.match(/Agents:\s+(\d+)/u)?.[1] ?? null;
result(
  "broker",
  brokerRunning ? "ok" : "warn",
  {
    running: brokerRunning,
    nodeDelivery: brokerDelivery,
    agents: brokerAgents ? Number(brokerAgents) : null,
  },
);

function relayVersion(command) {
  if (!command) return null;
  const probe = spawnSync(command, ["version"], { encoding: "utf8" });
  return /agent-relay v([^\s]+)/u.exec(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`)?.[1] ?? null;
}

const shellRelayVersion = relayVersion("agent-relay");
const connection = readJson(join(REPO_ROOT, ".agentworkforce/relay/connection.json"));
let brokerBinary = null;
if (connection?.pid) {
  const command = spawnSync("ps", ["-p", String(connection.pid), "-o", "command="], {
    encoding: "utf8",
  }).stdout?.trim();
  brokerBinary = command?.split(/\s+/u)[0] ?? null;
}
const brokerRelayCommand = brokerBinary?.endsWith("agent-relay-broker")
  ? join(dirname(brokerBinary), "agent-relay")
  : brokerBinary;
const brokerRelayVersion = relayVersion(brokerRelayCommand);
const relayVersionsAligned = Boolean(
  shellRelayVersion
  && brokerRelayVersion
  && shellRelayVersion === brokerRelayVersion,
);
result(
  "relay-version",
  relayVersionsAligned ? "ok" : "error",
  {
    shell: shellRelayVersion,
    broker: brokerRelayVersion,
    brokerBinary,
    brokerRelayCommand,
    next: relayVersionsAligned
      ? null
      : "Upgrade the CLI and resident binary together, then restart the broker in a coordinated maintenance window.",
  },
);

const relayDir = join(REPO_ROOT, ".agentworkforce/relay");
let residentState = {};
try {
  const stateName = readdirSync(relayDir).find((name) => /^state-.+\.json$/u.test(name));
  residentState = stateName ? readJson(join(relayDir, stateName))?.agents ?? {} : {};
} catch {
  // The broker result above owns the missing-state explanation.
}
for (const resident of config.roster?.agents ?? []) {
  const state = residentState[resident.name];
  const alive = Boolean(state && processIsAlive(state.pid));
  result(
    `resident:${resident.name}`,
    alive ? "ok" : "error",
    alive
      ? { pid: state.pid, startedAt: state.started_at ?? null }
      : {
          declared: true,
          presentInBrokerState: Boolean(state),
          pid: state?.pid ?? null,
          next: "Run `npm run install:services`, then inspect `agent-relay node tail` before replacing the resident.",
        },
  );
}

const watchdogLabel = `gui/${process.getuid()}/com.agentworkforce.fleet-watchdog`;
const watchdog = spawnSync("launchctl", ["print", watchdogLabel], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});
const watchdogLog = join(homedir(), "Library/Logs/fleet-watchdog.log");
let watchdogLastSweepMs = null;
try {
  watchdogLastSweepMs = statSync(watchdogLog).mtimeMs;
} catch {
  // A missing log is expected before the first installed sweep.
}
const watchdogState = watchdogHealth({
  installed: watchdog.status === 0,
  lastSweepMs: watchdogLastSweepMs,
});
result(
  "watchdog",
  watchdogState.healthy ? "ok" : "error",
  {
    ...watchdogState,
    next: watchdogState.healthy
      ? null
      : "Install or restart only the watchdog with `npm run watchdog:install`; do not recycle Chief's broker.",
  },
);

for (const entry of results) {
  console.log(`${entry.status.toUpperCase().padEnd(5)} ${entry.name}`);
  console.log(JSON.stringify(entry.detail, null, 2));
}

if (results.some((entry) => entry.status === "error")) process.exitCode = 1;
