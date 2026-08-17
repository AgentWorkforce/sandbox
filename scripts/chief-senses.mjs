#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  REPO_ROOT,
  activeWorkspace,
  findMountBinary,
  loadConfig,
  mintSensesSession,
  processIsAlive,
  publicWorkspace,
} from "./lib/chief-runtime.mjs";
import {
  acquireSupervisorLease,
  circuitOpenExitCode,
  createBoundedCoalescer,
  createRestartPolicy,
  parseResidentSetBytes,
  resourceCeilingDecision,
} from "./lib/supervisor-guard.mjs";
import {
  exactSensesMountPlan,
  mountPidsFromGeneration,
} from "./lib/senses-mount-plan.mjs";

const command = process.argv[2] ?? "run";
const config = loadConfig();
const runtimeDir = join(REPO_ROOT, ".agentworkforce/relayfile");
const credentialPath = join(runtimeDir, "chief-mount.json");
const stateDir = join(runtimeDir, "state");
const supervisorStatePath = join(runtimeDir, "supervisor.json");
const pidPath = join(runtimeDir, "supervisor.pid");
const localDir = resolve(REPO_ROOT, config.senses.localDir);
const mountPlan = exactSensesMountPlan({
  remotePaths: config.senses.remotePaths,
  localRoot: localDir,
  stateRoot: stateDir,
});
const supervisorLockDir = join(runtimeDir, "supervisor.lock");
const supervisorCheckpointDir = join(runtimeDir, "replaced-supervisors");
const configuredMaxRssMb = Number(process.env.CHIEF_SENSES_MAX_RSS_MB ?? 1024);
const MAX_MOUNT_RSS_BYTES = Math.min(
  Number.isFinite(configuredMaxRssMb) && configuredMaxRssMb > 0
    ? configuredMaxRssMb
    : 1024,
  1024,
) * 1024 * 1024;
// Websocket events provide the normal freshness path. The interval is a
// safety audit, not a reason to rescan a large local mirror every 30 seconds.
const SENSES_SYNC_INTERVAL =
  process.env.CHIEF_SENSES_SYNC_INTERVAL?.trim() || "5m";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writePrivateJson(path, value) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function currentSupervisorPid() {
  try {
    return Number(readFileSync(pidPath, "utf8").trim());
  } catch {
    return null;
  }
}

function printStatus() {
  const pid = currentSupervisorPid();
  const state = readJson(supervisorStatePath);
  console.log(JSON.stringify({
    running: processIsAlive(pid),
    pid: processIsAlive(pid) ? pid : null,
    localDir,
    remotePaths: config.senses.remotePaths,
    state,
  }, null, 2));
}

if (command === "status") {
  printStatus();
  process.exit(0);
}

if (command === "stop") {
  const pid = currentSupervisorPid();
  if (processIsAlive(pid)) process.kill(pid, "SIGTERM");
  else rmSync(pidPath, { force: true });
  console.log(pid ? `Stopping Chief senses supervisor (${pid})` : "Chief senses is stopped");
  process.exit(0);
}

