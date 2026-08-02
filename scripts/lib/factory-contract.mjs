/**
 * Factory's dispatch contract, read from the target repository.
 *
 * Chief does not define what makes work dispatchable. Factory does, and it
 * publishes that per repository in `factory.config.json` at the repo root:
 * `issueSource` selects the surface, `safety` carries the opt-in gate, and
 * `linear.states` names the states used when the surface is Linear.
 *
 * Chief used to keep its own `work.factory` block describing a Linear-only
 * world — a title prefix, a team key, a readiness state. That was a
 * reimplementation of this file, and it was wrong: `hoopsheet` dispatches with
 * `issueSource: "github"`, where the readiness signal is a label on a GitHub
 * issue and there is no Linear record at all. Read the owning component's
 * config; do not restate it.
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
 * `repos.cloneRoot`, but Chief needs a root to find the config in the first
 * place, so the caller supplies one and the file may confirm it.
 */
export function repoPath(repoName, cloneRoot) {
  const bare = repoName.includes("/") ? repoName.split("/").pop() : repoName;
  return join(resolve(cloneRoot), bare);
}

/**
 * Load and normalize a repository's Factory contract.
 *
 * Returns null when the repository has no `factory.config.json` — that is a
 * meaningful answer ("this repo is not Factory-enabled"), not an error, and the
 * caller decides whether that should block.
 */
/**
 * Where a repository's contract may be declared, nearest first.
 *
 * A contract does not have to be per-repository. Most repos in a workspace
 * share one surface and one safety gate, so a single `factory.config.json` at
 * the clone root covers them all; a repo only needs its own file when it
 * differs — as `hoopsheet` does by dispatching from GitHub. Nearest wins.
 */
export function contractSearchPaths(repoName, cloneRoot) {
  return [
    join(repoPath(repoName, cloneRoot), FACTORY_CONFIG_FILENAME),
    join(resolve(cloneRoot), FACTORY_CONFIG_FILENAME),
  ];
}

export function loadFactoryContract(repoName, { cloneRoot }) {
  const root = repoPath(repoName, cloneRoot);
  const path = contractSearchPaths(repoName, cloneRoot).find((candidate) =>
    existsSync(candidate)
  );
  if (!path) return null;

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
  return {
    repo: raw.repos?.default ?? repoName,
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
export function requireFactoryContract(repoName, { cloneRoot }) {
  const contract = loadFactoryContract(repoName, { cloneRoot });
  if (contract) return contract;
  throw new Error(
    `No ${FACTORY_CONFIG_FILENAME} covers ${repoName}. Looked in ` +
    `${contractSearchPaths(repoName, cloneRoot).join(" then ")}. Chief will ` +
    "not guess a surface. Add a shared contract at the clone root to cover " +
    "every repository that dispatches the same way, or a per-repo file where " +
    "one differs — minimally " +
    '{"issueSource":"linear","safety":{"requireTitlePrefix":"[factory]",' +
    '"requireLabel":"factory","requireTeamKey":"AR"},"mergePolicy":"never"}.',
  );
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
