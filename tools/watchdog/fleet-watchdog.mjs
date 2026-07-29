#!/usr/bin/env node
// Fleet liveness watchdog — alert-only pager for resident agents that go
// alive-but-unresponsive (PTY up, broker healthy, messages never processed).
//
// Signals and trip conditions are documented in README.md next to this file.
// Run with --json for machine-readable output, --quiet to suppress the table.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
// Overridable so the pipeline can be exercised against fixtures (see README).
const LAUNCH_AGENTS = process.env.WATCHDOG_LAUNCH_AGENTS || path.join(HOME, 'Library/LaunchAgents');
const LOG_FILE = process.env.WATCHDOG_LOG_FILE || path.join(HOME, 'Library/Logs/fleet-watchdog.log');
const STATE_FILE = process.env.WATCHDOG_STATE_FILE || path.join(HOME, 'Library/Application Support/fleet-watchdog/state.json');
const CLAUDE_PROJECTS = process.env.WATCHDOG_CLAUDE_PROJECTS || path.join(HOME, '.claude/projects');
const CODEX_SESSIONS = process.env.WATCHDOG_CODEX_SESSIONS || path.join(HOME, '.codex/sessions');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

// Minutes an open turn may sit without transcript growth before it is a page.
const STALE_MIN = num('WATCHDOG_STALE_MINUTES', 15);
// Grace after spawn: a booting agent has an open turn and little output yet.
const BOOT_GRACE_MIN = num('WATCHDOG_BOOT_GRACE_MINUTES', 10);
// CPU seconds the process tree must burn between runs to count as "working".
const CPU_ACTIVE_SEC = num('WATCHDOG_CPU_ACTIVE_SECONDS', 5);
// Re-page interval for a condition that is still true.
const REALERT_MIN = num('WATCHDOG_REALERT_MINUTES', 60);
// How far back to scan codex rollouts when resolving a session by cwd.
const CODEX_LOOKBACK_DAYS = num('WATCHDOG_CODEX_LOOKBACK_DAYS', 3);
// Slack between a delivery ack and the transcript write it should produce.
// A consuming harness records the inbound message within a second or two.
const ACK_TOLERANCE_SEC = num('WATCHDOG_ACK_TOLERANCE_SECONDS', 120);

const CHIEF_REPO = process.env.WATCHDOG_CHIEF_REPO || path.join(HOME, 'Projects/AgentWorkforce/chief');
const DM_TARGET = process.env.WATCHDOG_DM_TARGET || 'chief';
const DRY_RUN = process.argv.includes('--dry-run');
const AS_JSON = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet');
const TEST_DM = process.argv.includes('--test-dm');

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

const pidAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Read the trailing `bytes` of a file and return whole parsed JSONL records. */
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
    const full = path.join(LAUNCH_AGENTS, f);
    let plist;
    try {
      plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', full], { encoding: 'utf8' }));
    } catch {
      continue;
    }
    const cwd = plist.WorkingDirectory;
    if (!cwd) continue;
    out.push({ slug: m[1], label: plist.Label || `com.agentworkforce.${m[1]}.node`, cwd });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
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
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid)) continue;
    table.set(pid, { ppid, cpu: parseCpuTime(parts[2]) });
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
  const parts = rest.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (Number.isFinite(p) ? p : 0);
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
 * abandoned session or a human's own session in the same repo) so callers
 * report which path was used.
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
    let want = 256 * 1024; // codex headers embed base_instructions
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

