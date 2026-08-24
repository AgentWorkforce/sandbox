import { appendFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent37Runtime } from '../src/agent37/runtime.ts';

const root = dirname(fileURLToPath(import.meta.url));
const reportPath = `${root}/idle-report.json`;
const ledgerPath = `${root}/idle-ledger.jsonl`;
const runId = `a37-idle-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
const startedNs = process.hrtime.bigint();
const idleTimeoutSeconds = 60;
const providerKey = process.env.AGENT37_API_KEY ?? '';
const secrets = new Set(providerKey.length >= 8 ? [providerKey] : []);
const metrics = {
  create_ms: 'UNKNOWN', provider_ready_ms: 'UNKNOWN', provider_auto_sleep_ms: 'UNKNOWN',
  provider_wake_ready_ms: 'UNKNOWN', controller_stop_ms: 'UNKNOWN',
  controller_resume_ready_ms: 'UNKNOWN', destroy_ms: 'UNKNOWN', verified_gone_ms: 'UNKNOWN',
};
const state = { runtime: undefined, instance: undefined };

writeFileSync(ledgerPath, '');
const ms = (a, b = process.hrtime.bigint()) => Number((b - a) / 1_000_000n);
const sleep = (value) => new Promise((resolve) => setTimeout(resolve, value));

function safeText(value) {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text;
}

function ledger(event, data = {}) {
  const text = JSON.stringify({ at: new Date().toISOString(), runId, event, ...data });
  for (const secret of secrets) if (text.includes(secret)) throw new Error('idle ledger contains credential');
  appendFileSync(ledgerPath, `${text}\n`);
}

function ensureCost() {
  const projected = (ms(startedNs) / 3_600_000) * 0.0073;
  if (projected > 0.05) throw new Error(`idle probe cost gate exceeded: projected $${projected.toFixed(4)}`);
}

async function retry(label, fn, attempts = 6, intervalMs = 2000) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await fn(); } catch (error) { last = error; }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${safeText(last instanceof Error ? last.message : last)}`);
}

async function providerInstance(id) {
  const response = await fetch(`https://api.agent37.com/v1/instances/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${providerKey}` }, signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET instance returned HTTP ${response.status}`);
  return response.json();
}

async function poll(label, fn, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    ensureCost();
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timeout${last ? `: ${safeText(last.message)}` : ''}`);
}

async function destroy(reason) {
  if (!state.runtime || !state.instance) return;
  const id = state.instance.id;
  const destroyStart = process.hrtime.bigint();
  await retry('owned idle-probe destroy', () => state.runtime.destroy(state.instance));
  metrics.destroy_ms = ms(destroyStart);
  const goneStart = process.hrtime.bigint();
  await poll('owned idle-probe verified gone', async () => (await providerInstance(id)) === null, 60000, 1000);
  metrics.verified_gone_ms = ms(goneStart);
  ledger('destroyed', { resource: 'agent37-instance', id, reason, verifiedGone: true });
  state.instance = undefined;
}

