import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Daytona } from '@daytonaio/sdk';

import * as pkg from '../index.js';
import {
  DaytonaRuntime,
  SnapshotNotFoundError,
} from '../index.js';
import type { RuntimeHandle } from '../index.js';

// Sandbox images differ, so the runtime requires this explicitly.
const TEST_HOME_DIR = '/home/sandbox';

describe('public barrel', () => {
  it('exports DaytonaRuntime as a class', () => {
    assert.equal(typeof pkg.DaytonaRuntime, 'function');
    assert.equal(typeof DaytonaRuntime, 'function');
    assert.equal(typeof pkg.SnapshotNotFoundError, 'function');
    assert.equal(typeof SnapshotNotFoundError, 'function');
  });

});

describe('DaytonaRuntime shared primitives', () => {
  it('launches with snapshot, labels and create timeout without language', async () => {
    const created: Array<{ params: Record<string, unknown>; options?: unknown }> = [];
    const sandbox = fakeSandbox({ id: 'sbx-created', state: 'STARTED' });
    const daytona = {
      create: async (params: Record<string, unknown>, options?: unknown) => {
        created.push({ params, options });
        return sandbox;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR,
      daytona: daytona as never,
      snapshot: 'test-snapshot',
    });

    const handle = await runtime.launch({
      name: 'issue-greeter',
      labels: { purpose: 'test-purpose', agentId: 'agent-1' },
      env: { SANDBOX_AGENT_ID: 'agent-1' },
      createTimeoutSeconds: 120,
    });

    assert.equal(handle.id, 'sbx-created');
    assert.deepEqual(created, [
      {
        params: {
          snapshot: 'test-snapshot',
          envVars: { SANDBOX_AGENT_ID: 'agent-1' },
          name: 'issue-greeter',
          labels: { purpose: 'test-purpose', agentId: 'agent-1' },
        },
        options: { timeout: 120 },
      },
    ]);
    assert.equal('language' in created[0].params, false);
  });

  it('launchDetached creates through the raw sandbox API and returns before SDK waitUntilStarted', async () => {
    const createCalls: Array<{ params: Record<string, unknown>; options?: unknown }> = [];
    const daytona = {
      target: 'us',
      sandboxApi: {
        createSandbox: async (
          params: Record<string, unknown>,
          _organizationId?: string,
          options?: unknown,
        ) => {
          createCalls.push({ params, options });
          return { data: { id: 'sbx-starting', state: 'STARTING' } };
        },
      },
      get: async (id: string) => fakeSandbox({ id, state: 'STARTING' }),
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR,
      daytona: daytona as never,
      snapshot: 'test-snapshot',
    });

    const handle = await runtime.launchDetached({
      name: 'issue-greeter',
      labels: { purpose: 'test-purpose', agentId: 'agent-1' },
      env: { SANDBOX_AGENT_ID: 'agent-1' },
      createTimeoutSeconds: 5,
    });

    assert.deepEqual(handle, { id: 'sbx-starting', state: 'STARTING' });
    assert.deepEqual(createCalls, [
      {
        params: {
          snapshot: 'test-snapshot',
          env: { SANDBOX_AGENT_ID: 'agent-1' },
          name: 'issue-greeter',
          labels: {
            purpose: 'test-purpose',
            agentId: 'agent-1',
            'code-toolbox-language': 'python',
          },
          target: 'us',
        },
        options: { timeout: 5000 },
      },
    ]);
  });

  it('launchDetached throws on snapshot-not-found instead of falling back to a typescript base sandbox', async () => {
    const createCalls: Array<{ params: Record<string, unknown>; options?: unknown }> = [];
    const daytona = {
      target: 'us',
      sandboxApi: {
        createSandbox: async (
          params: Record<string, unknown>,
          _organizationId?: string,
          options?: unknown,
        ) => {
          createCalls.push({ params, options });
          throw Object.assign(new Error('snapshot missing-snapshot not found'), { status: 404 });
        },
      },
      get: async () => fakeSandbox({ id: 'unused', state: 'STARTED' }),
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR,
      daytona: daytona as never,
      snapshot: 'missing-snapshot',
    });

    await assert.rejects(
      () => runtime.launchDetached({
        name: 'issue-greeter',
        env: { SANDBOX_AGENT_ID: 'agent-1' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof SnapshotNotFoundError);
        assert.equal(err.snapshot, 'missing-snapshot');
        assert.equal(
          err.message,
          "Snapshot not found in Daytona: 'missing-snapshot'. Refusing silent fallback to typescript base — fix DEFAULT_SNAPSHOT or rebuild/publish the snapshot before retrying.",
        );
        return true;
      },
    );
    assert.deepEqual(createCalls, [
      {
        params: {
          snapshot: 'missing-snapshot',
          env: { SANDBOX_AGENT_ID: 'agent-1' },
          name: 'issue-greeter',
          labels: { 'code-toolbox-language': 'python' },
          target: 'us',
        },
        options: undefined,
      },
    ]);
  });

  it('getById attaches an existing sandbox without taking ownership by default', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-existing', state: 'STARTED' });
    let deleted = false;
    const daytona = {
      get: async (id: string) => {
        assert.equal(id, 'sbx-existing');
        return sandbox;
      },
      delete: async () => {
        deleted = true;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handle = await runtime.getById('sbx-existing');

    assert.deepEqual(handle, { id: 'sbx-existing', state: 'STARTED' });
    await runtime.destroy(handle!);
    assert.equal(deleted, false);
  });

  it('getById filters by requested sandbox states', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const daytona = {
      get: async (id: string) => {
        assert.equal(id, 'sbx-stopped');
        return sandbox;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    assert.equal(await runtime.getById('sbx-stopped', { states: ['STARTED'] }), null);
    assert.deepEqual(
      await runtime.getById('sbx-stopped', { states: null }),
      { id: 'sbx-stopped', state: 'STOPPED' },
    );
  });

  it('getById returns null when Daytona reports the sandbox is gone', async () => {
    const daytona = {
      get: async () => {
        throw Object.assign(new Error('Sandbox with ID or name sbx-gone not found'), {
          name: 'DaytonaNotFoundError',
          statusCode: 404,
        });
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    assert.equal(await runtime.getById('sbx-gone'), null);
  });

  it('getById rethrows non-404 Daytona errors', async () => {
    const upstream = Object.assign(new Error('Daytona rate limit'), { statusCode: 429 });
    const daytona = {
      get: async () => {
        throw upstream;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    await assert.rejects(() => runtime.getById('sbx-rate-limited'), upstream);
  });

  it('launchDetached registers an immediately started sandbox for uploads', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-started-now', state: 'STARTED' });
    const daytona = {
      target: 'us',
      sandboxApi: {
        createSandbox: async () => ({ data: { id: 'sbx-started-now', state: 'STARTED' } }),
      },
      get: async () => sandbox,
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handle = await runtime.launchDetached();
    await runtime.uploadFile(handle, Buffer.from('ready'), '/workspace/ready.txt');

    assert.deepEqual(sandbox.uploads, [
      { source: Buffer.from('ready'), destination: '/workspace/ready.txt' },
    ]);
  });

  it('findByLabels registers the first started sandbox and skips stopped matches', async () => {
    const stopped = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const started = fakeSandbox({ id: 'sbx-started', state: 'STARTED' });
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([stopped, started]);
      },
      get: async (id: string) => {
        assert.equal(id, 'sbx-started');
        return started;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handle = await runtime.findByLabels({ agentId: 'agent-1' });
    assert.equal(handle?.id, 'sbx-started');
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 10, states: ['started'] }]);

    await runtime.uploadFile(handle!, Buffer.from('ok'), '/workspace/ok.txt');
    assert.deepEqual(started.uploads, [{ source: Buffer.from('ok'), destination: '/workspace/ok.txt' }]);
    assert.deepEqual(stopped.uploads, []);
  });

  it('findByLabels consumes the cursor-backed Daytona iterator until a started sandbox appears', async () => {
    const archived = fakeSandbox({ id: 'sbx-archived', state: 'ARCHIVED' });
    const started = fakeSandbox({ id: 'sbx-page-2', state: 'STARTED' });
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([archived, archived, started]);
      },
      get: async (id: string) => {
        assert.equal(id, 'sbx-page-2');
        return started;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handle = await runtime.findByLabels({ agentId: 'agent-1' }, { limit: 2 });

    assert.equal(handle?.id, 'sbx-page-2');
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2, states: ['started'] }]);
  });

  it('findByLabels rehydrates only the first non-excluded matching sandbox', async () => {
    const busyListed = fakeSandbox({ id: 'sbx-busy', state: 'STARTED' });
    const selectedListed = fakeSandbox({ id: 'sbx-selected', state: 'STARTED' });
    const laterListed = fakeSandbox({ id: 'sbx-later', state: 'STARTED' });
    const selected = fakeSandbox({ id: 'sbx-selected', state: 'STARTED' });
    const yielded: string[] = [];
    const rehydrated: string[] = [];
    const daytona = {
      list: async function* () {
        for (const sandbox of [busyListed, selectedListed, laterListed]) {
          yielded.push(sandbox.id);
          yield sandbox;
        }
      },
      get: async (id: string) => {
        rehydrated.push(id);
        return selected;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handle = await runtime.findByLabels(
      { agentId: 'agent-1' },
      { excludeIds: ['sbx-busy'], timeoutMs: 1_000 },
    );
    await runtime.uploadFile(handle!, Buffer.from('safe'), '/workspace/invoke-safe.sh');

    assert.equal(handle?.id, 'sbx-selected');
    assert.deepEqual(yielded, ['sbx-busy', 'sbx-selected']);
    assert.deepEqual(rehydrated, ['sbx-selected']);
    assert.deepEqual(selected.uploads.map((upload) => upload.destination), ['/workspace/invoke-safe.sh']);
    assert.deepEqual(busyListed.uploads, []);
    assert.deepEqual(selectedListed.uploads, []);
    assert.deepEqual(laterListed.uploads, []);
  });

  it('findByLabels fails within its total lookup deadline when rehydration hangs', async () => {
    const listed = fakeSandbox({ id: 'sbx-hung', state: 'STARTED' });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR,
      daytona: {
        list: () => sandboxIterator([listed]),
        get: async () => new Promise<never>(() => undefined),
      } as never,
    });

    const startedAt = Date.now();
    await assert.rejects(
      runtime.findByLabels({ agentId: 'agent-1' }, { timeoutMs: 20 }),
      /lookup exceeded 20ms/u,
    );
    assert.ok(Date.now() - startedAt < 500, 'lookup deadline must fail well before a Worker cap');
  });

  it('countByLabels stops at maxCount without rehydrating listed sandboxes', async () => {
    const sandboxes = Array.from({ length: 5 }, (_, index) =>
      fakeSandbox({ id: `sbx-count-${index}`, state: 'STARTED' }),
    );
    const yielded: string[] = [];
    let getCalls = 0;
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR,
      daytona: {
        list: async function* () {
          for (const sandbox of sandboxes) {
            yielded.push(sandbox.id);
            yield sandbox;
          }
        },
        get: async () => {
          getCalls += 1;
          throw new Error('count must not rehydrate');
        },
      } as never,
    });

    const count = await runtime.countByLabels(
      { purpose: 'test-purpose' },
      { states: ['STARTED'], maxCount: 2, timeoutMs: 1_000 },
    );

    assert.equal(count, 2);
    assert.deepEqual(yielded, ['sbx-count-0', 'sbx-count-1']);
    assert.equal(getCalls, 0);
  });

  it('findAllByLabels returns every started sandbox from the cursor-backed Daytona iterator', async () => {
    const stopped = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const first = fakeSandbox({
      id: 'sbx-first',
      state: 'STARTED',
      createdAt: '2026-05-31T01:00:00.000Z',
      updatedAt: '2026-05-31T01:05:00.000Z',
      lastActivityAt: '2026-05-31T01:06:00.000Z',
    });
    const second = fakeSandbox({ id: 'sbx-second', state: 'STARTED' });
    const byId = new Map([first, second].map((sandbox) => [sandbox.id, sandbox]));
    const listed: unknown[] = [];
    const rehydrated: string[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([stopped, first, second]);
      },
      get: async (id: string) => {
        rehydrated.push(id);
        return byId.get(id)!;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { limit: 2 });

    assert.deepEqual(handles.map((handle) => handle.id), ['sbx-first', 'sbx-second']);
    assert.deepEqual(handles[0], {
      id: 'sbx-first',
      state: 'STARTED',
      createdAt: '2026-05-31T01:00:00.000Z',
      updatedAt: '2026-05-31T01:05:00.000Z',
      lastActivityAt: '2026-05-31T01:06:00.000Z',
    });
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2, states: ['started'] }]);
    assert.deepEqual(rehydrated, ['sbx-first', 'sbx-second']);
  });

  it('findAllByLabels isolates listed sandbox clients before upload and verification', async () => {
    const sharedListConfig = { uploadTargetId: 'sbx-first' };
    const misroutedUploads = new Map<string, string[]>([
      ['sbx-first', []],
      ['sbx-second', []],
    ]);
    const firstListed = fakeSandbox({ id: 'sbx-first', state: 'STARTED' });
    const secondListed = fakeSandbox({ id: 'sbx-second', state: 'STARTED' });
    firstListed.fs.uploadFile = secondListed.fs.uploadFile = async (_source, destination) => {
      misroutedUploads.get(sharedListConfig.uploadTargetId)!.push(destination);
    };

    const first = fakeSandbox({ id: 'sbx-first', state: 'STARTED' });
    const second = fakeSandbox({ id: 'sbx-second', state: 'STARTED' });
    const byId = new Map([first, second].map((sandbox) => [sandbox.id, sandbox]));
    const rehydrated: string[] = [];
    const daytona = {
      list: async function* () {
        sharedListConfig.uploadTargetId = firstListed.id;
        yield firstListed;
        sharedListConfig.uploadTargetId = secondListed.id;
        yield secondListed;
      },
      get: async (id: string) => {
        rehydrated.push(id);
        return byId.get(id)!;
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { limit: 2 });
    await runtime.uploadBundle(handles[0]!, {
      files: [{ source: Buffer.from('first'), destination: '/workspace/invoke-first.sh' }],
    });
    await runtime.uploadBundle(handles[1]!, {
      files: [{ source: Buffer.from('second'), destination: '/workspace/invoke-second.sh' }],
    });

    assert.deepEqual(rehydrated, ['sbx-first', 'sbx-second']);
    assert.deepEqual(first.uploads.map((upload) => upload.destination), ['/workspace/invoke-first.sh']);
    assert.deepEqual(second.uploads.map((upload) => upload.destination), ['/workspace/invoke-second.sh']);
    assert.deepEqual(firstListed.uploads, []);
    assert.deepEqual(secondListed.uploads, []);
    assert.deepEqual([...misroutedUploads.values()], [[], []]);
    assert.match(
      String((first.sessionCommands[1] as { req?: { command?: string } }).req?.command),
      /invoke-first\.sh/u,
    );
    assert.match(
      String((second.sessionCommands[1] as { req?: { command?: string } }).req?.command),
      /invoke-second\.sh/u,
    );
  });

  it('findAllByLabels excludes a sandbox whose rehydrated state no longer matches', async () => {
    const listed = fakeSandbox({ id: 'sbx-transitioned', state: 'STARTED' });
    const stopped = fakeSandbox({ id: 'sbx-transitioned', state: 'STOPPED' });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR,
      daytona: {
        list: () => sandboxIterator([listed]),
        get: async () => stopped,
      } as never,
    });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { states: ['STARTED'] });

    assert.deepEqual(handles, []);
  });

  it('findAllByLabels skips a listed sandbox deleted before rehydration', async () => {
    const gone = fakeSandbox({ id: 'sbx-gone', state: 'STARTED' });
    const healthyListed = fakeSandbox({ id: 'sbx-healthy', state: 'STARTED' });
    const healthy = fakeSandbox({ id: 'sbx-healthy', state: 'STARTED' });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR,
      daytona: {
        list: () => sandboxIterator([gone, healthyListed]),
        get: async (id: string) => {
          if (id === gone.id) {
            throw Object.assign(new Error('Sandbox sbx-gone not found'), {
              name: 'DaytonaNotFoundError',
              statusCode: 404,
            });
          }
          return healthy;
        },
      } as never,
    });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' });

    assert.deepEqual(handles.map((handle) => handle.id), ['sbx-healthy']);
  });

  it('findAllByLabels drains cursor-backed iterators beyond one page-size', async () => {
    const sandboxes = Array.from({ length: 250 }, (_, index) =>
      fakeSandbox({
        id: `sbx-page-${index}`,
        state: 'STOPPED',
        createdAt: '2026-05-31T01:00:00.000Z',
      }),
    );
    const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return pagedSandboxIterator(sandboxes, 100);
      },
      get: async (id: string) => byId.get(id)!,
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handles = await runtime.findAllByLabels(
      { purpose: 'test-purpose' },
      { states: ['STOPPED'], pageSize: 100, owned: true },
    );

    assert.equal(handles.length, 250);
    assert.deepEqual(handles.slice(0, 3).map((handle) => handle.id), [
      'sbx-page-0',
      'sbx-page-1',
      'sbx-page-2',
    ]);
    assert.equal(handles.at(-1)?.id, 'sbx-page-249');
    assert.deepEqual(listed, [
      { labels: { purpose: 'test-purpose' }, limit: 100, states: ['stopped'] },
    ]);
  });

  it('findAllByLabels returns an empty list when the Daytona iterator has no matches', async () => {
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([]);
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { limit: 2 });

    assert.deepEqual(handles, []);
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2, states: ['started'] }]);
  });

  it('findAllByLabels passes null states through without filtering the cursor-backed Daytona iterator', async () => {
    const first = fakeSandbox({ id: 'sbx-first', state: 'STARTED' });
    const stopped = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const byId = new Map([first, stopped].map((sandbox) => [sandbox.id, sandbox]));
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([first, stopped]);
      },
      get: async (id: string) => byId.get(id)!,
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { states: null, limit: 2 });

    assert.deepEqual(handles.map((handle) => handle.id), ['sbx-first', 'sbx-stopped']);
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2 }]);
  });

  it('runScript defaults to session exec and preserves missing exitCode as null', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-session',
      state: 'STARTED',
      sessionResult: { output: 'timed out' },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    const result = await runtime.runScript(handle, {
      command: 'node runner.mjs',
      cwd: '/workspace',
      env: { TOKEN: "a'b" },
      sessionId: 'session-1',
      timeoutMs: 120_000,
    });

    assert.equal(result.exitCode, null);
    assert.equal(result.output, 'timed out');
    assert.deepEqual(sandbox.sessions, ['session-1']);
    assert.deepEqual(sandbox.sessionCommands, [
      {
        sessionId: 'session-1',
        req: {
          command: "cd '/workspace'\nexport TOKEN='a'\\''b'\nnode runner.mjs",
          runAsync: false,
          suppressInputEcho: undefined,
        },
        timeout: 120,
      },
    ]);
    assert.deepEqual(sandbox.commands, []);
  });

  it('runScript requires session exec by default but allows explicit one-shot exec', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-no-session',
      state: 'STARTED',
      supportsSession: false,
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.runScript(handle, { command: 'node runner.mjs' }),
      /session execution is not available/,
    );
    assert.deepEqual(sandbox.commands, []);

    const result = await runtime.runScript(handle, {
      command: 'node runner.mjs',
      useSession: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'ok');
    assert.deepEqual(sandbox.commands, [
      {
        command: 'node runner.mjs',
        cwd: undefined,
        env: undefined,
        timeout: 1,
      },
    ]);
  });

  it('starts session scripts asynchronously and exposes poll/log helpers', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-123', output: null, stdout: '', stderr: '', exitCode: null },
      sessionCommand: { id: 'cmd-123', command: 'node runner.mjs' },
      sessionLogs: { stdout: 'done', stderr: '', output: 'prefix-bytes done' },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    const started = await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'session-1',
      timeoutMs: 15_000,
      suppressInputEcho: true,
    });
    const running = await runtime.getScriptStatus(handle, 'session-1', 'cmd-123');
    const logs = await runtime.getScriptLogs(handle, 'session-1', 'cmd-123');

    assert.deepEqual(started, { sessionId: 'session-1', commandId: 'cmd-123' });
    assert.deepEqual(running, { exitCode: null });
    assert.equal(logs.stdout, 'done');
    assert.equal(logs.output, 'prefix-bytes done');
    // startScript redirects combined stdout+stderr for the run command group to
    // a per-session log file so runAsync output is retrievable on
    // the Worker without redirecting later session commands.
    assert.deepEqual(sandbox.sessionCommands, [
      {
        sessionId: 'session-1',
        req: {
          command:
            "(\nnode runner.mjs\n) > '/tmp/.daytona-run-session-1.log' 2>&1\n" +
            "daytona_run_status=$?\n" +
            "printf '%s\\n' \"$daytona_run_status\" > '/tmp/.daytona-run-session-1.exit.tmp'\n" +
            "mv '/tmp/.daytona-run-session-1.exit.tmp' '/tmp/.daytona-run-session-1.exit'\n" +
            "exit \"$daytona_run_status\"",
          runAsync: true,
          suppressInputEcho: true,
        },
        timeout: 15,
      },
    ]);
    assert.deepEqual(sandbox.commands, [
      {
        command:
          "rm -f '/tmp/.daytona-run-session-1.exit' '/tmp/.daytona-run-session-1.exit.tmp'",
        cwd: undefined,
        env: undefined,
        timeout: undefined,
      },
      {
        command:
          "if [ -f '/tmp/.daytona-run-session-1.exit' ]; then cat '/tmp/.daytona-run-session-1.exit'; fi",
        cwd: undefined,
        env: undefined,
        timeout: undefined,
      },
    ]);
    assert.deepEqual(sandbox.polledCommands, [
      { sessionId: 'session-1', commandId: 'cmd-123' },
    ]);
    assert.deepEqual(sandbox.polledLogs, [
      { sessionId: 'session-1', commandId: 'cmd-123' },
    ]);
  });

  it('reconciles an outcome-unknown async admission without executing the command twice', async () => {
    const admissionTimeout = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const sandbox = fakeSandbox({
      id: 'sbx-async-admission-timeout',
      state: 'STARTED',
      sessionExecuteError: admissionTimeout,
      sessionReads: [
        { commands: [] },
        {
          commands: [
            {
              id: 'cmd-admitted-before-timeout',
              command: generatedAsyncCommand('session-admission-timeout'),
            },
          ],
        },
      ],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    const started = await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'session-admission-timeout',
      timeoutMs: 15_000,
    });

    assert.deepEqual(started, {
      sessionId: 'session-admission-timeout',
      commandId: 'cmd-admitted-before-timeout',
      reconciled: true,
    });
    assert.equal(sandbox.sessionCommands.length, 1);
    assert.deepEqual(sandbox.inspectedSessions, [
      'session-admission-timeout',
      'session-admission-timeout',
    ]);
  });

  it('does not confuse a stale generated command with the command admitted by this attempt', async () => {
    const admissionTimeout = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const sessionId = 'session-stale-baseline';
    const command = generatedAsyncCommand(sessionId);
    const sandbox = fakeSandbox({
      id: 'sbx-stale-baseline',
      state: 'STARTED',
      sessionExecuteError: admissionTimeout,
      sessionReads: [
        { commands: [{ id: 'cmd-stale', command }] },
        {
          commands: [
            { id: 'cmd-stale', command },
            { id: 'cmd-admitted-now', command },
          ],
        },
      ],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    const started = await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId,
      timeoutMs: 15_000,
    });

    assert.deepEqual(started, {
      sessionId,
      commandId: 'cmd-admitted-now',
      reconciled: true,
    });
    assert.equal(sandbox.sessionCommands.length, 1, 'must never resubmit after outcome-unknown');
  });

  it('preserves the original timeout for zero, duplicate, or conflicting newly observed commands', async () => {
    const cases = [
      { label: 'zero', commands: [{ id: 'cmd-other', command: 'echo unrelated' }] },
      {
        label: 'duplicate',
        commands: [
          { id: 'cmd-new-a', command: generatedAsyncCommand('session-duplicate') },
          { id: 'cmd-new-b', command: generatedAsyncCommand('session-duplicate') },
        ],
      },
      {
        label: 'conflicting',
        commands: [
          { id: 'cmd-expected', command: generatedAsyncCommand('session-conflicting') },
          { id: 'cmd-conflict', command: 'echo unexpected' },
        ],
      },
    ];

    for (const testCase of cases) {
      const admissionTimeout = Object.assign(
        new Error('timeout of 15000ms exceeded'),
        { code: 'ECONNABORTED' },
      );
      const sessionId = `session-${testCase.label}`;
      const sandbox = fakeSandbox({
        id: `sbx-${testCase.label}`,
        state: 'STARTED',
        sessionExecuteError: admissionTimeout,
        sessionReads: [{ commands: [] }, { commands: testCase.commands }],
      });
      const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
      const handle = runtime.attachSandbox(sandbox as never);

      await assert.rejects(
        () => runtime.startScript(handle, { command: 'node runner.mjs', sessionId, timeoutMs: 15_000 }),
        admissionTimeout,
        testCase.label,
      );
      assert.equal(sandbox.sessionCommands.length, 1, `${testCase.label}: must never resubmit`);
      assert.equal(sandbox.inspectedSessions.length, 2, `${testCase.label}: baseline and post-error reads`);
    }
  });

  it('preserves the original timeout when a post-error snapshot repeats a command id', async () => {
    const admissionTimeout = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const sessionId = 'session-duplicate-command-id';
    const sandbox = fakeSandbox({
      id: 'sbx-duplicate-command-id',
      state: 'STARTED',
      sessionExecuteError: admissionTimeout,
      sessionReads: [
        { commands: [{ id: 'cmd-duplicated', command: 'echo stale' }] },
        {
          commands: [
            { id: 'cmd-duplicated', command: 'echo stale' },
            { id: 'cmd-duplicated', command: generatedAsyncCommand(sessionId) },
            { id: 'cmd-expected', command: generatedAsyncCommand(sessionId) },
          ],
        },
      ],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.startScript(handle, { command: 'node runner.mjs', sessionId, timeoutMs: 15_000 }),
      admissionTimeout,
    );
    assert.equal(sandbox.sessionCommands.length, 1);
  });

  it('preserves the original timeout when either reconciliation snapshot is unreadable', async () => {
    const baselineFailure = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const baselineSandbox = fakeSandbox({
      id: 'sbx-unreadable-baseline',
      state: 'STARTED',
      sessionExecuteError: baselineFailure,
      readSession: async () => { throw new Error('baseline session read lost'); },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    await assert.rejects(
      () => runtime.startScript(runtime.attachSandbox(baselineSandbox as never), {
        command: 'node runner.mjs', sessionId: 'session-unreadable-baseline', timeoutMs: 15_000,
      }),
      baselineFailure,
    );
    assert.equal(baselineSandbox.inspectedSessions.length, 1, 'no post-error lookup without a readable baseline');

    const postFailure = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const postSandbox = fakeSandbox({
      id: 'sbx-unreadable-post',
      state: 'STARTED',
      sessionExecuteError: postFailure,
      readSession: async (sessionId, readCount) => {
        if (readCount === 0) return { sessionId, commands: [] };
        throw new Error('post-error session read lost');
      },
    });
    await assert.rejects(
      () => runtime.startScript(runtime.attachSandbox(postSandbox as never), {
        command: 'node runner.mjs', sessionId: 'session-unreadable-post', timeoutMs: 15_000,
      }),
      postFailure,
    );
    assert.equal(postSandbox.inspectedSessions.length, 2);
  });

  it('preserves the original timeout when the post-error snapshot is for another session', async () => {
    const admissionTimeout = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const sandbox = fakeSandbox({
      id: 'sbx-wrong-session',
      state: 'STARTED',
      sessionExecuteError: admissionTimeout,
      sessionReads: [
        { commands: [] },
        {
          sessionId: 'session-not-requested',
          commands: [{ id: 'cmd-wrong-session', command: generatedAsyncCommand('session-requested') }],
        },
      ],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    await assert.rejects(
      () => runtime.startScript(runtime.attachSandbox(sandbox as never), {
        command: 'node runner.mjs', sessionId: 'session-requested', timeoutMs: 15_000,
      }),
      admissionTimeout,
    );
  });

  it('uses a separate bounded post-error lookup budget and preserves the original admission timeout', async () => {
    const admissionTimeout = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const sandbox = fakeSandbox({
      id: 'sbx-bounded-reconciliation',
      state: 'STARTED',
      sessionExecuteError: admissionTimeout,
      readSession: async (sessionId, readCount) => {
        if (readCount === 0) return { sessionId, commands: [] };
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const startedAt = Date.now();
    await assert.rejects(
      () => runtime.startScript(runtime.attachSandbox(sandbox as never), {
        command: 'node runner.mjs', sessionId: 'session-bounded-reconciliation', timeoutMs: 15_000,
      }),
      admissionTimeout,
    );
    assert.ok(Date.now() - startedAt >= 800, 'post-error lookup must use its own bounded budget');
    assert.equal(sandbox.inspectedSessions.length, 2);
  });

  it('preserves the original timeout when the deterministic session cannot prove admission', async () => {
    const admissionTimeout = Object.assign(
      new Error('timeout of 15000ms exceeded'),
      { code: 'ECONNABORTED' },
    );
    const sandbox = fakeSandbox({
      id: 'sbx-async-admission-unproven',
      state: 'STARTED',
      sessionExecuteError: admissionTimeout,
      sessionReads: [
        { commands: [] },
        { commands: [{ id: 'cmd-other', command: 'echo unrelated' }] },
      ],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.startScript(handle, {
        command: 'node runner.mjs',
        sessionId: 'session-admission-unproven',
        timeoutMs: 15_000,
      }),
      admissionTimeout,
    );
    assert.equal(sandbox.sessionCommands.length, 1);
    assert.deepEqual(sandbox.inspectedSessions, [
      'session-admission-unproven',
      'session-admission-unproven',
    ]);
  });

  it('does not reconcile an explicit Daytona rejection', async () => {
    const explicitRejection = Object.assign(
      new Error('Daytona rejected command: invalid request'),
      { code: 'ERR_BAD_REQUEST' },
    );
    const sandbox = fakeSandbox({
      id: 'sbx-async-admission-rejected',
      state: 'STARTED',
      sessionExecuteError: explicitRejection,
      sessionReads: [{ commands: [] }],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.startScript(handle, {
        command: 'node runner.mjs',
        sessionId: 'session-admission-rejected',
        timeoutMs: 15_000,
      }),
      explicitRejection,
    );
    assert.equal(sandbox.sessionCommands.length, 1);
    assert.deepEqual(sandbox.inspectedSessions, ['session-admission-rejected']);
  });

  it('does not inspect a post-error session after an arbitrary non-transport failure', async () => {
    const nonTransportFailure = new Error('request validation failed');
    const sandbox = fakeSandbox({
      id: 'sbx-non-transport-failure',
      state: 'STARTED',
      sessionExecuteError: nonTransportFailure,
      sessionReads: [{ commands: [] }],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });

    await assert.rejects(
      () => runtime.startScript(runtime.attachSandbox(sandbox as never), {
        command: 'node runner.mjs', sessionId: 'session-non-transport-failure', timeoutMs: 15_000,
      }),
      nonTransportFailure,
    );
    assert.equal(sandbox.sessionCommands.length, 1);
    assert.equal(sandbox.inspectedSessions.length, 1, 'baseline only');
  });

  it('reports a direct command admission separately from a reconciled admission', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-direct-admission',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-direct', output: null, exitCode: null },
      sessionReads: [{ commands: [] }],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });

    const started = await runtime.startScript(runtime.attachSandbox(sandbox as never), {
      command: 'node runner.mjs', sessionId: 'session-direct-admission', timeoutMs: 15_000,
    });

    assert.deepEqual(started, { sessionId: 'session-direct-admission', commandId: 'cmd-direct' });
    assert.equal(sandbox.inspectedSessions.length, 1, 'baseline only');
  });

  it('recovers a terminal async exit code from the durable status file when Daytona keeps returning null', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async-terminal-file',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-terminal', output: null, exitCode: null },
      // Production Daytona can keep this REST command projection at null even
      // after the command itself exited and wrote its session output.
      sessionCommand: { id: 'cmd-terminal', command: 'node runner.mjs', exitCode: null },
      commandResult: { exitCode: 0, result: '0\n' },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'session-terminal-file',
      timeoutMs: 15_000,
    });
    const status = await runtime.getScriptStatus(
      handle,
      'session-terminal-file',
      'cmd-terminal',
    );

    assert.deepEqual(status, { exitCode: 0 });
    assert.match(
      (sandbox.sessionCommands[0] as { req: { command: string } }).req.command,
      /\.daytona-run-session-terminal-file\.exit/u,
    );
    assert.deepEqual(sandbox.commands, [
      {
        command:
          "rm -f '/tmp/.daytona-run-session-terminal-file.exit' '/tmp/.daytona-run-session-terminal-file.exit.tmp'",
        cwd: undefined,
        env: undefined,
        timeout: undefined,
      },
      {
        command:
          "if [ -f '/tmp/.daytona-run-session-terminal-file.exit' ]; then cat '/tmp/.daytona-run-session-terminal-file.exit'; fi",
        cwd: undefined,
        env: undefined,
        timeout: undefined,
      },
    ]);
  });

  it('clears a stale status sidecar before reusing an explicit session id', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async-reused-session',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-reused', output: null, exitCode: null },
      sessionCommand: { id: 'cmd-reused', command: 'sleep 30', exitCode: null },
      commandResults: [
        // A stale exit from the prior run. The cleanup consumes this mock call;
        // the following status read must see no terminal sidecar yet.
        { exitCode: 0, result: '7\n' },
        { exitCode: 0, result: '' },
      ],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'sleep 30',
      sessionId: 'reused-session',
      timeoutMs: 45_000,
    });
    const status = await runtime.getScriptStatus(handle, 'reused-session', 'cmd-reused');

    assert.deepEqual(status, { exitCode: null });
    assert.equal(
      (sandbox.commands[0] as { command: string }).command,
      "rm -f '/tmp/.daytona-run-reused-session.exit' '/tmp/.daytona-run-reused-session.exit.tmp'",
    );
  });

  it('getScriptLogs falls back to the captured log file when the runAsync snapshot is empty', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async-empty',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-async', output: null, stdout: '', stderr: '', exitCode: null },
      // Daytona returns an EMPTY snapshot for runAsync commands.
      sessionLogs: { output: '', stdout: '', stderr: '' },
      // A fresh one-shot `tail -c` read returns the real output after the
      // original async session has closed.
      commandResult: { exitCode: 0, result: 'TypeError: cannot read x\nrunner exited 1' },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'session-2',
      timeoutMs: 15_000,
    });
    const logs = await runtime.getScriptLogs(handle, 'session-2', 'cmd-async');

    // The empty snapshot is replaced by the file content.
    assert.equal(logs.output, 'TypeError: cannot read x\nrunner exited 1');
    // The fallback issued a bounded `tail -c` in a fresh one-shot process.
    const tailCmd = sandbox.commands.find(
      (entry) => typeof (entry as { command?: unknown }).command === 'string'
        && ((entry as { command: string }).command).startsWith('tail -c'),
    ) as { command: string } | undefined;
    assert.ok(tailCmd, 'expected a tail -c fallback read');
    assert.equal(
      tailCmd!.command,
      "tail -c 262144 '/tmp/.daytona-run-session-2.log' 2>/dev/null || true",
    );
  });

  it('startScript scopes log redirection to the async command group', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-scoped-redirection',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-scoped', output: null, stdout: '', stderr: '', exitCode: null },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'session-scoped',
      timeoutMs: 15_000,
    });

    assert.equal(
      (sandbox.sessionCommands[0] as { req: { command: string } }).req.command,
      "(\nnode runner.mjs\n) > '/tmp/.daytona-run-session-scoped.log' 2>&1\n" +
      "daytona_run_status=$?\n" +
      "printf '%s\\n' \"$daytona_run_status\" > '/tmp/.daytona-run-session-scoped.exit.tmp'\n" +
      "mv '/tmp/.daytona-run-session-scoped.exit.tmp' '/tmp/.daytona-run-session-scoped.exit'\n" +
      "exit \"$daytona_run_status\"",
    );
  });

  it('getScriptLogs returns the snapshot without a file read when it is non-empty', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async-nonempty',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-async', output: null, stdout: '', stderr: '', exitCode: null },
      sessionLogs: { output: 'snapshot has it', stdout: 'snapshot has it', stderr: '' },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'session-3',
      timeoutMs: 15_000,
    });
    const logs = await runtime.getScriptLogs(handle, 'session-3', 'cmd-async');

    assert.equal(logs.output, 'snapshot has it');
    const tailCmd = sandbox.commands.find(
      (entry) => typeof (entry as { command?: unknown }).command === 'string'
        && ((entry as { command: string }).command).startsWith('tail -c'),
    );
    assert.equal(tailCmd, undefined, 'non-empty snapshot must not trigger a file read');
  });

  it('uploadBundle writes all files and an optional manifest', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-upload', state: 'STARTED' });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.uploadBundle(handle, {
      files: [
        { source: Buffer.from('runner'), destination: '/workspace/runner.mjs' },
        { source: Buffer.from('agent'), destination: '/workspace/agent.bundle.mjs' },
      ],
      manifest: { files: 2 },
      manifestPath: '/workspace/bundle-manifest.json',
    });

    assert.equal(sandbox.sessions.length, 2);
    assert.match(sandbox.sessions[0], /^mkdir-sbx-upload-\d+$/);
    assert.match(sandbox.sessions[1], /^verify-upload-sbx-upload-\d+$/);
    assert.deepEqual(sandbox.sessionCommands, [
      {
        sessionId: sandbox.sessions[0],
        req: {
          command: "mkdir -p '/workspace'",
          runAsync: false,
          suppressInputEcho: undefined,
        },
        timeout: 30,
      },
      {
        sessionId: sandbox.sessions[1],
        req: {
          command: "test -f '/workspace/runner.mjs' && test -f '/workspace/agent.bundle.mjs' && test -f '/workspace/bundle-manifest.json'",
          runAsync: false,
          suppressInputEcho: undefined,
        },
        timeout: 30,
      },
    ]);
    assert.deepEqual(sandbox.uploads.map(({ destination }) => destination), [
      '/workspace/runner.mjs',
      '/workspace/agent.bundle.mjs',
      '/workspace/bundle-manifest.json',
    ]);
    assert.equal(String(sandbox.uploads[2].source), '{\n  "files": 2\n}');
  });

  it('uploadBundle verifies runner.mjs exists after upload before callers start it', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-upload-missing-runner',
      state: 'STARTED',
      sessionResults: [
        { exitCode: 0, output: 'ok' },
        { exitCode: 1, output: 'missing /home/sandbox/runtime/runner.mjs' },
      ],
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.uploadBundle(handle, {
        files: [
          { source: Buffer.from('runner'), destination: '/home/sandbox/runtime/runner.mjs' },
          { source: Buffer.from('agent'), destination: '/home/sandbox/runtime/agent.bundle.mjs' },
        ],
      }),
      /Failed to verify uploaded bundle files: missing \/home\/sandbox\/runtime\/runner\.mjs/,
    );

    assert.deepEqual(sandbox.uploads.map(({ destination }) => destination), [
      '/home/sandbox/runtime/runner.mjs',
      '/home/sandbox/runtime/agent.bundle.mjs',
    ]);
    assert.equal(sandbox.sessionCommands.length, 2);
    assert.equal(
      (sandbox.sessionCommands[1] as { req: { command: string } }).req.command,
      "test -f '/home/sandbox/runtime/runner.mjs' && test -f '/home/sandbox/runtime/agent.bundle.mjs'",
    );
  });

  it('uploadBundle fails before upload when parent directory creation fails', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-upload-fail',
      state: 'STARTED',
      sessionResult: { exitCode: 1, output: 'mkdir: permission denied' },
    });
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.uploadBundle(handle, {
        files: [
          { source: Buffer.from('runner'), destination: '/workspace/runner.mjs' },
        ],
      }),
      /Failed to create upload directories: mkdir: permission denied/,
    );

    assert.deepEqual(sandbox.uploads, []);
  });

  it('destroy keeps owned handles registered when remote deletion fails', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-delete-fails', state: 'STARTED' });
    const daytona = {
      delete: async () => {
        throw new Error('delete failed');
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });
    const handle = runtime.attachSandbox(sandbox as never, { owned: true });

    await assert.rejects(() => runtime.destroy(handle), /delete failed/);
    await runtime.uploadFile(handle, Buffer.from('still-registered'), '/workspace/retry.txt');

    assert.deepEqual(sandbox.uploads, [
      { source: Buffer.from('still-registered'), destination: '/workspace/retry.txt' },
    ]);
  });

  it('must-fire: stops owned handles without deleting them', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-stop', state: 'STARTED' });
    const stopped: string[] = [];
    const deleted: string[] = [];
    const daytona = {
      get: async () => sandbox,
      stop: async (value: unknown) => {
        stopped.push((value as { id: string }).id);
      },
      delete: async (value: unknown) => {
        deleted.push((value as { id: string }).id);
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handle = await runtime.getById('sbx-stop', { owned: true });
    await runtime.stop(handle!);

    assert.equal(handle!.state, 'STOPPED');
    assert.deepEqual(stopped, ['sbx-stop']);
    assert.deepEqual(deleted, []);
    await runtime.destroy(handle!);
    assert.deepEqual(deleted, ['sbx-stop']);
  });

  it('must-not-fire: a healthy native restart rehydrates the SDK client without recreating', async () => {
    const stoppedSandbox = fakeSandbox({ id: 'sbx-start', state: 'STOPPED' });
    const restartedSandbox = fakeSandbox({ id: 'sbx-start', state: 'STARTED' });
    const started: string[] = [];
    const created: unknown[] = [];
    const deleted: string[] = [];
    let getCalls = 0;
    const daytona = {
      get: async () => {
        getCalls += 1;
        return getCalls === 1 ? stoppedSandbox : restartedSandbox;
      },
      start: async (value: unknown) => {
        started.push((value as { id: string }).id);
      },
      create: async (params: unknown) => {
        created.push(params);
        throw new Error('healthy restart must not create a replacement');
      },
      delete: async (value: unknown) => {
        deleted.push((value as { id: string }).id);
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });

    const handle = await runtime.getById('sbx-start', { owned: true });
    const startedHandle = await runtime.start(handle!);

    assert.equal(startedHandle.state, 'STARTED');
    assert.deepEqual(started, ['sbx-start']);
    assert.deepEqual(created, []);
    assert.deepEqual(deleted, []);
    assert.deepEqual(restartedSandbox.commands, [
      { command: 'true', cwd: undefined, env: undefined, timeout: 10 },
    ]);

    await runtime.uploadFile(startedHandle, Buffer.from('fresh-client'), '/workspace/fresh.txt');
    assert.deepEqual(stoppedSandbox.uploads, []);
    assert.deepEqual(restartedSandbox.uploads, [
      { source: Buffer.from('fresh-client'), destination: '/workspace/fresh.txt' },
    ]);
  });

  it('must-fire: replaces an exec-dead restarted sandbox and moves ownership to the healthy ID', async () => {
    const stoppedSandbox = fakeSandbox({
      id: 'sbx-dead-after-restart',
      state: 'STOPPED',
      snapshot: 'snapshot-v1',
      user: 'daytona',
      env: { SAFE_ENV: 'preserved' },
      labels: {
        purpose: 'warm-lease',
        'code-toolbox-language': 'python',
      },
      public: false,
      autoStopInterval: 5,
      autoArchiveInterval: 60,
      autoDeleteInterval: -1,
      networkBlockAll: true,
      networkAllowList: '10.0.0.0/8',
    });
    const restartedButDead = fakeSandbox({
      id: 'sbx-dead-after-restart',
      state: 'STARTED',
      commandError: Object.assign(new Error('502 Bad Gateway'), { status: 502 }),
    });
    const replacement = fakeSandbox({ id: 'sbx-healthy-replacement', state: 'STARTED' });
    const created: unknown[] = [];
    const deleted: string[] = [];
    let getCalls = 0;
    const daytona = {
      get: async () => {
        getCalls += 1;
        return getCalls === 1 ? stoppedSandbox : restartedButDead;
      },
      start: async () => {},
      create: async (params: unknown) => {
        created.push(params);
        return replacement;
      },
      delete: async (sandbox: { id: string }) => {
        deleted.push(sandbox.id);
      },
    };
    const runtime = new DaytonaRuntime({ defaultHomeDir: TEST_HOME_DIR, daytona: daytona as never });
    const handle = await runtime.getById('sbx-dead-after-restart', { owned: true });

    const startedHandle = await runtime.start(handle!);

    assert.equal(startedHandle, handle);
    assert.equal(handle!.id, 'sbx-healthy-replacement');
    assert.equal(handle!.state, 'STARTED');
    assert.deepEqual(created, [
      {
        snapshot: 'snapshot-v1',
        user: 'daytona',
        envVars: { SAFE_ENV: 'preserved' },
        labels: {
          purpose: 'warm-lease',
          'code-toolbox-language': 'python',
        },
        public: false,
        autoStopInterval: 5,
        autoArchiveInterval: 60,
        autoDeleteInterval: -1,
        networkBlockAll: true,
        networkAllowList: '10.0.0.0/8',
      },
    ]);
    assert.deepEqual(restartedButDead.commands, [
      { command: 'true', cwd: undefined, env: undefined, timeout: 10 },
    ]);
    assert.deepEqual(replacement.commands, [
      { command: 'true', cwd: undefined, env: undefined, timeout: 10 },
    ]);
    assert.deepEqual(deleted, ['sbx-dead-after-restart']);

    await runtime.destroy(handle!);
    assert.deepEqual(deleted, ['sbx-dead-after-restart', 'sbx-healthy-replacement']);
  });

  it('must-not-fire: disabling recreate preserves the exec failure and creates no resource', async () => {
    const stoppedSandbox = fakeSandbox({ id: 'sbx-no-recreate', state: 'STOPPED' });
    const postStartFailure = Object.assign(new Error('502 exec daemon missing'), { status: 502 });
    const restartedButDead = fakeSandbox({
      id: 'sbx-no-recreate',
      state: 'STARTED',
      commandError: postStartFailure,
    });
    let getCalls = 0;
    let createCalls = 0;
    const runtime = new DaytonaRuntime({
      defaultHomeDir: TEST_HOME_DIR,
      recreateOnFailedStart: false,
      daytona: {
        get: async () => (++getCalls === 1 ? stoppedSandbox : restartedButDead),
        start: async () => {},
        create: async () => {
          createCalls += 1;
          return fakeSandbox({ id: 'must-not-exist', state: 'STARTED' });
        },
      } as never,
    });
    const handle = await runtime.getById('sbx-no-recreate', { owned: true });

    await assert.rejects(() => runtime.start(handle!), postStartFailure);
    assert.equal(createCalls, 0);
    assert.equal(handle!.id, 'sbx-no-recreate');
  });

  it('must-not-fire: a control-plane rehydrate failure never creates a replacement', async () => {
    const stoppedSandbox = fakeSandbox({ id: 'sbx-rehydrate-fails', state: 'STOPPED' });
    const upstream = Object.assign(new Error('Daytona rate limit'), { status: 429 });
    let getCalls = 0;
    let createCalls = 0;
    const runtime = new DaytonaRuntime({
      defaultHomeDir: TEST_HOME_DIR,
      daytona: {
        get: async () => {
          getCalls += 1;
          if (getCalls === 1) return stoppedSandbox;
          throw upstream;
        },
        start: async () => {},
        create: async () => {
          createCalls += 1;
          return fakeSandbox({ id: 'must-not-exist', state: 'STARTED' });
        },
      } as never,
    });
    const handle = await runtime.getById('sbx-rehydrate-fails', { owned: true });

    await assert.rejects(() => runtime.start(handle!), upstream);
    assert.equal(createCalls, 0);
    assert.equal(handle!.id, 'sbx-rehydrate-fails');
  });

  it('must-fire: an unhealthy replacement is deleted and never takes over the handle', async () => {
    const stoppedSandbox = fakeSandbox({ id: 'sbx-original-retained', state: 'STOPPED' });
    const restartedButDead = fakeSandbox({
      id: 'sbx-original-retained',
      state: 'STARTED',
      commandError: new Error('502 exec daemon missing'),
    });
    const unhealthyReplacement = fakeSandbox({
      id: 'sbx-replacement-rolled-back',
      state: 'STARTED',
      commandResult: { exitCode: 7, result: 'toolbox unavailable' },
    });
    const deleted: string[] = [];
    let getCalls = 0;
    const runtime = new DaytonaRuntime({
      defaultHomeDir: TEST_HOME_DIR,
      daytona: {
        get: async () => (++getCalls === 1 ? stoppedSandbox : restartedButDead),
        start: async () => {},
        create: async () => unhealthyReplacement,
        delete: async (sandbox: { id: string }) => {
          deleted.push(sandbox.id);
        },
      } as never,
    });
    const handle = await runtime.getById('sbx-original-retained', { owned: true });

    await assert.rejects(
      () => runtime.start(handle!),
      /restarted without working exec and replacement failed/,
    );
    assert.deepEqual(deleted, ['sbx-replacement-rolled-back']);
    assert.equal(handle!.id, 'sbx-original-retained');

    await runtime.uploadFile(handle!, Buffer.from('still-owned'), '/workspace/retry.txt');
    assert.deepEqual(stoppedSandbox.uploads, [
      { source: Buffer.from('still-owned'), destination: '/workspace/retry.txt' },
    ]);
    await runtime.destroy(handle!);
    assert.deepEqual(deleted, ['sbx-replacement-rolled-back', 'sbx-original-retained']);
  });
});

