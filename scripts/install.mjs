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

const config = loadConfig();
activeWorkspace(config);
const cliArgs = new Set(process.argv.slice(2));

function which(command) {
  return execFileSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  }).trim();
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plist({
  label,
  args,
  stdout,
  stderr,
  environment = {},
  startInterval = null,
}) {
  const array = args.map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
  const environmentEntries = Object.entries(environment)
    .map(([key, value]) =>
      `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${array}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(REPO_ROOT)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environmentEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    ${startInterval == null ? `<key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>` : `<key>StartInterval</key>
    <integer>${startInterval}</integer>`}
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(stderr)}</string>
  </dict>
</plist>
`;
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
    stdout: join(logs, "chief-senses.log"),
    stderr: join(logs, "chief-senses.err.log"),
  },
  {
    label: "com.agentworkforce.chief.node",
    args: [agentRelay, "node", "up"],
    environment: serviceEnvironment,
    // node up has historically logged credentials. Keep launchd output out of
    // persistent logs until the workspace-convergence task closes that leak.
    stdout: "/dev/null",
    stderr: "/dev/null",
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
  const path = join(launchAgents, `${service.label}.plist`);
  writeFileSync(path, plist(service), { mode: 0o600 });
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
