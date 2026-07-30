#!/usr/bin/env node
// Org chart server: serves the tree, reports per-repo broker health, opens
// a terminal attached to an agent, and renders live workstream status.
// Localhost only, no dependencies.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = 4780;

// Read-only: this server never writes outside its own directory.
const WORKSTREAMS_DIR = join(HERE, '..', '..', 'workstreams');
const STATUS_ORDER = { active: 0, blocked: 1, parked: 2, done: 3 };

// Sibling repos referenced by workstream frontmatter `repos:` live one level
// above the AgentWorkforce projects directory this repo sits in.
const REPOS_ROOT = join(HERE, '..', '..', '..');
const GIT_CACHE_TTL_MS = 60_000;
const GIT_LOG_DELIM = '\x1f';

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

// Splits a workstream file into its frontmatter (status/owner/updated/repos)
// and body. Frontmatter is flat `key: value`; repos is a bracketed list.
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (key === 'repos') {
      value = value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    }
    meta[key] = value;
  }
  return { meta, body: match[2] };
}

function extractTitle(body) {
  return body.match(/^#\s+(.+)$/m)?.[1].trim() ?? '';
}

// Strips **bold**/*italic* emphasis markers, keeping the underlying text.
function stripEmphasis(text) {
  return text.replace(/\*\*(.+?)\*\*/gs, '$1').replace(/\*(.+?)\*/gs, '$1');
}

function clean(text, cap = 400) {
  const collapsed = stripEmphasis(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > cap ? `${collapsed.slice(0, cap).trim()}…` : collapsed;
}

// Frontmatter string values (tldr) are quoted; strip the surrounding quotes.
function stripQuotes(text) {
  const match = text.match(/^"(.*)"$/s) ?? text.match(/^'(.*)'$/s);
  return match ? match[1] : text;
}

// Fallback for workstreams without a tldr: the first sentence of Goal.
function firstSentence(text) {
  if (!text) return '';
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).trim();
}

// A field runs from its `**Label:**` marker to the next section label
// (Goal/Now/Next), the next heading, or end of body — whichever comes
// first. Bounded to the known labels rather than any bold-prefixed line:
// hard-wrapped prose routinely starts a line mid-bold-span (e.g. a bold PR
// title wraps onto its own line), which a generic "**-prefixed line" rule
// would mistake for a new block and truncate real content on.
const FIELD_LABELS = ['Goal', 'Now', 'Next'];
function extractField(body, label) {
  const others = FIELD_LABELS.filter((l) => l !== label).join('|');
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*(?:${others}):\\*\\*|\\n#{1,6}\\s|$)`);
  const value = body.match(re)?.[1];
  return value ? clean(value) : '';
}

// History bullets look like "- YYYY-MM-DD — text" or "- YYYY-MM-DD (digest) —
// text", newest first, with wrapped continuation lines indented under the
// bullet. The first bullet in the section is the latest update.
//
// The heading is located with a multiline `^` (it isn't at the start of
// body), but the entry itself is then matched against the *un-flagged*
// remainder of the string — under the 'm' flag `$` matches end-of-line, not
// end-of-string, which would truncate every multi-line entry to its first line.
const HISTORY_HEADING_RE = /^## History\s*\n+/m;
const HISTORY_ENTRY_RE = /^- (\d{4}-\d{2}-\d{2})(?:\s*\([^)]*\))?\s*—\s*([\s\S]*?)(?=\n- \d{4}-\d{2}-\d{2}|\n#{1,6}\s|$)/;

function extractLatestUpdate(body) {
  const heading = body.match(HISTORY_HEADING_RE);
  if (!heading) return null;
  const section = body.slice(heading.index + heading[0].length);
  const match = section.match(HISTORY_ENTRY_RE);
  if (!match) return null;
  return { date: match[1], text: clean(match[2], 200) };
}

function humanizeAgo(epochSeconds) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function runGit(repoPath, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, maxBuffer: 2 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

// Per-repo git activity (read-only), memoized for GIT_CACHE_TTL_MS so the
// 60s UI poll doesn't fork a fresh `git log` per project every request —
// repos shared across workstreams (relaycast, cloud, ...) are read once per
// cache window regardless of how many projects reference them.
const gitCache = new Map();

function repoGitActivity(repoPath) {
  const cached = gitCache.get(repoPath);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.promise;
  const promise = (async () => {
    const [countOut, recentOut] = await Promise.all([
      runGit(repoPath, ['log', '--all', '--since=24h', '--oneline']),
      runGit(repoPath, ['log', '--all', '-5', `--format=%s${GIT_LOG_DELIM}%ct`]),
    ]);
    const commits24h = countOut ? countOut.split('\n').filter(Boolean).length : 0;
    const recent = recentOut
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [subject, epoch] = line.split(GIT_LOG_DELIM);
        return { subject, epoch: Number(epoch) };
      });
    return { commits24h, recent };
  })();
  gitCache.set(repoPath, { expires: now + GIT_CACHE_TTL_MS, promise });
  return promise;
}

