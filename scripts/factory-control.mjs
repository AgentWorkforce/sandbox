#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  activeWorkspace,
  cloudRequest,
  cloudSession,
  loadConfig,
  mintSensesSession,
  REPO_ROOT,
} from "./lib/chief-runtime.mjs";

const command = process.argv[2] ?? "status";
const config = loadConfig();
// Resolved by `connect()` inside the try below, not at module load: a failure
// to reach the workspace or mint a mount session is an operational error that
// belongs in the same friendly handler as everything else, not an unhandled
// rejection printed as a Node stack trace.
let workspace;
let mount;
let relayfileBase;
let relayfileWorkspace;

async function connect() {
  workspace = activeWorkspace(config, { switchIfNeeded: true });
  mount = await resolveFactoryMount();
  relayfileBase = mount.relayfileBaseUrl.replace(/\/+$/u, "");
  relayfileWorkspace = workspace.relayfileWorkspaceId;
}

async function resolveFactoryMount() {
  const cachePath = resolve(
    REPO_ROOT,
    ".agentworkforce/relayfile/chief-mount.json",
  );
  let cached;
  try {
    cached = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    cached = null;
  }
  const requiredScopes = config.senses.scopes;
  const expiresAt = Date.parse(cached?.relayfileTokenExpiresAt ?? "");
  const usable =
    typeof cached?.relayfileToken === "string" &&
    cached.relayfileToken.length > 0 &&
    typeof cached.relayfileUrl === "string" &&
    cached.relayfileUrl.length > 0 &&
    cached.relayfileWorkspaceId === workspace.relayfileWorkspaceId &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() + 60_000 &&
    Array.isArray(cached.scopes) &&
    requiredScopes.every((scope) => cached.scopes.includes(scope));
  if (usable) {
    return {
      relayfileToken: cached.relayfileToken,
      relayfileBaseUrl: cached.relayfileUrl,
    };
  }
  return mintSensesSession(config, workspace);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function aliasSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

async function relayfileRequest(path, init = {}, { allowNotFound = false } = {}) {
  const response = await fetch(`${relayfileBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${mount.relayfileToken}`,
      "x-correlation-id": randomUUID(),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 1000) };
  }
  if (response.status === 404 && allowNotFound) return null;
  if (!response.ok) {
    throw new Error(
      `Relayfile ${response.status}: ${body?.message ?? body?.code ?? response.statusText}`,
    );
  }
  return body;
}

async function readRemoteJson(remotePath, { allowNotFound = false } = {}) {
  const query = new URLSearchParams({ path: remotePath });
  const file = await relayfileRequest(
    `/v1/workspaces/${encodeURIComponent(relayfileWorkspace)}/fs/file?${query}`,
    {},
    { allowNotFound },
  );
  if (!file) return null;
  return JSON.parse(file.content);
}

async function listOperations({ provider, path, correlationId } = {}) {
  const query = new URLSearchParams({ limit: "200" });
  if (provider) query.set("provider", provider);
  const feed = await relayfileRequest(
    `/v1/workspaces/${encodeURIComponent(relayfileWorkspace)}/ops?${query}`,
  );
  return (feed.items ?? []).filter((operation) => {
    if (path && operation.path !== path) return false;
    if (correlationId && operation.correlationId !== correlationId) return false;
    return true;
  });
}

async function waitForOperationAdmission(
  remotePath,
  correlationId,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [operation] = await listOperations({
      provider: "linear",
      path: remotePath,
      correlationId,
    });
    if (operation) return operation;
    await delay(500);
  }
  throw new Error(
    `Relayfile accepted ${remotePath} but did not expose its provider operation`,
  );
}

