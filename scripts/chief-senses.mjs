#!/usr/bin/env node

import { spawn } from "node:child_process";
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

const command = process.argv[2] ?? "run";
const config = loadConfig();
const runtimeDir = join(REPO_ROOT, ".agentworkforce/relayfile");
const credentialPath = join(runtimeDir, "chief-mount.json");
const stateDir = join(runtimeDir, "state");
const supervisorStatePath = join(runtimeDir, "supervisor.json");
const pidPath = join(runtimeDir, "supervisor.pid");
const localDir = resolve(REPO_ROOT, config.senses.localDir);

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
if (!once) {
  const existingPid = currentSupervisorPid();
  if (processIsAlive(existingPid) && existingPid !== process.pid) {
    console.log(`Chief senses is already running (${existingPid})`);
    process.exit(0);
  }
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
}

mkdirSync(localDir, { recursive: true });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

let child = null;
let stopped = false;
let refreshTimer = null;
let restartTimer = null;

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
        await refreshCredentials();
      } catch (error) {
        console.error(`Chief senses credential refresh failed: ${error.message}`);
        refreshTimer = setTimeout(() => void refreshCredentials(), 30_000);
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
  const { workspace, mount } = await refreshCredentials();
  const binary = findMountBinary();
  child = spawn(binary, mountArgs(workspace, mount), {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  writePrivateJson(supervisorStatePath, {
    ...(readJson(supervisorStatePath) ?? {}),
    status: "running",
    mountPid: child.pid,
    startedAt: new Date().toISOString(),
  });

  child.on("exit", (code, signal) => {
    child = null;
    const previous = readJson(supervisorStatePath) ?? {};
    writePrivateJson(supervisorStatePath, {
      ...previous,
      status: stopped ? "stopped" : "restarting",
      mountPid: null,
      lastExit: { code, signal, at: new Date().toISOString() },
    });
    if (once) process.exit(code ?? (signal ? 1 : 0));
    if (!stopped) {
      restartTimer = setTimeout(() => {
        void startMount().catch((error) => {
          console.error(`Chief senses restart failed: ${error.message}`);
        });
      }, 5_000);
    }
  });
}

function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  clearTimeout(refreshTimer);
  clearTimeout(restartTimer);
  if (child) child.kill(signal);
  rmSync(pidPath, { force: true });
  if (!child) process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  if (!once) rmSync(pidPath, { force: true });
});

startMount().catch((error) => {
  console.error(`Chief senses failed: ${error.message}`);
  if (!once) rmSync(pidPath, { force: true });
  process.exit(1);
});
