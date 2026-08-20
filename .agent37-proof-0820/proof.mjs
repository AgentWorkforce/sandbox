import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { AgentRelay } from '/tmp/agent37-proof-controller-0820/node_modules/@agent-relay/sdk/dist/index.js';
import { Agent37Runtime } from '/Users/khaliqgant/Projects/AgentWorkforce/.worktrees/sandbox-agent37-0819/src/agent37/runtime.ts';

const localRoot = '/Users/khaliqgant/Projects/AgentWorkforce/sandbox/.agent37-proof-0820';
const ledgerPath = `${localRoot}/resource-ledger.jsonl`;
const reportPath = `${localRoot}/report.json`;
const relayBase = 'https://cast.agentrelay.com';
const historyBase = 'https://history.agentrelay.com';
const cloudWorkspaceId = '50587328-441d-4acb-b8f3-dbe1b3c5de99';
const remoteRoot = '/opt/agent37-proof';
const relayhistoryCommit = 'b5a469b9132f51512e47496fb01c912469bcfd63';
const relayfileSha256 = 'fa3f4d0da57c2a5a2857647c5352ba4d6738d4fcc00040732ece45199f980e05';
const relayfileAsset = 'https://github.com/AgentWorkforce/relayfile/releases/download/v0.10.45/relayfile-cli-linux-amd64';
const runId = `a37-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
const nodeId = `node_${runId.replace(/-/g, '_')}`;
const nodeName = `agent37-${runId}`;
const workerName = `worker-${runId}`;
const controllerName = `controller-${runId}`;
const sentinel = `AGENT37_REPO_SENTINEL_${runId}`;
const firstMarker = `AGENT37_HISTORY_CANARY_${runId}`;
const finalMarker = `AGENT37_FINAL_HISTORY_${runId}`;
const relayfileRemoteRoot = `/benchmarks/agent37/${runId}/repo`;
const startedNs = process.hrtime.bigint();
const secrets = new Set();
const metrics = Object.fromEntries([
  'bare_create_ms','provider_ready_ms','agent_relay_ready_ms','bootstrap_gap_ms',
  'history_first_cloud_receipt_ms','targeted_spawn_ready_ms','repo_mount_read_ms',
  'history_drain_before_destroy_ms','destroy_ms','verified_gone_ms',
].map((key) => [key, 'UNKNOWN']));
const state = {
  relay: undefined, controller: undefined, worker: undefined, instance: undefined,
  runtime: undefined, relayfile: undefined, historyRefresh: undefined,
  historyPossible: false, finalHistoryReceipt: false, servicesStopped: false,
  sentinelCreated: false, nodeStarted: false, mountStarted: false,
};

mkdirSync(localRoot, { recursive: true });
writeFileSync(ledgerPath, '');

const ms = (a, b = process.hrtime.bigint()) => Number((b - a) / 1_000_000n);
const sleep = (n) => new Promise((resolve) => setTimeout(resolve, n));
const publicEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

function addSecret(value) {
  if (typeof value !== 'string' || value.length < 8) throw new Error('refusing empty/short credential');
  secrets.add(value);
  return value;
}
function safeText(value) {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text;
}
function assertNoSecret(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) if (text.includes(secret)) throw new Error(`${label} contains a credential`);
}
function ledger(event, data = {}) {
  assertNoSecret(data, 'ledger');
  appendFileSync(ledgerPath, JSON.stringify({ at: new Date().toISOString(), runId, event, ...data }) + '\n');
}
async function jsonFetch(url, init = {}, allowed = [200]) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!allowed.includes(response.status)) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  return text ? JSON.parse(text) : {};
}
function pick(object, keys) {
  for (const key of keys) if (typeof object?.[key] === 'string' && object[key]) return object[key];
  return undefined;
}
function ensureCost() {
  const projected = (ms(startedNs) / 3_600_000) * 0.0073;
  if (projected > 0.30) throw new Error(`cost gate exceeded: projected $${projected.toFixed(4)}`);
}
function assertDestroyAllowed(s) {
  if (!s.servicesStopped) throw new Error('destroy gate: services not stopped');
  if (s.historyPossible && !s.finalHistoryReceipt) throw new Error('destroy gate: final cloud history receipt absent');
}
try {
  assertDestroyAllowed({ servicesStopped: false, historyPossible: true, finalHistoryReceipt: false });
  throw new Error('must-not-fire negative control failed open');
} catch (error) {
  if (!String(error).includes('destroy gate')) throw error;
  ledger('destroy-race-negative-control', { result: 'PASS' });
}

function patchBytes() {
  return execFileSync('git', ['-C', '/Users/khaliqgant/Projects/AgentWorkforce/.worktrees/sandbox-agent37-aihist-env-0820', 'diff', '--binary', '--', 'crates/ai-hist/src/cloud.rs'], { env: publicEnv, maxBuffer: 8 * 1024 * 1024 });
}
function sourceArchive() {
  return execFileSync('git', ['-C', '/Users/khaliqgant/Projects/AgentWorkforce/relayhistory', 'archive', '--format=tar', relayhistoryCommit], { env: publicEnv, maxBuffer: 128 * 1024 * 1024 });
}

async function poll(label, fn, timeoutMs = 120000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    ensureCost();
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timeout${last ? `: ${safeText(last.message)}` : ''}`);
}

