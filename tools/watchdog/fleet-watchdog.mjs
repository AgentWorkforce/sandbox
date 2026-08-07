#!/usr/bin/env node
// Fleet liveness watchdog — alert-only pager for resident agents that go
// alive-but-unresponsive (PTY up, broker healthy, messages never processed).
//
// Tiered, so the common case costs nothing:
//   T1  every run, zero tokens: does this resident have work addressed to it
//       that it has not read, while its own relay activity has stopped?
//   T2  only on a T1 trip: DM that one resident a liveness probe from the
//       dedicated `watchdog` identity and wait for a bare ACK.
//   T3  no ACK inside the response window: page chief with the evidence chain.
//
// Passive harness signals (transcript freshness, turn state, CPU) are gathered
// for every resident but never trip on their own — they ride along in the alert
// so a reader can tell "hung" from "mid-heavy-build and slow".
//
// Signals, trip conditions and false positives: see README.md.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
// Overridable so the pipeline can be exercised against fixtures (see README).
const LAUNCH_AGENTS = process.env.WATCHDOG_LAUNCH_AGENTS || path.join(HOME, 'Library/LaunchAgents');
const LOG_FILE = process.env.WATCHDOG_LOG_FILE || path.join(HOME, 'Library/Logs/fleet-watchdog.log');
const SUPPORT_DIR = process.env.WATCHDOG_SUPPORT_DIR || path.join(HOME, 'Library/Application Support/fleet-watchdog');
const STATE_FILE = process.env.WATCHDOG_STATE_FILE || path.join(SUPPORT_DIR, 'state.json');
const IDENTITY_FILE = process.env.WATCHDOG_IDENTITY_FILE || path.join(SUPPORT_DIR, 'identity.json');
const CLAUDE_PROJECTS = process.env.WATCHDOG_CLAUDE_PROJECTS || path.join(HOME, '.claude/projects');
const CODEX_SESSIONS = process.env.WATCHDOG_CODEX_SESSIONS || path.join(HOME, '.codex/sessions');

const API = process.env.WATCHDOG_API_BASE || 'https://cast.agentrelay.com/v1';
const UA = 'fleet-watchdog/1.0';
const RELAY_LOG_DIR = process.env.WATCHDOG_RELAY_LOG_DIR
  || path.join(HOME, 'Library/Logs/agentworkforce/relay');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

// Minutes a message may sit unread before it counts as stale work.
const STALE_MIN = num('WATCHDOG_STALE_MINUTES', 15);
// Minutes a resident has to answer a T2 probe before it is paged.
const RESPONSE_MIN = num('WATCHDOG_RESPONSE_MINUTES', 10);
// Grace after spawn.
const BOOT_GRACE_MIN = num('WATCHDOG_BOOT_GRACE_MINUTES', 10);
// Never probe more than this many residents in one sweep.
const MAX_PINGS = num('WATCHDOG_MAX_PINGS_PER_SWEEP', 3);
// Ignore inbound older than this; pre-restart backlog is not actionable.
const LOOKBACK_HOURS = num('WATCHDOG_LOOKBACK_HOURS', 12);
// Read-receipt checks per resident per sweep (newest first).
const MAX_CANDIDATES = num('WATCHDOG_MAX_CANDIDATES', 5);
// CPU seconds the process tree must burn between runs to count as working.
const CPU_ACTIVE_SEC = num('WATCHDOG_CPU_ACTIVE_SECONDS', 5);
// Re-page interval for a condition that is still true.
const REALERT_MIN = num('WATCHDOG_REALERT_MINUTES', 60);
const CODEX_LOOKBACK_DAYS = num('WATCHDOG_CODEX_LOOKBACK_DAYS', 3);
const BROKER_FAILURE_MIN = num('WATCHDOG_BROKER_FAILURE_MINUTES', 20);
const PTY_TIMEOUT_LIMIT = num('WATCHDOG_PTY_TIMEOUT_LIMIT', 2);
const UNVERIFIED_LIMIT = num('WATCHDOG_UNVERIFIED_DELIVERY_LIMIT', 3);
const CLOUD_FAILURE_LIMIT = num('WATCHDOG_CLOUD_FAILURE_SWEEPS', 2);

const CHIEF_REPO = process.env.WATCHDOG_CHIEF_REPO || path.join(HOME, 'Projects/AgentWorkforce/chief');
const DM_TARGET_OVERRIDE = process.env.WATCHDOG_DM_TARGET || null;

const DRY_RUN = process.argv.includes('--dry-run');   // evaluate only; no sends or persistent writes
const NO_PING = process.argv.includes('--no-ping');   // T1 only, never probe
const AS_JSON = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet');

const PING_TEXT = 'liveness check from the fleet watchdog. Reply with exactly: ACK '
  + '— nothing else, no investigation, no tool calls, and do not change whatever you '
  + 'were doing. This is an automated responsiveness probe.';

const NOW = Date.now();

// ---------------------------------------------------------------- utilities

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

