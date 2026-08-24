import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRelay } from '/tmp/agent37-proof-controller-0820/node_modules/@agent-relay/sdk/dist/index.js';
import { Agent37Runtime } from '../src/agent37/runtime.ts';

const localRoot = dirname(fileURLToPath(import.meta.url));
const ledgerPath = `${localRoot}/resource-ledger.jsonl`;
const reportPath = `${localRoot}/report.json`;
const relayBase = 'https://cast.agentrelay.com';
const historyBase = 'https://history.agentrelay.com';
const cloudWorkspaceId = '50587328-441d-4acb-b8f3-dbe1b3c5de99';
// The provider template runs as a non-root user. /opt was the original intended
// long-lived workspace, but that user cannot create it. Keep the same isolated
// proof-root contract under the template's guaranteed writable /tmp instead.
const remoteRoot = '/tmp/agent37-proof';
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
  fileSurface: {
    hostingExec: 'UNKNOWN', providerPutGet: 'UNKNOWN', providerRoundTripBytes: 'UNKNOWN',
    relayfileMount: 'UNKNOWN',
  },
  idle: {
    providerAutoSleep: 'UNKNOWN', configuredAutoSleep: false, configuredIdleTimeoutSeconds: 300,
    observedAutoSleep: 'UNKNOWN', controllerStopResume: 'UNKNOWN',
    stopMs: 'UNKNOWN', resumeReadyMs: 'UNKNOWN',
  },
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
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000) });
  const text = await response.text();
  if (!allowed.includes(response.status)) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}${text ? `: ${safeText(text).slice(0, 1000)}` : ''}`);
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

async function retryCleanup(label, fn, attempts = 6, intervalMs = 2000) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await fn(); } catch (error) { last = error; }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${safeText(last instanceof Error ? last.message : last)}`);
}

async function destroyRunInstance(reason) {
  if (!state.runtime) return false;
  let handle = state.instance;
  if (!handle) {
    handle = await state.runtime.findByLabels(
      { purpose: 'agent37-fleet-proof', run: runId },
      { states: null, owned: true },
    );
    if (handle) ledger('recovered-for-cleanup', { resource: 'agent37-instance', id: handle.id, reason });
  }
  if (!handle) return false;
  const destroyStart = process.hrtime.bigint();
  await retryCleanup('Agent37 destroy', () => state.runtime.destroy(handle));
  metrics.destroy_ms = ms(destroyStart);
  const goneStart = process.hrtime.bigint();
  await poll('Agent37 verified gone', async () => (await state.runtime.getById(handle.id)) === null, 60000, 1000);
  metrics.verified_gone_ms = ms(goneStart);
  ledger('destroyed', { resource: 'agent37-instance', id: handle.id, verifiedGone: true, reason });
  state.instance = undefined;
  return true;
}

