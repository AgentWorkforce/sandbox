import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(LIB_DIR, "../..");

/**
 * The active roster. `teams.json` is a per-machine copy of the committed
 * `teams.<principal>.json`, and it is the only thing that says which principal
 * this machine runs.
 *
 * Chief used to keep a parallel `chief.config.json` beside it, which restated
 * the agent name the broker already spawns from, a brainRoot the principal slug
 * already implies, and a workspace name that agent-relay already resolves
 * machine-globally. Every one of those was a second source of truth for a fact
 * another system owned. What is genuinely local — the principal's identity and
 * the senses least-privilege declaration — now lives in the roster itself.
 */
export const TEAMS_PATH = join(REPO_ROOT, "teams.json");
export const LEGACY_CONFIG_PATH = join(REPO_ROOT, "chief.config.json");

/**
 * The dispatch contract Chief owns, following the same split as the roster:
 * `factory.<principal>.config.json` is committed, `factory.config.json` is the
 * per-machine copy because it carries an absolute `cloneRoot`.
 *
 * Factory resolves exactly one contract — `--config` or the file in its cwd
 * (see `src/cli/fleet.ts`). There is no per-repository lookup and no walk to a
 * clone root. Routing scope lives inside that contract's `repos` maps, never in
 * where other files happen to be placed.
 */
export const FACTORY_CONFIG_PATH = join(REPO_ROOT, "factory.config.json");

/** The checkout root Chief and every routed repository share. */
function defaultCloneRoot() {
  try {
    // In a linked worktree REPO_ROOT's parent is the worktree container, not
    // the sibling-checkout root. The common git dir still belongs to the main
    // Chief checkout, so walking up from it is stable in both layouts.
    const commonGitDir = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (commonGitDir) return resolve(REPO_ROOT, commonGitDir, "../..");
  } catch {
    // Source archives and installations without git use the normal sibling
    // layout, where Chief's parent is the checkout root.
  }
  return resolve(REPO_ROOT, "..");
}

export const CLONE_ROOT = process.env.CLONE_ROOT
  ? resolve(REPO_ROOT, process.env.CLONE_ROOT)
  : defaultCloneRoot();

/** Environment inherited by Chief-owned services and external Factory runs. */
export function factoryRuntimeEnv({
  factoryConfigPath = FACTORY_CONFIG_PATH,
  cloneRoot = CLONE_ROOT,
} = {}) {
  return {
    FACTORY_CONFIG_PATH: resolve(REPO_ROOT, factoryConfigPath),
    CLONE_ROOT: resolve(REPO_ROOT, cloneRoot),
  };
}

/** Constants, not choices: nobody configures these differently. */
const SENSES_LOCAL_DIR = "senses";
const SENSES_REFRESH_BEFORE_SECONDS = 600;
const CHIEF_ROLE = "chief of staff";
export const DEFAULT_RECIPES = Object.freeze({
  default: "single",
  labels: Object.freeze({
    single: "agent:single",
    workflow: "agent:workflow",
    team: "agent:team",
  }),
});

function assertRelativeRepoPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const absolute = resolve(REPO_ROOT, value);
  if (absolute !== REPO_ROOT && !absolute.startsWith(`${REPO_ROOT}/`)) {
    throw new Error(`${label} must stay inside the Chief repo`);
  }
}

/**
 * Derive Chief's runtime configuration from the active roster.
 *
 * Everything here is read from a fact the roster already states, or is a
 * constant. Nothing is restated from another system: the workspace comes from
 * `agent-relay workspace active`, and the Factory dispatch contract comes from
 * `factory.config.json`.
 */
function principalSlugFromBrainRoot(brainRoot) {
  if (typeof brainRoot !== "string") return null;
  const match = /^principals\/([a-z0-9][a-z0-9-]*)$/u.exec(brainRoot);
  return match?.[1] ?? null;
}

function recipesFromLegacyConfig(legacyConfig) {
  const factory = legacyConfig?.work?.factory;
  if (!factory) return DEFAULT_RECIPES;
  return {
    default: factory.defaultRecipe,
    labels: factory.recipeLabels,
  };
}

/**
 * Convert the v1 two-file configuration into the v2 roster shape without
 * widening scopes, changing agent names, or changing the selected workspace.
 * This pure function is shared by the compatibility reader and the explicit
 * migration command.
 */