async function waitForOperation(opId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await relayfileRequest(
      `/v1/workspaces/${encodeURIComponent(relayfileWorkspace)}` +
        `/ops/${encodeURIComponent(opId)}`,
    );
    if (["succeeded", "completed"].includes(operation.status)) {
      return operation;
    }
    if (["failed", "dead_lettered", "canceled"].includes(operation.status)) {
      throw new Error(
        `Relayfile provider writeback ${opId} ${operation.status}: ` +
        `${operation.lastError ?? "provider mutation was not acknowledged"}`,
      );
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Relayfile writeback ${opId}`);
}

async function writeProviderMutation(
  remotePath,
  payload,
  identityKind = "chief-provider-mutation",
  { requireNewOperation = true } = {},
) {
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const response = await relayfileRequest(
    `/v1/workspaces/${encodeURIComponent(relayfileWorkspace)}/fs/bulk`,
    {
      method: "POST",
      body: JSON.stringify({
        files: [{
          path: remotePath,
          contentType: "application/json",
          content,
          encoding: "utf-8",
          contentIdentity: {
            kind: identityKind,
            key: `${relayfileWorkspace}:${remotePath}:${digest}`,
            ttlSeconds: 2_592_000,
          },
        }],
      }),
    },
  );
  if (response.errorCount > 0 || response.errors?.length > 0) {
    throw new Error(`Relayfile rejected ${remotePath}`);
  }
  if (response.operationCountDelta < 1) {
    if (!requireNewOperation) return null;
    throw new Error(
      `Relayfile stored ${remotePath} without creating a provider operation`,
    );
  }
  const admitted = await waitForOperationAdmission(
    remotePath,
    response.correlationId,
  );
  return waitForOperation(admitted.opId);
}

async function writeCreateDraft(remotePath, payload) {
  return writeProviderMutation(
    remotePath,
    payload,
    "mount-writeback-create-draft",
  );
}

function createReceipt(value) {
  const record = value?.payload ?? value;
  if (
    record &&
    typeof record === "object" &&
    typeof record.created === "string" &&
    (record.path || record.id || record.externalId)
  ) {
    return record;
  }
  return null;
}

async function waitForCreateReceipt(remotePath, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readRemoteJson(remotePath, { allowNotFound: true });
    const receipt = createReceipt(value);
    if (receipt) return receipt;
    await delay(500);
  }
  throw new Error(
    `Provider operation succeeded but ${remotePath} did not materialize its receipt`,
  );
}

async function resolveTeam() {
  const rows = await readRemoteJson("/linear/teams/_index.json");
  for (const row of rows) {
    const team = await readRemoteJson(`/linear/teams/${row.id}.json`);
    const record = team.payload ?? team;
    if (record.key === config.work.factory.teamKey) return record;
    if (
      !record.key &&
      config.work.factory.teamKey === "AR" &&
      record.name === "Agent Relay"
    ) {
      return record;
    }
  }
  throw new Error(`Linear team ${config.work.factory.teamKey} was not found`);
}

async function findLabel(names) {
  for (const name of [...new Set(names.filter(Boolean))]) {
    const alias = `/linear/labels/by-name/${aliasSlug(name)}.json`;
    const value = await readRemoteJson(alias, { allowNotFound: true });
    const record = value?.payload ?? value;
    if (record?.id) return record;
  }
  return null;
}

const RECIPE_LABEL_DEFINITIONS = {
  single: {
    description: "Factory recipe: one implementation agent with verification.",
    color: "#26B5CE",
  },
  workflow: {
    description: "Factory recipe: staged implementation and review workflow.",
    color: "#F2C94C",
  },
  team: {
    description: "Factory recipe: coordinated specialist agent team.",
    color: "#BB87FC",
  },
};

async function ensureRecipeLabel(team, recipe) {
  const name = config.work.factory.recipeLabels[recipe];
  if (!name) return null;
  const existing = await findLabel([name]);
  if (existing?.id) return existing;

  const definition = RECIPE_LABEL_DEFINITIONS[recipe];
  const draftPath = `/linear/labels/factory-create-${aliasSlug(name)}.json`;
  let receipt = createReceipt(
    await readRemoteJson(draftPath, { allowNotFound: true }),
  );
  if (!receipt) {
    await writeCreateDraft(draftPath, {
      name,
      description: definition?.description,
      color: definition?.color,
      teamId: team.id,
    });
    receipt = await waitForCreateReceipt(draftPath);
  }
  const id = receipt.id ?? receipt.externalId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Linear created ${name} but returned no label id`);
  }
  return { id, name };
}