async function deleteRelayfileSentinel(reason) {
  if (!state.sentinelCreated || !state.relayfile?.url || !state.relayfile?.workspace || !state.relayfileToken) return false;
  const url = `${state.relayfile.url}/v1/workspaces/${state.relayfile.workspace}/fs/file?path=${encodeURIComponent(`${relayfileRemoteRoot}/REPO_SENTINEL.txt`)}`;
  await retryCleanup('Relayfile sentinel delete', async () => {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${state.relayfileToken}`, 'if-match': '*', 'x-correlation-id': `agent37-proof-${runId}` },
      signal: AbortSignal.timeout(30000),
    });
    if (![200, 202, 204, 404].includes(response.status)) throw new Error(`HTTP ${response.status}`);
  });
  await poll('Relayfile sentinel verified gone', async () => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${state.relayfileToken}`, 'x-correlation-id': `agent37-proof-${runId}` },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return true;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return false;
  }, 60000, 1000);
  state.sentinelCreated = false;
  ledger('deleted', { resource: 'relayfile-sentinel', path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt`, verifiedGone: true, reason });
  return true;
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
  state.relayfileToken = relayfileToken;
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
  state.historyAccess = historyAccess;
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
  state.runtime = new Agent37Runtime({
    apiKey: providerKey,
    baseUrl: 'https://api.agent37.com',
    defaultHomeDir: '/root',
    user: 'agent37-proof',
    autoSleep: state.idle.configuredAutoSleep,
    idleTimeoutSeconds: state.idle.configuredIdleTimeoutSeconds,
    fetch: (url, init = {}) => fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30000),
    }),
  });
  const createStart = process.hrtime.bigint();
  state.instance = await state.runtime.launch({ name: `fleet-${runId}`, labels: { purpose: 'agent37-fleet-proof', run: runId }, env: launchEnv, workdir: '/' });
  const createEnd = process.hrtime.bigint();
  metrics.bare_create_ms = ms(createStart, createEnd);
  ledger('created', { resource: 'agent37-instance', id: state.instance.id, name: `fleet-${runId}` });

  const providerInstance = await jsonFetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(state.instance.id)}`, {
    headers: { authorization: `Bearer ${providerKey}` },
  });
  state.idle.observedAutoSleep = typeof providerInstance.auto_sleep === 'boolean' ? providerInstance.auto_sleep : 'UNKNOWN';
  state.fileSurface.instanceUrlPresent = typeof providerInstance.url === 'string' && providerInstance.url.length > 0;
  state.fileSurface.providerTransferPlane = state.fileSurface.instanceUrlPresent ? 'instance-file-api' : 'exec-fallback';
  ledger('observed', {
    resource: 'agent37-idle-config',
    autoSleep: state.idle.observedAutoSleep,
    idleTimeoutSeconds: providerInstance.idle_timeout_seconds ?? 'UNKNOWN',
  });

  async function run(command, timeoutMs = 280000) {
    ensureCost();
    assertNoSecret(command, 'remote command');
    const result = await state.runtime.runScript(state.instance, { command, timeoutMs, requestTimeoutMs: timeoutMs + 15000 });
    assertNoSecret(result.output, 'remote stdout/stderr');
    if (result.exitCode !== 0) throw new Error(`remote exit ${result.exitCode}${result.truncated ? ' (output truncated)' : ''}: ${safeText(result.output).slice(0, 1200)}`);
    return result.output;
  }
  const unsets = '-u RELAY_NODE_TOKEN -u RELAY_WORKER_AGENT_TOKEN -u RELAYFILE_TOKEN -u RELAYHISTORY_ACCESS_TOKEN';
  const runClean = (command) => run(`env ${unsets} sh -lc ${JSON.stringify(command)}`);
  const runHist = (command) => run(`env -u RELAY_NODE_TOKEN -u RELAY_WORKER_AGENT_TOKEN -u RELAYFILE_TOKEN sh -lc ${JSON.stringify(command)}`);

  await runClean('node --version');
  const providerReady = process.hrtime.bigint();
  metrics.provider_ready_ms = ms(createEnd, providerReady);
  state.fileSurface.hostingExec = true;
  ledger('verified', { resource: 'agent37-hosting-exec', command: 'node --version', exitCode: 0 });

  await runClean(`if ! mkdir -p ${remoteRoot}/app ${remoteRoot}/state ${remoteRoot}/repo ${remoteRoot}/trajectories ${remoteRoot}/src 2>/dev/null; then command -v sudo >/dev/null && sudo -n mkdir -p ${remoteRoot}/app ${remoteRoot}/state ${remoteRoot}/repo ${remoteRoot}/trajectories ${remoteRoot}/src && sudo -n chown -R "$(id -u):$(id -g)" ${remoteRoot}; fi; test -w ${remoteRoot}/state`);
  const fileRoundTrip = Buffer.from(`AGENT37_FILE_SURFACE_${runId}`, 'utf8');
  const fileRoundTripPath = `${remoteRoot}/state/provider-file-roundtrip.txt`;
  try {
    await state.runtime.uploadFile(state.instance, fileRoundTrip, fileRoundTripPath);
    const downloaded = await state.runtime.downloadFile(state.instance, fileRoundTripPath);
    if (!Buffer.isBuffer(downloaded) || !downloaded.equals(fileRoundTrip)) throw new Error('provider file round-trip bytes differ');
    state.fileSurface.providerPutGet = true;
    state.fileSurface.providerRoundTripBytes = fileRoundTrip.length;
    ledger('verified', { resource: 'agent37-file-plane', put: true, get: true, bytes: fileRoundTrip.length });
  } catch (error) {
    state.fileSurface.providerPutGet = 'UNKNOWN';
    state.fileSurface.providerPutGetReason = safeText(error instanceof Error ? error.message : error).slice(0, 800);
    ledger('unverified', { resource: 'agent37-file-plane', result: 'UNKNOWN', reason: state.fileSurface.providerPutGetReason });
  }

  ledger('intent', { resource: 'relayfile-sentinel', workspace: state.relayfile.workspace, path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt` });
  await jsonFetch(`${state.relayfile.url}/v1/workspaces/${state.relayfile.workspace}/fs/bulk`, {
    method: 'POST', headers: { authorization: `Bearer ${relayfileToken}`, 'content-type': 'application/json', 'x-correlation-id': `agent37-proof-${runId}` },
    body: JSON.stringify({ files: [{ path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt`, contentType: 'text/plain', content: sentinel }] }),
  }, [200, 201, 202]);
  state.sentinelCreated = true;
  ledger('created', { resource: 'relayfile-sentinel', workspace: state.relayfile.workspace, path: `${relayfileRemoteRoot}/REPO_SENTINEL.txt` });

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

  await runClean(`mkdir -p ${remoteRoot}/src/relayhistory && tar -xf ${remoteRoot}/src/relayhistory.tar -C ${remoteRoot}/src/relayhistory && cd ${remoteRoot}/src/relayhistory && git init -q && git apply --check ../aihist-env.patch && git apply ../aihist-env.patch && export CARGO_HOME=${remoteRoot}/cargo RUSTUP_HOME=${remoteRoot}/rustup && (curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >${remoteRoot}/state/rustup.log 2>&1 || { code=$?; tail -n 120 ${remoteRoot}/state/rustup.log; exit $code; }) && . ${remoteRoot}/cargo/env && (cargo build --release -p ai-hist-cli >${remoteRoot}/state/cargo-build.log 2>&1 || { code=$?; tail -n 160 ${remoteRoot}/state/cargo-build.log; exit $code; })`);
  await runClean(`${remoteRoot}/src/relayhistory/target/release/ai-hist --version`);
  ledger('verified', { resource: 'ai-hist-binary', sourceCommit: relayhistoryCommit, authPatch: 'local-uncommitted-env-only', version: '0.1.0' });

  await run(`nohup env -u RELAY_NODE_TOKEN -u RELAY_WORKER_AGENT_TOKEN -u RELAYHISTORY_ACCESS_TOKEN ${remoteRoot}/relayfile mount "$RELAYFILE_WORKSPACE" ${remoteRoot}/repo --server "$RELAYFILE_SERVER" --remote-path "$RELAYFILE_REMOTE_ROOT" --local-layout exact --mode poll --interval 5s --interval-jitter 0 --low-memory >${remoteRoot}/state/mount.log 2>&1 < /dev/null & echo $! >${remoteRoot}/state/mount.pid`);
  state.mountStarted = true;
  await poll('Relayfile sentinel mount', async () => (await runClean(`test -f ${remoteRoot}/repo/REPO_SENTINEL.txt && cat ${remoteRoot}/repo/REPO_SENTINEL.txt`)).trim() === sentinel, 120000, 2000);
  state.fileSurface.relayfileMount = true;
  ledger('verified', { resource: 'relayfile-mount', path: `${remoteRoot}/repo/REPO_SENTINEL.txt`, contentMatched: true });

  await run(`nohup env -u RELAYFILE_TOKEN -u RELAYHISTORY_ACCESS_TOKEN node ${remoteRoot}/app/remote-node.mjs >${remoteRoot}/state/node.log 2>&1 < /dev/null & echo $! >${remoteRoot}/state/node.pid`);
  state.nodeStarted = true;
  await poll('Relay node roster online', async () => {
    const node = await state.relay.nodes.get(nodeName);
    return node?.status === 'online' && node.capabilities?.some((cap) => cap.name === 'spawn:proof') ? node : false;
  }, 120000, 1500);
  const relayReady = process.hrtime.bigint();
  metrics.agent_relay_ready_ms = ms(createStart, relayReady);
  metrics.bootstrap_gap_ms = metrics.agent_relay_ready_ms - metrics.bare_create_ms;
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

  const scan = await run(`node ${remoteRoot}/app/scan-secrets.mjs`);
  if (!scan.includes('"ok":true')) throw new Error('remote secret filesystem scan failed');
  ledger('verified', { resource: 'secret-negative-scan', stage: 'ready', result: 'PASS' });

  const spawnStart = process.hrtime.bigint();
  const placement = state.controller.messaging.placement.spawn({
    // For spawn:* placement, the SDK deliberately invokes the engine's native
    // `spawn` action and routes by this advertised capability. Supplying
    // actionName:'spawn:proof' bypasses that mapping and fails action discovery.
    capability: 'spawn:proof', node: nodeName, repo: 'agent37/proof',
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
  const idleStart = process.hrtime.bigint();
  await poll('fleet node offline', async () => (await state.relay.nodes.get(nodeName))?.status !== 'online', 60000, 1000);
  state.servicesStopped = true;
  ledger('stopped', { resource: 'remote-services', node: true, relayfileMount: true });

  await deleteRelayfileSentinel('success');
  await state.relay.workspace.release({ name: workerName, reason: 'Agent37 proof complete', deleteAgent: true });
  await state.relay.workspace.release({ name: controllerName, reason: 'Agent37 proof complete', deleteAgent: true });
  ledger('released', { resource: 'relay-agents', names: [workerName, controllerName] });

  await jsonFetch(`${historyBase}/v1/auth/token/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: state.historyRefresh }) }, [200]);
  const revokedCheck = await fetch(`${historyBase}/v1/pair/check`, { method: 'POST', headers: { authorization: `Bearer ${historyAccess}`, 'content-type': 'application/json' }, body: JSON.stringify({ task: `revocation-check-${runId}` }) });
  if (revokedCheck.status !== 401) throw new Error(`RelayHistory revocation verification returned ${revokedCheck.status}`);
  ledger('revoked', { resource: 'relayhistory-session', verifiedStatus: 401 });

  if (state.idle.configuredAutoSleep && state.idle.observedAutoSleep === true) {
    try {
      await poll('Agent37 provider auto-sleep', async () => {
        const observed = await jsonFetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(state.instance.id)}`, {
          headers: { authorization: `Bearer ${providerKey}` },
        });
        return observed.status === 'sleeping';
      }, state.idle.configuredIdleTimeoutSeconds * 1000 + 180000, 5000);
      const sleepingAt = process.hrtime.bigint();
      state.idle.autoSleepMs = ms(idleStart, sleepingAt);
      state.idle.providerAutoSleep = true;
      state.instance = await state.runtime.start(state.instance);
      await poll('Agent37 auto-sleep wake', async () => {
        const observed = await jsonFetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(state.instance.id)}`, {
          headers: { authorization: `Bearer ${providerKey}` },
        });
        return observed.status === 'running';
      }, 120000, 1000);
      await runClean('node --version');
      state.idle.autoSleepWakeReadyMs = ms(sleepingAt);
      ledger('verified', {
        resource: 'agent37-provider-auto-sleep',
        autoSleepMs: state.idle.autoSleepMs,
        wakeReadyMs: state.idle.autoSleepWakeReadyMs,
        postWakeExec: true,
      });
    } catch (error) {
      state.idle.providerAutoSleep = 'UNKNOWN';
      state.idle.providerAutoSleepReason = safeText(error instanceof Error ? error.message : error).slice(0, 800);
      ledger('unverified', { resource: 'agent37-provider-auto-sleep', result: 'UNKNOWN', reason: state.idle.providerAutoSleepReason });
    }
  } else if (state.idle.configuredAutoSleep && state.idle.observedAutoSleep === false) {
    state.idle.providerAutoSleep = false;
    state.idle.providerAutoSleepReason = 'create requested auto_sleep=true but GET instance returned auto_sleep=false';
    ledger('verified', { resource: 'agent37-provider-auto-sleep', result: false, reason: state.idle.providerAutoSleepReason });
  } else if (!state.idle.configuredAutoSleep) {
    state.idle.providerAutoSleep = 'UNKNOWN';
    state.idle.providerAutoSleepReason = 'disabled for the uninterrupted full-lifecycle sample; measured by the separate idle probe';
    ledger('unverified', { resource: 'agent37-provider-auto-sleep', result: 'UNKNOWN', reason: state.idle.providerAutoSleepReason });
  }

  const stopStart = process.hrtime.bigint();
  try {
    const beforeStop = await jsonFetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(state.instance.id)}`, {
      headers: { authorization: `Bearer ${providerKey}` },
    });
    if (beforeStop.status === 'sleeping') {
      state.instance = await state.runtime.start(state.instance);
      await poll('Agent37 pre-stop wake', async () => {
        const observed = await jsonFetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(state.instance.id)}`, {
          headers: { authorization: `Bearer ${providerKey}` },
        });
        return observed.status === 'running';
      }, 120000, 1000);
    }
    await state.runtime.stop(state.instance);
    await poll('Agent37 controller stop', async () => {
      const observed = await jsonFetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(state.instance.id)}`, {
        headers: { authorization: `Bearer ${providerKey}` },
      });
      return observed.status === 'stopped';
    }, 60000, 1000);
    const stoppedAt = process.hrtime.bigint();
    state.idle.stopMs = ms(stopStart, stoppedAt);
    state.instance = await state.runtime.start(state.instance);
    await poll('Agent37 controller resume running', async () => {
      const observed = await jsonFetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(state.instance.id)}`, {
        headers: { authorization: `Bearer ${providerKey}` },
      });
      return observed.status === 'running';
    }, 120000, 1000);
    await runClean('node --version');
    const retained = await runClean(`if test -f ${remoteRoot}/state/provider-file-roundtrip.txt; then echo retained; else echo missing; fi`);
    state.idle.proofRootRetainedAfterResume = retained.trim() === 'retained';
    state.idle.resumeReadyMs = ms(stoppedAt);
    state.idle.controllerStopResume = true;
    ledger('verified', {
      resource: 'agent37-controller-stop-resume', stopMs: state.idle.stopMs,
      resumeReadyMs: state.idle.resumeReadyMs, postResumeExec: true,
      proofRootRetained: state.idle.proofRootRetainedAfterResume,
    });
  } catch (error) {
    state.idle.controllerStopResume = 'UNKNOWN';
    state.idle.controllerStopResumeReason = safeText(error instanceof Error ? error.message : error).slice(0, 800);
    ledger('unverified', { resource: 'agent37-controller-stop-resume', result: 'UNKNOWN', reason: state.idle.controllerStopResumeReason });
  }

  assertDestroyAllowed(state);
  await destroyRunInstance('success');

  const report = {
    ok: true, runId, provider: 'agent37', sampleCount: 1, metrics,
    versions: { agentRelay: '11.8.0', relayfile: '0.10.45', relayhistory: relayhistoryCommit },
    proof: {
      nodeOnline: true, targetedSpawnConfirmed: true, repoMountSentinelRead: true,
      firstHistoryReceipt: true, finalHistoryReceipt: true,
      providerHostingExec: state.fileSurface.hostingExec,
      providerFilePutGet: state.fileSurface.providerPutGet,
      providerAutoSleep: state.idle.providerAutoSleep,
      controllerStopResume: state.idle.controllerStopResume,
      destroyRaceNegativeControl: 'PASS', providerGone: true,
    },
    apiSurface: {
      hostingExecRequestResponse: state.fileSurface.hostingExec,
      providerFilePutGet: state.fileSurface.providerPutGet,
      providerTransferPlane: state.fileSurface.providerTransferPlane,
      sseConversationOnly: false,
      conclusion: state.fileSurface.providerTransferPlane === 'instance-file-api'
        ? 'actual hosting-plane exec and instance-plane file round trips succeeded'
        : 'actual hosting-plane exec succeeded; file round trip used the bounded exec fallback',
    },
    fileSurface: state.fileSurface,
    idle: state.idle,
    measurement: {
      bare_create_ms: 'wall time of POST create through parsed running instance response',
      provider_ready_ms: 'create return to successful node --version exec with exit code 0',
      agent_relay_ready_ms: 'create start to Relay roster status=online with spawn:proof capability',
      bootstrap_gap_ms: 'agent_relay_ready_ms minus bare_create_ms',
      history_first_cloud_receipt_ms: 'ai-hist push start to pair-check matching marker, session id, and event id',
      targeted_spawn_ready_ms: 'placement request start to worker-written ready file containing run id',
      repo_mount_read_ms: 'placement request start to worker-written mount-read file after exact sentinel comparison',
      history_drain_before_destroy_ms: 'quiesce request to final cloud pair-check matching marker, session id, and event id',
      destroy_ms: 'DELETE lifecycle call wall time',
      verified_gone_ms: 'DELETE return to first GET-by-id null assertion',
    },
    cleanup: { nodeOffline: true, mountStopped: true, sentinelDeleted: true, relayAgentsReleased: true, relayhistorySessionRevoked: true, relayWorkspaceDisposableKeyDiscarded: true },
    cost: { upperBoundUsd: Number(((ms(startedNs) / 3_600_000) * 0.0073).toFixed(6)), capUsd: 0.30 },
  };
  assertNoSecret(report, 'report');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ok: true, reportPath, ledgerPath, runId, metrics }) + '\n');
  process.exit(0);
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
    } catch (cleanupError) { failures.push(`service stop: ${safeText(cleanupError.message)}`); }
  }
  try {
    await destroyRunInstance('failure-unconditional');
  } catch (cleanupError) {
    failures.push(`provider destroy: ${safeText(cleanupError.message)}`);
  }
  if (state.sentinelCreated && state.relayfile?.url && state.relayfile?.workspace && state.relayfileToken) {
    try {
      await deleteRelayfileSentinel('failure');
    } catch (cleanupError) { failures.push(`relayfile sentinel: ${safeText(cleanupError.message)}`); }
  }
  if (state.relay?.workspace) {
    for (const name of [workerName, controllerName]) {
      try {
        await retryCleanup(`relay agent ${name}`, () => state.relay.workspace.release({ name, reason: 'Agent37 proof failed', deleteAgent: true }));
      }
      catch (cleanupError) { failures.push(`relay agent ${name}: ${safeText(cleanupError.message)}`); }
    }
  }
  if (state.historyRefresh) {
    try {
      await retryCleanup('RelayHistory revoke', async () => {
        const response = await fetch(`${historyBase}/v1/auth/token/revoke`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: state.historyRefresh }), signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      });
    } catch (cleanupError) { failures.push(safeText(cleanupError.message)); }
  }
  const output = {
    ok: false,
    error: safeText(error instanceof Error ? error.message : error),
    cleanupFailures: failures,
    reportPath,
    ledgerPath,
    runId,
    metrics,
    fileSurface: state.fileSurface,
    idle: state.idle,
  };
  assertNoSecret(output, 'failure output');
  writeFileSync(reportPath, JSON.stringify(output, null, 2) + '\n');
  process.stderr.write(JSON.stringify(output) + '\n');
  process.exit(1);
}
