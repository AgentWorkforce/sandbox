#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

for (const entry of results) {
  console.log(`${entry.status.toUpperCase().padEnd(5)} ${entry.name}`);
  console.log(JSON.stringify(entry.detail, null, 2));
}

if (results.some((entry) => entry.status === "error")) process.exitCode = 1;
