import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeOrg,
  executionLayersFromFleet,
  parseFirstJson,
} from './serve.mjs';

const khaliqTeam = {
  principal: { slug: 'khaliq', name: 'Khaliq Gant', timezone: 'Europe/Oslo' },
  agents: [
    { name: 'chief-khaliq', role: 'chief of staff', cli: 'claude', task: 'stay online' },
  ],
};

test('parseFirstJson ignores an Agent Relay update notice after JSON', () => {
  const parsed = parseFirstJson('{"nodes":[{"name":"sf-mini"}]}\nUpdate available: 11.3.1');
  assert.deepEqual(parsed, { nodes: [{ name: 'sf-mini' }] });
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
      },
      {
        name: 'sage-worker',
        cli: 'codex',
        current_state: 'idle',
        runtime_kind: 'pty',
        last_activity_ms: 500,
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
