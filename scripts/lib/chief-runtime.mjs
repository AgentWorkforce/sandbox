import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(LIB_DIR, "../..");
export const CONFIG_PATH = join(REPO_ROOT, "chief.config.json");

function assertRelativeRepoPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const absolute = resolve(REPO_ROOT, value);
  if (absolute !== REPO_ROOT && !absolute.startsWith(`${REPO_ROOT}/`)) {
    throw new Error(`${label} must stay inside the Chief repo`);
  }
}

export function validateConfig(config) {
  const requiredStrings = [
    ["principal.name", config?.principal?.name],
    ["principal.timezone", config?.principal?.timezone],
    ["agent.name", config?.agent?.name],
    ["agent.displayName", config?.agent?.displayName],
    ["workspace.name", config?.workspace?.name],
  ];
  for (const [label, value] of requiredStrings) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(config.agent.name)) {
    throw new Error("agent.name may only contain letters, numbers, dots, underscores, and dashes");
  }
  assertRelativeRepoPath(config.brainRoot, "brainRoot");
  assertRelativeRepoPath(config?.senses?.localDir, "senses.localDir");
  if (!Array.isArray(config?.senses?.remotePaths) || config.senses.remotePaths.length === 0) {
    throw new Error("senses.remotePaths must contain at least one Relayfile path");
  }
  if (!Array.isArray(config?.senses?.scopes) || config.senses.scopes.length === 0) {
    throw new Error("senses.scopes must contain at least one Relayfile scope");
  }
  // No `work` validation here on purpose. Which surface a task arrives on,
  // what makes it dispatchable, and whether merge is automatic are Factory's
  // to declare, per repository, in that repository's `factory.config.json`.
  // Chief previously restated them and pinned humanSystem to Linear, which
  // made a GitHub-native repo like `hoopsheet` unrepresentable.
  const recipes = config?.recipes;
  if (!recipes || typeof recipes !== "object") {
    throw new Error("recipes must define the Factory recipe Chief selects");
  }
  if (!["single", "workflow", "team"].includes(recipes.default)) {
    throw new Error("recipes.default must be single, workflow, or team");
  }
  for (const recipe of ["single", "workflow", "team"]) {
    if (typeof recipes.labels?.[recipe] !== "string" || !recipes.labels[recipe]) {
      throw new Error(`recipes.labels.${recipe} must be a non-empty label name`);
    }
  }
  return config;
}

export function loadConfig() {
  return validateConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}

export function execJson(command, args) {
  const output = execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

export function activeWorkspace(config, { switchIfNeeded = false } = {}) {
  let workspace = execJson("agent-relay", ["workspace", "active", "--json"]);
  if (workspace.name !== config.workspace.name && switchIfNeeded) {
    execFileSync("agent-relay", ["workspace", "switch", config.workspace.name], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    workspace = execJson("agent-relay", ["workspace", "active", "--json"]);
  }
  if (workspace.name !== config.workspace.name) {
    throw new Error(
      `Chief expects Agent Relay workspace "${config.workspace.name}", ` +
      `but "${workspace.name ?? "none"}" is active. Run: ` +
      `agent-relay workspace switch ${config.workspace.name}`,
    );
  }
  assertWorkspaceConvergence(workspace, config);
  return workspace;
}

export function assertWorkspaceConvergence(workspace, config) {
  const ids = {
    relaycast: workspace.relaycastWorkspaceId,
    relayfile: workspace.relayfileWorkspaceId,
    relayauth: workspace.relayauthWorkspaceId,
  };
  const missing = Object.entries(ids)
    .filter(([, value]) => typeof value !== "string" || value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Workspace is missing ${missing.join(", ")} identity`);
  }
  if (
    config.workspace.requireUnifiedDataPlaneId &&
    new Set(Object.values(ids)).size !== 1
  ) {
    throw new Error(
      "Workspace convergence invariant failed: Relaycast, Relayfile, and " +
      `RelayAuth resolve to different identities (${JSON.stringify(ids)})`,
    );
  }
}

export function cloudSession() {
  const session = execJson("agent-relay", ["cloud", "session", "--json"]);
  if (!session.apiUrl || !session.accessToken) {
    throw new Error("Agent Relay Cloud session is unavailable; run agent-relay cloud login");
  }
  return session;
}

export async function cloudRequest(session, path, init = {}) {
  const response = await fetch(
    `${session.apiUrl.replace(/\/+$/u, "")}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    },
  );
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { text: text.slice(0, 1000) };
  }
  if (!response.ok) {
    const detail = body?.error ?? body?.code ?? body?.text ?? response.statusText;
    const error = new Error(`${response.status} ${detail}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function mintSensesSession(config, workspace) {
  const session = cloudSession();
  const localDir = resolve(REPO_ROOT, config.senses.localDir);
  let mount;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      mount = await cloudRequest(
        session,
        `/api/v1/workspaces/${encodeURIComponent(workspace.relayfileWorkspaceId)}` +
          "/relayfile/mount-session",
        {
          method: "POST",
          body: JSON.stringify({
            localDir,
            remotePath: "/",
            mode: "poll",
            agentName: config.agent.name,
            scopes: config.senses.scopes,
          }),
        },
      );
      break;
    } catch (error) {
      lastError = error;
      if (error.status < 500 || attempt === 3) throw error;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, attempt * 1_000)
      );
    }
  }
  if (!mount) throw lastError ?? new Error("Cloud mount session unavailable");
  if (!mount?.relayfileToken || !mount?.relayfileBaseUrl) {
    throw new Error("Cloud returned an incomplete Relayfile mount session");
  }
  return mount;
}

export function findMountBinary() {
  const candidates = [
    join(homedir(), ".agent-relay/bin/relayfile-mount"),
    join(
      REPO_ROOT,
      "../relayfile/dist",
      process.arch === "arm64"
        ? "relayfile-mount-darwin-arm64"
        : "relayfile-mount-darwin-amd64",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const probe = spawnSync("sh", ["-c", "command -v relayfile-mount"], {
    encoding: "utf8",
  });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  throw new Error(
    "relayfile-mount binary not found; install Relayfile or build ../relayfile",
  );
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function publicWorkspace(workspace) {
  return {
    name: workspace.name,
    cloudWorkspaceId: workspace.cloudWorkspaceId,
    relaycastWorkspaceId: workspace.relaycastWorkspaceId,
    relayfileWorkspaceId: workspace.relayfileWorkspaceId,
    relayauthWorkspaceId: workspace.relayauthWorkspaceId,
  };
}