if (command === "probe") {
  try {
    const workspace = activeWorkspace(config);
    const mount = await mintSensesSession(config, workspace);
    console.log(JSON.stringify({
      workspace: publicWorkspace(workspace),
      relayfileUrl: mount.relayfileBaseUrl,
      localDir,
      remotePaths: config.senses.remotePaths,
      scopes: mount.scopes,
      expiresAt: mount.expiresAt,
    }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`Chief senses probe failed: ${error.message}`);
    process.exit(1);
  }
}

const once = command === "once";
let lease = null;
if (!once) {
  try {
    lease = acquireSupervisorLease({
      lockDir: supervisorLockDir,
      checkpointDir: supervisorCheckpointDir,
      owner: config.agent.name,
      isProcessAlive: processIsAlive,
    });
  } catch (error) {
    console.error(error.message);
    // Only genuine lease contention (another live owner, or a lost takeover
    // race) is a benign reason to stand down. Any other failure (EACCES,
    // ENOSPC, a corrupted lease file, ...) is a transient fault: exiting 0
    // would tell launchd's SuccessfulExit=false contract this job is done,
    // permanently disabling it. Exit non-zero so launchd retries instead.
    process.exit(error?.code === "LEASE_CONTENDED" ? 0 : 1);
  }
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
}

mkdirSync(localDir, { recursive: true });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

let generation = null;
let stopped = false;
let refreshTimer = null;
let restartTimer = null;
let leaseTimer = null;
let resourceTimer = null;
let killTimer = null;
const coalescer = createBoundedCoalescer({ maxPending: 2 });
const restartPolicy = createRestartPolicy();

if (lease) {
  leaseTimer = setInterval(() => {
    try {
      lease.renew();
    } catch (error) {
      console.error(`Chief senses lease lost: ${error.message}`);
      shutdown("SIGTERM");
    }
  }, 30_000);
}

async function refreshCredentials() {
  const workspace = activeWorkspace(config);
  const mount = await mintSensesSession(config, workspace);
  writePrivateJson(credentialPath, {
    relayfileUrl: mount.relayfileBaseUrl,
    relayfileWorkspaceId: mount.workspaceId,
    relayfileToken: mount.relayfileToken,
    relayfileTokenExpiresAt: mount.expiresAt,
    scopes: mount.scopes,
    agentName: config.agent.name,
    updatedAt: new Date().toISOString(),
  });
  const mountPids = mountPidsFromGeneration(generation);
  writePrivateJson(supervisorStatePath, {
    status: generation && !generation.ended ? "running" : "starting",
    workspace: publicWorkspace(workspace),
    localDir,
    remotePaths: config.senses.remotePaths,
    credentialExpiresAt: mount.expiresAt,
    credentialRefreshedAt: new Date().toISOString(),
    mountPid: Object.values(mountPids)[0] ?? null,
    mountPids,
  });

  if (!once) {
    const refreshBeforeMs =
      (config.senses.refreshBeforeSeconds ?? 600) * 1000;
    const suggested = Date.parse(mount.suggestedRefreshAt ?? mount.expiresAt);
    const fallback = Date.now() + 30 * 60_000;
    const nextAt = Number.isFinite(suggested)
      ? Math.max(Date.now() + 60_000, suggested - refreshBeforeMs)
      : fallback;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        await coalescer.run("credentials", refreshCredentials);
      } catch (error) {
        console.error(`Chief senses credential refresh failed: ${error.message}`);
        refreshTimer = setTimeout(
          () => void coalescer.run("credentials", refreshCredentials),
          30_000,
        );
      }
    }, nextAt - Date.now());
  }
  return { workspace, mount };
}

function mountArgs(workspace, mount, spec) {
  const args = [
    "--base-url", mount.relayfileBaseUrl,
    "--workspace", workspace.relayfileWorkspaceId,
    "--local-dir", spec.localDir,
    "--local-layout", "exact",
    "--creds-file", credentialPath,
    "--state-dir", spec.stateDir,
    "--mode", "poll",
    "--interval", SENSES_SYNC_INTERVAL,
    "--low-memory",
    `--websocket=${once ? "false" : "true"}`,
  ];
  args.push("--remote-path", spec.remotePath);
  if (once) args.push("--once");
  return args;
}

