import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Agent37Runtime, composeScript } from '/Users/khaliqgant/Projects/AgentWorkforce/.worktrees/sandbox-agent37-0819/src/agent37/runtime.ts';

const secret = `dummy_${randomBytes(24).toString('hex')}`;
const root = mkdtempSync(join(tmpdir(), 'agent37-secret-gate-'));
const recorder = [];
const requestFacts = [];

function assertAbsent(label, text) {
  if (String(text).includes(secret)) throw new Error(`${label}: dummy secret leaked`);
}

function record(event) {
  const encoded = JSON.stringify(event);
  assertAbsent('recorder', encoded);
  recorder.push(event);
}

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

try {
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (parsed.pathname === '/v1/instances' && init.method === 'POST') {
      if (body?.env?.DUMMY_SECRET !== secret) throw new Error('launch env transport missing dummy');
      requestFacts.push({ plane: 'hosting', method: 'POST', envTransport: true });
      return new Response(JSON.stringify({
        id: 'dummy-instance', status: 'running', url: 'https://dummy.invalid',
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected mock request ${init.method} ${parsed.pathname}`);
  };

  const runtime = new Agent37Runtime({
    apiKey: secret,
    baseUrl: 'https://dummy.invalid',
    defaultHomeDir: '/root',
    fetch,
    maxAttempts: 1,
  });
  await runtime.launch({ env: { DUMMY_SECRET: secret }, name: 'dummy-gate' });

  const unsafe = composeScript('true', { env: { DUMMY_SECRET: secret } });
  if (!unsafe.includes(secret)) throw new Error('negative control did not detect runScript env serialization');
  record({ control: 'runScript-env', rejected: true });

  const childArgs = ['-e', "process.stdout.write('child-ok')"];
  assertAbsent('constructed child argv', JSON.stringify(childArgs));
  const child = spawnSync(process.execPath, childArgs, {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', DUMMY_SECRET: secret },
    encoding: 'utf8',
  });
  if (child.status !== 0) throw new Error(`dummy child exit ${child.status}`);
  assertAbsent('child stdout', child.stdout);
  assertAbsent('child stderr', child.stderr);
  for (const path of walkFiles(root)) {
    assertAbsent('filesystem path', path);
    assertAbsent('filesystem content', readFileSync(path));
  }
  record({ control: 'launch-env', transportObserved: requestFacts.length === 1 });
  record({ control: 'child-argv', absent: true });
  record({ control: 'child-stdout-stderr', absent: true });
  record({ control: 'filesystem-delta', absent: true, fileCount: walkFiles(root).length });
  record({ control: 'recorder', absent: true, eventCount: recorder.length + 1 });
  assertAbsent('recorder-final', JSON.stringify(recorder));
  process.stdout.write(JSON.stringify({ ok: true, gate: 'dummy-secret-negative-controls', recorder }) + '\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