const minsSince = (ms) => (ms == null ? null : (NOW - ms) / 60000);
const fmtMin = (m) => (m == null ? '—' : m < 1 ? '<1m' : `${Math.round(m)}m`);
const parseTs = (s) => {
  const t = Date.parse(s ?? '');
  return Number.isFinite(t) ? t : null;
};

const pidAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Read the trailing bytes of a file and return whole parsed JSONL records. */
function tailRecords(file, bytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* truncated / non-JSON line */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Parse the first JSONL record of a file. Codex `session_meta` headers embed
 * `base_instructions` and routinely run past 100KB, so grow the read until a
 * newline shows up rather than assuming a small header.
 */
function readFirstRecord(file, cap = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let want = 256 * 1024;
    while (want <= cap) {
      const len = Math.min(want, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      const text = buf.toString('utf8');
      const nl = text.indexOf('\n');
      if (nl > -1) return JSON.parse(text.slice(0, nl));
      if (len >= size) return JSON.parse(text); // single-line file
      want *= 4;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// -------------------------------------------------------- resident discovery

/** Residents are launchd jobs: com.agentworkforce.<repo>.node */
function discoverResidents() {
  let entries = [];
  try {
    entries = fs.readdirSync(LAUNCH_AGENTS);
  } catch {
    return [];
  }
  const out = [];
  for (const f of entries) {
    const m = /^com\.agentworkforce\.(.+)\.node\.plist$/.exec(f);
    if (!m) continue;
    let plist;
    try {
      plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(LAUNCH_AGENTS, f)], { encoding: 'utf8' }));
    } catch {
      continue;
    }
    if (!plist.WorkingDirectory) continue;
    out.push({ slug: m[1], cwd: plist.WorkingDirectory });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The checked-in roster is the authority for which agents must stay resident. */
export function expectedAgents(repoCwd) {
  const roster = readJson(path.join(repoCwd, 'teams.json'));
  if (!Array.isArray(roster?.agents)) return [];
  return roster.agents.filter((agent) => agent?.name && agent?.cli);
}

/** Page the principal directly; a dead Chief cannot consume its own alert. */
export function resolveDmTarget(residents) {
  if (DM_TARGET_OVERRIDE) return DM_TARGET_OVERRIDE;
  for (const resident of residents) {
    const handle = readJson(path.join(resident.cwd, 'teams.json'))?.principal?.handle;
    if (handle) return handle;
  }
  const roster = residents.flatMap((resident) => expectedAgents(resident.cwd));
  return roster.find((agent) => /chief/i.test(agent.role ?? ''))?.name
    ?? roster.find((agent) => /^chief(?:-|$)/i.test(agent.name))?.name
    ?? 'chief';
}

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/gu;

/** Definitive delivery failures from the broker's bounded local log. */
export function brokerDeliveryFailures(logDir, slug, names, sinceMs) {
  const result = Object.fromEntries(
    names.map((name) => [name, {
      ptyTimeouts: 0,
      unverified: 0,
      lastPtyTimeoutAt: null,
      lastUnverifiedAt: null,
    }]),
  );
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter((name) => name === `${slug}.log` || name.startsWith(`${slug}.log.`))
      .map((name) => path.join(logDir, name))
      .sort((a, b) => mtime(b) - mtime(a))
      .slice(0, 2);
  } catch {
    return result;
  }
  for (const file of files) {
    let text;
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      const start = Math.max(0, size - 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd);
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.replace(ANSI_RE, '');
      const timestamp = parseTs(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/u.exec(line)?.[0]);
      if (timestamp == null || timestamp < sinceMs) continue;
      const worker = /(?:^|\s)worker=([^\s]+)/u.exec(line)?.[1];
      if (!worker || !Object.hasOwn(result, worker)) continue;
      if (line.includes('worker request timed out before worker responded')
        && line.includes('kind=write_pty')) {
        result[worker].ptyTimeouts += 1;
        result[worker].lastPtyTimeoutAt = Math.max(
          result[worker].lastPtyTimeoutAt ?? 0,
          timestamp,
        );
      }
      if (line.includes('delivery acked via timeout fallback')
        && line.includes('echo never verified')) {
        result[worker].unverified += 1;
        result[worker].lastUnverifiedAt = Math.max(
          result[worker].lastUnverifiedAt ?? 0,
          timestamp,
        );
      }
    }
  }
  return result;
}

/**
 * Broker failures only describe an outage while no later resident activity is
 * visible. A transcript write after the newest failure proves the worker made
 * progress, so an old timeout must not keep paging for the whole log window.
 */
export function classifyDeliveryFailures(failures, recoveredAtMs, {
  ptyLimit = PTY_TIMEOUT_LIMIT,
  unverifiedLimit = UNVERIFIED_LIMIT,
} = {}) {
  if (!failures) return null;
  const recoveredAt = recoveredAtMs ?? 0;
  if (failures.ptyTimeouts >= ptyLimit
    && (failures.lastPtyTimeoutAt ?? 0) > recoveredAt) {
    return {
      verdict: 'PTY_UNREACHABLE',
      detail: `${failures.ptyTimeouts} PTY write requests timed out without later resident activity`,
    };
  }
  if (failures.unverified >= unverifiedLimit
    && (failures.lastUnverifiedAt ?? 0) > recoveredAt) {
    return {
      verdict: 'DELIVERY_UNVERIFIED',
      detail: `${failures.unverified} deliveries were acknowledged without verified terminal echo or later resident activity`,
    };
  }
  return null;
}

/** Require consecutive blind sweeps so one transient API response does not page. */
export function cloudBlindStatus(cloudError, previousFailures = 0, limit = CLOUD_FAILURE_LIMIT) {
  const failureCount = cloudError ? previousFailures + 1 : 0;
  if (!cloudError) return { failureCount, row: null };
  const page = failureCount >= limit;
  return {
    failureCount,
    row: {
      repo: 'fleet', agent: 'control-plane', key: 'fleet/cloud',
      verdict: page ? 'CLOUD_BLIND' : 'CLOUD_DEGRADED', page, tier: 0,
      detail: `cannot inspect Relaycast liveness (${cloudError}); blind sweep ${failureCount}/${limit}`,
    },
  };
}

// ------------------------------------------------------------ process CPU

/** pid -> {ppid, cpu} for every process, so we can total an agent's subtree. */
function processTable() {
  const table = new Map();
  let out;
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,ppid=,time='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return table;
  }
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    if (!Number.isFinite(pid)) continue;
    table.set(pid, { ppid: Number(parts[1]), cpu: parseCpuTime(parts[2]) });
  }
  return table;
}