// Aggregates git activity across a workstream's repos: total commits in the
// last 24h, the single most recent commit, and up to 5 most recent overall.
async function projectPulse(repos) {
  const existing = repos.filter((r) => existsSync(join(REPOS_ROOT, r)));
  const perRepo = await Promise.all(
    existing.map(async (r) => ({ repo: r, ...(await repoGitActivity(join(REPOS_ROOT, r))) }))
  );
  const commits24h = perRepo.reduce((sum, r) => sum + r.commits24h, 0);
  const allRecent = perRepo
    .flatMap((r) => r.recent.map((c) => ({ ...c, repo: r.repo })))
    .sort((a, b) => b.epoch - a.epoch);
  const toCommit = (c) => ({ repo: c.repo, subject: c.subject, ago: humanizeAgo(c.epoch), epoch: c.epoch });
  return {
    commits24h,
    latestCommit: allRecent[0] ? toCommit(allRecent[0]) : null,
    recentCommits: allRecent.slice(0, 5).map(toCommit),
  };
}

// An agent belongs to a project if its repo's basename matches one of the
// workstream's `repos:` entries (plain string match — "agentrelay.com"'s dot
// is just part of the basename, nothing to special-case) or its name is the
// workstream's owner. Dedupe: an agent can match both rules for one project.
function matchAgents(repos, owner, agents) {
  const repoSet = new Set(repos);
  const seen = new Set();
  const matches = [];
  for (const agent of agents) {
    if (!repoSet.has(basename(agent.repo)) && agent.name !== owner) continue;
    if (seen.has(agent.name)) continue;
    seen.add(agent.name);
    matches.push({ name: agent.name, title: agent.title, status: agent.status });
  }
  return matches;
}

async function loadProjects(agents) {
  const files = (await readdir(WORKSTREAMS_DIR)).filter((f) => f.endsWith('.md')).sort();
  const projects = await Promise.all(files.map(async (file) => {
    const raw = await readFile(join(WORKSTREAMS_DIR, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const goal = extractField(body, 'Goal');
    const repos = meta.repos ?? [];
    const owner = meta.owner ?? '';
    const pulse = await projectPulse(repos);
    return {
      file,
      status: meta.status ?? '',
      owner,
      updated: meta.updated ?? '',
      repos,
      title: extractTitle(body),
      card: meta.card ? stripQuotes(meta.card) : '',
      tldr: (meta.tldr ? stripQuotes(meta.tldr) : '') || firstSentence(goal),
      goal,
      now: extractField(body, 'Now'),
      next: extractField(body, 'Next'),
      latestUpdate: extractLatestUpdate(body),
      commits24h: pulse.commits24h,
      latestCommit: pulse.latestCommit,
      recentCommits: pulse.recentCommits,
      agents: matchAgents(repos, owner, agents),
    };
  }));
  projects.sort((a, b) => {
    const order = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (order !== 0) return order;
    const aEpoch = a.latestCommit?.epoch ?? -Infinity;
    const bEpoch = b.latestCommit?.epoch ?? -Infinity;
    if (bEpoch !== aEpoch) return bEpoch - aEpoch;
    return a.file.localeCompare(b.file);
  });
  return projects;
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

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const org = await loadOrg();
      return send(res, 200, await loadProjects(org.agents));
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