async function main() {
  if (providerKey.length < 8) throw new Error('AGENT37_API_KEY is absent or too short');
  state.runtime = new Agent37Runtime({
    apiKey: providerKey,
    baseUrl: 'https://api.agent37.com',
    defaultHomeDir: '/root',
    user: 'agent37-idle-proof',
    autoSleep: true,
    idleTimeoutSeconds,
    fetch: (url, init = {}) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000) }),
  });
  const createStart = process.hrtime.bigint();
  state.instance = await state.runtime.launch({
    name: `idle-${runId}`,
    labels: { purpose: 'agent37-idle-proof', run: runId },
    workdir: '/',
  });
  const createEnd = process.hrtime.bigint();
  metrics.create_ms = ms(createStart, createEnd);
  ledger('created', { resource: 'agent37-instance', id: state.instance.id });

  const configured = await providerInstance(state.instance.id);
  if (configured?.auto_sleep !== true || configured?.idle_timeout_seconds !== idleTimeoutSeconds) {
    throw new Error(`provider did not persist requested idle config: auto_sleep=${String(configured?.auto_sleep)} idle_timeout_seconds=${String(configured?.idle_timeout_seconds)}`);
  }
  ledger('verified', { resource: 'provider-idle-config', autoSleep: true, idleTimeoutSeconds });

  const readyStart = process.hrtime.bigint();
  const ready = await state.runtime.runScript(state.instance, { command: 'node --version', timeoutMs: 280000, requestTimeoutMs: 295000 });
  if (ready.exitCode !== 0) throw new Error(`provider readiness exec failed: ${ready.exitCode}`);
  const idleStart = process.hrtime.bigint();
  metrics.provider_ready_ms = ms(readyStart, idleStart);
  ledger('verified', { resource: 'provider-ready', execExitCode: 0 });

  await poll('provider auto-sleep', async () => (await providerInstance(state.instance.id))?.status === 'sleeping', (idleTimeoutSeconds + 180) * 1000, 2000);
  const sleepingAt = process.hrtime.bigint();
  metrics.provider_auto_sleep_ms = ms(idleStart, sleepingAt);
  ledger('verified', { resource: 'provider-auto-sleep', status: 'sleeping', durationMs: metrics.provider_auto_sleep_ms });

  state.instance = await state.runtime.start(state.instance);
  await poll('provider wake running', async () => (await providerInstance(state.instance.id))?.status === 'running', 120000, 1000);
  const postWake = await state.runtime.runScript(state.instance, { command: 'node --version', timeoutMs: 280000, requestTimeoutMs: 295000 });
  if (postWake.exitCode !== 0) throw new Error(`post-wake exec failed: ${postWake.exitCode}`);
  const wakeReadyAt = process.hrtime.bigint();
  metrics.provider_wake_ready_ms = ms(sleepingAt, wakeReadyAt);
  ledger('verified', { resource: 'provider-wake', status: 'running', execExitCode: 0, durationMs: metrics.provider_wake_ready_ms });

  const stopStart = process.hrtime.bigint();
  await state.runtime.stop(state.instance);
  await poll('controller stop', async () => (await providerInstance(state.instance.id))?.status === 'stopped', 60000, 1000);
  const stoppedAt = process.hrtime.bigint();
  metrics.controller_stop_ms = ms(stopStart, stoppedAt);
  state.instance = await state.runtime.start(state.instance);
  await poll('controller resume', async () => (await providerInstance(state.instance.id))?.status === 'running', 120000, 1000);
  const postResume = await state.runtime.runScript(state.instance, { command: 'node --version', timeoutMs: 280000, requestTimeoutMs: 295000 });
  if (postResume.exitCode !== 0) throw new Error(`post-resume exec failed: ${postResume.exitCode}`);
  metrics.controller_resume_ready_ms = ms(stoppedAt);
  ledger('verified', {
    resource: 'controller-stop-resume', stopMs: metrics.controller_stop_ms,
    resumeReadyMs: metrics.controller_resume_ready_ms, postResumeExec: true,
  });

  await destroy('success');
  const report = {
    ok: true, runId, metrics,
    idle: { configuredAutoSleep: true, configuredIdleTimeoutSeconds: idleTimeoutSeconds, observedSleeping: true },
    measurement: {
      provider_auto_sleep_ms: 'successful readiness exec return to first GET status=sleeping',
      provider_wake_ready_ms: 'first observed sleeping to status=running plus successful node --version exec',
      controller_stop_ms: 'stop request start to first GET status=stopped',
      controller_resume_ready_ms: 'first observed stopped to status=running plus successful node --version exec',
      destroy_ms: 'idempotent DELETE wall time',
      verified_gone_ms: 'DELETE return to first GET 404',
    },
    cost: { upperBoundUsd: Number(((ms(startedNs) / 3_600_000) * 0.0073).toFixed(6)), capUsd: 0.05 },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath, ledgerPath, runId, metrics })}\n`);
  process.exit(0);
}

try {
  await main();
} catch (error) {
  const cleanupFailures = [];
  try { await destroy('failure-unconditional'); } catch (cleanupError) { cleanupFailures.push(safeText(cleanupError.message)); }
  const report = {
    ok: false, runId, error: safeText(error instanceof Error ? error.message : error),
    cleanupFailures, metrics,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(report)}\n`);
  process.exit(1);
}
