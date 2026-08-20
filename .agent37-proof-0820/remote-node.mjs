import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { action, defineNode, serveNode } from '@agent-relay/fleet';
import { z } from 'zod';

const root = '/opt/agent37-proof';
const publicEnv = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/root',
  RELAY_WORKER_AGENT_TOKEN: process.env.RELAY_WORKER_AGENT_TOKEN ?? '',
  RELAYCAST_BASE_URL: process.env.RELAYCAST_BASE_URL ?? 'https://cast.agentrelay.com',
  PROOF_RUN_ID: process.env.PROOF_RUN_ID ?? '',
  PROOF_SENTINEL: process.env.PROOF_SENTINEL ?? '',
  PROOF_FINAL_MARKER: process.env.PROOF_FINAL_MARKER ?? '',
  TRAJECTORY_ROOT: `${root}/trajectories`,
};

async function waitJson(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    await delay(200);
  }
  throw new Error(`public readiness timeout: ${path}`);
}

const proof = action({
  input: z.object({ cli: z.literal('proof'), expected: z.string(), runId: z.string() }).passthrough(),
}, async (input) => {
  if (input.expected !== publicEnv.PROOF_SENTINEL || input.runId !== publicEnv.PROOF_RUN_ID) {
    throw new Error('placement public marker mismatch');
  }
  const child = spawn(process.execPath, [`${root}/app/spawned-worker.mjs`], {
    cwd: `${root}/repo`, env: publicEnv, stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  const ready = await waitJson(`${root}/state/worker-ready.json`, 90000);
  const mount = await waitJson(`${root}/state/mount-read.json`, 90000);
  return { ok: true, ready: ready.ok === true, mount: mount.ok === true, runId: input.runId };
});

const definition = defineNode({
  name: process.env.RELAY_NODE_NAME ?? 'agent37-proof-node',
  maxAgents: 1,
  version: 'agent-relay-11.8.0-agent37-proof1',
  repoPaths: { 'agent37/proof': `${root}/repo` },
  capabilities: { 'spawn:proof': proof },
});

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort());
const stopWatch = (async () => {
  while (!controller.signal.aborted) {
    if (existsSync(`${root}/state/node.stop`)) { controller.abort(); break; }
    await delay(250);
  }
})();

await serveNode({
  definition,
  connection: {
    nodeToken: process.env.RELAY_NODE_TOKEN ?? '',
    nodeId: process.env.RELAY_NODE_ID ?? '',
    baseUrl: process.env.RELAYCAST_BASE_URL ?? 'https://cast.agentrelay.com',
  },
  signal: controller.signal,
  reconnect: true,
  log: (message) => process.stdout.write(`[node] ${message}\n`),
  warn: (message) => process.stderr.write(`[node] ${message}\n`),
  onRegistered: () => process.stdout.write('[node] registered\n'),
});
await stopWatch;