async function resolveReadyState() {
  const states = await readRemoteJson("/linear/states/_index.json");
  const state = states.find(
    (candidate) => candidate.title === config.work.factory.readinessState,
  );
  if (!state) {
    throw new Error(
      `Linear state ${config.work.factory.readinessState} was not found`,
    );
  }
  return state;
}

async function bootstrap() {
  const team = await resolveTeam();
  const state = await resolveReadyState();
  const readinessLabel = await findLabel([
    config.work.factory.readinessLabel,
    "factory-ready",
    "factory",
  ]);
  if (!readinessLabel) {
    throw new Error(
      "No Factory readiness label exists. Create `factory-ready` or `factory` " +
      "in Linear, then rerun onboarding.",
    );
  }
  const deployment = await factoryDeployment();
  if (!deployment) {
    throw new Error("cloud-factory-brain is not active in this workspace");
  }
  console.log(`✓ Linear team ${config.work.factory.teamKey}`);
  console.log(`✓ Linear state ${state.title}`);
  console.log(`✓ Linear label ${readinessLabel.name}`);
  console.log("✓ Hosted Cloud Factory brain active");
  return { team, state, readinessLabel, deployment };
}

async function factoryDeployment() {
  const session = cloudSession();
  const deployments = await cloudRequest(
    session,
    `/api/v1/workspaces/${encodeURIComponent(workspace.cloudWorkspaceId)}/deployments`,
  );
  return deployments.agents?.find(
    (agent) => agent.deployedName === "cloud-factory-brain" && agent.status === "active",
  ) ?? null;
}

async function status() {
  const { team, state, readinessLabel, deployment } = await bootstrap();
  console.log(JSON.stringify({
    ready: true,
    workspace: {
      name: workspace.name,
      cloudWorkspaceId: workspace.cloudWorkspaceId,
      dataPlaneWorkspaceId: workspace.relaycastWorkspaceId,
    },
    linear: {
      team: { id: team.id, key: config.work.factory.teamKey, name: team.name },
      readinessState: { id: state.id, name: state.title },
      readinessLabel: { id: readinessLabel.id, name: readinessLabel.name },
      defaultRecipe: config.work.factory.defaultRecipe,
    },
    deployment: {
      agentId: deployment.agentId,
      name: deployment.deployedName,
      status: deployment.status,
    },
    mergePolicy: config.work.factory.mergePolicy,
  }, null, 2));
}

async function createWorkspaceConvergenceTask() {
  const { team, state, readinessLabel, deployment } = await bootstrap();
  const repoLabel = await readRemoteJson("/linear/labels/by-name/relay.json");
  const repoLabelRecord = repoLabel?.payload ?? repoLabel;
  if (!repoLabelRecord?.id) throw new Error("Linear repository label relay was not found");

  const title = "[factory] Make Relay workspace identity durable across node restarts";
  const existingIssues = await readRemoteJson("/linear/issues/_index.json");
  const existing = existingIssues.find((issue) => issue.title === title);
  if (existing) {
    console.log(JSON.stringify({
      created: false,
      reason: "already_exists",
      issue: existing,
    }, null, 2));
    return;
  }

  const description = [
    "## Outcome",
    "",
    "Make the canonical Agent Relay Cloud workspace the durable identity for a",
    "local Relay node and its resident agents. After a full node stop/start,",
    "Relaycast, Relayfile, and RelayAuth must still resolve the same workspace",
    "and `khaliq-chief` must retain its address/inbox rather than becoming a new",
    "process-lifetime agent.",
    "",
    "## Acceptance",
    "",
    "- `agent-relay workspace active --json` proves Relaycast, Relayfile, and",
    "  RelayAuth use one data-plane workspace ID.",
    "- `agent-relay node up` automatically uses that canonical workspace without",
    "  manual workspace-key copying.",
    "- A stop/start regression test proves the resident agent identity and",
    "  durable delivery address remain stable.",
    "- Node status and logs never print workspace keys, agent tokens, or",
    "  credential-bearing observer URLs.",
    "- Document the invariant and migration behavior for existing local nodes.",
    "- Open a PR with test evidence. Do not merge.",
    "",
    "## Context",
    "",
    "This is Khaliq Chief's first platform task and the prerequisite for Chiefs",
    "owned by different principals to share one company workspace reliably.",
  ].join("\n");

  const draftPath =
    "/linear/issues/factory-create-chief-workspace-convergence.json";
  const existingReceipt = createReceipt(
    await readRemoteJson(draftPath, { allowNotFound: true }),
  );
  if (existingReceipt) {
    console.log(JSON.stringify({
      created: false,
      reason: "receipt_exists",
      issue: existingReceipt,
    }, null, 2));
    return;
  }
  await writeCreateDraft(draftPath, {
    teamId: team.id,
    title,
    description,
    priority: 2,
    stateId: state.id,
    labelIds: [
      readinessLabel.id,
      repoLabelRecord.id,
    ],
  });
  const receipt = await waitForCreateReceipt(draftPath);
  console.log(JSON.stringify({
    created: true,
    issue: receipt,
    deployment: {
      agentId: deployment.agentId,
      name: deployment.deployedName,
    },
    mergePolicy: config.work.factory.mergePolicy,
  }, null, 2));
}

