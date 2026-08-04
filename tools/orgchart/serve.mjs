#!/usr/bin/env node
// Org chart server: serves the tree, reports per-repo broker health, opens
// a terminal attached to an agent, and renders live workstream status.
// Localhost only, no dependencies.
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from '../../scripts/lib/chief-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = 4780;

// Read-only: this server never writes outside its own directory.
const REPO_ROOT = join(HERE, '..', '..');
const activeTeam = () => loadConfig().roster;
const brainRoot = () => join(REPO_ROOT, `principals/${activeTeam().principal.slug}`);
const workstreamsDir = () => join(brainRoot(), 'workstreams');
const STATUS_ORDER = { active: 0, blocked: 1, parked: 2, done: 3 };

// Sibling repos referenced by workstream frontmatter `repos:` live one level
// above the AgentWorkforce projects directory this repo sits in.
const REPOS_ROOT = join(HERE, '..', '..', '..');
const GIT_CACHE_TTL_MS = 60_000;
const GIT_LOG_DELIM = '\x1f';

// Review inbox: chief is the sole writer of queue.md, this server only reads
// it and relays verdict clicks back to chief as a DM — it never edits the
// file directly.
const CHIEF_REPO = join(HERE, '..', '..');
const REVIEW_CACHE_TTL_MS = 30_000;
const REVIEW_STATE_DIR = join(HERE, '.state');
const REVIEW_STATE_FILE = join(REVIEW_STATE_DIR, 'review-seen.json');
const REVIEW_VERDICTS = new Set(['approve', 'reject', 'discuss']);

// Terminal.app inherits a minimal env, so resolve the active agent-relay shim
// once and carry both its directory and the current node binary directory into
// attach shells. AGENT_RELAY_BIN remains an explicit operator override.
function resolveRelayBin() {
  if (process.env.AGENT_RELAY_BIN) return process.env.AGENT_RELAY_BIN;
  try {
    return execFileSync('/usr/bin/which', ['agent-relay'], {
      encoding: 'utf8',
      env: process.env,
    }).trim();
  } catch {
    return 'agent-relay';
  }
}

const RELAY_BIN = resolveRelayBin();
const RELAY_BIN_DIR = dirname(RELAY_BIN);
const NODE_BIN_DIR = dirname(process.execPath);
const GHOSTTY_APP = '/Applications/Ghostty.app';

const NOT_ATTACHABLE = {
  unseated: 'has no seat yet — nothing is running to attach to.',
  'pending-spawn': 'has not been spawned yet — spawn it before attaching.',
};

const RUNTIME_CACHE_TTL_MS = 5_000;
let runtimeCache = null;

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Agent Relay may append a human update notice after its JSON payload. Parse
// the first complete JSON object/array instead of assuming stdout is only JSON.
function parseFirstJson(text) {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error('Agent Relay command did not return JSON');
}

function overlayMatchesPrincipal(overlay, principal) {
  if (!overlay?.principal) return false;
  const overlaySlug = overlay.principal.slug || slugify(overlay.principal.name);
  return overlaySlug === principal.slug;
}

function inferLiveTitle(agent) {
  if (agent.name?.toLowerCase().includes('chief')) return 'Chief of Staff';
  if (agent.team) return `${agent.team} agent`;
  return `${agent.cli || agent.runtime || 'Relay'} agent`;
}

function buildRuntimeOrg(config, overlay, liveAgents = []) {
  const principal = { ...config.principal };
  const declared = new Map();

  // org.json is now an optional, same-principal hierarchy overlay. It keeps
  // Will's richer department tree when Will's roster is active, but can never
  // replace the principal selected by teams.json.
  if (overlayMatchesPrincipal(overlay, principal)) {
    for (const agent of overlay.agents ?? []) {
      const reportsTo = agent.reportsTo === overlay.principal.name
        ? principal.name
        : agent.reportsTo;
      declared.set(agent.name, {
        ...agent,
        reportsTo: reportsTo || principal.name,
        source: 'org-overlay',
      });
    }
  }

  const rosterChief = config.agents.find((agent) => agent.role === 'chief of staff')?.name;
  const liveChief = liveAgents.find((agent) => agent.name === rosterChief)?.name
    || liveAgents.find((agent) => agent.name?.toLowerCase().includes('chief'))?.name;
  for (const agent of config.agents) {
    const current = declared.get(agent.name) ?? {};
    declared.set(agent.name, {
      ...current,
      name: agent.name,
      title: agent.title || current.title || agent.role,
      reportsTo: agent.reportsTo || current.reportsTo || principal.name,
      repo: agent.repo || current.repo || REPO_ROOT,
      status: current.status === 'unseated' ? 'unseated' : 'pending-spawn',
      attachable: false,
      source: 'teams.json',
    });
  }

  for (const live of liveAgents) {
    const current = declared.get(live.name) ?? {};
    const looksLikeChief = live.name?.toLowerCase().includes('chief');
    declared.set(live.name, {
      ...current,
      name: live.name,
      title: current.title || inferLiveTitle(live),
      reportsTo: current.reportsTo || (looksLikeChief ? principal.name : liveChief || rosterChief || principal.name),
      repo: current.repo || REPO_ROOT,
      status: 'resident',
      attachable: true,
      live: true,
      currentState: live.current_state || 'online',
      lastActivityMs: live.last_activity_ms ?? null,
      cli: live.cli ?? null,
      runtime: live.runtime_kind || live.runtime || null,
      source: current.source ? `${current.source}+live` : 'live-broker',
    });
  }

  return { principal, agents: [...declared.values()] };
}