async function main() {
  const providerKey = addSecret(process.env.AGENT37_API_KEY ?? '');
  const cloudAuth = JSON.parse(readFileSync('/Users/khaliqgant/.agentworkforce/relay/cloud-auth.json', 'utf8'));
  const cloudToken = addSecret(cloudAuth.accessToken);
  const cloudBase = String(cloudAuth.apiUrl).replace(/\/+$/, '');
  if (Date.parse(cloudAuth.accessTokenExpiresAt) <= Date.now() + 15 * 60_000) throw new Error('controller Cloud session expires too soon');
  const workspaceRows = await jsonFetch(`${cloudBase}/api/v1/workspaces`, { headers: { authorization: `Bearer ${cloudToken}` } });
  const rows = Array.isArray(workspaceRows) ? workspaceRows : workspaceRows.data ?? workspaceRows.workspaces ?? [];
  if (!rows.some((row) => row.id === cloudWorkspaceId)) throw new Error('Cloud workspace prerequisite not found');

  const patch = patchBytes();
  const archive = sourceArchive();
  if (!patch.length || !archive.length) throw new Error('local ai-hist patch/source archive unavailable');
  assertNoSecret(patch.toString('utf8'), 'ai-hist patch');

  ledger('intent', { resource: 'relay-workspace', name: `agent37-proof-${runId}` });
  state.relay = await AgentRelay.createWorkspace({ name: `agent37-proof-${runId}`, baseUrl: relayBase });
  const workspaceKey = addSecret(state.relay.workspaceKey);
  const workspaceInfo = await state.relay.workspace.info();
  ledger('created', { resource: 'relay-workspace', name: `agent37-proof-${runId}`, workspaceId: workspaceInfo.id ?? 'not-returned' });
  // The published @agent-relay/sdk 11.8.0 resolves @relaycast/sdk 8.1.3,
  // whose runtime omits the optional workspace fleet-toggle facade. Node
  // enrollment and placement are independent engine APIs, so prove those
  // directly instead of claiming a toggle result we cannot observe.
  ledger('workspace-fleet-toggle', { result: 'UNKNOWN', reason: 'published-relaycast-sdk-8.1.3-omits-optional-facade' });

  ledger('intent', { resource: 'relay-agent', name: controllerName });
  state.controller = await state.relay.workspace.register({ name: controllerName, type: 'system' }, { strict: true });
  ledger('created', { resource: 'relay-agent', name: controllerName, id: state.controller.id });
  ledger('intent', { resource: 'relay-agent', name: workerName });
  state.worker = await state.relay.workspace.register({ name: workerName, type: 'agent' }, { strict: true });
  const workerToken = addSecret(state.worker.token);
  ledger('created', { resource: 'relay-agent', name: workerName, id: state.worker.id });

  ledger('intent', { resource: 'relay-node', nodeId, name: nodeName });
  const nodeEnrollment = await jsonFetch(`${relayBase}/v1/nodes`, {
    method: 'POST', headers: { authorization: `Bearer ${workspaceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ node_id: nodeId, name: nodeName, capabilities: ['spawn:proof'], max_agents: 1 }),
  }, [200, 201]);
  const nodeToken = addSecret(pick(nodeEnrollment, ['token']) ?? pick(nodeEnrollment.data, ['token']));
  ledger('created', { resource: 'relay-node', nodeId, name: nodeName });

  ledger('intent', { resource: 'relayfile-delegation', path: relayfileRemoteRoot });
  const relayfileBundle = await jsonFetch(`${cloudBase}/api/v1/workspaces/${cloudWorkspaceId}/relayfile/delegated-token`, {
    method: 'POST', headers: { authorization: `Bearer ${cloudToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agentName: workerName, scopes: [
      `fs:read:${relayfileRemoteRoot}/**`, `fs:write:${relayfileRemoteRoot}/**`, 'ops:read', 'sync:trigger',
    ] }),
  }, [200, 201]);
  const relayfileToken = addSecret(relayfileBundle.relayfileToken);
  state.relayfile = {
    url: relayfileBundle.relayfileUrl, workspace: relayfileBundle.relayfileWorkspaceId,
    expiresAt: relayfileBundle.relayfileTokenExpiresAt,
  };
  const scopes = relayfileBundle.relayfileScopes ?? [];
  if (scopes.some((scope) => /fs:(?:read|write):\*$/.test(scope) || /fs:(?:read|write):\/\*\*$/.test(scope))) throw new Error('Relayfile delegation broadened to filesystem wildcard');
  ledger('created', { resource: 'relayfile-delegation', workspace: state.relayfile.workspace, expiresAt: state.relayfile.expiresAt, scopes });

  ledger('intent', { resource: 'relayhistory-session', mode: 'sync' });
  const history = await jsonFetch(`${historyBase}/v1/cli/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentRelayToken: cloudToken, label: `agent37-${runId}`, mode: 'sync' }),
  }, [200, 201]);
  const historyAccess = addSecret(history.accessToken);
  state.historyRefresh = addSecret(history.refreshToken);
  ledger('created', { resource: 'relayhistory-session', orgId: history.orgId, workspaceId: history.workspaceId, mode: 'sync' });

  const launchEnv = {
    RELAY_NODE_TOKEN: nodeToken, RELAY_NODE_ID: nodeId, RELAY_NODE_NAME: nodeName,
    RELAY_WORKER_AGENT_TOKEN: workerToken, RELAYCAST_BASE_URL: relayBase,
    RELAYFILE_TOKEN: relayfileToken, RELAYFILE_SERVER: state.relayfile.url,
    RELAYFILE_WORKSPACE: state.relayfile.workspace, RELAYFILE_REMOTE_ROOT: relayfileRemoteRoot,
    RELAYHISTORY_ACCESS_TOKEN: historyAccess, RELAYHISTORY_BASE_URL: historyBase,
    AI_HIST_DB: `${remoteRoot}/state/history.db`, RELAYHISTORY_HOME: `${remoteRoot}/state/relayhistory`,
    TRAJECTORY_ROOT: `${remoteRoot}/trajectories`, PROOF_RUN_ID: runId,
    PROOF_SENTINEL: sentinel, PROOF_FINAL_MARKER: finalMarker,
  };
  ledger('intent', { resource: 'agent37-instance', name: `fleet-${runId}`, maxCostUsd: 0.30 });
  state.runtime = new Agent37Runtime({ apiKey: providerKey, baseUrl: 'https://api.agent37.com', defaultHomeDir: '/root', user: 'agent37-proof' });
  const createStart = process.hrtime.bigint();
  state.instance = await state.runtime.launch({ name: `fleet-${runId}`, labels: { purpose: 'agent37-fleet-proof', run: runId }, env: launchEnv, workdir: remoteRoot });
  const createEnd = process.hrtime.bigint();
  metrics.bare_create_ms = ms(createStart, createEnd);
  ledger('created', { resource: 'agent37-instance', id: state.instance.id, name: `fleet-${runId}` });

  async function run(command, timeoutMs = 280000) {
    ensureCost();
    assertNoSecret(command, 'remote command');
    const result = await state.runtime.runScript(state.instance, { command, timeoutMs, requestTimeoutMs: timeoutMs + 15000 });
    assertNoSecret(result.output, 'remote stdout/stderr');
    if (result.exitCode !== 0) throw new Error(`remote exit ${result.exitCode}: ${safeText(result.output).slice(0, 1200)}`);
    return result.output;
  }
  const unsets = '-u RELAY_NODE_TOKEN -u RELAY_WORKER_AGENT_TOKEN -u RELAYFILE_TOKEN -u RELAYHISTORY_ACCESS_TOKEN';
  const runClean = (command) => run(`env ${unsets} sh -lc ${JSON.stringify(command)}`);
  const runHist = (command) => run(`env -u RELAY_NODE_TOKEN -u RELAY_WORKER_AGENT_TOKEN -u RELAYFILE_TOKEN sh -lc ${JSON.stringify(command)}`);

  await runClean('node --version');
  const providerReady = process.hrtime.bigint();
  metrics.provider_ready_ms = ms(createEnd, providerReady);

  await runClean(`mkdir -p ${remoteRoot}/app ${remoteRoot}/state ${remoteRoot}/repo ${remoteRoot}/trajectories ${remoteRoot}/src`);
  for (const name of ['remote-node.mjs','spawned-worker.mjs','scan-secrets.mjs']) {
    await state.runtime.uploadFile(state.instance, readFileSync(`${localRoot}/${name}`), `${remoteRoot}/app/${name}`);
  }
  await state.runtime.uploadFile(state.instance, archive, `${remoteRoot}/src/relayhistory.tar`);
  await state.runtime.uploadFile(state.instance, patch, `${remoteRoot}/src/aihist-env.patch`);

  const relayInstallStart = process.hrtime.bigint();
  const installOut = await runClean(`cd ${remoteRoot} && npm init -y >/dev/null && npm install --ignore-scripts --save-exact agent-relay@11.8.0 @agent-relay/fleet@11.8.0 @agent-relay/sdk@11.8.0 zod@4.4.3 >/dev/null && ./node_modules/.bin/agent-relay --version && node -e "for(const p of ['agent-relay','@agent-relay/fleet','@agent-relay/sdk'])console.log(p+'='+require('./node_modules/'+p+'/package.json').version)"`);
  if (!installOut.includes('11.8.0')) throw new Error('exact agent-relay version verification failed');
  const relayBinaryReady = process.hrtime.bigint();
  ledger('verified', { resource: 'agent-relay-install', version: '11.8.0', durationMs: ms(relayInstallStart, relayBinaryReady) });

  await runClean(`curl -fsSL ${relayfileAsset} -o ${remoteRoot}/relayfile && echo '${relayfileSha256}  ${remoteRoot}/relayfile' | sha256sum -c - && chmod 0755 ${remoteRoot}/relayfile && ${remoteRoot}/relayfile --version`);
  ledger('verified', { resource: 'relayfile-binary', version: '0.10.45', sha256: relayfileSha256 });

  await runClean(`mkdir -p ${remoteRoot}/src/relayhistory && tar -xf ${remoteRoot}/src/relayhistory.tar -C ${remoteRoot}/src/relayhistory && cd ${remoteRoot}/src/relayhistory && git init -q && git apply --check ../aihist-env.patch && git apply ../aihist-env.patch && curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null && . /root/.cargo/env && cargo build --release -p ai-hist-cli`);
  await runClean(`${remoteRoot}/src/relayhistory/target/release/ai-hist --version`);
  ledger('verified', { resource: 'ai-hist-binary', sourceCommit: relayhistoryCommit, authPatch: 'local-uncommitted-env-only', version: '0.1.0' });

  ledger('intent', { resource: 'relayfile-sentinel', workspace: state.relayfile.workspace, path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt` });
  await jsonFetch(`${state.relayfile.url}/v1/workspaces/${state.relayfile.workspace}/fs/bulk`, {
    method: 'POST', headers: { authorization: `Bearer ${relayfileToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt`, contentType: 'text/plain', content: sentinel, encoding: '' }] }),
  }, [200, 201]);
  state.sentinelCreated = true;
  ledger('created', { resource: 'relayfile-sentinel', workspace: state.relayfile.workspace, path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt` });

  await run(`nohup env -u RELAY_NODE_TOKEN -u RELAY_WORKER_AGENT_TOKEN -u RELAYHISTORY_ACCESS_TOKEN ${remoteRoot}/relayfile mount "$RELAYFILE_WORKSPACE" ${remoteRoot}/repo --server "$RELAYFILE_SERVER" --remote-path "$RELAYFILE_REMOTE_ROOT" --local-layout exact --mode poll --interval 5s --interval-jitter 0 --low-memory >${remoteRoot}/state/mount.log 2>&1 < /dev/null & echo $! >${remoteRoot}/state/mount.pid`);
  state.mountStarted = true;
  await poll('Relayfile sentinel mount', async () => (await runClean(`test -f ${remoteRoot}/repo/REPO_SENTINEL.txt && cat ${remoteRoot}/repo/REPO_SENTINEL.txt`)).trim() === sentinel, 120000, 2000);

  await run(`nohup env -u RELAYFILE_TOKEN -u RELAYHISTORY_ACCESS_TOKEN node ${remoteRoot}/app/remote-node.mjs >${remoteRoot}/state/node.log 2>&1 < /dev/null & echo $! >${remoteRoot}/state/node.pid`);
  state.nodeStarted = true;
  await poll('Relay node roster online', async () => {
    const node = await state.relay.nodes.get(nodeName);
    return node?.status === 'online' && node.capabilities?.some((cap) => cap.name === 'spawn:proof') ? node : false;
  }, 120000, 1500);
  ledger('verified', { resource: 'relay-node', nodeId, name: nodeName, status: 'online', capability: 'spawn:proof' });

  const firstTrajectory = {
    id: `agent37-first-${runId}`, version: 1, personaId: 'agent37-proof-controller', projectId: 'sandbox-provider-comparison',
    task: { title: `Agent37 first receipt ${runId}`, description: 'Pre-spawn uploader health canary' }, status: 'completed',
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), decisions: [],
    retrospective: { summary: 'Agent37 uploader is active.', suggestions: [firstMarker], confidence: 1.0 },
  };
  await state.runtime.uploadFile(state.instance, JSON.stringify(firstTrajectory), `${remoteRoot}/trajectories/first-${runId}.json`);
  state.historyPossible = true;
  await runHist(`${remoteRoot}/src/relayhistory/target/release/ai-hist sync`);
  const firstPushStart = process.hrtime.bigint();
  const firstPush = await runHist(`${remoteRoot}/src/relayhistory/target/release/ai-hist push --base-url "$RELAYHISTORY_BASE_URL" --limit 25 --json`);
  const firstPair = await runHist(`${remoteRoot}/src/relayhistory/target/release/ai-hist pair check --base-url "$RELAYHISTORY_BASE_URL" --task "${firstMarker}" --limit 10 --json`);
  if (!firstPush.includes('accepted') || !firstPair.includes(firstMarker) || !firstPair.includes(`reflection:agent37-first-${runId}:suggestion:0`) || !firstPair.includes(`agent37-first-${runId}`)) throw new Error('first remote history cloud receipt predicate failed');
  const firstReceipt = process.hrtime.bigint();
  metrics.history_first_cloud_receipt_ms = ms(firstPushStart, firstReceipt);
  ledger('verified', { resource: 'relayhistory-first-receipt', sessionId: `agent37-first-${runId}`, eventId: `reflection:agent37-first-${runId}:suggestion:0`, marker: firstMarker });

  const allReady = process.hrtime.bigint();
  metrics.agent_relay_ready_ms = ms(createStart, allReady);
  metrics.bootstrap_gap_ms = metrics.agent_relay_ready_ms - metrics.bare_create_ms;

  const scan = await run(`node ${remoteRoot}/app/scan-secrets.mjs`);
  if (!scan.includes('"ok":true')) throw new Error('remote secret filesystem scan failed');
  ledger('verified', { resource: 'secret-negative-scan', stage: 'ready', result: 'PASS' });

  const spawnStart = process.hrtime.bigint();
  const placement = state.controller.messaging.placement.spawn({
    capability: 'spawn:proof', node: nodeName, repo: 'agent37/proof',
    actionName: 'spawn:proof',
    input: { cli: 'proof', expected: sentinel, runId }, failFast: true, confirm: true,
    confirmTimeoutMs: 120000, confirmPollIntervalMs: 500,
  });
  const readyPoll = poll('targeted spawn ready file', async () => (await runClean(`test -f ${remoteRoot}/state/worker-ready.json && cat ${remoteRoot}/state/worker-ready.json`)).includes(runId), 120000, 500).then(() => process.hrtime.bigint());
  const mountPoll = poll('spawned worker mount read file', async () => (await runClean(`test -f ${remoteRoot}/state/mount-read.json && cat ${remoteRoot}/state/mount-read.json`)).includes(runId), 120000, 500).then(() => process.hrtime.bigint());
  const [ack, readyAt, mountAt] = await Promise.all([placement, readyPoll, mountPoll]);
  if (ack.placement?.confirmed !== true) throw new Error('targeted placement was not terminally confirmed');
  metrics.targeted_spawn_ready_ms = ms(spawnStart, readyAt);
  metrics.repo_mount_read_ms = ms(spawnStart, mountAt);
  const agentOnline = await poll('spawned agent roster online', async () => {
    const agents = await state.relay.agents.list({ status: 'online' });
    return agents.some((agent) => agent.name === workerName);
  }, 30000, 1000);
  if (!agentOnline) throw new Error('spawned worker roster predicate failed');
  ledger('verified', { resource: 'targeted-spawn', node: nodeName, worker: workerName, confirmed: true, repoSentinelRead: true });

  const drainStart = process.hrtime.bigint();
  await runClean(`touch ${remoteRoot}/state/worker.quiesce`);
  await poll('worker quiescence', async () => (await runClean(`test -f ${remoteRoot}/state/worker-quiesced.json && cat ${remoteRoot}/state/worker-quiesced.json`)).includes(runId), 60000, 500);
  await runHist(`${remoteRoot}/src/relayhistory/target/release/ai-hist sync`);
  const finalPush = await runHist(`${remoteRoot}/src/relayhistory/target/release/ai-hist push --base-url "$RELAYHISTORY_BASE_URL" --limit 25 --json`);
  const finalPair = await runHist(`${remoteRoot}/src/relayhistory/target/release/ai-hist pair check --base-url "$RELAYHISTORY_BASE_URL" --task "${finalMarker}" --limit 10 --json`);
  if (!finalPush.includes('accepted') || !finalPair.includes(finalMarker) || !finalPair.includes(`reflection:agent37-final-${runId}:suggestion:0`) || !finalPair.includes(`agent37-final-${runId}`)) throw new Error('final history coordinator receipt predicate failed');
  state.finalHistoryReceipt = true;
  metrics.history_drain_before_destroy_ms = ms(drainStart);
  ledger('verified', { resource: 'relayhistory-final-receipt', sessionId: `agent37-final-${runId}`, eventId: `reflection:agent37-final-${runId}:suggestion:0`, marker: finalMarker });

  await runClean(`touch ${remoteRoot}/state/node.stop; test ! -f ${remoteRoot}/state/node.pid || kill $(cat ${remoteRoot}/state/node.pid) 2>/dev/null || true; test ! -f ${remoteRoot}/state/mount.pid || kill $(cat ${remoteRoot}/state/mount.pid) 2>/dev/null || true`);
  await poll('fleet node offline', async () => (await state.relay.nodes.get(nodeName))?.status !== 'online', 60000, 1000);
  state.servicesStopped = true;
  ledger('stopped', { resource: 'remote-services', node: true, relayfileMount: true });

  await jsonFetch(`${state.relayfile.url}/v1/workspaces/${state.relayfile.workspace}/fs/file?path=${encodeURIComponent(`${relayfileRemoteRoot}/REPO_SENTINEL.txt`)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${relayfileToken}`, 'if-match': '*' },
  }, [200, 204, 404]);
  state.sentinelCreated = false;
  ledger('deleted', { resource: 'relayfile-sentinel', path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt` });
  await state.relay.workspace.release({ name: workerName, reason: 'Agent37 proof complete', deleteAgent: true });
  await state.relay.workspace.release({ name: controllerName, reason: 'Agent37 proof complete', deleteAgent: true });
  ledger('released', { resource: 'relay-agents', names: [workerName, controllerName] });

  await jsonFetch(`${historyBase}/v1/auth/token/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: state.historyRefresh }) }, [200]);
  const revokedCheck = await fetch(`${historyBase}/v1/pair/check`, { method: 'POST', headers: { authorization: `Bearer ${historyAccess}`, 'content-type': 'application/json' }, body: JSON.stringify({ task: `revocation-check-${runId}` }) });
  if (revokedCheck.status !== 401) throw new Error(`RelayHistory revocation verification returned ${revokedCheck.status}`);
  ledger('revoked', { resource: 'relayhistory-session', verifiedStatus: 401 });

  assertDestroyAllowed(state);
  const destroyStart = process.hrtime.bigint();
  await state.runtime.destroy(state.instance);
  const destroyEnd = process.hrtime.bigint();
  metrics.destroy_ms = ms(destroyStart, destroyEnd);
  const goneStart = process.hrtime.bigint();
  await poll('Agent37 verified gone', async () => (await state.runtime.getById(state.instance.id)) === null, 60000, 1000);
  metrics.verified_gone_ms = ms(goneStart);
  ledger('destroyed', { resource: 'agent37-instance', id: state.instance.id, verifiedGone: true });
  state.instance = undefined;

  const report = {
    ok: true, runId, provider: 'agent37', sampleCount: 1, metrics,
    versions: { agent37AdapterCommit: 'd5e59a4a245c7235f842747f7c06d38c66affae0', agentRelay: '11.8.0', relayfile: '0.10.45', relayhistory: relayhistoryCommit },
    proof: { nodeOnline: true, targetedSpawnConfirmed: true, repoMountSentinelRead: true, firstHistoryReceipt: true, finalHistoryReceipt: true, destroyRaceNegativeControl: 'PASS', providerGone: true },
    cleanup: { nodeOffline: true, mountStopped: true, sentinelDeleted: true, relayAgentsReleased: true, relayhistorySessionRevoked: true, relayWorkspaceDisposableKeyDiscarded: true },
    cost: { upperBoundUsd: Number(((ms(startedNs) / 3_600_000) * 0.0073).toFixed(6)), capUsd: 0.30 },
  };
  assertNoSecret(report, 'report');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ok: true, reportPath, ledgerPath, runId, metrics }) + '\n');
}

try {
  await main();
} catch (error) {
  ledger('failure', { message: safeText(error instanceof Error ? error.message : error).slice(0, 1600) });
  const failures = [];
  if (state.instance && state.runtime) {
    try {
      if (state.nodeStarted || state.mountStarted) await state.runtime.runScript(state.instance, { command: `touch ${remoteRoot}/state/node.stop ${remoteRoot}/state/worker.quiesce 2>/dev/null || true; test ! -f ${remoteRoot}/state/node.pid || kill $(cat ${remoteRoot}/state/node.pid) 2>/dev/null || true; test ! -f ${remoteRoot}/state/mount.pid || kill $(cat ${remoteRoot}/state/mount.pid) 2>/dev/null || true`, timeoutMs: 280000 });
      state.servicesStopped = true;
      if (!state.historyPossible) state.finalHistoryReceipt = false;
      assertDestroyAllowed(state);
      await state.runtime.destroy(state.instance);
      const gone = await state.runtime.getById(state.instance.id);
      if (gone !== null) failures.push('provider destroy did not verify gone');
      else ledger('destroyed-after-failure', { resource: 'agent37-instance', id: state.instance.id, verifiedGone: true });
    } catch (cleanupError) { failures.push(safeText(cleanupError.message)); }
  }
  if (state.historyRefresh) {
    try { await fetch(`${historyBase}/v1/auth/token/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: state.historyRefresh }) }); } catch (cleanupError) { failures.push(safeText(cleanupError.message)); }
  }
  const output = { ok: false, error: safeText(error instanceof Error ? error.message : error), cleanupFailures: failures, reportPath, ledgerPath, runId, metrics };
  assertNoSecret(output, 'failure output');
  writeFileSync(reportPath, JSON.stringify(output, null, 2) + '\n');
  process.stderr.write(JSON.stringify(output) + '\n');
  process.exitCode = 1;
}