async function waitForIssuePromotion(
  issueKey,
  stateId,
  titlePrefix,
  requiredLabels,
  timeoutMs = 90_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readRemoteJson(
      `/linear/issues/by-id/${issueKey}.json`,
      { allowNotFound: true },
    );
    const issue = value?.payload ?? value;
    const labelNames = (issue?.labels ?? []).map((label) =>
      typeof label === "string" ? label : label?.name
    );
    if (
      issue?.stateId === stateId &&
      issue?.title?.toLowerCase().startsWith(titlePrefix.toLowerCase()) &&
      requiredLabels.every((label) =>
        labelNames.some((candidate) =>
          candidate?.toLowerCase() === label.toLowerCase()
        )
      )
    ) {
      return issue;
    }
    await delay(1_000);
  }
  throw new Error(
    `Linear accepted the update for ${issueKey}, but its mounted record did not converge`,
  );
}

/**
 * Open pull requests that already reference this Linear key, across the repos
 * the issue routes to.
 *
 * `Ready for Agent` is the only claim signal every dispatcher can see, so an
 * issue sitting in that state means "nobody is working on this". An open PR
 * says otherwise. AR-448 proved the gap: Factory dispatched it and recorded
 * the claim only in its own hosted state store, the writeback that would have
 * moved the issue out of `Ready for Agent` failed on the RelayAuth outage, and
 * 77 minutes later a second dispatcher took the still-ready issue and opened a
 * competing PR against the same files.
 */
async function findOpenPullRequestsForIssue(issueKey, repoNames) {
  const found = [];
  for (const repoName of repoNames) {
    const repo = repoName.includes("/") ? repoName : `AgentWorkforce/${repoName}`;
    const result = spawnSync("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      issueKey,
      "--json",
      "number,title,headRefName,author,url",
    ], { encoding: "utf8", timeout: 60_000 });
    if (result.status !== 0) {
      // An unreachable GitHub is not proof the issue is unclaimed. Say so and
      // let the caller decide rather than silently promoting into a race.
      throw new Error(
        `Cannot verify whether ${issueKey} is already claimed: ` +
        `\`gh pr list --repo ${repo}\` failed ` +
        `(${(result.stderr || result.error?.message || "unknown error").trim()}). ` +
        "Re-run once GitHub is reachable, or pass --allow-claimed to override.",
      );
    }
    for (const pr of JSON.parse(result.stdout || "[]")) {
      found.push({ repo, ...pr, author: pr.author?.login ?? null });
    }
  }
  return found;
}