function executionLayersFromFleet(fleet, error = null) {
  const cloudOnline = !error;
  const layers = [{
    id: 'agent-relay-cloud',
    name: 'Agent Relay Cloud',
    title: 'Hosted workflows and Factory execution',
    kind: 'cloud',
    status: cloudOnline ? 'online' : 'unavailable',
    live: cloudOnline,
    capabilities: ['factory:control-plane', 'workflow:hosted'],
    detail: error ? error.message : 'Workspace control plane reachable',
  }];

  for (const node of fleet?.nodes ?? []) {
    layers.push({
      id: node.id,
      name: node.name,
      title: 'Fleet execution node',
      kind: 'fleet-node',
      status: node.status,
      live: node.live === true && node.status === 'online',
      capabilities: (node.capabilities ?? []).map((capability) => capability.name),
      tags: node.tags ?? [],
      activeAgents: node.activeAgents ?? 0,
      maxAgents: node.maxAgents ?? 0,
      handlersLive: node.handlersLive === true,
      version: node.version ?? '',
      lastHeartbeatAt: node.lastHeartbeatAt ?? null,
    });
  }
  return layers;
}

function capture(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd: REPO_ROOT,
      env: childEnv(),
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });
}

// org.json holds one hierarchy overlay per principal (`{ overlays: [...] }`) so
// Khaliq's and Will's department trees can live in the same committed file
// without either one clobbering the other — loadRuntime() below picks the
// entry matching the currently active principal via overlayMatchesPrincipal.
async function readOrgOverlays() {
  try {
    const parsed = JSON.parse(await readFile(join(HERE, 'org.json'), 'utf8'));
    if (Array.isArray(parsed?.overlays)) return parsed.overlays;
    // Back-compat: a bare single-overlay object (the pre-multi-principal shape).
    if (parsed?.principal) return [parsed];
    return [];
  } catch {
    return [];
  }
}

async function loadRuntime() {
  const now = Date.now();
  if (runtimeCache && runtimeCache.expires > now) return runtimeCache.promise;
  const promise = (async () => {
    const config = activeTeam();
    const [overlays, localResult, fleetResult] = await Promise.all([
      readOrgOverlays(),
      capture(RELAY_BIN, ['node', 'agent', 'list'])
        .then((stdout) => ({ value: parseFirstJson(stdout), error: null }))
        .catch((error) => ({ value: [], error })),
      capture(RELAY_BIN, ['fleet', 'nodes'])
        .then((stdout) => ({ value: parseFirstJson(stdout), error: null }))
        .catch((error) => ({ value: { nodes: [] }, error })),
    ]);
    const overlay = overlays.find((entry) => overlayMatchesPrincipal(entry, config.principal)) ?? null;
    return {
      org: buildRuntimeOrg(config, overlay, Array.isArray(localResult.value) ? localResult.value : []),
      executionLayers: executionLayersFromFleet(fleetResult.value, fleetResult.error),
      warnings: [localResult.error, fleetResult.error].filter(Boolean).map((error) => error.message),
    };
  })();
  runtimeCache = { expires: now + RUNTIME_CACHE_TTL_MS, promise };
  return promise;
}

