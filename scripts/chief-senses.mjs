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

const command = process.argv[2] ?? "run";
const config = loadConfig();
const runtimeDir = join(REPO_ROOT, ".agentworkforce/relayfile");
const credentialPath = join(runtimeDir, "chief-mount.json");
const stateDir = join(runtimeDir, "state");
const supervisorStatePath = join(runtimeDir, "supervisor.json");
const pidPath = join(runtimeDir, "supervisor.pid");
const localDir = resolve(REPO_ROOT, config.senses.localDir);
const supervisorLockDir = join(runtimeDir, "supervisor.lock");
const supervisorCheckpointDir = join(runtimeDir, "replaced-supervisors");
const configuredMaxRssMb = Number(process.env.CHIEF_SENSES_MAX_RSS_MB ?? 1024);
const MAX_MOUNT_RSS_BYTES = Math.min(
  Number.isFinite(configuredMaxRssMb) && configuredMaxRssMb > 0
    ? configuredMaxRssMb
    : 1024,
  1024,
) * 1024 * 1024;

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

let child = null;
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
  writePrivateJson(supervisorStatePath, {
    status: child ? "running" : "starting",
    workspace: publicWorkspace(workspace),
    localDir,
    remotePaths: config.senses.remotePaths,
    credentialExpiresAt: mount.expiresAt,
    credentialRefreshedAt: new Date().toISOString(),
    mountPid: child?.pid ?? null,
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

function mountArgs(workspace, mount) {
  const args = [
    "--base-url", mount.relayfileBaseUrl,
    "--workspace", workspace.relayfileWorkspaceId,
    "--local-dir", localDir,
    "--local-layout", "scoped",
    "--creds-file", credentialPath,
    "--state-dir", stateDir,
    "--mode", "poll",
    "--interval", "30s",
    `--websocket=${once ? "false" : "true"}`,
  ];
  for (const remotePath of config.senses.remotePaths) {
    args.push("--remote-path", remotePath);
  }
  if (once) args.push("--once");
  return args;
}

async function startMount() {
  const { workspace, mount } = await coalescer.run("credentials", refreshCredentials);
  const binary = findMountBinary();
  const startedAtMs = Date.now();
  child = spawn(binary, mountArgs(workspace, mount), {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  let mountEnded = false;
  let pendingResourceRecycle = false;
  writePrivateJson(supervisorStatePath, {
    ...(readJson(supervisorStatePath) ?? {}),
    status: "running",
    mountPid: child.pid,
    startedAt: new Date().toISOString(),
    resourceCeilingBytes: MAX_MOUNT_RSS_BYTES,
    supervisorFence: lease?.token ?? null,
  });

  clearInterval(resourceTimer);
  resourceTimer = setInterval(() => {
    if (!child?.pid) return;
    let rssBytes = null;
    try {
      rssBytes = parseResidentSetBytes(execFileSync(
        "ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { encoding: "utf8" },
      ));
    } catch {
      // A process can exit between the pid check and ps; its exit handler owns recovery.
      return;
    }
    const previous = readJson(supervisorStatePath) ?? {};
    writePrivateJson(supervisorStatePath, {
      ...previous,
      measuredAt: new Date().toISOString(),
      mountRssBytes: rssBytes,
      resourceCeilingBytes: MAX_MOUNT_RSS_BYTES,
    });
    if (resourceCeilingDecision(rssBytes, MAX_MOUNT_RSS_BYTES) === "terminate") {
      console.error(
        `Chief senses mount exceeded RSS ceiling (${rssBytes} > ${MAX_MOUNT_RSS_BYTES})`,
      );
      pendingResourceRecycle = true;
      const overLimitChild = child;
      const overLimitPid = child.pid;
      child.kill("SIGTERM");
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        killTimer = null;
        if (child === overLimitChild && processIsAlive(overLimitPid)) {
          overLimitChild.kill("SIGKILL");
        }
      }, 10_000);
    }
  }, 30_000);

  function finishMount(code, signal, error = null) {
    if (mountEnded) return;
    mountEnded = true;
    clearInterval(resourceTimer);
    clearTimeout(killTimer);
    killTimer = null;
    child = null;
    const isResourceRecycle = pendingResourceRecycle;
    pendingResourceRecycle = false;
    if (Date.now() - startedAtMs >= 5 * 60_000) restartPolicy.recordHealthy();
    // A deliberate RSS-ceiling recycle is not a crash: counting it against
    // restartPolicy would trip the crash circuit breaker on a healthy mount
    // that is simply being cycled for resource hygiene.
    const decision = isResourceRecycle
      ? { action: "restart", failures: 0, delayMs: 0 }
      : restartPolicy.recordFailure();
    const previous = readJson(supervisorStatePath) ?? {};
    writePrivateJson(supervisorStatePath, {
      ...previous,
      status: stopped ? "stopped" : decision.action === "open" ? "circuit-open" : "restarting",
      mountPid: null,
      lastExit: {
        code,
        signal,
        error: error?.message ?? null,
        at: new Date().toISOString(),
      },
      restartFailures: decision.failures,
      nextRestartAt: decision.action === "restart"
        ? new Date(Date.now() + decision.delayMs).toISOString()
        : null,
    });
    if (once) process.exit(error ? 1 : (code ?? (signal ? 1 : 0)));
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
  }

  child.once("error", (error) => finishMount(null, null, error));
  child.once("exit", (code, signal) => finishMount(code, signal));
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
  if (child) child.kill(signal);
  lease?.release();
  rmSync(pidPath, { force: true });
  if (!child) process.exit(0);
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
