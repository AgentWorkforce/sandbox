#!/usr/bin/env node
// Org chart server: serves the tree, reports per-repo broker health, and opens
// a terminal attached to an agent. Localhost only, no dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = 4780;

// Terminal.app inherits a minimal env, so the attach command carries its own
// PATH — the agent-relay shim is a node script and needs node beside it.
const RELAY_BIN_DIR = '/Users/will/.nvm/versions/node/v22.22.2/bin';
const RELAY_BIN = join(RELAY_BIN_DIR, 'agent-relay');
const GHOSTTY_APP = '/Applications/Ghostty.app';

const NOT_ATTACHABLE = {
  unseated: 'has no seat yet — nothing is running to attach to.',
  'pending-spawn': 'has not been spawned yet — spawn it before attaching.',
};

async function loadOrg() {
  return JSON.parse(await readFile(join(HERE, 'org.json'), 'utf8'));
}

// Reads only the port. The api_key in this file never leaves the process.
async function brokerPort(repo) {
  const path = join(repo, '.agentworkforce/relay/connection.json');
  if (!existsSync(path)) return null;
  try {
    const port = JSON.parse(await readFile(path, 'utf8')).port;
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

async function repoStatus(repo) {
  const port = await brokerPort(repo);
  if (!port) return { up: false, agentCount: 0 };
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return { up: false, agentCount: 0 };
    const health = await res.json();
    return { up: health.status === 'ok', agentCount: health.agentCount ?? 0 };
  } catch {
    return { up: false, agentCount: 0 };
  }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The CLI resolves broker url and api key independently, so an ambient
// RELAY_BROKER_API_KEY (this process is itself a relay agent) would pair one
// broker's key with the target repo's url and 401. Clear both and let the
// target repo's connection.json answer for itself.
const CONNECTION_ENV = ['RELAY_BROKER_URL', 'RELAY_BROKER_API_KEY'];

function attachCommand(agent) {
  const attach = `${shellQuote(RELAY_BIN)} node agent attach ${shellQuote(agent.name)}`;
  return [
    `unset ${CONNECTION_ENV.join(' ')}`,
    `export PATH=${shellQuote(RELAY_BIN_DIR)}:"$PATH"`,
    `cd ${shellQuote(agent.repo)} || exit 1`,
    // Hold the window open on failure — otherwise it closes before the error is readable.
    `${attach} || { printf '\\n[attach exited %s — press Enter to close]\\n' "$?"; read -r _; }`,
  ].join('; ');
}

function childEnv() {
  const env = { ...process.env };
  for (const key of CONNECTION_ENV) delete env[key];
  return env;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: childEnv() }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve();
    });
  });
}

async function openTerminal(command) {
  if (existsSync(GHOSTTY_APP)) {
    await run('open', ['-na', 'Ghostty', '--args', '-e', '/bin/sh', '-c', command]);
    return 'Ghostty';
  }
  const script = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await run('osascript', [
    '-e', 'tell application "Terminal" to activate',
    '-e', `tell application "Terminal" to do script "${script}"`,
  ]);
  return 'Terminal';
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8192) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(HERE, 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/org.json') {
      const json = await readFile(join(HERE, 'org.json'), 'utf8');
      return send(res, 200, json);
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const org = await loadOrg();
      const repos = [...new Set(org.agents.map((a) => a.repo))];
      const results = await Promise.all(repos.map(repoStatus));
      return send(res, 200, Object.fromEntries(repos.map((r, i) => [r, results[i]])));
    }

    if (req.method === 'POST' && url.pathname === '/api/attach') {
      const { name } = JSON.parse((await readBody(req)) || '{}');
      const org = await loadOrg();
      const agent = org.agents.find((a) => a.name === name);
      if (!agent) return send(res, 404, { ok: false, error: `Unknown agent: ${name}` });
      if (NOT_ATTACHABLE[agent.status]) {
        return send(res, 409, { ok: false, error: `${agent.name} ${NOT_ATTACHABLE[agent.status]}` });
      }
      const app = await openTerminal(attachCommand(agent));
      console.log(`attach ${agent.name} -> ${app} (${agent.repo})`);
      return send(res, 200, { ok: true, app, message: `Attached to ${agent.name} in ${app}` });
    }

    send(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err.message);
    send(res, 500, { ok: false, error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — the org chart may already be running.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Org chart on http://${HOST}:${PORT}`);
});