async function loadOrg() {
  return (await loadRuntime()).org;
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
  const directory = workstreamsDir();
  const files = (await readdir(directory)).filter((f) => f.endsWith('.md')).sort();
  const projects = await Promise.all(files.map(async (file) => {
    const raw = await readFile(join(directory, file), 'utf8');
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

// --------------------------------------------------------------- review queue

// review/queue.md sections look like:
//   ## RQ-1: Title
//   - status: pending
//   - ask: run `wrangler login` (browser, ~2 min) — every CF credential on
//     this machine is dead.
// Bullet values wrap onto indented continuation lines with no `- ` prefix;
// those are folded back into the bullet they follow.
const REVIEW_HEADING_RE = /^## (RQ-\d+):\s*(.+)$/;
const REVIEW_BULLET_RE = /^- ([a-z][a-z-]*):\s?(.*)$/;
const REVIEW_SUMMARY_KEYS = new Set(['status', 'date', 'from', 'ask']);

function parseReviewQueue(raw) {
  const items = [];
  let current = null;
  let currentField = null;
  for (const line of raw.split('\n')) {
    const heading = line.match(REVIEW_HEADING_RE);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), order: [], fields: {} };
      items.push(current);
      currentField = null;
      continue;
    }
    if (!current) continue;
    const bullet = line.match(REVIEW_BULLET_RE);
    if (bullet) {
      const [, key, value] = bullet;
      current.fields[key] = value.trim();
      current.order.push(key);
      currentField = key;
      continue;
    }
    if (currentField && /^\s+\S/.test(line)) {
      current.fields[currentField] = `${current.fields[currentField]} ${line.trim()}`;
      continue;
    }
    currentField = null; // blank line or unindented prose ends the run
  }
  return items.map(toReviewCard);
}

// Splits a parsed item into the fields the UI treats specially (status,
// date, from, ask) and the rest, in file order, for generic labeled rows —
// keys vary per item (why-you, recommendation, on-done, on-approve, ...) so
// nothing beyond the summary keys is hardcoded.
function toReviewCard(item) {
  const status = item.fields.status ?? '';
  const seen = new Set();
  const fields = [];
  for (const key of item.order) {
    if (REVIEW_SUMMARY_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    fields.push({ key, value: item.fields[key] });
  }
  return {
    id: item.id,
    title: item.title,
    status,
    pending: status === 'pending',
    date: item.fields.date ?? '',
    from: item.fields.from ?? '',
    ask: item.fields.ask ?? '',
    fields,
  };
}

// In-memory seen-id set for review notifications, backed by a state file so
// restarts don't re-page for items already surfaced. `null` means not yet
// loaded from disk this process; loadSeenState() populates it once.
let seenReviewIds = null;
let seenReviewInitialized = false;

async function loadSeenState() {
  if (seenReviewIds) return;
  try {
    const data = JSON.parse(await readFile(REVIEW_STATE_FILE, 'utf8'));
    seenReviewIds = new Set(data.seenIds ?? []);
    seenReviewInitialized = true;
  } catch {
    seenReviewIds = new Set();
    seenReviewInitialized = false; // no state file yet: bootstrap on first pass, don't page
  }
}

async function saveSeenState() {
  await mkdir(REVIEW_STATE_DIR, { recursive: true });
  await writeFile(REVIEW_STATE_FILE, JSON.stringify({ seenIds: [...seenReviewIds] }, null, 2));
}

// AppleScript string literal for `osascript -e`: backslash- and
// quote-escape. osascript takes one shell arg per -e, so nothing beyond
// this needs escaping.
function appleScriptString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function notifyNewReviewItem(item) {
  const message = appleScriptString(`${item.id}: ${item.title}`);
  try {
    await run('osascript', ['-e', `display notification ${message} with title "Review needed" sound name "Glass"`]);
  } catch (err) {
    console.error(`review notification failed for ${item.id}:`, err.message);
  }
}

// Called on every fresh (non-memoized) parse of queue.md. Diffs the current
// pending set against what's already been seen and pages for anything new.
// First-ever run adopts the current pending set as seen without paging —
// those items are already known to Will.
async function handleReviewNotifications(items) {
  await loadSeenState();
  const pending = items.filter((i) => i.pending);
  if (!seenReviewInitialized) {
    for (const item of pending) seenReviewIds.add(item.id);
    seenReviewInitialized = true;
    await saveSeenState();
    return;
  }
  const fresh = pending.filter((item) => !seenReviewIds.has(item.id));
  if (!fresh.length) return;
  for (const item of fresh) {
    await notifyNewReviewItem(item);
    seenReviewIds.add(item.id);
  }
  await saveSeenState();
}

let reviewCache = null; // { expires, promise }

async function loadReviewQueue() {
  const now = Date.now();
  if (reviewCache && reviewCache.expires > now) return reviewCache.promise;
  const promise = (async () => {
    let raw;
    try {
      raw = await readFile(join(brainRoot(), 'review', 'queue.md'), 'utf8');
    } catch {
      return [];
    }
    const items = parseReviewQueue(raw);
    await handleReviewNotifications(items);
    return items;
  })();
  reviewCache = { expires: now + REVIEW_CACHE_TTL_MS, promise };
  return promise;
}

// Reads port + key from chief's own connection.json. The api_key never
// leaves this process — it's only ever attached to the outbound request
// header, never logged.
async function chiefConnection() {
  const path = join(CHIEF_REPO, '.agentworkforce/relay/connection.json');
  if (!existsSync(path)) return null;
  try {
    const conn = JSON.parse(await readFile(path, 'utf8'));
    return conn.port && conn.api_key ? conn : null;
  } catch {
    return null;
  }
}

// Relays a verdict click to chief as a DM over the broker HTTP API. The
// dashboard never edits queue.md — chief is the sole writer and clears the
// item itself once it acts on the DM.
async function sendToChief(text) {
  const conn = await chiefConnection();
  if (!conn) return { ok: false };
  try {
    const config = activeTeam();
    const configuredChief = config.agents.find((agent) => agent.role === 'chief of staff')?.name;
    const runtime = await loadRuntime();
    const recipient = runtime.org.agents.find((agent) => agent.name === configuredChief && agent.live)?.name
      || runtime.org.agents.find((agent) => agent.live && agent.title === 'Chief of Staff')?.name
      || configuredChief;
    if (!recipient) return { ok: false };
    const res = await fetch(`http://127.0.0.1:${conn.port}/api/send`, {
      method: 'POST',
      headers: { 'X-API-Key': conn.api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ to: recipient, from: 'review-dashboard', message: text }),
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
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

const ATTACH_MODES = new Set(['view', 'drive']);

function attachCommand(agent, mode) {
  const driveFlag = mode === 'drive' ? ' --mode drive' : '';
  const attach = `${shellQuote(RELAY_BIN)} node agent attach ${shellQuote(agent.name)}${driveFlag}`;
  return [
    `unset ${CONNECTION_ENV.join(' ')}`,
    `export PATH=${shellQuote(RELAY_BIN_DIR)}:${shellQuote(NODE_BIN_DIR)}:"$PATH"`,
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
      return send(res, 200, await loadOrg());
    }

    if (req.method === 'GET' && url.pathname === '/api/runtime') {
      return send(res, 200, await loadRuntime());
    }

    if (req.method === 'GET' && url.pathname === '/api/execution') {
      return send(res, 200, (await loadRuntime()).executionLayers);
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

    if (req.method === 'GET' && url.pathname === '/api/review') {
      return send(res, 200, await loadReviewQueue());
    }

    if (req.method === 'POST' && url.pathname === '/api/review/verdict') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { id, verdict } = body;
      if (!REVIEW_VERDICTS.has(verdict)) {
        return send(res, 400, { ok: false, error: `Invalid verdict: ${verdict}` });
      }
      const items = await loadReviewQueue();
      const item = items.find((i) => i.id === id);
      if (!item) return send(res, 404, { ok: false, error: `Unknown review item: ${id}` });
      const text = `[review] ${activeTeam().principal.name} clicked ${verdict.toUpperCase()} on ${item.id}: ${item.title}`;
      const result = await sendToChief(text);
      if (!result.ok) return send(res, 502, { ok: false, error: 'Could not reach chief over the broker' });
      return send(res, 200, { ok: true, message: 'Sent to chief — it executes and clears the item' });
    }

    if (req.method === 'POST' && url.pathname === '/api/attach') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { name } = body;
      const mode = body.mode ?? 'view';
      if (!ATTACH_MODES.has(mode)) return send(res, 400, { ok: false, error: `Invalid mode: ${mode}` });
      const org = await loadOrg();
      const agent = org.agents.find((a) => a.name === name);
      if (!agent) return send(res, 404, { ok: false, error: `Unknown agent: ${name}` });
      if (agent.attachable === false) {
        return send(res, 409, { ok: false, error: `${agent.name} is not running on this local broker.` });
      }
      if (NOT_ATTACHABLE[agent.status]) {
        return send(res, 409, { ok: false, error: `${agent.name} ${NOT_ATTACHABLE[agent.status]}` });
      }
      const app = await openTerminal(attachCommand(agent, mode));
      console.log(`attach ${agent.name} -> ${app} (${agent.repo}) mode=${mode}`);
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

// Guarded so this module can be imported (e.g. to exercise the review-queue
// parser/notifier in a test script) without binding the port a second time.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(`Org chart on http://${HOST}:${PORT}`);
  });
}

export {
  buildRuntimeOrg,
  executionLayersFromFleet,
  handleReviewNotifications,
  parseFirstJson,
  parseReviewQueue,
};
