import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WATCHDOG_MAX_SWEEP_AGE_MS,
  watchdogHealth,
} from './watchdog-health.mjs';

const NOW = Date.parse('2026-08-07T08:00:00.000Z');

test('an installed watchdog with a recent sweep is healthy', () => {
  assert.deepEqual(watchdogHealth({
    installed: true,
    lastSweepMs: NOW - 9 * 60_000,
    now: NOW,
  }), {
    installed: true,
    fresh: true,
    healthy: true,
    lastSweepAt: '2026-08-07T07:51:00.000Z',
    ageMinutes: 9,
    maxAgeMinutes: 25,
  });
});

test('a historical log does not make a stopped watchdog healthy', () => {
  const health = watchdogHealth({
    installed: true,
    lastSweepMs: NOW - WATCHDOG_MAX_SWEEP_AGE_MS - 1,
    now: NOW,
  });
  assert.equal(health.installed, true);
  assert.equal(health.fresh, false);
  assert.equal(health.healthy, false);
});

test('a fresh log does not make an uninstalled watchdog healthy', () => {
  const health = watchdogHealth({ installed: false, lastSweepMs: NOW, now: NOW });
  assert.equal(health.fresh, true);
  assert.equal(health.healthy, false);
});

test('a missing sweep is unhealthy without fabricating an age', () => {
  const health = watchdogHealth({ installed: true, lastSweepMs: null, now: NOW });
  assert.equal(health.lastSweepAt, null);
  assert.equal(health.ageMinutes, null);
  assert.equal(health.healthy, false);
});
