/**
 * Factory's dispatch contract, owned by Chief.
 *
 * Chief does not define what makes work dispatchable. Factory does, and Chief
 * keeps the active contract at its own repo root as `factory.config.json`:
 * `issueSource` selects the surface, `safety` carries the opt-in gate, and
 * `linear.states` names the states used when the surface is Linear. Factory
 * must be started with that exact file via `--config`; it performs no search.
 *
 * Chief used to keep its own `work.factory` block describing a Linear-only
 * world — a title prefix, a team key, a readiness state. That was a
 * reimplementation of this file, and it was wrong: a GitHub-native contract
 * uses a label on a GitHub issue and has no Linear record at all. Read the
 * owning component's config; do not restate it.
 *
 * @see AgentWorkforce/factory README, "Tell it what to work on"
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const FACTORY_CONFIG_FILENAME = "factory.config.json";

/** Surfaces Factory can take work from. */
export const ISSUE_SOURCES = ["linear", "github"];

const DEFAULT_READINESS_LABEL = "factory";
const DEFAULT_READY_STATE = "Ready for Agent";

/**
 * Where a repository is checked out. Factory configs carry their own
 * `repos.cloneRoot`; the caller supplies Chief's runtime root and the active
 * contract may confirm it.
 */
export function repoPath(repoName, cloneRoot) {
  const bare = repoName.includes("/") ? repoName.split("/").pop() : repoName;
  return join(resolve(cloneRoot), bare);
}

/**
 * Build the per-machine active contract written by onboarding. The committed
 * `factory.<principal>.config.json` variant carries the same content; only its
 * absolute clone root makes the split necessary.
 */
export function createFactoryContract(
  config,
  { cloneRoot, workspaceId, repos = {} } = {},
) {
  if (typeof cloneRoot !== "string" || cloneRoot.length === 0) {
    throw new Error("cloneRoot is required to generate the Factory contract");
  }
  return {
    // Omitted until workspace convergence resolves a cloud record; Factory's
    // schema treats it as optional and the node config supplies it otherwise.
    ...(workspaceId ? { workspaceId } : {}),
    issueSource: "github",
    repos: {
      ...repos,
      org: repos.org ?? "AgentWorkforce",
      cloneRoot: resolve(cloneRoot),
    },
    safety: {
      requireLabel: "factory",
      requireTitlePrefix: "[factory]",
    },
    recipes: config.recipes,
    mergePolicy: "never",
    babysitter: { enabled: true },
    terminalState: "human-review",
  };
}

/** Resolve the one active contract path supplied by Chief's runtime. */
export function resolveFactoryConfigPath(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new Error(
      "Factory config path is unset. Chief must pass its repo-owned " +
      "factory.config.json explicitly; Factory does not discover contracts.",
    );
  }
  return resolve(configPath);
}

/**
 * Load and normalize Chief's one active Factory contract for a routed repo.
 *
 * Returns null only when that exact file is absent. A target repo's cwd and
 * any sibling `factory.config.json` files have no effect.
 */
export function loadFactoryContract(repoName, { cloneRoot, configPath } = {}) {
  if (typeof cloneRoot !== "string" || cloneRoot.length === 0) {
    throw new Error("cloneRoot is required to resolve a routed repository");
  }
  const root = repoPath(repoName, cloneRoot);
  const path = resolveFactoryConfigPath(configPath);
  if (!existsSync(path)) return null;

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }

  const issueSource = raw.issueSource ?? null;
  if (issueSource !== null && !ISSUE_SOURCES.includes(issueSource)) {
    throw new Error(
      `${path} sets issueSource "${issueSource}", which is not one of ` +
      `${ISSUE_SOURCES.join(", ")}`,
    );
  }

  const safety = raw.safety ?? {};
  const repo = repoName.includes("/") || !raw.repos?.org
    ? repoName
    : `${raw.repos.org}/${repoName}`;
  const routedRepos = factoryRoutedRepos(raw.repos);
  return {
    repo,
    routesRepo: routedRepos.has(repo.toLowerCase()),
    path,
    root,
    // Null means "Factory decides at dispatch time by asking Relayfile whether
    // Linear is connected". Chief must not guess on Factory's behalf; see
    // requireIssueSource below.
    issueSource,
    safety: {
      requireLabel: safety.requireLabel ?? DEFAULT_READINESS_LABEL,
      requireTitlePrefix: safety.requireTitlePrefix ?? null,
      requireTeamKey: safety.requireTeamKey ?? null,
    },
    readyState: raw.linear?.states?.readyForAgent ?? DEFAULT_READY_STATE,
    linearStates: raw.linear?.states ?? {},
    mergePolicy: raw.mergePolicy ?? "never",
    terminalState: raw.terminalState ?? null,
    cloneRoot: raw.repos?.cloneRoot ?? resolve(cloneRoot),
  };
}

