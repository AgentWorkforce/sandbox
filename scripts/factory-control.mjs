#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  activeWorkspace,
  cloudRequest,
  cloudSession,
  loadConfig,
  mintSensesSession,
} from "./lib/chief-runtime.mjs";

const command = process.argv[2] ?? "status";
const config = loadConfig();
const workspace = activeWorkspace(config, { switchIfNeeded: true });
const mount = await mintSensesSession(config, workspace);
const relayfileBase = mount.relayfileBaseUrl.replace(/\/+$/u, "");
const relayfileWorkspace = workspace.relayfileWorkspaceId;

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

async function promoteExistingIssue(issueKey, repoNames, recipe) {
  const { state, readinessLabel } = await bootstrap();
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
  const recipeLabelName = config.work.factory.recipeLabels[recipeName];
  const recipeLabel = recipeLabelName
    ? await findLabel([recipeLabelName])
    : null;
  if (recipeLabelName && !recipeLabel?.id) {
    throw new Error(`Linear recipe label ${recipeLabelName} was not found`);
  }

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

try {
  if (command === "bootstrap") {
    await bootstrap();
  } else if (command === "status") {
    await status();
  } else if (command === "dispatch-workspace-task") {
    await createWorkspaceConvergenceTask();
  } else if (command === "promote-issue") {
    const issueKey = process.argv[3];
    const repoNames = (process.argv[4] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const recipe = process.argv[5];
    if (!issueKey || repoNames.length === 0) {
      throw new Error(
        "Usage: node scripts/factory-control.mjs promote-issue " +
        "<LINEAR-KEY> <repo[,repo]> [single|workflow|team]",
      );
    }
    if (recipe && !["single", "workflow", "team"].includes(recipe)) {
      throw new Error(`Unsupported Factory recipe ${recipe}`);
    }
    await promoteExistingIssue(issueKey, repoNames, recipe);
  } else {
    throw new Error(
      "Usage: node scripts/factory-control.mjs " +
      "bootstrap|status|dispatch-workspace-task|" +
      "promote-issue <LINEAR-KEY> <repo[,repo]> [single|workflow|team]",
    );
  }
} catch (error) {
  console.error(`Factory control stopped: ${error.message}`);
  process.exitCode = 1;
}
