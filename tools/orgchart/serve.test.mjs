import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  buildRuntimeOrg,
  executionLayersFromFleet,
  mergeRuntimeAgents,
  normalizeWorkspaceAgents,
  readLocalBrokerStatus,
  readWorkspaceRuntime,
  readOrgOverlays,
  validateExternalOverlay,
} from './serve.mjs';

const khaliqTeam = {
  principal: { slug: 'khaliq', name: 'Khaliq Gant', timezone: 'Europe/Oslo' },
  agents: [
    { name: 'chief-khaliq', role: 'chief of staff', cli: 'claude', task: 'stay online' },
  ],
};

async function temporaryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'chief-org-overlay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function externalManifest(name, slug, repo) {
  return {
    schemaVersion: 1,
    principal: { name, slug },
    agents: [{ name: `chief-${slug}`, title: 'Chief of Staff', reportsTo: name, repo, status: 'resident' }],
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('local broker status uses the authenticated loopback API', async () => {
  const requests = [];
  const result = await readLocalBrokerStatus({
    connectionProvider: async () => ({ port: 49495, api_key: 'test-broker-key' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          agents: [{ name: 'chief-khaliq', current_state: 'idle', runtime_kind: 'pty' }],
          node_connected: true,
        }),
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:49495/api/status');
  assert.equal(requests[0].options.headers['X-API-Key'], 'test-broker-key');
  assert.equal(result.agents[0].name, 'chief-khaliq');
});

test('local broker status fails closed on a malformed roster', async () => {
  await assert.rejects(
    readLocalBrokerStatus({
      connectionProvider: async () => ({ port: 49495, api_key: 'test-broker-key' }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ agents: null }),
      }),
    }),
    /invalid agent roster/,
  );
});

test('workspace runtime reads agents and nodes without exposing its key', async () => {
  const requests = [];
  const result = await readWorkspaceRuntime({
    keyProvider: async () => 'test-workspace-key',
    apiBase: 'https://relay.example/v1',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: url.endsWith('/agents')
            ? [{ name: 'chief-khaliq', last_seen: '2026-08-07T08:00:00.000Z' }]
            : [{ id: 'node_1', name: 'chief', live: true }],
        }),
      };
    },
  });

  assert.deepEqual(requests.map((request) => request.url), [
    'https://relay.example/v1/agents',
    'https://relay.example/v1/nodes',
  ]);
  assert.ok(requests.every((request) =>
    request.options.headers.Authorization === 'Bearer test-workspace-key'));
  assert.equal(result.agents[0].name, 'chief-khaliq');
  assert.equal(result.nodes[0].name, 'chief');
});

test('workspace presence stays visible but only local broker agents are attachable', () => {
  const now = Date.parse('2026-08-07T08:00:00.000Z');
  const workspace = normalizeWorkspaceAgents([
    {
      name: 'chief-khaliq',
      status: 'active',
      last_seen: '2026-08-07T07:59:30.000Z',
      metadata: { fleet: { nodeId: 'node_chief' } },
    },
    {
      name: 'daily-ship',
      status: 'active',
      last_seen: '2026-08-07T07:59:00.000Z',
      metadata: { source: 'cloud-persona-deploy' },
    },
    {
      name: 'stale-worker',
      status: 'offline',
      last_seen: '2026-08-07T06:00:00.000Z',
    },
  ], now);
  const merged = mergeRuntimeAgents(workspace, [
    { name: 'chief-khaliq', current_state: 'idle', runtime_kind: 'pty' },
  ]);

  assert.deepEqual(merged.map((agent) => ({
    name: agent.name,
    attachable: agent.attachable,
    runtime: agent.runtime_kind,
    nodeId: agent.node_id ?? null,
  })), [
    { name: 'chief-khaliq', attachable: true, runtime: 'pty', nodeId: 'node_chief' },
    { name: 'daily-ship', attachable: false, runtime: 'cloud', nodeId: null },
  ]);
});

test('teams.json always owns the principal and a mismatched org overlay is ignored', () => {
  const org = buildRuntimeOrg(
    khaliqTeam,
    {
      principal: { name: 'Will' },
      agents: [{ name: 'cpo', title: 'CPO', reportsTo: 'Will', repo: '/Users/will/cpo' }],
    },
    [
      {
        name: 'khaliq-chief',
        cli: 'claude',
        current_state: 'working',
        runtime_kind: 'pty',
        last_activity_ms: 100,
        attachable: true,
      },
      {
        name: 'sage-worker',
        cli: 'codex',
        current_state: 'idle',
        runtime_kind: 'pty',
        last_activity_ms: 500,
        attachable: true,
      },
    ],
  );

  assert.equal(org.principal.name, 'Khaliq Gant');
  assert.equal(org.agents.some((agent) => agent.name === 'cpo'), false);
  assert.deepEqual(
    org.agents.map((agent) => ({
      name: agent.name,
      status: agent.status,
      attachable: agent.attachable,
      reportsTo: agent.reportsTo,
    })),
    [
      { name: 'chief-khaliq', status: 'pending-spawn', attachable: false, reportsTo: 'Khaliq Gant' },
      { name: 'khaliq-chief', status: 'resident', attachable: true, reportsTo: 'Khaliq Gant' },
      { name: 'sage-worker', status: 'resident', attachable: true, reportsTo: 'khaliq-chief' },
    ],
  );
});