async function startMount() {
  const { workspace, mount } = await coalescer.run("credentials", refreshCredentials);
  const binary = findMountBinary();
  const startedAtMs = Date.now();
  const current = {
    children: new Map(),
    endedPaths: new Set(),
    exits: new Map(),
    ended: false,
    finishing: false,
    firstExit: null,
    pendingResourceRecycle: false,
  };
  generation = current;

  const signalRemaining = (signal) => {
    for (const [remotePath, mountChild] of current.children) {
      if (!current.endedPaths.has(remotePath)) mountChild.kill(signal);
    }
  };

  const armKillEscalation = () => {
    clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      killTimer = null;
      if (generation !== current || current.ended) return;
      for (const [remotePath, mountChild] of current.children) {
        if (
          !current.endedPaths.has(remotePath)
          && processIsAlive(mountChild.pid)
        ) {
          mountChild.kill("SIGKILL");
        }
      }
    }, 10_000);
  };

  const finishGeneration = () => {
    if (current.ended) return;
    current.ended = true;
    clearInterval(resourceTimer);
    clearTimeout(killTimer);
    killTimer = null;
    if (generation === current) generation = null;

    const exit = current.firstExit
      ?? [...current.exits.values()].find((entry) =>
        entry.error || entry.signal || entry.code !== 0)
      ?? [...current.exits.values()][0]
      ?? { remotePath: null, code: null, signal: null, error: null };
    const isResourceRecycle = current.pendingResourceRecycle;
    if (Date.now() - startedAtMs >= 5 * 60_000) restartPolicy.recordHealthy();
    // Match Pear's bounded restart contract. Routine resource hygiene can
    // recycle a complete mount generation immediately; real child exits still
    // accumulate backoff and eventually open the circuit.
    const decision = stopped
      ? { action: "stopped", failures: 0, delayMs: 0 }
      : isResourceRecycle
        ? { action: "restart", failures: 0, delayMs: 0 }
        : restartPolicy.recordFailure();
    const previous = readJson(supervisorStatePath) ?? {};
    writePrivateJson(supervisorStatePath, {
      ...previous,
      status: stopped || once
        ? "stopped"
        : decision.action === "open" ? "circuit-open" : "restarting",
      mountPid: null,
      mountPids: {},
      lastExit: {
        remotePath: exit.remotePath,
        code: exit.code,
        signal: exit.signal,
        error: exit.error?.message ?? null,
        at: new Date().toISOString(),
      },
      restartFailures: decision.failures,
      nextRestartAt: decision.action === "restart"
        ? new Date(Date.now() + decision.delayMs).toISOString()
        : null,
    });

    if (once) {
      const failed = [...current.exits.values()].some((entry) =>
        entry.error || entry.signal || entry.code !== 0);
      process.exit(failed ? 1 : 0);
    }
    if (!stopped && decision.action === "open") {
      stopped = true;
      clearInterval(leaseTimer);
      lease?.release();
      rmSync(pidPath, { force: true });
      // Successful exit intentionally keeps launchd's SuccessfulExit=false job down.
      process.exit(circuitOpenExitCode(decision));
    }
    if (!stopped) {
      restartTimer = setTimeout(() => {
        void startWithRecovery();
      }, decision.delayMs);
    }
  };

  const finishMount = (remotePath, code, signal, error = null) => {
    if (current.ended || current.endedPaths.has(remotePath)) return;
    current.endedPaths.add(remotePath);
    const detail = { remotePath, code, signal, error };
    current.exits.set(remotePath, detail);

    if (!once && !current.finishing) {
      current.finishing = true;
      current.firstExit = detail;
      signalRemaining("SIGTERM");
      armKillEscalation();
    }
    if (current.endedPaths.size === current.children.size) {
      finishGeneration();
    }
  };

  for (const spec of mountPlan) {
    mkdirSync(spec.localDir, { recursive: true });
    mkdirSync(spec.stateDir, { recursive: true, mode: 0o700 });
    // A provider tree can need a large initial audit. Keep that maintenance
    // below interactive Chief/Skip work in the OS scheduler even if several
    // exact mounts are reconciling at the same time.
    const mountChild = spawn(
      "/usr/bin/nice",
      ["-n", "10", binary, ...mountArgs(workspace, mount, spec)],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: process.env,
      },
    );
    current.children.set(spec.remotePath, mountChild);
    mountChild.once("error", (error) =>
      finishMount(spec.remotePath, null, null, error));
    mountChild.once("exit", (code, signal) =>
      finishMount(spec.remotePath, code, signal));
  }

  const mountPids = mountPidsFromGeneration(current);
  writePrivateJson(supervisorStatePath, {
    ...(readJson(supervisorStatePath) ?? {}),
    status: "running",
    mountPid: Object.values(mountPids)[0] ?? null,
    mountPids,
    startedAt: new Date().toISOString(),
    resourceCeilingBytes: MAX_MOUNT_RSS_BYTES,
    supervisorFence: lease?.token ?? null,
  });

  clearInterval(resourceTimer);
  resourceTimer = setInterval(() => {
    if (generation !== current || current.ended) return;
    const mountRssBytesByPath = {};
    for (const [remotePath, mountChild] of current.children) {
      try {
        mountRssBytesByPath[remotePath] = parseResidentSetBytes(execFileSync(
          "ps",
          ["-o", "rss=", "-p", String(mountChild.pid)],
          { encoding: "utf8" },
        ));
      } catch {
        // A process can exit between the pid check and ps; its exit handler owns recovery.
      }
    }
    const rssValues = Object.values(mountRssBytesByPath)
      .filter((value) => Number.isFinite(value));
    const rssBytes = rssValues.length > 0
      ? rssValues.reduce((total, value) => total + value, 0)
      : null;
    const previous = readJson(supervisorStatePath) ?? {};
    writePrivateJson(supervisorStatePath, {
      ...previous,
      measuredAt: new Date().toISOString(),
      mountRssBytes: rssBytes,
      mountRssBytesByPath,
      resourceCeilingBytes: MAX_MOUNT_RSS_BYTES,
    });
    if (
      !current.finishing
      && resourceCeilingDecision(rssBytes, MAX_MOUNT_RSS_BYTES) === "terminate"
    ) {
      const error = new Error(
        `aggregate RSS ${rssBytes} exceeded ${MAX_MOUNT_RSS_BYTES}`,
      );
      console.error(
        `Chief senses mounts exceeded RSS ceiling (${rssBytes} > ${MAX_MOUNT_RSS_BYTES})`,
      );
      current.pendingResourceRecycle = true;
      current.finishing = true;
      current.firstExit = {
        remotePath: null,
        code: null,
        signal: "SIGTERM",
        error,
      };
      signalRemaining("SIGTERM");
      armKillEscalation();
    }
  }, 30_000);
}