/** "12:34.56" | "1:02:03" | "2-03:04:05" -> seconds */
export function parseCpuTime(s) {
  if (!s) return 0;
  let days = 0;
  let rest = s;
  const dash = s.indexOf('-');
  if (dash > -1) {
    days = Number(s.slice(0, dash)) || 0;
    rest = s.slice(dash + 1);
  }
  let sec = 0;
  for (const p of rest.split(':').map(Number)) sec = sec * 60 + (Number.isFinite(p) ? p : 0);
  return days * 86400 + sec;
}

function subtreeCpu(rootPid, table) {
  if (!table.has(rootPid)) return null;
  const children = new Map();
  for (const [pid, info] of table) {
    if (!children.has(info.ppid)) children.set(info.ppid, []);
    children.get(info.ppid).push(pid);
  }
  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += table.get(pid)?.cpu ?? 0;
    for (const c of children.get(pid) || []) stack.push(c);
  }
  return total;
}

// ----------------------------------------------------- transcript resolution

const claudeSlug = (cwd) => cwd.replace(/[/.]/g, '-');

/**
 * Resolve a claude resident's transcript. The session_id recorded at spawn is
 * authoritative; the newest-file fallback is a guess (it can land on an
 * abandoned session or a human's own session in the same repo).
 */
