#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  CONFIG_PATH,
  REPO_ROOT,
  activeWorkspace,
  cloudRequest,
  cloudSession,
  execJson,
  publicWorkspace,
  validateConfig,
} from "./lib/chief-runtime.mjs";

const args = new Set(process.argv.slice(2));
const nonInteractive = args.has("--non-interactive") || !process.stdin.isTTY;
const skipMount = args.has("--no-mount");
const skipServices = args.has("--no-services");
const rl = nonInteractive
  ? null
  : createInterface({ input: process.stdin, output: process.stdout });

function step(number, label) {
  console.log(`\n${number}. ${label}`);
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase() || "principal";
}

async function answer(label, fallback) {
  if (!rl) return fallback;
  const value = (await rl.question(`${label} [${fallback}]: `)).trim();
  return value || fallback;
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

function readExistingConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function starterBrain(config) {
  const root = resolve(REPO_ROOT, config.brainRoot);
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: config.principal.timezone,
  });
  const files = {
    "memory/people.md": `# People\n\n- **${config.principal.name}** — Chief's principal.\n`,
    "memory/projects.md": [
      "# Projects",
      "",
      "- **Agent Relay workspace** — one Cloud workspace resolves the durable",
      "  Relaycast, Relayfile, and RelayAuth identity used by Chief and its team.",
      "- **Chief** — the front door for the principal's agent team.",
      "",
    ].join("\n"),
    "memory/preferences.md": [
      `# Preferences — how ${config.principal.name} works`,
      "",
      "- One interface: the principal talks to Chief; Chief coordinates the team.",
      "- Linear is the human command plane. GitHub is the agent execution plane.",
      "- Earn autonomy progressively. Never merge without explicit human approval.",
      "",
    ].join("\n"),
    "memory/learnings.md": [
      "# Learnings",
      "",
      "- Durable agent identity comes from the canonical Cloud workspace, not a",
      "  process-lifetime broker room.",
      "",
    ].join("\n"),
    "memory/open-threads.md": [
      "# Open threads",
      "",
      "- Verify the canonical workspace remains converged across Relaycast,",
      "  Relayfile, and RelayAuth after a broker restart.",
      "",
    ].join("\n"),
    [`journal/daily/${today}.md`]: [
      "---",
      `date: ${today}`,
      "repos: [chief, relay, cloud]",
      "tags: [onboarding, workspace, factory]",
      "---",
      "# Daily",
      "",
      "## Decided",
      "",
      "- Linear is for humans, GitHub is for agents, and Cloud Factory bridges them.",
      "- Chief's first platform task is durable workspace convergence.",
      "",
      "## In flight",
      "",
      "- Enable and verify live Cloud Factory dispatch.",
      "",
    ].join("\n"),
  };

  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(resolve(path, ".."), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, contents);
  }
  for (const directory of ["journal/weekly", "journal/monthly", "journal/retros", "workstreams"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
}

async function ensureCloudLogin() {
  try {
    return cloudSession();
  } catch (error) {
    if (nonInteractive) throw error;
    console.log("No active Agent Relay Cloud login. Opening the login flow…");
    run("agent-relay", ["cloud", "login"]);
    return cloudSession();
  }
}

async function ensureIntegrations(session, workspace, providers) {
  const path =
    `/api/v1/workspaces/${encodeURIComponent(workspace.relayfileWorkspaceId)}` +
    "/integrations";
  let connections = await cloudRequest(session, path);
  for (const provider of providers) {
    const usable = connections.some(
      (entry) =>
        entry.provider === provider &&
        (entry.status === "ready" || entry.status === "degraded"),
    );
    if (usable) {
      console.log(`✓ ${provider}`);
      continue;
    }
    if (nonInteractive) {
      throw new Error(
        `${provider} is not connected. Run npm run setup interactively to connect it.`,
      );
    }
    console.log(`${provider} is required. Opening its connection flow…`);
    run("relayfile", [
      "integration",
      "connect",
      provider,
      "--workspace",
      workspace.name,
      "--wait-sync",
    ]);
    connections = await cloudRequest(session, path);
    if (!connections.some((entry) => entry.provider === provider)) {
      throw new Error(`${provider} connection did not appear in the workspace`);
    }
    console.log(`✓ ${provider}`);
  }
}

let exitCode = 0;
try {
  console.log("Chief onboarding");
  console.log("Linear for humans → Cloud Factory → GitHub for agents");

  step(1, "Cloud identity");
  const session = await ensureCloudLogin();
  console.log(`✓ Signed in to ${session.apiUrl}`);

  step(2, "Canonical workspace");
  const existing = readExistingConfig();
  const workspaceList = execJson("agent-relay", ["workspace", "list"]);
  const workspaceDefault =
    existing?.workspace?.name ?? workspaceList.active ?? workspaceList.workspaces?.[0];
  if (!workspaceDefault) throw new Error("No Agent Relay workspace is available");
  if (!nonInteractive) {
    console.log(`Available: ${workspaceList.workspaces.join(", ")}`);
  }
  const workspaceName = await answer("Workspace", workspaceDefault);
  if (!workspaceList.workspaces.includes(workspaceName)) {
    throw new Error(`Unknown workspace "${workspaceName}"`);
  }

  step(3, "Principal and resident Chief");
  const principalName = await answer(
    "Your name",
    existing?.principal?.name ?? userInfo().username,
  );
  const principalHandle = await answer(
    "Short handle",
    existing?.principal?.handle ?? slug(principalName),
  );
  const timezone = await answer(
    "Timezone",
    existing?.principal?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const profileSlug = slug(principalHandle);
  const config = validateConfig({
    $schema: "./schemas/chief-config.schema.json",
    principal: {
      name: principalName,
      handle: principalHandle,
      timezone,
    },
    agent: {
      name: existing?.agent?.name ?? `${profileSlug}-chief`,
      displayName: existing?.agent?.displayName ?? "Chief",
    },
    brainRoot: existing?.brainRoot ?? `principals/${profileSlug}`,
    workspace: {
      name: workspaceName,
      requireUnifiedDataPlaneId: true,
    },
    senses: existing?.senses ?? {
      localDir: "senses",
      remotePaths: ["/linear", "/github", "/digests"],
      scopes: [
        "relayfile:fs:read:/linear/**",
        "relayfile:fs:write:/linear/**",
        "relayfile:fs:read:/github/**",
        "relayfile:fs:read:/digests/**",
      ],
      refreshBeforeSeconds: 600,
    },
    work: existing?.work ?? {
      humanSystem: "linear",
      agentSystem: "github",
      factory: {
        execution: "cloud",
        teamKey: "AR",
        titlePrefix: "[factory]",
        readinessState: "Ready for Agent",
        readinessLabel: "factory-ready",
        defaultRecipe: "single",
        recipeLabels: {
          single: "agent:single",
          workflow: "agent:workflow",
          team: "agent:team",
        },
        mergePolicy: "never",
      },
    },
  });
  writeJsonAtomic(CONFIG_PATH, config);
  starterBrain(config);
  const workspace = activeWorkspace(config, { switchIfNeeded: true });
  console.log("✓ Workspace convergence verified");
  console.log(JSON.stringify(publicWorkspace(workspace), null, 2));

  step(4, "Human and agent work systems");
  await ensureIntegrations(session, workspace, ["linear", "github"]);
  run(process.execPath, [join(REPO_ROOT, "scripts/factory-control.mjs"), "bootstrap"]);
  console.log("✓ Factory readiness gate and hosted brain verified");

  step(5, "Scoped Chief senses");
  if (skipMount) {
    console.log("Skipped (--no-mount)");
  } else {
    run(process.execPath, [join(REPO_ROOT, "scripts/chief-senses.mjs"), "probe"]);
    console.log("✓ Least-privilege Relayfile session verified");
  }

  step(6, "Resident services");
  if (skipServices) {
    console.log("Skipped (--no-services)");
  } else if (process.platform !== "darwin") {
    console.log("Automatic service install currently targets macOS; run Chief manually.");
  } else {
    run(process.execPath, [join(REPO_ROOT, "scripts/install.mjs")]);
  }

  step(7, "Readiness check");
  run(process.execPath, [join(REPO_ROOT, "scripts/chief-doctor.mjs")]);

  console.log("\nChief is ready.");
  console.log("Run `npm run chief` to attach.");
  console.log(
    "A Factory task dispatches only when its Linear issue is in " +
    `"${config.work.factory.readinessState}" with the ` +
    `\`${config.work.factory.readinessLabel}\` label and a repository label; ` +
    "merge remains human-gated.",
  );
  if (!skipMount && skipServices) {
    console.log("Run `npm run senses` to keep the projections synchronized.");
  }
} catch (error) {
  exitCode = 1;
  console.error(`\nOnboarding stopped: ${error.message}`);
} finally {
  rl?.close();
}

process.exitCode = exitCode;