async function assertUnclaimed(issueKey, repoNames, { allowClaimed }) {
  const open = await findOpenPullRequestsForIssue(issueKey, repoNames);
  if (open.length === 0) return;
  const summary = open
    .map((pr) => `${pr.repo}#${pr.number} (${pr.author ?? "unknown"}) ${pr.title}`)
    .join("; ");
  if (allowClaimed) {
    console.warn(
      `Warning: ${issueKey} already has ${open.length} open pull request(s) ` +
      `— ${summary}. Promoting anyway because --allow-claimed was passed.`,
    );
    return;
  }
  throw new Error(
    `${issueKey} already has ${open.length} open pull request(s): ${summary}. ` +
    "Promoting it back to Ready for Agent would re-offer claimed work to a " +
    "second dispatcher. Close or merge the existing PR first, or pass " +
    "--allow-claimed if the duplicate is intentional.",
  );
}

async function promoteExistingIssue(issueKey, repoNames, recipe, options = {}) {
  await assertUnclaimed(issueKey, repoNames, {
    allowClaimed: Boolean(options.allowClaimed),
  });
  const { team, state, readinessLabel } = await bootstrap();
  const value = await readRemoteJson(
    `/linear/issues/by-id/${issueKey}.json`,
    { allowNotFound: true },
  );
  const issue = value?.payload ?? value;
  if (!issue?.id || !issue?.title) {
    throw new Error(`Linear issue ${issueKey} was not found`);
  }

  const routeLabels = [];
  for (const repoName of repoNames) {
    const label = await findLabel([repoName]);
    if (!label?.id) {
      throw new Error(`Linear repository label ${repoName} was not found`);
    }
    routeLabels.push(label);
  }
  const recipeName = recipe ?? config.work.factory.defaultRecipe;
  const recipeLabel = await ensureRecipeLabel(team, recipeName);

  const currentLabels = (issue.labels ?? []).map((label) =>
    typeof label === "string" ? { name: label } : label
  );
  const desiredLabels = [
    readinessLabel,
    ...routeLabels,
    ...(recipeLabel ? [recipeLabel] : []),
  ];
  const addedLabelIds = desiredLabels
    .filter((label) =>
      !currentLabels.some((current) =>
        current?.id === label.id ||
        current?.name?.toLowerCase() === label.name?.toLowerCase()
      )
    )
    .map((label) => label.id);
  const title = issue.title.toLowerCase().startsWith(
    config.work.factory.titlePrefix.toLowerCase(),
  )
    ? issue.title
    : `${config.work.factory.titlePrefix} ${issue.title}`;
  const alreadyReady =
    issue.stateId === state.id &&
    title === issue.title &&
    addedLabelIds.length === 0;
  if (alreadyReady) {
    console.log(JSON.stringify({
      promoted: false,
      reason: "already_ready",
      issue: {
        id: issue.id,
        key: issue.identifier ?? issueKey,
        title: issue.title,
        url: issue.url,
      },
    }, null, 2));
    return;
  }

  const canonicalPath =
    `/linear/issues/${issue.identifier ?? issueKey}__${issue.id}.json`;
  await writeProviderMutation(canonicalPath, {
    title,
    stateId: state.id,
    ...(addedLabelIds.length > 0 ? { addedLabelIds } : {}),
  }, "chief-factory-promotion", { requireNewOperation: false });
  const promoted = await waitForIssuePromotion(
    issue.identifier ?? issueKey,
    state.id,
    config.work.factory.titlePrefix,
    desiredLabels.map((label) => label.name),
  );
  console.log(JSON.stringify({
    promoted: true,
    issue: {
      id: promoted.id,
      key: promoted.identifier ?? issueKey,
      title: promoted.title,
      url: promoted.url,
      state: promoted.state?.name,
      labels: promoted.labels?.map((label) =>
        typeof label === "string" ? label : label.name
      ),
    },
    repos: repoNames,
    recipe: recipeName,
    mergePolicy: config.work.factory.mergePolicy,
  }, null, 2));
}