/**
 * The contract, or a refusal explaining which repo is missing it.
 */
export function requireFactoryContract(repoName, { cloneRoot, configPath } = {}) {
  const path = resolveFactoryConfigPath(configPath);
  const contract = loadFactoryContract(repoName, { cloneRoot, configPath: path });
  if (contract?.routesRepo) return contract;
  if (contract) {
    throw new Error(
      `Chief's active Factory contract at ${path} does not route ${contract.repo}. ` +
      "Add it to repos.names or one of repos.byLabel, repos.byProject, " +
      "repos.keywordRules, or repos.default. Chief will not infer routing from " +
      "file placement.",
    );
  }
  throw new Error(
    `Chief's active Factory contract is missing at ${path}; cannot route ` +
    `${repoName}. Chief will not guess a surface or search target repositories. ` +
    "Run `npm run setup` or copy the correct committed " +
    "factory.<principal>.config.json variant to factory.config.json. A minimal " +
    "contract is " +
    '{"issueSource":"linear","repos":{"org":"AgentWorkforce",' +
    '"names":["chief"]},"safety":{"requireTitlePrefix":"[factory]",' +
    '"requireLabel":"factory","requireTeamKey":"AR"},"mergePolicy":"never"}.',
  );
}

/** Reproduce Factory's configured repo set without importing Factory itself. */
function factoryRoutedRepos(repos = {}) {
  const org = typeof repos.org === "string" ? repos.org : null;
  const normalizeRepo = (repo) => {
    if (typeof repo !== "string" || repo.length === 0) return null;
    return (repo.includes("/") || !org ? repo : `${org}/${repo}`).toLowerCase();
  };
  const routed = new Set();
  const names = Array.isArray(repos.names) ? repos.names : [];
  const values = (record) =>
    record && typeof record === "object" && !Array.isArray(record)
      ? Object.values(record)
      : [];
  for (const name of names) {
    const repo = repos.overrides?.[name] ?? name;
    const normalized = normalizeRepo(repo);
    if (normalized) routed.add(normalized);
  }
  for (const repo of [
    ...values(repos.byLabel),
    ...values(repos.byProject),
    ...(Array.isArray(repos.keywordRules) ? repos.keywordRules : [])
      .map((rule) => rule?.repo),
    repos.default,
  ]) {
    const normalized = normalizeRepo(repo);
    if (normalized) routed.add(normalized);
  }
  return routed;
}

/**
 * The surface a repository's work is expressed on.
 *
 * When `issueSource` is unset, Factory resolves it at dispatch time from
 * whether Linear is authoritatively connected, and treats connection errors or
 * mid-sync states as a stop rather than a guess. Chief has no better
 * information than Factory does, so it refuses in the same way instead of
 * assuming Linear — assuming Linear is precisely the bug this replaced.
 */
export function requireIssueSource(contract) {
  if (contract.issueSource) return contract.issueSource;
  throw new Error(
    `${contract.path} does not set issueSource, so the surface for ` +
    `${contract.repo} is resolved by Factory at dispatch time and Chief ` +
    "cannot determine it here. Set issueSource explicitly to route this " +
    "repository from Chief.",
  );
}