let codexIndex = null;
/** Index recent codex rollouts by their session_meta cwd (survives compaction forks). */
function codexRollouts() {
  if (codexIndex) return codexIndex;
  codexIndex = [];
  const days = [];
  for (let i = 0; i < CODEX_LOOKBACK_DAYS; i++) {
    const d = new Date(NOW - i * 86400000);
    days.push(path.join(CODEX_SESSIONS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  for (const dir of days) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const head = readFirstRecord(p);
      const payload = head?.payload;
      if (!payload?.cwd) continue;
      codexIndex.push({
        p,
        cwd: payload.cwd,
        id: payload.id || payload.session_id,
        originator: payload.originator,
        t: mtime(p) ?? 0,
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
  const mine = all
    .filter((r) => r.cwd === cwd && r.originator === 'agent-relay')
    .sort((a, b) => b.t - a.t);
  if (mine.length) return { file: mine[0].p, how: 'cwd+originator' };
  if (sessionId) {
    const byId = all.find((r) => r.id === sessionId);
    if (byId) return { file: byId.p, how: 'session_id' };
  }
  return null;
}

// -------------------------------------------------------- turn-state parsing

/**
 * Decide whether the session's final turn completed.
 * Returns 'closed' (agent finished, legitimately idle), 'open' (a turn is
 * in flight), or 'unknown'.
 */
export function turnState(file, cli) {
  const recs = tailRecords(file);
  if (!recs.length) return { state: 'unknown', marker: null };
  const codex = /codex/.test(cli);
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    const verdict = codex ? codexMarker(r) : claudeMarker(r);
    if (verdict) return { state: verdict.state, marker: verdict.marker };
  }
  return { state: 'unknown', marker: null };
}

export function codexMarker(r) {
  const t = r?.payload?.type;
  if (!t) return null;
  // Turn boundaries emitted by the codex harness.
  if (t === 'task_complete' || t === 'turn_aborted' || t === 'shutdown_complete') {
    return { state: 'closed', marker: t };
  }
  if (t === 'user_message' || t === 'task_started') return { state: 'open', marker: t };
  if (t === 'message' && r?.payload?.role === 'user') return { state: 'open', marker: 'user_message' };
  return null;
}

export function claudeMarker(r) {
  const type = r?.type;
  if (type === 'assistant') {
    const stop = r?.message?.stop_reason;
    if (stop === 'end_turn' || stop === 'stop_sequence') return { state: 'closed', marker: `end_turn` };
    if (stop === 'tool_use') return { state: 'open', marker: 'tool_use' };
    return null; // stop_reason null => streaming/partial, keep looking
  }
  if (type === 'user') return { state: 'open', marker: 'user' };
  return null; // system / attachment / summary / permission-mode are not boundaries
}

// ------------------------------------------------------------- broker status

async function brokerStatus(repoCwd) {
  const conn = readJson(path.join(repoCwd, '.agentworkforce/relay/connection.json'));
  if (!conn?.port || !conn?.api_key) return { ok: false, reason: 'no-connection-file' };
  if (conn.pid && !pidAlive(conn.pid)) return { ok: false, reason: 'broker-pid-dead', conn };
  try {
    const res = await fetch(`http://127.0.0.1:${conn.port}/api/status`, {
      headers: { 'X-API-Key': conn.api_key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: `status-http-${res.status}`, conn };
    return { ok: true, data: await res.json(), conn };
  } catch (e) {
    return { ok: false, reason: `status-unreachable:${e.name}`, conn };
  }
}

/**
 * Latest `delivery_read_ack:<agent>:<event_id>` timestamp per agent, from the
 * broker's persisted dedup cache. This is the "work arrived" clock: the broker
 * saw the injected text echo back on the PTY (or gave up waiting after 5s).
 * It says the message reached the terminal, NOT that the model consumed it.
 */
function lastAckByAgent(relayDir) {
  const out = {};
  let file;
  try {
    const f = fs.readdirSync(relayDir).find((x) => /^dedup-.+\.json$/.test(x));
    if (f) file = path.join(relayDir, f);
  } catch {
    return out;
  }
  const entries = file ? readJson(file) : null;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const key = e?.key;
    if (typeof key !== 'string' || !key.startsWith('delivery_read_ack:')) continue;
    const agent = key.split(':')[1];
    const t = Number(e.inserted_at_ms);
    if (!agent || !Number.isFinite(t)) continue;
    if (!out[agent] || t > out[agent]) out[agent] = t;
  }
  return out;
}

/** Oldest in-flight delivery age (minutes) for a given worker. */
function oldestPendingMin(status, agentName) {
  const list = status?.pending_deliveries;
  if (!Array.isArray(list)) return null;
  let oldest = null;
  for (const d of list) {
    if (d?.worker_name !== agentName) continue;
    const age = Number(d.age_ms);
    if (!Number.isFinite(age)) continue;
    const m = age / 60000;
    if (oldest == null || m > oldest) oldest = m;
  }
  return oldest;
}

// ------------------------------------------------------------ classification

/**
 * The entire trip decision, as a pure function of observed facts, so it can be
 * exercised without a live fleet (see test-watchdog.mjs).
 *
 * Inputs (all nullable unless noted):
 *   alive              boolean — PTY pid responds to signal 0
 *   pid                number  — for the DEAD_PTY message
 *   isCodex            boolean
 *   startedMin         minutes since the agent was spawned
 *   queuedMin          age of the oldest delivery the broker has not had acked
 *   hasTranscript      boolean
 *   staleMin           minutes since the transcript last grew
 *   turn               'open' | 'closed' | 'unknown'
 *   marker             the record type that decided `turn`
 *   ackMin             minutes since the last delivery ack for this agent
 *   ackMinusTranscript ms by which the last ack post-dates the transcript
 *   cpuDelta           CPU seconds burned by the process tree since last run
 *   inferred           boolean — transcript was guessed, not session-id matched
 */
export function classify(o) {
  const note = o.inferred ? ' [transcript inferred, not session-id matched]' : '';

  if (!o.alive) {
    return { verdict: 'DEAD_PTY', page: true, detail: `pid ${o.pid} not running (state file still lists it)` };
  }

  // Work the broker could not even get acked into the terminal.
  if (o.queuedMin != null && o.queuedMin > STALE_MIN) {
    return {
      verdict: 'QUEUED_STUCK',
      page: true,
      detail: `delivery unacked for ${fmtMin(o.queuedMin)} (broker never confirmed injection)`,
    };
  }

  if (!o.hasTranscript) {
    return {
      verdict: 'NO_TRANSCRIPT',
      page: false,
      detail: `no ${o.isCodex ? 'codex rollout' : 'claude transcript'} resolved for this cwd`,
    };
  }

  // Acked into the terminal, but the session never wrote a record afterwards:
  // the harness never consumed it. PTY idle-sleeping, broker reporting green.
  const unconsumed = o.ackMinusTranscript != null && o.ackMinusTranscript > ACK_TOLERANCE_SEC * 1000;
  if (unconsumed && o.ackMin != null && o.ackMin > STALE_MIN) {
    return {
      verdict: 'HUNG_UNCONSUMED',
      page: true,
      detail: `message delivered ${fmtMin(o.ackMin)} ago but session has written nothing since `
        + `(transcript ${fmtMin(o.staleMin)} old, ${Math.round(o.ackMinusTranscript / 60000)}m older than the delivery)${note}`,
    };
  }

  if (o.turn === 'closed') {
    return { verdict: 'IDLE_OK', page: false, detail: `turn complete (${o.marker}), quiet ${fmtMin(o.staleMin)}` };
  }
  if (o.startedMin != null && o.startedMin < BOOT_GRACE_MIN) {
    return { verdict: 'BOOTING', page: false, detail: `spawned ${fmtMin(o.startedMin)} ago, within grace` };
  }
  if (o.staleMin != null && o.staleMin < STALE_MIN) {
    return { verdict: 'ACTIVE', page: false, detail: `turn in flight (${o.marker}), last output ${fmtMin(o.staleMin)} ago` };
  }
  // A long build or tool call produces no transcript records but does burn CPU.
  if (o.cpuDelta != null && o.cpuDelta >= CPU_ACTIVE_SEC) {
    return {
      verdict: 'WORKING_LONG',
      page: false,
      detail: `open turn stale ${fmtMin(o.staleMin)} but burned ${o.cpuDelta.toFixed(0)}s CPU since last check`,
    };
  }
  if (o.turn === 'unknown') {
    return {
      verdict: 'UNREADABLE',
      page: false,
      detail: `no turn boundary found in transcript tail, quiet ${fmtMin(o.staleMin)}`,
    };
  }
  return {
    verdict: 'HUNG',
    page: true,
    detail: `open turn (${o.marker}) with no output for ${fmtMin(o.staleMin)}`
      + (o.cpuDelta != null ? `, CPU +${o.cpuDelta.toFixed(0)}s` : ', no prior CPU sample')
      + (o.queuedMin != null ? `, oldest queued delivery ${fmtMin(o.queuedMin)}` : '')
      + note,
  };
}

// -------------------------------------------------------------- evaluation

async function evaluateResident(res, psTable, prevState) {
  const relayDir = path.join(res.cwd, '.agentworkforce/relay');
  const rows = [];

  let stateFile = null;
  try {
    const f = fs.readdirSync(relayDir).find((x) => /^state-.+\.json$/.test(x));
    if (f) stateFile = path.join(relayDir, f);
  } catch {
    /* no relay dir */
  }

  const status = await brokerStatus(res.cwd);
  const agents = stateFile ? readJson(stateFile)?.agents ?? {} : {};
  const acks = lastAckByAgent(relayDir);

  // A resident whose broker is gone cannot be reached at all, and none of the
  // per-agent signals can be trusted. That is the headline for the whole repo.
  if (!status.ok) {
    rows.push({
      repo: res.slug,
      agent: Object.keys(agents)[0] ?? '(none)',
      cli: '—',
      key: `${res.slug}/broker`,
      verdict: 'BROKER_DOWN',
      detail: `broker unreachable (${status.reason}); ${Object.keys(agents).length} agent(s) in state file`,
      page: true,
    });
    return rows;
  }

  if (!stateFile || Object.keys(agents).length === 0) {
    rows.push({
      repo: res.slug, agent: '(none)', cli: '—', key: `${res.slug}/none`,
      verdict: 'NO_AGENTS', detail: 'broker up, no agents in state file', page: false,
    });
    return rows;
  }

  for (const [name, a] of Object.entries(agents)) {
    const cli = a?.spec?.cli || 'unknown';
    const pid = a?.pid;
    const sessionId = a?.spec?.session_id;
    const startedMin = a?.started_at ? minsSince(a.started_at * 1000) : null;
    const key = `${res.slug}/${name}`;

    const isCodex = /codex/.test(cli);
    const row = { repo: res.slug, agent: name, cli, pid, key };
    const alive = pidAlive(pid);

    // CPU burned since the previous run — separates a real hang from a long
    // build/tool call that legitimately produces no transcript output.
    const cpu = alive ? subtreeCpu(pid, psTable) : null;
    const prev = prevState.cpu?.[key];
    row.cpu = cpu;
    row.cpuDelta = cpu != null && prev?.cpu != null && prev.pid === pid ? cpu - prev.cpu : null;

    const resolved = alive
      ? (isCodex ? resolveCodexTranscript(res.cwd, sessionId) : resolveClaudeTranscript(res.cwd, sessionId))
      : null;
    row.transcript = resolved?.file ?? null;
    row.resolvedBy = resolved?.how ?? null;

    row.queuedMin = status.ok ? oldestPendingMin(status.data, name) : null;
    const brokerAgent = status.ok
      ? (status.data?.agents || []).find((x) => x?.name === name || x?.worker_name === name)
      : null;
    row.brokerState = brokerAgent?.current_state ?? null;
    row.pendingMessages = brokerAgent?.pending_messages ?? null;

    const tmtime = row.transcript ? mtime(row.transcript) : null;
    row.staleMin = minsSince(tmtime);
    if (row.transcript) {
      const { state, marker } = turnState(row.transcript, cli);
      row.turn = state;
      row.marker = marker;
    }

    // "Work arrived" clock. The broker's dedup cache expires entries after 5
    // minutes, so carry forward the newest ack we have ever seen for this pid.
    const prevAck = prevState.acks?.[key];
    let ackMs = acks[name] ?? null;
    if (prevAck?.pid === pid && prevAck.ackMs && (!ackMs || prevAck.ackMs > ackMs)) ackMs = prevAck.ackMs;
    row.ackMs = ackMs;
    row.ackMin = minsSince(ackMs);

    Object.assign(row, classify({
      alive,
      pid,
      isCodex,
      startedMin,
      queuedMin: row.queuedMin,
      hasTranscript: Boolean(row.transcript),
      staleMin: row.staleMin,
      turn: row.turn,
      marker: row.marker,
      ackMin: row.ackMin,
      ackMinusTranscript: ackMs != null && tmtime != null ? ackMs - tmtime : null,
      cpuDelta: row.cpuDelta,
      inferred: row.resolvedBy === 'newest-fallback',
    }));

    rows.push(row);
  }

  return rows;
}

// ------------------------------------------------------------------ alerting

const LOG_MAX_BYTES = 2 * 1024 * 1024;

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // Bounded log: a sweep line every 10 minutes accumulates indefinitely.
    if ((fs.statSync(LOG_FILE).size ?? 0) > LOG_MAX_BYTES) {
      const keep = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-5000).join('\n');
      fs.writeFileSync(LOG_FILE, keep);
    }
  } catch {
    /* first write, or unreadable — fall through to append */
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    process.stderr.write(`watchdog: cannot write log: ${e.message}\n`);
  }
}

/** DM via a local broker HTTP API. Prefers chief's broker, falls back to any live one. */
async function sendDm(text, residents) {
  const candidates = [CHIEF_REPO, ...residents.map((r) => r.cwd).filter((c) => c !== CHIEF_REPO)];
  for (const repo of candidates) {
    const conn = readJson(path.join(repo, '.agentworkforce/relay/connection.json'));
    if (!conn?.port || !conn?.api_key) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${conn.port}/api/send`, {
        method: 'POST',
        headers: { 'X-API-Key': conn.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: DM_TARGET, message: text }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return { ok: true, via: path.basename(repo) };
      // Do not surface the body: it echoes request context.
      if (res.status === 401) continue;
    } catch {
      continue;
    }
  }
  return { ok: false };
}

// ---------------------------------------------------------------------- main

async function main() {
  const residents = discoverResidents();
  const prevState = readJson(STATE_FILE) || {};
  const psTable = processTable();

  const rows = [];
  for (const r of residents) {
    rows.push(...(await evaluateResident(r, psTable, prevState)));
  }

  // Decide which pages actually fire, honouring re-alert backoff.
  const prevAlerts = prevState.alerts || {};
  const nextAlerts = {};
  const firing = [];
  for (const row of rows) {
    if (!row.page) continue;
    const key = row.key || `${row.repo}/${row.agent}`;
    const prev = prevAlerts[key];
    const changed = !prev || prev.verdict !== row.verdict;
    const aged = prev && NOW - (prev.lastAlerted || 0) > REALERT_MIN * 60000;
    if (changed || aged) {
      firing.push(row);
      nextAlerts[key] = { verdict: row.verdict, firstSeen: changed ? NOW : prev.firstSeen, lastAlerted: NOW };
    } else {
      nextAlerts[key] = prev;
    }
  }

  const stamp = new Date(NOW).toISOString();
  const summary = rows.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});

  appendLog(JSON.stringify({
    ts: stamp,
    event: 'sweep',
    residents: residents.length,
    agents: rows.length,
    summary,
  }));

  for (const row of firing) {
    appendLog(JSON.stringify({
      ts: stamp,
      event: 'trip',
      verdict: row.verdict,
      repo: row.repo,
      agent: row.agent,
      cli: row.cli,
      pid: row.pid,
      stale_min: row.staleMin == null ? null : Math.round(row.staleMin),
      last_msg_min: row.ackMin == null ? null : Math.round(row.ackMin),
      queued_min: row.queuedMin == null ? null : Math.round(row.queuedMin),
      turn: row.turn ?? null,
      marker: row.marker ?? null,
      cpu_delta_sec: row.cpuDelta == null ? null : Math.round(row.cpuDelta),
      detail: row.detail,
    }));
  }

  let dmResult = null;
  if (firing.length && !DRY_RUN) {
    const lines = firing.map((r) => `- *${r.repo}/${r.agent}* (${r.cli}) — ${r.verdict}: ${r.detail}`);
    const text = [
      `[watchdog] ${firing.length} resident${firing.length > 1 ? 's' : ''} unresponsive`,
      ...lines,
      '',
      `Alert-only; no kickstart was attempted. Log: ${LOG_FILE}`,
    ].join('\n');
    dmResult = await sendDm(text, residents);
    appendLog(JSON.stringify({ ts: stamp, event: 'dm', ok: dmResult.ok, via: dmResult.via ?? null, count: firing.length }));
  }

  if (TEST_DM) {
    const r = await sendDm(`[watchdog-test] fleet liveness watchdog online — ${residents.length} residents, ${rows.length} agents evaluated, ${rows.filter((x) => x.page).length} tripping. This is a one-off test message.`, residents);
    appendLog(JSON.stringify({ ts: stamp, event: 'test-dm', ok: r.ok, via: r.via ?? null }));
    process.stderr.write(`test DM: ${r.ok ? `sent via ${r.via} broker` : 'FAILED'}\n`);
  }

  // Persist CPU samples, delivery-ack clocks, and alert bookkeeping.
  const cpu = {};
  const acks = {};
  for (const row of rows) {
    if (!row.key) continue;
    if (row.cpu != null) cpu[row.key] = { pid: row.pid, cpu: row.cpu };
    if (row.ackMs != null) acks[row.key] = { pid: row.pid, ackMs: row.ackMs };
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ts: NOW, cpu, acks, alerts: nextAlerts }, null, 2));
  } catch (e) {
    process.stderr.write(`watchdog: cannot write state: ${e.message}\n`);
  }

  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ ts: stamp, rows, firing: firing.map((f) => f.key), summary }, null, 2) + '\n');
  } else if (!QUIET) {
    const w = (s, n) => String(s ?? '—').padEnd(n).slice(0, n);
    process.stdout.write(`fleet-watchdog ${stamp}  stale>${STALE_MIN}m  ${residents.length} residents / ${rows.length} agents\n`);
    process.stdout.write(`${w('REPO', 18)} ${w('AGENT', 20)} ${w('CLI', 8)} ${w('VERDICT', 16)} ${w('QUIET', 7)} ${w('LASTMSG', 8)} DETAIL\n`);
    for (const r of rows) {
      const flag = r.page ? '!' : ' ';
      process.stdout.write(`${flag}${w(r.repo, 17)} ${w(r.agent, 20)} ${w((r.cli || '').split(' ')[0], 8)} ${w(r.verdict, 16)} ${w(fmtMin(r.staleMin), 7)} ${w(fmtMin(r.ackMin), 8)} ${r.detail}\n`);
    }
    process.stdout.write(`\n${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join('  ')}\n`);
    if (firing.length) process.stdout.write(`PAGED: ${firing.map((f) => f.key).join(', ')}${dmResult ? ` (dm ${dmResult.ok ? 'sent' : 'FAILED'})` : ''}\n`);
  }
}

// Only sweep when executed directly; importing this file (tests, tooling) is side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    appendLog(JSON.stringify({ ts: new Date().toISOString(), event: 'error', error: e.message }));
    process.stderr.write(`watchdog failed: ${e.stack}\n`);
    process.exit(1);
  });
}