async function startWithRecovery() {
  try {
    await coalescer.run("mount-start", startMount);
  } catch (error) {
    const decision = restartPolicy.recordFailure();
    console.error(`Chief senses start failed: ${error.message}`);
    writePrivateJson(supervisorStatePath, {
      ...(readJson(supervisorStatePath) ?? {}),
      status: decision.action === "open" ? "circuit-open" : "restarting",
      mountPid: null,
      mountPids: {},
      restartFailures: decision.failures,
      lastStartError: { message: error.message, at: new Date().toISOString() },
      nextRestartAt: decision.action === "restart"
        ? new Date(Date.now() + decision.delayMs).toISOString()
        : null,
    });
    if (once) process.exit(1);
    if (decision.action === "open") {
      stopped = true;
      clearInterval(leaseTimer);
      lease?.release();
      rmSync(pidPath, { force: true });
      process.exit(circuitOpenExitCode(decision));
    }
    restartTimer = setTimeout(() => void startWithRecovery(), decision.delayMs);
  }
}

function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  clearTimeout(refreshTimer);
  clearTimeout(restartTimer);
  clearTimeout(killTimer);
  clearInterval(leaseTimer);
  clearInterval(resourceTimer);
  if (generation && !generation.ended) {
    for (const mountChild of generation.children.values()) mountChild.kill(signal);
  }
  lease?.release();
  rmSync(pidPath, { force: true });
  if (!generation || generation.ended) process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  if (!once) {
    lease?.release();
    rmSync(pidPath, { force: true });
  }
});

void startWithRecovery();