export function migrateLegacyRoster(roster, legacyConfig) {
  if (roster?.principal) return roster;
  if (!legacyConfig) {
    throw new Error(
      `Legacy teams.json requires ${LEGACY_CONFIG_PATH}. Keep both files in ` +
      "place or run `npm run config:migrate -- --write` before upgrading.",
    );
  }
  const principalSlug = principalSlugFromBrainRoot(legacyConfig.brainRoot);
  if (!principalSlug) {
    throw new Error(
      "Legacy brainRoot must have the form principals/<principal-slug> before migration",
    );
  }
  const chief = roster?.agents?.find(
    (agent) => agent.name === legacyConfig?.agent?.name,
  ) ?? roster?.agents?.find((agent) => agent.role === CHIEF_ROLE);
  if (!chief) {
    throw new Error(
      `Legacy roster does not contain resident Chief ${legacyConfig?.agent?.name ?? ""}`.trim(),
    );
  }
  return {
    $schema: "./schemas/chief-team.schema.json",
    principal: {
      slug: principalSlug,
      ...legacyConfig.principal,
    },
    senses: {
      remotePaths: legacyConfig.senses?.remotePaths,
      scopes: legacyConfig.senses?.scopes,
    },
    recipes: recipesFromLegacyConfig(legacyConfig),
    workspace: {
      name: legacyConfig.workspace?.name,
      requireUnifiedDataPlaneId:
        legacyConfig.workspace?.requireUnifiedDataPlaneId ?? true,
    },
    team: roster.team,
    autoSpawn: roster.autoSpawn,
    agents: roster.agents,
  };
}

export function deriveConfig(roster, { legacyConfig = null } = {}) {
  const legacy = !roster?.principal;
  const normalizedRoster = migrateLegacyRoster(roster, legacyConfig);
  const workspacePolicy = legacyConfig?.workspace ?? normalizedRoster?.workspace;
  const slug = normalizedRoster?.principal?.slug;
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(slug)) {
    throw new Error(
      "principal.slug must be a lowercase identifier; it names the brain " +
      "directory under principals/",
    );
  }
  const configuredAgentName = legacyConfig?.agent?.name;
  const chief = normalizedRoster.agents?.find(
    (agent) => configuredAgentName && agent.name === configuredAgentName,
  ) ?? normalizedRoster.agents?.find((agent) => agent.role === CHIEF_ROLE);
  if (!chief?.name) {
    throw new Error(
      `The roster has no agent with role "${CHIEF_ROLE}", so there is no ` +
      "resident Chief to configure",
    );
  }
  return validateConfig({
    principal: { slug, ...normalizedRoster.principal },
    agent: {
      name: chief.name,
      displayName: legacyConfig?.agent?.displayName ?? "Chief",
    },
    brainRoot: legacyConfig?.brainRoot ?? `principals/${slug}`,
    workspace: workspacePolicy
      ? {
          expectedName: workspacePolicy.name ?? null,
          requireUnifiedDataPlaneId:
            workspacePolicy.requireUnifiedDataPlaneId ?? true,
        }
      : {
          expectedName: null,
          requireUnifiedDataPlaneId: true,
        },
    senses: {
      localDir: legacyConfig?.senses?.localDir ?? SENSES_LOCAL_DIR,
      refreshBeforeSeconds:
        legacyConfig?.senses?.refreshBeforeSeconds ?? SENSES_REFRESH_BEFORE_SECONDS,
      remotePaths: normalizedRoster?.senses?.remotePaths,
      scopes: normalizedRoster?.senses?.scopes,
    },
    recipes: normalizedRoster?.recipes,
    roster: normalizedRoster,
    configVersion: legacy ? 1 : 2,
  });
}

