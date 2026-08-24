import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentClient } from '@agent-relay/sdk';

const root = '/tmp/agent37-proof';
const runId = process.env.PROOF_RUN_ID ?? '';
const expected = process.env.PROOF_SENTINEL ?? '';
const finalMarker = process.env.PROOF_FINAL_MARKER ?? '';
const client = createAgentClient({
  agentToken: process.env.RELAY_WORKER_AGENT_TOKEN ?? '',
  baseUrl: process.env.RELAYCAST_BASE_URL ?? 'https://cast.agentrelay.com',
  autoHeartbeatMs: 2000,
});

await client.channels.join('general');
await client.send('general', `AGENT37_WORKER_READY ${runId}`);
writeFileSync(`${root}/state/worker-ready.json`, JSON.stringify({ ok: true, runId }));

const sentinel = readFileSync(`${root}/repo/REPO_SENTINEL.txt`, 'utf8').trim();
if (sentinel !== expected) throw new Error('mounted repository sentinel mismatch');
await client.send('general', `AGENT37_MOUNT_READ ${runId}`);
writeFileSync(`${root}/state/mount-read.json`, JSON.stringify({ ok: true, runId }));

while (!existsSync(`${root}/state/worker.quiesce`)) await delay(250);
const now = new Date().toISOString();
const trajectory = {
  id: `agent37-final-${runId}`,
  version: 1,
  personaId: 'agent37-proof-worker',
  projectId: 'sandbox-provider-comparison',
  task: { title: `Agent37 final drain ${runId}`, description: 'Fleet-node teardown ordering proof' },
  status: 'completed', startedAt: now, completedAt: now,
  decisions: [],
  retrospective: { summary: 'Agent37 worker quiesced before destroy.', suggestions: [finalMarker], confidence: 1.0 },
};
writeFileSync(`${root}/trajectories/final-${runId}.json`, JSON.stringify(trajectory));
await client.send('general', `AGENT37_WORKER_QUIESCED ${runId}`);
writeFileSync(`${root}/state/worker-quiesced.json`, JSON.stringify({ ok: true, runId }));
