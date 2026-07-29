#!/usr/bin/env node
// Controls for the watchdog's tier ladder and transcript parsing.
// Run: node tools/watchdog/test-watchdog.mjs
//
// A healthy fleet only ever demonstrates the OK path, so the escalation cases
// are exercised here against synthetic observations and synthetic transcripts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classify, turnState, parseCpuTime, codexMarker, claudeMarker } from './fleet-watchdog.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
const write = (name, records) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
};
const minsAgo = (m) => Date.now() - m * 60000;

// ------------------------------------------------------------- transcripts

const codexHeader = { type: 'session_meta', payload: { id: 'x', cwd: '/tmp/x', originator: 'agent-relay' } };
const codexUser = { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } };
const codexReason = { type: 'response_item', payload: { type: 'reasoning' } };
const codexDone = { type: 'event_msg', payload: { type: 'task_complete' } };

const claudeUser = { type: 'user', message: { role: 'user', content: 'do the thing' } };
const claudeTool = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } };
const claudeDone = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } };
const claudeSys = { type: 'system', subtype: 'post_turn' };

test('codex: completed turn reads as closed', () => {
  assert.equal(turnState(write('c-done.jsonl', [codexHeader, codexUser, codexReason, codexDone]), 'codex').state, 'closed');
});

test('codex: message received with no completion reads as open', () => {
  const r = turnState(write('c-open.jsonl', [codexHeader, codexUser]), 'codex');
  assert.equal(r.state, 'open');
  assert.equal(r.marker, 'user_message');
});

test('codex: work started after the last completion reads as open', () => {
  assert.equal(turnState(write('c-re.jsonl', [codexHeader, codexUser, codexDone, codexUser, codexReason]), 'codex').state, 'open');
});

test('claude: end_turn reads as closed even with trailing system records', () => {
  assert.equal(turnState(write('l-done.jsonl', [claudeUser, claudeDone, claudeSys, claudeSys]), 'claude').state, 'closed');
});

test('claude: dangling tool_use reads as open', () => {
  const r = turnState(write('l-tool.jsonl', [claudeUser, claudeTool]), 'claude');
  assert.equal(r.state, 'open');
  assert.equal(r.marker, 'tool_use');
});

test('claude: unanswered user message reads as open', () => {
  assert.equal(turnState(write('l-open.jsonl', [claudeUser, claudeDone, claudeUser]), 'claude').state, 'open');
});

test('an unreadable transcript is not treated as a turn boundary', () => {
  assert.equal(turnState(write('l-noise.jsonl', [claudeSys, { type: 'attachment' }]), 'claude').state, 'unknown');
});

test('harness markers do not cross-fire', () => {
  assert.equal(codexMarker(claudeDone), null);
  assert.equal(claudeMarker(codexDone), null);
});

// ------------------------------------------------------------ tier 1: quiet

const base = {
  alive: true, pid: 123, startedMin: 600, unread: [], lastSeenMs: minsAgo(2),
  ping: null, answered: false, probeAgeMin: null, pingBudget: 3,
};
const stale = (min, from = 'chief') => [{ id: '900', from, at: minsAgo(min) }];

test('an idle resident with an empty inbox is healthy, however long it has been quiet', () => {
  for (const lastSeen of [5, 120, 600]) {
    const r = classify({ ...base, lastSeenMs: minsAgo(lastSeen) });
    assert.equal(r.verdict, 'OK');
    assert.equal(r.page, false);
  }
});

test('unread work with recent relay activity is not suspicious', () => {
  // Message landed 60m ago, agent was seen 59m ago => it is transacting.
  const r = classify({ ...base, unread: stale(60), lastSeenMs: minsAgo(59) });
  assert.equal(r.verdict, 'OK_ACTIVE');
  assert.equal(r.page, false);
});

test('a freshly spawned resident is given boot grace', () => {
  const r = classify({ ...base, unread: stale(60), lastSeenMs: minsAgo(300), startedMin: 3 });
  assert.equal(r.verdict, 'BOOTING');
  assert.equal(r.page, false);
});

test('TRIPS TO PROBE: unread work and relay activity that predates it', () => {
  const r = classify({ ...base, unread: stale(60), lastSeenMs: minsAgo(300) });
  assert.equal(r.verdict, 'PROBE');
  assert.equal(r.page, false);            // tier 1 never pages on its own
  assert.equal(r.tier, 1);
});

test('probe budget defers rather than dropping a suspicion', () => {
  const r = classify({ ...base, unread: stale(60), lastSeenMs: minsAgo(300), pingBudget: 0 });
  assert.equal(r.verdict, 'SUSPECT');
  assert.equal(r.page, false);
});

// ------------------------------------------------------------ tier 2 and 3

test('an answered probe clears the suspicion as a near miss', () => {
  const r = classify({ ...base, unread: stale(60), lastSeenMs: minsAgo(300), ping: { pingedAt: minsAgo(4) }, answered: true, probeAgeMin: 4 });
  assert.equal(r.verdict, 'NEAR_MISS');
  assert.equal(r.page, false);
});

test('an unanswered probe inside the window waits, it does not page', () => {
  const r = classify({ ...base, unread: stale(60), lastSeenMs: minsAgo(300), ping: { pingedAt: minsAgo(4) }, answered: false, probeAgeMin: 4 });
  assert.equal(r.verdict, 'AWAITING_ACK');
  assert.equal(r.page, false);
});

test('PAGES: no ACK once the response window has elapsed', () => {
  const r = classify({ ...base, unread: stale(60), lastSeenMs: minsAgo(300), ping: { pingedAt: minsAgo(11) }, answered: false, probeAgeMin: 11 });
  assert.equal(r.verdict, 'UNRESPONSIVE');
  assert.equal(r.page, true);
  assert.equal(r.tier, 3);
});

test('PAGES: state file lists an agent whose PTY is gone', () => {
  const r = classify({ ...base, alive: false });
  assert.equal(r.verdict, 'DEAD_PTY');
  assert.equal(r.page, true);
});

test('a probe answered late still clears rather than paging', () => {
  const r = classify({ ...base, ping: { pingedAt: minsAgo(30) }, answered: true, probeAgeMin: 30 });
  assert.equal(r.verdict, 'NEAR_MISS');
  assert.equal(r.page, false);
});

test('an outstanding probe outranks a newly quiet inbox', () => {
  // No unread this sweep, but a probe is still in flight: keep waiting on it.
  const r = classify({ ...base, unread: [], ping: { pingedAt: minsAgo(2) }, answered: false, probeAgeMin: 2 });
  assert.equal(r.verdict, 'AWAITING_ACK');
});

test('a resident with no last_seen at all is still probed, not ignored', () => {
  const r = classify({ ...base, unread: stale(60), lastSeenMs: null });
  assert.equal(r.verdict, 'PROBE');
});

// ------------------------------------------------------------------ misc

test('ps TIME strings parse to seconds', () => {
  assert.equal(parseCpuTime('0:05.20'), 5.2);
  assert.equal(parseCpuTime('12:34'), 754);
  assert.equal(parseCpuTime('1:02:03'), 3723);
  assert.equal(parseCpuTime('2-03:04:05'), 2 * 86400 + 11045);
  assert.equal(parseCpuTime(''), 0);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