async function createFactoryTaskFromSpec(specPath) {
  const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
  if (!spec?.idempotencyKey || !spec?.title || !spec?.description) {
    throw new Error(
      "Factory task spec requires idempotencyKey, title, and description",
    );
  }
  if (!Array.isArray(spec.repos) || spec.repos.length === 0) {
    throw new Error("Factory task spec requires at least one repository label");
  }
  const recipe = spec.recipe ?? config.work.factory.defaultRecipe;
  if (!["single", "workflow", "team"].includes(recipe)) {
    throw new Error(`Unsupported Factory recipe ${recipe}`);
  }

  const { team, state, readinessLabel, deployment } = await bootstrap();
  const routeLabels = [];
  for (const repoName of spec.repos) {
    const label = await findLabel([repoName]);
    if (!label?.id) {
      throw new Error(`Linear repository label ${repoName} was not found`);
    }
    routeLabels.push(label);
  }
  const recipeLabel = await ensureRecipeLabel(team, recipe);

  const title = spec.title.toLowerCase().startsWith(
    config.work.factory.titlePrefix.toLowerCase(),
  )
    ? spec.title
    : `${config.work.factory.titlePrefix} ${spec.title}`;
  const existingIssues = await readRemoteJson("/linear/issues/_index.json");
  const existing = existingIssues.find((issue) => issue.title === title);
  if (existing) {
    console.log(JSON.stringify({
      created: false,
      reason: "already_exists",
      issue: existing,
    }, null, 2));
    return;
  }

  const draftPath =
    `/linear/issues/factory-create-${aliasSlug(spec.idempotencyKey)}.json`;
  const existingReceipt = createReceipt(
    await readRemoteJson(draftPath, { allowNotFound: true }),
  );
  if (existingReceipt) {
    console.log(JSON.stringify({
      created: false,
      reason: "receipt_exists",
      issue: existingReceipt,
    }, null, 2));
    return;
  }

  await writeCreateDraft(draftPath, {
    teamId: team.id,
    title,
    description: spec.description,
    priority: spec.priority ?? 2,
    stateId: state.id,
    labelIds: [
      readinessLabel.id,
      ...routeLabels.map((label) => label.id),
      ...(recipeLabel ? [recipeLabel.id] : []),
    ],
  });
  const receipt = await waitForCreateReceipt(draftPath);
  console.log(JSON.stringify({
    created: true,
    issue: receipt,
    repos: spec.repos,
    recipe,
    deployment: {
      agentId: deployment.agentId,
      name: deployment.deployedName,
    },
    mergePolicy: config.work.factory.mergePolicy,
  }, null, 2));
}