export function validateConfig(config) {
  const requiredStrings = [
    ["principal.name", config?.principal?.name],
    ["principal.timezone", config?.principal?.timezone],
    ["agent.name", config?.agent?.name],
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
  // to declare in Chief's active `factory.config.json`.
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

export function loadConfig({
  teamsPath = TEAMS_PATH,
  legacyConfigPath = LEGACY_CONFIG_PATH,
} = {}) {
  if (!existsSync(teamsPath)) {
    throw new Error(
      `No active roster at ${teamsPath}. Copy the committed variant for this ` +
      "machine's principal, e.g. `cp teams.khaliq.json teams.json`, or run " +
      "`npm run setup`.",
    );
  }
  const roster = JSON.parse(readFileSync(teamsPath, "utf8"));
  const legacyConfig = !roster?.principal && existsSync(legacyConfigPath)
    ? JSON.parse(readFileSync(legacyConfigPath, "utf8"))
    : null;
  return deriveConfig(roster, { legacyConfig });
}

export function execJson(command, args) {
  const output = execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(jsonPayload(output, `${command} ${args.join(" ")}`));
}

/**
 * agent-relay writes notices to stdout ahead of `--json` payloads — the
 * telemetry banner is the standing example, and update notices behave the same
 * way. Parsing raw stdout therefore fails on a healthy command, which stayed
 * hidden for as long as the workspace call failed earlier for its own reasons.
 *
 * Take the payload from the first structural character so a banner cannot
 * masquerade as a resolve failure.
 */
function jsonPayload(output, label) {
  const start = output.search(/[[{]/u);
  if (start === -1) {
    throw new Error(`${label} produced no JSON payload: ${output.trim() || "(empty)"}`);
  }
  return output.slice(start);
}

/**
 * The canonical workspace, as agent-relay resolves it machine-globally.
 *
 * A v2 Chief does not pin a workspace name. agent-relay owns which workspace is
 * canonical for this machine, and Chief asserting a second name was the same
 * duplicated-authority pattern that produced AR-448 — a start with no project
 * pin fell through to minting a fresh workspace. What Chief still enforces is
 * the invariant it genuinely cares about: one `rw_` identity across Relaycast,
 * Relayfile, and RelayAuth. A migrated v1 roster can temporarily preserve its
 * explicit workspace policy so an upgrade does not change behavior.
 */
export function activeWorkspace(config) {
  const workspace = execJson("agent-relay", ["workspace", "active", "--json"]);
  if (!workspace?.name) {
    throw new Error(
      "agent-relay reports no active workspace. Run `agent-relay workspace " +
      "switch <name>` to make one canonical for this machine.",
    );
  }
  assertWorkspaceConvergence(workspace, config);
  return workspace;
}

export function assertWorkspaceConvergence(workspace, config) {
  const expectedName = config?.workspace?.expectedName;
  if (expectedName && workspace?.name !== expectedName) {
    throw new Error(
      `Chief expects Agent Relay workspace "${expectedName}", but ` +
      `"${workspace?.name ?? "none"}" is active. Run: ` +
      `agent-relay workspace switch ${expectedName}`,
    );
  }
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
  // v2 rosters enforce one durable data-plane identity. During the one-release
  // compatibility window, a v1 config keeps its explicit setting so pulling
  // this change cannot take Will's existing Chief offline.
  if (
    config?.workspace?.requireUnifiedDataPlaneId !== false &&
    new Set(Object.values(ids)).size !== 1
  ) {
    throw new Error(
      "Workspace convergence invariant failed: Relaycast, Relayfile, and " +
      `RelayAuth resolve to different identities (${JSON.stringify(ids)})`,
    );
  }
}

export function cloudSession() {
  // `--json` masks the access token as `cld_at_…suffix` on builds that carry the
  // mask. Without --reveal-token every authenticated call there fails inside
  // fetch with a ByteString error, because the mask's ellipsis is not Latin-1 —
  // an unreadable way to be told the token was never real.
  //
  // The flag arrived after the mask, so a build old enough to print the raw
  // token rejects it outright (`unknown option '--reveal-token'`). Ask for it,
  // and fall back to plain `--json` when the CLI does not know it; the check
  // below is what actually decides whether the token is usable, on either build.
  let session;
  try {
    session = execJson("agent-relay", ["cloud", "session", "--json", "--reveal-token"]);
  } catch (error) {
    if (!/unknown option .*--reveal-token/u.test(String(error?.stderr ?? error?.message ?? ""))) {
      throw error;
    }
    session = execJson("agent-relay", ["cloud", "session", "--json"]);
  }
  if (!session.apiUrl || !session.accessToken) {
    throw new Error("Agent Relay Cloud session is unavailable; run agent-relay cloud login");
  }
  if (session.accessToken.includes("…")) {
    throw new Error(
      "Agent Relay Cloud returned a masked access token. This build of " +
      "agent-relay masks it and did not honor --reveal-token; upgrade agent-relay",
    );
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
  } catch (error) {
    // EPERM means the pid exists but is owned by another user, not that it
    // is dead. Treating EPERM as "dead" risks two live supervisors both
    // believing the lease is free.
    return error?.code === "EPERM";
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

/**
 * Provider integrations implied by Chief's scoped Relayfile projection.
 * Digests are derived output, not a provider connection of their own.
 */
export function configuredIntegrationProviders(remotePaths = []) {
  const providers = new Set();
  for (const remotePath of remotePaths) {
    const provider = /^\/([a-z0-9-]+)(?:\/|$)/u.exec(remotePath)?.[1];
    if (provider && provider !== "digests") providers.add(provider);
  }
  return [...providers];
}
