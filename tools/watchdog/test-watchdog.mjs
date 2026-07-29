#!/usr/bin/env node
// Positive and negative controls for the watchdog's trip logic.
// Run: node tools/watchdog/test-watchdog.mjs
//
// A live fleet only ever demonstrates the healthy path, so the hang cases are
// exercised here against synthetic transcripts and synthetic observations.

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

// ------------------------------------------------------------- transcripts

const codexUser = { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } };
const codexReason = { type: 'response_item', payload: { type: 'reasoning' } };
const codexDone = { type: 'event_msg', payload: { type: 'task_complete' } };
const codexHeader = { type: 'session_meta', payload: { id: 'x', cwd: '/tmp/x', originator: 'agent-relay' } };

const claudeUser = { type: 'user', message: { role: 'user', content: 'do the thing' } };
const claudeTool = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use' } };
const claudeDone = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } };
const claudeSys = { type: 'system', subtype: 'post_turn' };

test('codex: completed turn reads as closed', () => {
  const f = write('codex-done.jsonl', [codexHeader, codexUser, codexReason, codexDone]);
  assert.equal(turnState(f, 'codex').state, 'closed');
});

test('codex: message received with no completion reads as open', () => {
  const f = write('codex-open.jsonl', [codexHeader, codexUser]);
  const r = turnState(f, 'codex');
  assert.equal(r.state, 'open');
  assert.equal(r.marker, 'user_message');
});

test('codex: work started after the last completion reads as open', () => {
  const f = write('codex-reopen.jsonl', [codexHeader, codexUser, codexDone, codexUser, codexReason]);
  assert.equal(turnState(f, 'codex').state, 'open');
});

test('claude: end_turn reads as closed even with trailing system records', () => {
  const f = write('claude-done.jsonl', [claudeUser, claudeDone, claudeSys, claudeSys]);
  assert.equal(turnState(f, 'claude').state, 'closed');
});

test('claude: dangling tool_use reads as open', () => {
  const f = write('claude-tool.jsonl', [claudeUser, claudeTool]);
  const r = turnState(f, 'claude');
  assert.equal(r.state, 'open');
  assert.equal(r.marker, 'tool_use');
});

test('claude: unanswered user message reads as open', () => {
  const f = write('claude-open.jsonl', [claudeUser, claudeDone, claudeUser]);
  assert.equal(turnState(f, 'claude').state, 'open');
});

test('an unreadable transcript is not treated as a turn boundary', () => {
  const f = write('claude-noise.jsonl', [claudeSys, { type: 'attachment' }]);
  assert.equal(turnState(f, 'claude').state, 'unknown');
});

test('harness markers do not cross-fire', () => {
  assert.equal(codexMarker(claudeDone), null);
  assert.equal(claudeMarker(codexDone), null);
});

// -------------------------------------------------------- classify: healthy

const base = {
  alive: true, pid: 123, isCodex: false, startedMin: 600, queuedMin: null,
  hasTranscript: true, staleMin: 2, turn: 'closed', marker: 'end_turn',
  ackMin: null, ackMinusTranscript: null, cpuDelta: null, inferred: false,
};

test('idle agent that finished its turn never pages, however long it has been quiet', () => {
  for (const staleMin of [5, 60, 200, 1440]) {
    const r = classify({ ...base, staleMin });
    assert.equal(r.verdict, 'IDLE_OK');
    assert.equal(r.page, false);
  }
});

test('agent mid-turn and producing output does not page', () => {
  const r = classify({ ...base, turn: 'open', marker: 'tool_use', staleMin: 3 });
  assert.equal(r.verdict, 'ACTIVE');
  assert.equal(r.page, false);
});

test('freshly spawned agent is given boot grace', () => {
  const r = classify({ ...base, turn: 'open', marker: 'user', staleMin: 20, startedMin: 4 });
  assert.equal(r.verdict, 'BOOTING');
  assert.equal(r.page, false);
});

test('long tool call that burns CPU is working, not hung', () => {
  const r = classify({ ...base, turn: 'open', marker: 'tool_use', staleMin: 40, cpuDelta: 120 });
  assert.equal(r.verdict, 'WORKING_LONG');
  assert.equal(r.page, false);
});

test('delivery consumed by the harness does not page', () => {
  // Transcript written 5s after the ack => negative delta => consumed.
  const r = classify({ ...base, ackMin: 300, ackMinusTranscript: -5000 });
  assert.equal(r.verdict, 'IDLE_OK');
  assert.equal(r.page, false);
});

test('a just-arrived unconsumed message waits for the threshold before paging', () => {
  const r = classify({ ...base, ackMin: 6, ackMinusTranscript: 6 * 60000 });
  assert.equal(r.page, false);
});

// --------------------------------------------------- classify: the failures

test('PAGES: message acked into the terminal but the session never wrote anything', () => {
  // The observed incident: PTY alive and idle-sleeping, broker green, closed
  // turn in the transcript, but the delivery post-dates all session output.
  const r = classify({ ...base, turn: 'closed', staleMin: 75, ackMin: 60, ackMinusTranscript: 15 * 60000 });
  assert.equal(r.verdict, 'HUNG_UNCONSUMED');
  assert.equal(r.page, true);
  assert.match(r.detail, /written nothing since/);
});

test('PAGES: turn opened and then froze with no output', () => {
  const r = classify({ ...base, turn: 'open', marker: 'user_message', staleMin: 55, cpuDelta: 0 });
  assert.equal(r.verdict, 'HUNG');
  assert.equal(r.page, true);
});

test('PAGES: broker holds a delivery it could never get acked', () => {
  const r = classify({ ...base, queuedMin: 22 });
  assert.equal(r.verdict, 'QUEUED_STUCK');
  assert.equal(r.page, true);
});

test('PAGES: state file lists an agent whose PTY is gone', () => {
  const r = classify({ ...base, alive: false });
  assert.equal(r.verdict, 'DEAD_PTY');
  assert.equal(r.page, true);
});

test('a hang detected on a guessed transcript says so in the page', () => {
  const r = classify({ ...base, turn: 'open', marker: 'user', staleMin: 55, inferred: true });
  assert.equal(r.page, true);
  assert.match(r.detail, /transcript inferred/);
});

test('unresolvable transcript degrades to a non-paging observation', () => {
  const r = classify({ ...base, hasTranscript: false });
  assert.equal(r.verdict, 'NO_TRANSCRIPT');
  assert.equal(r.page, false);
});

test('unreadable transcript does not page on its own', () => {
  const r = classify({ ...base, turn: 'unknown', marker: null, staleMin: 90 });
  assert.equal(r.verdict, 'UNREADABLE');
  assert.equal(r.page, false);
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