async function readCommentBody(source) {
  if (source === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFileSync(resolve(source), "utf8");
}

/**
 * Ask the mount which field carries a comment's text. The adapter advertises a
 * create example per writable resource; reading it beats hard-coding a guess
 * that silently posts an empty comment if the contract ever moves.
 */
async function resolveCommentBodyField(issueId) {
  const candidates = [
    `/discovery/linear/issues/${issueId}/comments/.create.example.json`,
    `discovery/linear/issues/${issueId}/comments/.create.example.json`,
  ];
  for (const path of candidates) {
    const example = await readRemoteJson(path, { allowNotFound: true });
    const record = example?.payload ?? example;
    if (!record || typeof record !== "object") continue;
    const field = ["body", "content", "bodyData"].find((name) =>
      Object.hasOwn(record, name)
    );
    if (field) return field;
  }
  // The documented default. A wrong guess here fails loudly at the provider
  // rather than posting a blank comment.
  return "body";
}

async function commentOnIssue(issueKey, body, idempotencyKey) {
  const value = await readRemoteJson(
    `/linear/issues/by-id/${issueKey}.json`,
    { allowNotFound: true },
  );
  const issue = value?.payload ?? value;
  if (!issue?.id) {
    throw new Error(`Linear issue ${issueKey} was not found`);
  }

  // Default the idempotency key to the body's digest so a retried checkpoint
  // reuses its draft instead of double-posting.
  const key = aliasSlug(
    idempotencyKey ?? createHash("sha256").update(body).digest("hex").slice(0, 16),
  );
  const draftPath = `/linear/issues/${issue.id}/comments/chief-comment-${key}.json`;

  const existingReceipt = createReceipt(
    await readRemoteJson(draftPath, { allowNotFound: true }),
  );
  if (existingReceipt) {
    console.log(JSON.stringify({
      posted: false,
      reason: "receipt_exists",
      issue: { key: issue.identifier ?? issueKey, url: issue.url },
      comment: existingReceipt,
    }, null, 2));
    return;
  }

  const bodyField = await resolveCommentBodyField(issue.id);
  await writeCreateDraft(draftPath, { [bodyField]: body });
  const receipt = await waitForCreateReceipt(draftPath);
  console.log(JSON.stringify({
    posted: true,
    issue: {
      id: issue.id,
      key: issue.identifier ?? issueKey,
      title: issue.title,
      url: issue.url,
    },
    comment: receipt,
    idempotencyKey: key,
  }, null, 2));
}

const COMMANDS = new Set([
  "bootstrap",
  "status",
  "dispatch-workspace-task",
  "promote-issue",
  "create-task",
  "comment",
]);

const USAGE =
  "Usage: node scripts/factory-control.mjs " +
  "bootstrap|status|dispatch-workspace-task|" +
  "promote-issue <LINEAR-KEY> <repo[,repo]> [single|workflow|team] " +
  "[--allow-claimed]|" +
  "create-task <task-spec.json>|" +
  "comment <LINEAR-KEY> <body-file|-> [idempotency-key]";

/**
 * Validate argv and return the work to run. Parsing before connecting means a
 * usage mistake reports the usage, not whatever the workspace round-trip
 * happened to fail with.
 */
async function planCommand() {
  if (!COMMANDS.has(command)) {
    throw new Error(USAGE);
  }
  if (command === "bootstrap") return () => bootstrap();
  if (command === "status") return () => status();
  if (command === "dispatch-workspace-task") {
    return () => createWorkspaceConvergenceTask();
  }
  if (command === "promote-issue") {
    const positional = process.argv.slice(3).filter((value) =>
      value !== "--allow-claimed"
    );
    const allowClaimed = process.argv.includes("--allow-claimed");
    const issueKey = positional[0];
    const repoNames = (positional[1] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const recipe = positional[2];
    if (!issueKey || repoNames.length === 0) {
      throw new Error(
        "Usage: node scripts/factory-control.mjs promote-issue " +
        "<LINEAR-KEY> <repo[,repo]> [single|workflow|team] [--allow-claimed]",
      );
    }
    if (recipe && !["single", "workflow", "team"].includes(recipe)) {
      throw new Error(`Unsupported Factory recipe ${recipe}`);
    }
    return () => promoteExistingIssue(issueKey, repoNames, recipe, { allowClaimed });
  }
  if (command === "create-task") {
    const specPath = process.argv[3];
    if (!specPath) {
      throw new Error(
        "Usage: node scripts/factory-control.mjs create-task <task-spec.json>",
      );
    }
    return () => createFactoryTaskFromSpec(specPath);
  }
  const issueKey = process.argv[3];
  const bodySource = process.argv[4];
  const idempotencyKey = process.argv[5];
  if (!issueKey || !bodySource) {
    throw new Error(
      "Usage: node scripts/factory-control.mjs comment " +
      "<LINEAR-KEY> <body-file|-> [idempotency-key]",
    );
  }
  // Read the body now: an unreadable file or an empty checkpoint should fail
  // before anything is posted, not after the workspace round-trip.
  const body = (await readCommentBody(bodySource)).trim();
  if (!body) {
    throw new Error(`Refusing to post an empty comment from ${bodySource}`);
  }
  return () => commentOnIssue(issueKey, body, idempotencyKey);
}

try {
  const run = await planCommand();
  try {
    await connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the Agent Relay workspace: ${error.message}. ` +
      "Senses and Linear writeback are unavailable until this recovers; " +
      "check `npm run doctor`.",
    );
  }
  await run();
} catch (error) {
  console.error(`Factory control stopped: ${error.message}`);
  process.exitCode = 1;
}