test('a same-principal org overlay augments the active roster and normalizes its root', () => {
  const org = buildRuntimeOrg(
    {
      principal: { slug: 'will', name: 'Will Washburn', timezone: 'America/New_York' },
      agents: [{ name: 'chief-will', role: 'chief of staff', cli: 'claude', task: 'stay online' }],
    },
    {
      principal: { name: 'Will' },
      agents: [{ name: 'cpo', title: 'CPO', reportsTo: 'Will', repo: '/tmp/cpo', status: 'resident' }],
    },
    [],
  );

  assert.equal(org.agents.find((agent) => agent.name === 'cpo').reportsTo, 'Will Washburn');
  assert.equal(org.agents.find((agent) => agent.name === 'chief-will').status, 'pending-spawn');
});

test('Cloud and fleet machines are execution layers, not agents in the org', () => {
  const layers = executionLayersFromFleet({
    nodes: [{
      id: 'node_1',
      name: 'sf-mini',
      status: 'online',
      live: true,
      capabilities: [{ name: 'spawn:codex' }, { name: 'workflow:run' }],
      tags: ['repo:AgentWorkforce/sage'],
      activeAgents: 2,
      maxAgents: 4,
      handlersLive: true,
      version: 'relay-broker/11.3.1',
    }],
  });

  assert.equal(layers[0].kind, 'cloud');
  assert.equal(layers[0].live, true);
  assert.deepEqual(layers[1], {
    id: 'node_1',
    name: 'sf-mini',
    title: 'Fleet execution node',
    kind: 'fleet-node',
    status: 'online',
    live: true,
    capabilities: ['spawn:codex', 'workflow:run'],
    tags: ['repo:AgentWorkforce/sage'],
    activeAgents: 2,
    maxAgents: 4,
    handlersLive: true,
    version: 'relay-broker/11.3.1',
    lastHeartbeatAt: null,
  });
});

test('execution layers normalize API fields and hide dead or direct nodes', () => {
  const layers = executionLayersFromFleet({
    nodes: [
      {
        id: 'node_live',
        name: 'finn-mini',
        status: 'online',
        live: true,
        handlers_live: true,
        capabilities: [{ name: 'spawn:codex' }],
        active_agents: 3,
        max_agents: 0,
        last_heartbeat_at: '2026-08-07T08:00:00.000Z',
      },
      { id: 'node_dead', name: 'old-node', status: 'offline', live: false },
      { id: 'node_direct', name: 'direct-chief', status: 'online', live: true, tags: ['direct'] },
    ],
  });

  assert.equal(layers.length, 2);
  assert.deepEqual(layers[1], {
    id: 'node_live',
    name: 'finn-mini',
    title: 'Fleet execution node',
    kind: 'fleet-node',
    status: 'online',
    live: true,
    capabilities: ['spawn:codex'],
    tags: [],
    activeAgents: 3,
    maxAgents: 0,
    handlersLive: true,
    version: '',
    lastHeartbeatAt: '2026-08-07T08:00:00.000Z',
  });
});

test('external overlay validation enforces the generic v1 schema', () => {
  assert.equal(validateExternalOverlay({
    schemaVersion: 1,
    principal: { name: 'Example', slug: 'example' },
    agents: [{ name: 'chief-example', repo: '/tmp/example' }],
  }).valid, true);
  assert.match(validateExternalOverlay({
    schemaVersion: 1,
    principal: { name: 'Example', slug: 'example', accountId: 'private' },
    agents: [],
  }).error, /unknown principal field/);
  assert.match(validateExternalOverlay({
    schemaVersion: 1,
    principal: { name: 'Example', slug: 'example' },
    agents: [{ name: 'duplicate' }, { name: 'duplicate' }],
  }).error, /duplicate agent name/);
});

test('external discovery is explicit and merges sources in canonical path order', async (t) => {
  const root = await temporaryFixture(t);
  const builtInPath = join(root, 'org.json');
  const alphaDir = join(root, 'alpha');
  const zetaDir = join(root, 'zeta');
  await Promise.all([mkdir(alphaDir), mkdir(zetaDir)]);
  await writeJson(builtInPath, { overlays: [{ principal: { name: 'Built In' }, agents: [] }] });
  await Promise.all([
    writeJson(join(alphaDir, 'org-overlay.json'), externalManifest('Alpha', 'alpha', alphaDir)),
    writeJson(join(zetaDir, 'org-overlay.json'), externalManifest('Zeta', 'zeta', zetaDir)),
  ]);

  const result = await readOrgOverlays({
    builtInPath,
    configuredDirs: [zetaDir, alphaDir].join(delimiter),
    warn: () => {},
  });
  assert.deepEqual(result.overlays.map((overlay) => overlay.principal.name), ['Built In', 'Alpha', 'Zeta']);
  assert.deepEqual(result.warnings, []);
});