function fakeSandbox(input: {
  id: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  sessionResult?: Record<string, unknown>;
  sessionResults?: Array<Record<string, unknown>>;
  sessionExecuteError?: Error;
  session?: Record<string, unknown>;
  sessionReads?: Array<Record<string, unknown>>;
  readSession?: (sessionId: string, readCount: number) => Promise<Record<string, unknown>>;
  commandResult?: { exitCode: number; result: string; artifacts?: { stdout?: string } };
  commandResults?: Array<{ exitCode: number; result: string; artifacts?: { stdout?: string } }>;
  commandError?: Error;
  sessionCommand?: Record<string, unknown>;
  sessionLogs?: Record<string, unknown>;
  supportsSession?: boolean;
  snapshot?: string;
  user?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  networkBlockAll?: boolean;
  networkAllowList?: string;
}) {
  const uploads: Array<{ source: Buffer | string; destination: string }> = [];
  const commands: Array<unknown> = [];
  const sessions: string[] = [];
  const sessionCommands: Array<unknown> = [];
  const polledCommands: Array<unknown> = [];
  const polledLogs: Array<unknown> = [];
  const inspectedSessions: string[] = [];
  const sessionReads = [...(input.sessionReads ?? [])];
  const process: {
    executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => Promise<{ exitCode: number; result: string }>;
    createSession?: (sessionId: string) => Promise<void>;
    executeSessionCommand?: (
      sessionId: string,
      req: Record<string, unknown>,
      timeout?: number,
    ) => Promise<Record<string, unknown>>;
    getSessionCommand?: (
      sessionId: string,
      commandId: string,
    ) => Promise<Record<string, unknown>>;
    getSession?: (sessionId: string) => Promise<Record<string, unknown>>;
    getSessionCommandLogs?: (
      sessionId: string,
      commandId: string,
    ) => Promise<Record<string, unknown>>;
  } = {
    executeCommand: async (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => {
      commands.push({ command, cwd, env, timeout });
      if (input.commandError) {
        throw input.commandError;
      }
      if (input.commandResults && input.commandResults.length > 0) {
        return input.commandResults.shift()!;
      }
      return input.commandResult ?? { exitCode: 0, result: 'ok' };
    },
  };
  if (input.supportsSession !== false) {
    process.createSession = async (sessionId: string) => {
      sessions.push(sessionId);
    };
    process.executeSessionCommand = async (
      sessionId: string,
      req: Record<string, unknown>,
      timeout?: number,
    ) => {
      sessionCommands.push({ sessionId, req, timeout });
      if (input.sessionExecuteError) {
        throw input.sessionExecuteError;
      }
      if (input.sessionResults && input.sessionResults.length > 0) {
        return input.sessionResults.shift()!;
      }
      return input.sessionResult ?? { exitCode: 0, output: 'ok' };
    };
    process.getSession = async (sessionId: string) => {
      inspectedSessions.push(sessionId);
      const readCount = inspectedSessions.length - 1;
      if (input.readSession) {
        return input.readSession(sessionId, readCount);
      }
      const next = sessionReads.shift();
      if (next) {
        return { sessionId, ...next };
      }
      return input.session ?? { sessionId, commands: [] };
    };
    process.getSessionCommand = async (
      sessionId: string,
      commandId: string,
    ) => {
      polledCommands.push({ sessionId, commandId });
      return input.sessionCommand ?? { id: commandId, command: 'true', exitCode: 0 };
    };
    process.getSessionCommandLogs = async (
      sessionId: string,
      commandId: string,
    ) => {
      polledLogs.push({ sessionId, commandId });
      return input.sessionLogs ?? { output: 'ok', stdout: 'ok', stderr: '' };
    };
  }

  return {
    id: input.id,
    state: input.state,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    ...(input.user ? { user: input.user } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
    ...(typeof input.public === 'boolean' ? { public: input.public } : {}),
    ...(typeof input.autoStopInterval === 'number'
      ? { autoStopInterval: input.autoStopInterval }
      : {}),
    ...(typeof input.autoArchiveInterval === 'number'
      ? { autoArchiveInterval: input.autoArchiveInterval }
      : {}),
    ...(typeof input.autoDeleteInterval === 'number'
      ? { autoDeleteInterval: input.autoDeleteInterval }
      : {}),
    ...(typeof input.networkBlockAll === 'boolean'
      ? { networkBlockAll: input.networkBlockAll }
      : {}),
    ...(input.networkAllowList ? { networkAllowList: input.networkAllowList } : {}),
    uploads,
    commands,
    sessions,
    sessionCommands,
    polledCommands,
    polledLogs,
    inspectedSessions,
    getUserHomeDir: async () => '/home/sandbox',
    fs: {
      uploadFile: async (source: Buffer | string, destination: string) => {
        uploads.push({ source, destination });
      },
      downloadFile: async () => Buffer.from(''),
    },
    process,
  };
}

function generatedAsyncCommand(sessionId: string): string {
  return "(\nnode runner.mjs\n) > '/tmp/.daytona-run-" + sessionId + ".log' 2>&1\n"
    + 'daytona_run_status=$?\n'
    + "printf '%s\\n' \"$daytona_run_status\" > '/tmp/.daytona-run-" + sessionId + ".exit.tmp'\n"
    + "mv '/tmp/.daytona-run-" + sessionId + ".exit.tmp' '/tmp/.daytona-run-" + sessionId + ".exit'\n"
    + 'exit "$daytona_run_status"';
}

async function* sandboxIterator(sandboxes: Array<ReturnType<typeof fakeSandbox>>) {
  for (const sandbox of sandboxes) {
    yield sandbox;
  }
}

async function* pagedSandboxIterator(
  sandboxes: Array<ReturnType<typeof fakeSandbox>>,
  pageSize: number,
) {
  for (let i = 0; i < sandboxes.length; i += pageSize) {
    for (const sandbox of sandboxes.slice(i, i + pageSize)) {
      yield sandbox;
    }
  }
}

const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim();
const HAS_DAYTONA = Boolean(daytonaApiKey);
const SMOKE_LABEL = `daytona-runner-smoke-${process.pid}-${Date.now()}`;

describe('DaytonaRuntime smoke', { concurrency: false }, () => {
  let daytona: Daytona | undefined;
  let runtime: DaytonaRuntime | undefined;
  let handle: RuntimeHandle | undefined;
  const createdSandboxIds = new Set<string>();

  before(() => {
    if (!HAS_DAYTONA) return;
    daytona = new Daytona({ apiKey: daytonaApiKey });
    runtime = new DaytonaRuntime({ daytona, defaultHomeDir: TEST_HOME_DIR });
  });

  after(async () => {
    if (!daytona) return;
    if (runtime && handle) {
      createdSandboxIds.add(handle.id);
      try {
        await runtime.destroy(handle);
      } catch {
        // Direct provider cleanup below still has the ID and verifies absence.
      }
    }

    const cleanupFailures: unknown[] = [];
    for (const id of createdSandboxIds) {
      try {
        let sandbox;
        try {
          sandbox = await daytona.get(id);
        } catch (error) {
          if (isTestDaytonaNotFound(error)) continue;
          throw error;
        }
        await daytona.delete(sandbox);
        await assertDaytonaSandboxGone(daytona, id);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Daytona smoke cleanup did not verify every sandbox gone');
    }
  });

  it(
    'launches a sandbox, runs node -e, and destroys it',
    { skip: HAS_DAYTONA ? false : 'DAYTONA_API_KEY is not set', timeout: 120_000 },
    async () => {
      assert.ok(runtime, 'runtime should be initialised when DAYTONA_API_KEY is set');
      handle = await runtime.launch({ label: SMOKE_LABEL });
      createdSandboxIds.add(handle.id);
      const result = await runtime.exec(handle, "node -e 'console.log(\"ok\")'");
      assert.equal(
        result.exitCode,
        0,
        `expected exitCode 0, got ${result.exitCode}: ${result.output}`,
      );
      assert.match(
        result.output,
        /\bok\b/,
        `expected output to contain "ok", got: ${result.output}`,
      );
    },
  );

  it(
    'must-fire: stop then start restores exec or replaces the unusable sandbox',
    { skip: HAS_DAYTONA ? false : 'DAYTONA_API_KEY is not set', timeout: 180_000 },
    async () => {
      assert.ok(runtime && handle, 'launch smoke must produce an owned handle');
      const originalId = handle.id;
      await runtime.stop(handle);
      assert.equal(handle.state, 'STOPPED');

      handle = await runtime.start(handle);
      createdSandboxIds.add(originalId);
      createdSandboxIds.add(handle.id);
      const result = await runtime.exec(handle, "node -e 'console.log(\"restarted-ok\")'");

      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /\brestarted-ok\b/u);
    },
  );
});

async function assertDaytonaSandboxGone(daytona: Daytona, id: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await daytona.get(id);
    } catch (error) {
      if (isTestDaytonaNotFound(error)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Daytona sandbox ${id} still exists after cleanup`);
}

function isTestDaytonaNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; statusCode?: unknown; name?: unknown };
  return candidate.status === 404
    || candidate.statusCode === 404
    || candidate.name === 'DaytonaNotFoundError';
}
