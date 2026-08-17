#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLONE_ROOT,
  FACTORY_CONFIG_PATH,
  REPO_ROOT,
  activeWorkspace,
  factoryRuntimeEnv,
  loadConfig,
} from "./lib/chief-runtime.mjs";
import { ensurePrivateLog, plist } from "./lib/launchd.mjs";

const config = loadConfig();
activeWorkspace(config);
const cliArgs = new Set(process.argv.slice(2));

function which(command) {
  return execFileSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  }).trim();
}

const uid = process.getuid();
const domain = `gui/${uid}`;
const launchAgents = join(homedir(), "Library/LaunchAgents");
const logs = join(homedir(), "Library/Logs");
mkdirSync(launchAgents, { recursive: true });
mkdirSync(logs, { recursive: true });
const agentRelay = which("agent-relay");
const relayfile = which("relayfile");
const claude = which("claude");
const runtimePath = Array.from(new Set([
  dirname(process.execPath),
  dirname(agentRelay),
  dirname(relayfile),
  dirname(claude),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
])).join(":");
const serviceEnvironment = {
  PATH: runtimePath,
  ...factoryRuntimeEnv({
    factoryConfigPath: FACTORY_CONFIG_PATH,
    cloneRoot: CLONE_ROOT,
  }),
};

const allServices = [
  {
    label: "com.agentworkforce.chief.senses",
    args: [process.execPath, join(REPO_ROOT, "scripts/chief-senses.mjs"), "run"],
    environment: serviceEnvironment,
    resident: true,
    stdout: join(logs, "chief-senses.log"),
    stderr: join(logs, "chief-senses.err.log"),
  },
  {
    label: "com.agentworkforce.chief.node",
    args: [
      process.execPath,
      join(REPO_ROOT, "scripts/chief-node-supervisor.mjs"),
      agentRelay,
      "node",
      "up",
    ],
    environment: serviceEnvironment,
    resident: true,
    // The supervisor gives the exact broker PID 8 seconds to exit before its
    // SIGKILL backstop. Keep launchd from killing the supervisor first.
    exitTimeout: 20,
    // node up has historically logged credentials on stdout, so stdout stays
    // out of persistent logs until the workspace-convergence task closes that
    // leak. stderr goes to an owner-only log so a KeepAlive respawn loop is
    // observable rather than silent. The supervisor owns the broker PID as
    // well as the CLI wrapper, so a wedged broker cannot outlive a restart.
    stdout: "/dev/null",
    stderr: join(logs, "chief-node.log"),
  },
  {
    label: "com.agentworkforce.fleet-watchdog",
    args: [
      process.execPath,
      join(REPO_ROOT, "tools/watchdog/fleet-watchdog.mjs"),
      "--quiet",
    ],
    environment: {
      ...serviceEnvironment,
      WATCHDOG_CHIEF_REPO: REPO_ROOT,
    },
    stdout: join(logs, "fleet-watchdog-run.log"),
    stderr: join(logs, "fleet-watchdog-run.log"),
    startInterval: 600,
  },
];
const services = cliArgs.has("--watchdog-only")
  ? allServices.filter((service) => service.label === "com.agentworkforce.fleet-watchdog")
  : allServices;

for (const service of services) {
  ensurePrivateLog(service.stdout);
  ensurePrivateLog(service.stderr);
  const path = join(launchAgents, `${service.label}.plist`);
  writeFileSync(path, plist({ ...service, workingDirectory: REPO_ROOT }), { mode: 0o600 });
  chmodSync(path, 0o600);
  try {
    execFileSync("launchctl", ["bootout", domain, path], { stdio: "ignore" });
  } catch {
    // An absent prior service is the normal first-install case.
  }
  execFileSync("launchctl", ["bootstrap", domain, path]);
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/${service.label}`]);
  console.log(`Installed and started ${service.label}`);
}

if (cliArgs.has("--watchdog-only")) {
  console.log("Watchdog installed without restarting Chief's resident services.");
} else {
  console.log(`Chief is configured for ${config.principal.name}.`);
  console.log("Run `npm run doctor` to verify, then `npm run chief` to attach.");
}