function resolveClaudeTranscript(cwd, sessionId) {
  const dir = path.join(CLAUDE_PROJECTS, claudeSlug(cwd));
  if (sessionId) {
    const direct = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return { file: direct, how: 'session_id' };
  }
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const ranked = files
    .map((f) => path.join(dir, f))
    .map((p) => ({ p, t: mtime(p) ?? 0 }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 6);
  for (const { p } of ranked) {
    const head = readFirstRecord(p);
    if (head && head.isSidechain) continue;
    return { file: p, how: 'newest-fallback' };
  }
  return ranked.length ? { file: ranked[0].p, how: 'newest-fallback' } : null;
}

let codexIndex = null;
function codexRollouts() {
  if (codexIndex) return codexIndex;
  codexIndex = [];
  for (let i = 0; i < CODEX_LOOKBACK_DAYS; i++) {
    const d = new Date(NOW - i * 86400000);
    const dir = path.join(CODEX_SESSIONS, String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const payload = readFirstRecord(p)?.payload;
      if (!payload?.cwd) continue;
      codexIndex.push({
        p, cwd: payload.cwd, id: payload.id || payload.session_id,
        originator: payload.originator, t: mtime(p) ?? 0,
      });
    }
  }
  return codexIndex;
}

/**
 * Resolve a codex resident's live rollout. Codex forks a new rollout on
 * compaction, so the session_id recorded at spawn goes stale — match on cwd
 * instead. Humans also run Codex Desktop in these repos, so require the
 * broker's originator tag rather than trusting "newest in this directory".
 */
function resolveCodexTranscript(cwd, sessionId) {
  const all = codexRollouts();
  const mine = all.filter((r) => r.cwd === cwd && r.originator === 'agent-relay').sort((a, b) => b.t - a.t);
  if (mine.length) return { file: mine[0].p, how: 'cwd+originator' };
  if (sessionId) {
    const byId = all.find((r) => r.id === sessionId);
    if (byId) return { file: byId.p, how: 'session_id' };
  }
  return null;
}

// -------------------------------------------------------- turn-state parsing

/**
 * Whether the session's final turn completed. 'closed' means the agent
 * finished and is legitimately idle; 'open' means a turn is in flight.
 */
export function turnState(file, cli) {
  const recs = tailRecords(file);
  if (!recs.length) return { state: 'unknown', marker: null };
  const codex = /codex/.test(cli);
  for (let i = recs.length - 1; i >= 0; i--) {
    const v = codex ? codexMarker(recs[i]) : claudeMarker(recs[i]);
    if (v) return { state: v.state, marker: v.marker };
  }
  return { state: 'unknown', marker: null };
}

export function codexMarker(r) {
  const t = r?.payload?.type;
  if (!t) return null;
  if (t === 'task_complete' || t === 'turn_aborted' || t === 'shutdown_complete') return { state: 'closed', marker: t };
  if (t === 'user_message' || t === 'task_started') return { state: 'open', marker: t };
  if (t === 'message' && r?.payload?.role === 'user') return { state: 'open', marker: 'user_message' };
  return null;
}

export function claudeMarker(r) {
  if (r?.type === 'assistant') {
    const stop = r?.message?.stop_reason;
    if (stop === 'end_turn' || stop === 'stop_sequence') return { state: 'closed', marker: 'end_turn' };
    if (stop === 'tool_use') return { state: 'open', marker: 'tool_use' };
    return null; // streaming/partial — keep looking
  }
  if (r?.type === 'user') return { state: 'open', marker: 'user' };
  return null; // system / attachment / summary are not boundaries
}

// ------------------------------------------------------------- cloud client

function loadWorkspaceKey(residents) {
  for (const repo of [CHIEF_REPO, ...residents.map((r) => r.cwd)]) {
    const j = readJson(path.join(repo, '.agentworkforce/relay/workspace-key.json'));
    const key = j?.workspaceKey || j?.key;
    if (typeof key === 'string' && key.startsWith('rk_live_')) return key;
  }
  return null;
}

function makeClient(token) {
  return async function call(pathname, init = {}) {
    const res = await fetch(API + pathname, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': UA,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      // Never echo the response body: it can restate request context.
      const err = new Error(`http_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return (await res.json()).data;
  };
}

// --------------------------------------------------------- tier 1: inbox scan

/**
 * Messages addressed to `agent` that it has not read. "Addressed to" means a DM
 * conversation the agent participates in, authored by somebody else.
 *
 * Bounded on purpose: only messages inside the lookback window, newer than the
 * current PTY session, and newer than the last id already adjudicated for this
 * agent — otherwise a permanently-unread message would re-trip forever.
 */
async function unreadFor(ws, conversations, agent, { sessionStartMs, sinceId, cache }) {
  const floor = Math.max(NOW - LOOKBACK_HOURS * 3600000, sessionStartMs ?? 0);
  const mine = conversations.filter((c) => (c.participants || []).includes(agent));
  const candidates = [];

  for (const conv of mine) {
    // Both participants of a 2-party DM are usually residents; fetch once.
    if (!cache.has(conv.id)) {
      cache.set(conv.id, ws(`/dm/conversations/${conv.id}/messages?limit=20`).catch(() => null));
    }
    const msgs = await cache.get(conv.id);
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (m.agent_name === agent) continue;            // authored by the resident
      const at = parseTs(m.created_at);
      if (at == null || at < floor) continue;
      if (sinceId && String(m.id) <= String(sinceId)) continue;
      candidates.push({ id: String(m.id), from: m.agent_name, at, conv: conv.id });
    }
  }

  candidates.sort((a, b) => b.at - a.at);
  const unread = [];
  let newestId = null;
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    if (!newestId || c.id > newestId) newestId = c.id;
    if ((NOW - c.at) / 60000 < STALE_MIN) continue;    // too fresh to judge
    let readers;
    try {
      readers = await ws(`/messages/${c.id}/readers`);
    } catch {
      continue;
    }
    if (!(Array.isArray(readers) && readers.some((r) => r.agent_name === agent))) unread.push(c);
  }
  return { unread, newestId };
}

// ------------------------------------------------------------ tier 2: probe

async function sendProbe(agentClient, target) {
  const data = await agentClient('/dm', {
    method: 'POST',
    body: JSON.stringify({ to: target, text: PING_TEXT }),
  });
  return {
    conversationId: data.conversation_id,
    messageId: String(data.message?.id ?? data.id),
    pingedAt: NOW,
  };
}

/** Did `target` reply in the watchdog's own DM thread after the probe? */
async function probeAnswered(agentClient, ping, target) {
  let msgs;
  try {
    msgs = await agentClient(`/dm/${ping.conversationId}/messages?limit=20`);
  } catch {
    return { answered: false, error: true };
  }
  if (!Array.isArray(msgs)) return { answered: false, error: true };
  const reply = msgs.find((m) => m.agent_name === target && String(m.id) > String(ping.messageId));
  return { answered: Boolean(reply), reply: reply?.text?.slice(0, 60) };
}

// ------------------------------------------------------------ classification

/**
 * Verdict for one resident, as a pure function of observed facts, so the whole
 * ladder can be exercised without a live fleet (see test-watchdog.mjs).
 *
 *   alive          PTY pid responds to signal 0
 *   startedMin     minutes since spawn
 *   unread         stale unread messages addressed to this agent, newest first
 *   lastSeenMs     workspace last_seen for this agent
 *   ping           in-flight probe {pingedAt} or null
 *   answered       the probe was answered (only meaningful with `ping`)
 *   probeAgeMin    minutes since the probe was sent
 *   pingBudget     probes still allowed this sweep
 */
export function classify(o) {
  if (!o.alive) {
    return { verdict: 'DEAD_PTY', page: true, tier: 0, detail: `pid ${o.pid} not running (state file still lists it)` };
  }

  // An outstanding probe outranks everything: it is the definitive test.
  if (o.ping) {
    if (o.answered) {
      return { verdict: 'NEAR_MISS', page: false, tier: 2, detail: `answered the liveness probe after ${fmtMin(o.probeAgeMin)}; the unread inbox was a false alarm` };
    }
    if (o.probeAgeMin != null && o.probeAgeMin >= RESPONSE_MIN) {
      return { verdict: 'UNRESPONSIVE', page: true, tier: 3, detail: `no reply to the liveness probe sent ${fmtMin(o.probeAgeMin)} ago` };
    }
    return { verdict: 'AWAITING_ACK', page: false, tier: 2, detail: `probe sent ${fmtMin(o.probeAgeMin)} ago, ${fmtMin(Math.max(RESPONSE_MIN - (o.probeAgeMin ?? 0), 0))} left to answer` };
  }

  if (!(o.unread || []).length) {
    return { verdict: 'OK', page: false, tier: 1, detail: 'no unread work addressed to this resident' };
  }

  const newest = o.unread[0];
  const gapMin = o.lastSeenMs != null ? (newest.at - o.lastSeenMs) / 60000 : Infinity;

  // Unread work exists, but the agent has been active on relay since it landed
  // — it is reading and acting, the receipt just did not stick.
  if (gapMin < STALE_MIN) {
    return {
      verdict: 'OK_ACTIVE', page: false, tier: 1,
      detail: `${o.unread.length} unread, but last_seen is within ${fmtMin(STALE_MIN)} of the newest (gap ${fmtMin(Math.max(gapMin, 0))})`,
    };
  }

  if (o.startedMin != null && o.startedMin < BOOT_GRACE_MIN) {
    return { verdict: 'BOOTING', page: false, tier: 1, detail: `spawned ${fmtMin(o.startedMin)} ago, within grace` };
  }

  if (o.pingBudget <= 0) {
    return {
      verdict: 'SUSPECT', page: false, tier: 1,
      detail: `${o.unread.length} unread (newest ${fmtMin(minsSince(newest.at))}), last_seen ${fmtMin(minsSince(o.lastSeenMs))} — probe deferred, budget spent`,
    };
  }

  return {
    verdict: 'PROBE', page: false, tier: 1,
    detail: `${o.unread.length} unread (newest ${fmtMin(minsSince(newest.at))} from ${newest.from}), `
      + `last_seen ${fmtMin(minsSince(o.lastSeenMs))} — ${fmtMin(gapMin)} before that message arrived`,
  };
}

// ---------------------------------------------------------- passive evidence

/** Harness-side corroboration. Never trips; explains a trip. */
function passiveEvidence(row) {
  const bits = [];
  if (row.staleMin != null) bits.push(`transcript ${fmtMin(row.staleMin)} old`);
  if (row.turn) bits.push(`last turn ${row.turn}${row.marker ? ` (${row.marker})` : ''}`);
  bits.push(row.cpuDelta != null ? `CPU +${row.cpuDelta.toFixed(0)}s since last sweep` : 'no prior CPU sample');
  if (row.cpuDelta != null && row.cpuDelta >= CPU_ACTIVE_SEC) bits.push('actively burning CPU — may be mid-build rather than hung');
  if (row.resolvedBy === 'newest-fallback') bits.push('transcript inferred, not session-id matched');
  if (row.brokerState) bits.push(`broker says ${row.brokerState}`);
  if (row.pendingMessages) bits.push(`${row.pendingMessages} pending in broker`);
  return bits.join('; ');
}

// ------------------------------------------------------------- broker status

async function brokerStatus(repoCwd) {
  const conn = readJson(path.join(repoCwd, '.agentworkforce/relay/connection.json'));
  if (!conn?.port || !conn?.api_key) return { ok: false, reason: 'no-connection-file' };
  if (conn.pid && !pidAlive(conn.pid)) return { ok: false, reason: 'broker-pid-dead' };
  try {
    const res = await fetch(`http://127.0.0.1:${conn.port}/api/status`, {
      headers: { 'X-API-Key': conn.api_key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: `status-http-${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: `status-unreachable:${e.name}` };
  }
}

// ------------------------------------------------------------------ alerting

const LOG_MAX_BYTES = 2 * 1024 * 1024;

function appendLog(line) {
  if (DRY_RUN) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if ((fs.statSync(LOG_FILE).size ?? 0) > LOG_MAX_BYTES) {
      fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-5000).join('\n'));
    }
  } catch {
    /* first write — fall through */
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    process.stderr.write(`watchdog: cannot write log: ${e.message}\n`);
  }
}

/** Page chief. Prefers the watchdog identity; falls back to a local broker. */
async function pageChief(text, target, agentClient, residents) {
  if (agentClient) {
    try {
      await agentClient('/dm', { method: 'POST', body: JSON.stringify({ to: target, text }) });
      return { ok: true, via: 'watchdog-identity' };
    } catch { /* fall through to a local broker */ }
  }
  for (const repo of [CHIEF_REPO, ...residents.map((r) => r.cwd)]) {
    const conn = readJson(path.join(repo, '.agentworkforce/relay/connection.json'));
    if (!conn?.port || !conn?.api_key) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${conn.port}/api/send`, {
        method: 'POST',
        headers: { 'X-API-Key': conn.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: target, message: text }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return { ok: true, via: `broker:${path.basename(repo)}` };
    } catch { /* try next */ }
  }
  return { ok: false };
}

// ---------------------------------------------------------------------- main

async function main() {
  const residents = discoverResidents();
  const dmTarget = resolveDmTarget(residents);
  const prev = readJson(STATE_FILE) || {};
  const psTable = processTable();

  const identity = readJson(IDENTITY_FILE);
  const agentClient = identity?.token ? makeClient(identity.token) : null;
  const wsKey = loadWorkspaceKey(residents);
  const ws = wsKey ? makeClient(wsKey) : null;

  // Cloud state: workspace roster (last_seen) + every DM conversation.
  const lastSeen = {};
  const cloudAgents = {};
  let conversations = [];
  let cloudError = null;
  if (ws) {
    try {
      for (const a of await ws('/agents')) {
        lastSeen[a.name] = parseTs(a.last_seen);
        cloudAgents[a.name] = a;
      }
      conversations = await ws('/dm/conversations/all?limit=200');
    } catch (e) {
      cloudError = e.message;
    }
  } else {
    cloudError = 'no-workspace-key';
  }

  const rows = [];
  let pingBudget = NO_PING || DRY_RUN ? 0 : MAX_PINGS;
  const nextPings = {};
  const nextAdjudicated = { ...(prev.adjudicated || {}) };
  const convCache = new Map();

  // A Cloud error disables the unread-work detector. It is a monitor outage,
  // not a healthy sweep, and must never collapse into misleading OK rows. One
  // blind sweep is degraded; consecutive failures page the principal.
  const cloudHealth = cloudBlindStatus(cloudError, prev.cloudFailureCount ?? 0);
  if (cloudHealth.row) rows.push(cloudHealth.row);

  for (const res of residents) {
    const relayDir = path.join(res.cwd, '.agentworkforce/relay');
    let stateFile = null;
    try {
      const f = fs.readdirSync(relayDir).find((x) => /^state-.+\.json$/.test(x));
      if (f) stateFile = path.join(relayDir, f);
    } catch { /* no relay dir */ }

    const status = await brokerStatus(res.cwd);
    const agents = stateFile ? readJson(stateFile)?.agents ?? {} : {};
    const expected = expectedAgents(res.cwd);

    if (!status.ok) {
      rows.push({
        repo: res.slug, agent: Object.keys(agents)[0] ?? '(none)', key: `${res.slug}/broker`,
        verdict: 'BROKER_DOWN', page: true, tier: 0,
        detail: `broker unreachable (${status.reason}); ${Object.keys(agents).length} agent(s) in state file`,
      });
      continue;
    }
    if (Object.keys(agents).length === 0 && expected.length === 0) {
      rows.push({ repo: res.slug, agent: '(none)', key: `${res.slug}/none`, verdict: 'NO_AGENTS', page: false, tier: 1, detail: 'broker up, no agents in state file' });
      continue;
    }

    for (const declared of expected) {
      if (!agents[declared.name]) {
        rows.push({
          repo: res.slug, agent: declared.name, key: `${res.slug}/${declared.name}`,
          verdict: 'MISSING_RESIDENT', page: true, tier: 0,
          detail: `declared in teams.json but absent from ${stateFile ? path.basename(stateFile) : 'broker state'}`,
        });
        continue;
      }

      const aliases = Object.keys(agents).filter((name) =>
        name.startsWith(`${declared.name}-successor`)
        || name.startsWith(`${declared.name}-replacement`));
      const canonicalSeen = lastSeen[declared.name] ?? null;
      const freshAlias = aliases.find((name) => {
        const aliasSeen = lastSeen[name] ?? null;
        return aliasSeen != null
          && (canonicalSeen == null || aliasSeen - canonicalSeen >= STALE_MIN * 60000);
      });
      if (freshAlias && cloudAgents[declared.name]?.status !== 'online') {
        rows.push({
          repo: res.slug, agent: declared.name, key: `${res.slug}/${declared.name}/identity`,
          verdict: 'IDENTITY_SPLIT', page: true, tier: 0,
          detail: `${freshAlias} is fresher while the canonical roster identity is ${cloudAgents[declared.name]?.status ?? 'unknown'}; the successor is not restart-durable`,
        });
      }
    }

    const monitoredNames = new Set(expected.map((agent) => agent.name));
    for (const name of Object.keys(agents)) {
      if (expected.some((agent) =>
        name.startsWith(`${agent.name}-successor`)
        || name.startsWith(`${agent.name}-replacement`))) {
        monitoredNames.add(name);
      }
    }
    const deliveryFailures = brokerDeliveryFailures(
      RELAY_LOG_DIR,
      res.slug,
      [...monitoredNames],
      NOW - BROKER_FAILURE_MIN * 60000,
    );
    for (const [name, a] of Object.entries(agents)) {
      const cli = a?.spec?.cli || 'unknown';
      const pid = a?.pid;
      const key = `${res.slug}/${name}`;
      const startedMs = a?.started_at ? a.started_at * 1000 : null;
      const row = { repo: res.slug, agent: name, cli, pid, key };
      const alive = pidAlive(pid);

      // Passive corroboration — gathered always, trips never.
      const cpu = alive ? subtreeCpu(pid, psTable) : null;
      const prevCpu = prev.cpu?.[key];
      row.cpu = cpu;
      row.cpuDelta = cpu != null && prevCpu?.cpu != null && prevCpu.pid === pid ? cpu - prevCpu.cpu : null;

      const resolved = alive
        ? (/codex/.test(cli) ? resolveCodexTranscript(res.cwd, a?.spec?.session_id) : resolveClaudeTranscript(res.cwd, a?.spec?.session_id))
        : null;
      row.transcript = resolved?.file ?? null;
      row.resolvedBy = resolved?.how ?? null;
      row.staleMin = row.transcript ? minsSince(mtime(row.transcript)) : null;
      if (row.transcript) {
        const { state, marker } = turnState(row.transcript, cli);
        row.turn = state;
        row.marker = marker;
      }
      const brokerAgent = (status.data?.agents || []).find((x) => x?.name === name || x?.worker_name === name);
      row.brokerState = brokerAgent?.current_state ?? null;
      row.pendingMessages = brokerAgent?.pending_messages ?? null;

      // Delivery failures are actionable only when the resident has not made
      // progress since. This clears transient broker timeouts once transcript
      // activity proves the worker recovered.
      const recoveredAtMs = Math.max(startedMs ?? 0, row.transcript ? (mtime(row.transcript) ?? 0) : 0);
      const deliveryIssue = classifyDeliveryFailures(deliveryFailures[name], recoveredAtMs);
      if (deliveryIssue) {
        rows.push({
          repo: res.slug,
          agent: name,
          key: `${key}/${deliveryIssue.verdict === 'PTY_UNREACHABLE' ? 'pty' : 'delivery'}`,
          verdict: deliveryIssue.verdict,
          page: true,
          tier: 0,
          detail: `${deliveryIssue.detail} in the last ${BROKER_FAILURE_MIN}m`,
        });
      }

      // Tier 1 — unread work addressed to this resident.
      row.lastSeenMs = lastSeen[name] ?? null;
      row.lastSeenMin = minsSince(row.lastSeenMs);
      let unread = [];
      if (ws && !cloudError && alive) {
        try {
          unread = (await unreadFor(ws, conversations, name, {
            sessionStartMs: startedMs,
            sinceId: prev.adjudicated?.[key],
            cache: convCache,
          })).unread;
        } catch { /* degrade to passive-only */ }
      }
      row.unread = unread;

      // Tier 2 — an outstanding probe decides the verdict.
      const ping = prev.pings?.[key] || null;
      let answered = false;
      if (ping && agentClient) {
        const r = await probeAnswered(agentClient, ping, name);
        answered = r.answered;
        row.reply = r.reply;
      }

      Object.assign(row, classify({
        alive, pid,
        startedMin: startedMs ? minsSince(startedMs) : null,
        unread,
        lastSeenMs: row.lastSeenMs,
        ping,
        answered,
        probeAgeMin: ping ? minsSince(ping.pingedAt) : null,
        pingBudget,
      }));
      row.evidence = passiveEvidence(row);

      if (row.verdict === 'PROBE') {
        if (agentClient) {
          try {
            nextPings[key] = await sendProbe(agentClient, name);
            pingBudget -= 1;
            appendLog(JSON.stringify({
              ts: new Date(NOW).toISOString(), event: 'probe', repo: res.slug, agent: name,
              unread_ids: unread.map((u) => u.id),
              unread_newest_min: Math.round(minsSince(unread[0].at)),
              last_seen_min: row.lastSeenMin == null ? null : Math.round(row.lastSeenMin),
              evidence: row.evidence,
            }));
          } catch (e) {
            row.verdict = 'PROBE_FAILED';
            row.detail = `could not send liveness probe (${e.message})`;
          }
        } else {
          row.verdict = 'SUSPECT';
          row.detail += ' — no watchdog identity registered, cannot probe';
        }
      } else if (ping && row.verdict === 'AWAITING_ACK') {
        nextPings[key] = ping;                       // still in flight
      } else if (ping) {
        // Resolved either way: stop reconsidering the messages that caused it.
        if (unread[0]?.id) nextAdjudicated[key] = unread[0].id;
        if (row.verdict === 'NEAR_MISS') {
          appendLog(JSON.stringify({
            ts: new Date(NOW).toISOString(), event: 'near-miss', repo: res.slug, agent: name,
            probe_age_min: Math.round(row.probeAgeMin ?? 0), reply: row.reply ?? null,
          }));
        }
      }

      rows.push(row);
    }
  }

  // Pages, honouring re-alert backoff.
  const prevAlerts = prev.alerts || {};
  const nextAlerts = {};
  const firing = [];
  for (const row of rows) {
    if (!row.page) continue;
    const before = prevAlerts[row.key];
    const changed = !before || before.verdict !== row.verdict;
    const aged = before && NOW - (before.lastAlerted || 0) > REALERT_MIN * 60000;
    if (changed || aged) {
      firing.push(row);
      nextAlerts[row.key] = { verdict: row.verdict, firstSeen: changed ? NOW : before.firstSeen, lastAlerted: NOW };
    } else {
      nextAlerts[row.key] = before;
    }
  }

  const stamp = new Date(NOW).toISOString();
  const summary = rows.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] || 0) + 1), acc), {});
  appendLog(JSON.stringify({
    ts: stamp, event: 'sweep', residents: residents.length, agents: rows.length,
    summary, cloud: cloudError ? `error:${cloudError}` : 'ok',
  }));

  for (const row of firing) {
    appendLog(JSON.stringify({
      ts: stamp, event: 'trip', tier: row.tier, verdict: row.verdict, repo: row.repo, agent: row.agent,
      detail: row.detail, evidence: row.evidence ?? null,
      unread_ids: (row.unread || []).map((u) => u.id),
      last_seen_min: row.lastSeenMin == null ? null : Math.round(row.lastSeenMin),
    }));
  }

  let dm = null;
  if (firing.length && !DRY_RUN) {
    const text = [
      `[watchdog] ${firing.length} resident${firing.length > 1 ? 's' : ''} need attention`,
      ...firing.map((r) => {
        const lines = [`• ${r.repo}/${r.agent} — ${r.verdict}: ${r.detail}`];
        if (r.evidence) lines.push(`    evidence: ${r.evidence}`);
        if ((r.unread || []).length) {
          lines.push(`    unread: ${r.unread.map((u) => `${u.id} from ${u.from} ${fmtMin(minsSince(u.at))} ago`).join('; ')}`);
        }
        if (r.lastSeenMin != null) lines.push(`    last_seen: ${fmtMin(r.lastSeenMin)} ago`);
        lines.push('    recommend kickstart');
        return lines.join('\n');
      }),
      '',
      `Alert-only — nothing was restarted. Log: ${LOG_FILE}`,
    ].join('\n');
    dm = await pageChief(text, dmTarget, agentClient, residents);
    appendLog(JSON.stringify({ ts: stamp, event: 'page', ok: dm.ok, via: dm.via ?? null, count: firing.length }));
  }

  // Persist for the next sweep. Dry-run is observational: it must not consume
  // a page, advance a probe, or make the doctor believe a scheduled sweep ran.
  const cpu = {};
  for (const row of rows) if (row.key && row.cpu != null) cpu[row.key] = { pid: row.pid, cpu: row.cpu };
  if (!DRY_RUN) {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        ts: NOW,
        cpu,
        pings: nextPings,
        adjudicated: nextAdjudicated,
        alerts: nextAlerts,
        cloudFailureCount: cloudHealth.failureCount,
      }, null, 2), { mode: 0o600 });
    } catch (e) {
      process.stderr.write(`watchdog: cannot write state: ${e.message}\n`);
    }
  }

  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ ts: stamp, cloud: cloudError ?? 'ok', rows, summary }, null, 2) + '\n');
  } else if (!QUIET) {
    const w = (s, n) => String(s ?? '—').padEnd(n).slice(0, n);
    process.stdout.write(`fleet-watchdog ${stamp}  stale>${STALE_MIN}m  probe-window ${RESPONSE_MIN}m  `
      + `${residents.length} residents / ${rows.length} agents  cloud=${cloudError ?? 'ok'}\n`);
    process.stdout.write(`${w('REPO', 17)} ${w('AGENT', 20)} ${w('T', 2)} ${w('VERDICT', 14)} ${w('UNRD', 5)} ${w('LASTSEEN', 9)} DETAIL\n`);
    for (const r of rows) {
      process.stdout.write(`${r.page ? '!' : ' '}${w(r.repo, 16)} ${w(r.agent, 20)} ${w(r.tier, 2)} ${w(r.verdict, 14)} `
        + `${w((r.unread || []).length || '·', 5)} ${w(fmtMin(r.lastSeenMin), 9)} ${r.detail}\n`);
    }
    process.stdout.write(`\n${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
    if (firing.length) process.stdout.write(`${DRY_RUN ? 'WOULD PAGE' : 'PAGED'}: ${firing.map((f) => f.key).join(', ')}${dm ? ` (dm ${dm.ok ? `sent via ${dm.via}` : 'FAILED'})` : ''}\n`);
  }
}

// Only sweep when executed directly; importing this file is side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    appendLog(JSON.stringify({ ts: new Date().toISOString(), event: 'error', error: e.message }));
    process.stderr.write(`watchdog failed: ${e.stack}\n`);
    process.exit(1);
  });
}