test('missing and malformed external sources warn and skip without breaking built-ins', async (t) => {
  const root = await temporaryFixture(t);
  const builtInPath = join(root, 'org.json');
  const malformedDir = join(root, 'malformed');
  const missingDir = join(root, 'missing-file');
  await Promise.all([mkdir(malformedDir), mkdir(missingDir)]);
  await writeJson(builtInPath, { overlays: [{ principal: { name: 'Built In' }, agents: [] }] });
  await writeFile(join(malformedDir, 'org-overlay.json'), '{broken');

  const result = await readOrgOverlays({
    builtInPath,
    configuredDirs: [missingDir, malformedDir].join(delimiter),
    warn: () => {},
  });
  assert.deepEqual(result.overlays.map((overlay) => overlay.principal.name), ['Built In']);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => warning.startsWith('Skipping')));
});

test('duplicate external names or slugs fail closed and built-ins stay authoritative', async (t) => {
  const root = await temporaryFixture(t);
  const builtInPath = join(root, 'org.json');
  const sources = ['built-in-conflict', 'slug-a', 'slug-b', 'name-a', 'name-b'];
  await Promise.all(sources.map((source) => mkdir(join(root, source))));
  await writeJson(builtInPath, {
    overlays: [{ principal: { name: 'Core', slug: 'core' }, agents: [] }],
  });
  const manifests = [
    externalManifest('Different Name', 'core', join(root, sources[0])),
    externalManifest('First Slug Owner', 'shared', join(root, sources[1])),
    externalManifest('Second Slug Owner', 'shared', join(root, sources[2])),
    externalManifest('Repeated Name', 'name-a', join(root, sources[3])),
    externalManifest('Repeated Name', 'name-b', join(root, sources[4])),
  ];
  await Promise.all(sources.map((source, index) => (
    writeJson(join(root, source, 'org-overlay.json'), manifests[index])
  )));

  const result = await readOrgOverlays({
    builtInPath,
    configuredDirs: sources.map((source) => join(root, source)).join(delimiter),
    warn: () => {},
  });
  assert.deepEqual(result.overlays.map((overlay) => overlay.principal.slug), ['core']);
  assert.ok(result.warnings.some((warning) => warning.includes('duplicates a built-in principal')));
  assert.ok(result.warnings.filter((warning) => warning.includes('duplicate external principal')).length >= 4);
});

test('built-in single-overlay backcompat and no-source behavior are preserved', async (t) => {
  const root = await temporaryFixture(t);
  const builtInPath = join(root, 'org.json');
  const bareOverlay = { principal: { name: 'Legacy' }, agents: [] };
  await writeJson(builtInPath, bareOverlay);

  const result = await readOrgOverlays({ builtInPath, configuredDirs: '', warn: () => {} });
  assert.deepEqual(result.overlays, [bareOverlay]);
  assert.deepEqual(result.warnings, []);
});

test('relative and parent-traversal source entries are rejected before loading', async (t) => {
  const root = await temporaryFixture(t);
  const builtInPath = join(root, 'org.json');
  await writeJson(builtInPath, { overlays: [] });

  const result = await readOrgOverlays({
    builtInPath,
    configuredDirs: ['relative', `${root}/allowed/../outside`].join(delimiter),
    warn: () => {},
  });
  assert.deepEqual(result.overlays, []);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => warning.includes('invalid CHIEF_ORG_OVERLAY_DIRS entry')));
});

test('an overlay symlink cannot escape its allowlisted directory', async (t) => {
  const root = await temporaryFixture(t);
  const builtInPath = join(root, 'org.json');
  const allowedDir = join(root, 'allowed');
  const outsideDir = join(root, 'outside');
  await Promise.all([mkdir(allowedDir), mkdir(outsideDir)]);
  await writeJson(builtInPath, { overlays: [{ principal: { name: 'Built In' }, agents: [] }] });
  const outsideManifest = join(outsideDir, 'org-overlay.json');
  await writeJson(outsideManifest, externalManifest('Outside', 'outside', outsideDir));
  await symlink(outsideManifest, join(allowedDir, 'org-overlay.json'));

  const result = await readOrgOverlays({ builtInPath, configuredDirs: allowedDir, warn: () => {} });
  assert.deepEqual(result.overlays.map((overlay) => overlay.principal.name), ['Built In']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /symlink outside allowlisted directory/);
});
