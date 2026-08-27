import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { resolveSandboxRuntimeCapabilities } from "../port.js";
import type {
  RunloopClientLike,
  RunloopDevboxView,
  RunloopExecutionView,
} from "./internal/sdk.js";
import {
  RunloopCommandTimeoutError,
  RunloopForeignDevboxError,
  RunloopRuntime,
} from "./runtime.js";

class FakeRunloopClient implements RunloopClientLike {
  readonly devboxes = new Map<string, RunloopDevboxView>();
  readonly executions = new Map<string, RunloopExecutionView>();
  readonly uploaded = new Map<string, Buffer>();
  readonly commands: Array<{ id: string; command: string; shellName?: string }> = [];
  readonly killed: string[] = [];
  readonly lifecycle: string[] = [];
  nextExecution: RunloopExecutionView = {
    execution_id: "exec-1",
    status: "completed",
    exit_status: 0,
    stdout: "ok\n",
    stderr: "",
  };

  async create(options: {
    name?: string;
    environment_variables?: Record<string, string>;
    metadata: Record<string, string>;
  }): Promise<RunloopDevboxView> {
    const view = {
      id: `devbox-${this.devboxes.size + 1}`,
      status: "running",
      metadata: { ...options.metadata },
      create_time_ms: 1_700_000_000_000,
      name: options.name,
    } satisfies RunloopDevboxView;
    this.devboxes.set(view.id, view);
    return view;
  }

  async get(id: string): Promise<RunloopDevboxView | null> {
    return this.devboxes.get(id) ?? null;
  }

  async list(): Promise<RunloopDevboxView[]> {
    return [...this.devboxes.values()];
  }

  async executeAsync(id: string, command: string, shellName?: string): Promise<RunloopExecutionView> {
    this.commands.push({ id, command, ...(shellName ? { shellName } : {}) });
    const execution = { ...this.nextExecution };
    this.executions.set(execution.execution_id, execution);
    return execution;
  }

  async getExecution(_id: string, executionId: string): Promise<RunloopExecutionView> {
    return this.executions.get(executionId) ?? this.nextExecution;
  }

  async killExecution(_id: string, executionId: string): Promise<void> {
    this.killed.push(executionId);
  }

  async upload(id: string, destination: string, content: Buffer): Promise<void> {
    this.uploaded.set(`${id}:${destination}`, Buffer.from(content));
  }

  async download(id: string, source: string): Promise<Buffer> {
    return Buffer.from(this.uploaded.get(`${id}:${source}`) ?? Buffer.alloc(0));
  }

  async suspend(id: string): Promise<RunloopDevboxView> {
    this.lifecycle.push(`suspend:${id}`);
    return this.updateState(id, "suspended");
  }

  async resume(id: string): Promise<RunloopDevboxView> {
    this.lifecycle.push(`resume:${id}`);
    return this.updateState(id, "running");
  }

  async shutdown(id: string): Promise<void> {
    this.lifecycle.push(`shutdown:${id}`);
    this.updateState(id, "shutdown");
  }

  private updateState(id: string, status: string): RunloopDevboxView {
    const current = this.devboxes.get(id)!;
    const updated = { ...current, status };
    this.devboxes.set(id, updated);
    return updated;
  }
}

function fixture(client = new FakeRunloopClient()): {
  client: FakeRunloopClient;
  runtime: RunloopRuntime;
} {
  return {
    client,
    runtime: new RunloopRuntime({
      apiKey: "test-key",
      defaultHomeDir: "/home/runloop",
      ownerTag: "test-owner",
      pollIntervalMs: 1,
    }, {
      clientFactory: () => client,
      sleep: async () => {},
    }),
  };
}

test("launch persists caller labels, reap metadata, and reserved ownership", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({
    name: "proof",
    labels: { lane: "matrix", "agent-relay-owner": "spoofed" },
    attributionTag: "proof:dev",
    ephemeralUntil: "2030-01-01T00:00:00.000Z",
  });

  assert.equal(handle.id, "devbox-1");
  assert.deepEqual(client.devboxes.get(handle.id)?.metadata, {
    lane: "matrix",
    "agent-relay-owner": "test-owner",
    "_sandbox.attributionTag": "proof:dev",
    "_sandbox.ephemeralUntil": String(Date.parse("2030-01-01T00:00:00.000Z")),
  });
});

test("label lookup is provider-backed and scoped to the configured owner", async () => {
  const { client, runtime } = fixture();
  await runtime.launch({ labels: { lane: "wanted" } });
  client.devboxes.set("foreign", {
    id: "foreign",
    status: "running",
    metadata: { lane: "wanted", "agent-relay-owner": "someone-else" },
  });

  assert.deepEqual((await runtime.findAllByLabels({ lane: "wanted" })).map(({ id }) => id), [
    "devbox-1",
  ]);
  assert.equal(await runtime.countByLabels({ lane: "wanted" }), 1);
});

test("runScript composes cwd and env safely and returns truncation", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  client.nextExecution = {
    execution_id: "exec-quoted",
    status: "completed",
    exit_status: 7,
    stdout: "out",
    stderr: "err",
    stderr_truncated: true,
  };

  const result = await runtime.runScript(handle, {
    command: "node task.js",
    cwd: "/tmp/a'b",
    env: { VALUE: "x'y" },
    sessionId: "proof/session",
  });

  assert.deepEqual(client.commands[0], {
    id: handle.id,
    command: "cd '/tmp/a'\"'\"'b' && export VALUE='x'\"'\"'y' && node task.js",
    shellName: "proof-session",
  });
  assert.deepEqual(result, {
    output: "out\nerr",
    stdout: "out",
    stderr: "err",
    exitCode: 7,
    truncated: true,
  });
});

test("runScript falls back to the handle workdir", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({ workdir: "/workspace" });
  await runtime.runScript(handle, { command: "pwd" });
  assert.equal(client.commands[0]?.command, "cd '/workspace' && pwd");
});

test("a command deadline kills the provider execution before rejecting", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  client.nextExecution = { execution_id: "exec-slow", status: "running" };

  await assert.rejects(
    runtime.runScript(handle, { command: "sleep 30", timeoutMs: 1 }),
    RunloopCommandTimeoutError,
  );
  assert.deepEqual(client.killed, ["exec-slow"]);
});

test("binary transfer and real suspend/resume/shutdown lifecycle are wired", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  await runtime.uploadFile(handle, Buffer.from([0, 1, 255]), "/tmp/blob");
  assert.deepEqual(await runtime.downloadFile(handle, "/tmp/blob"), Buffer.from([0, 1, 255]));

  await runtime.stop(handle);
  assert.equal((await runtime.start(handle)).state, "running");
  await runtime.destroy(handle);
  assert.deepEqual(client.lifecycle, [
    `suspend:${handle.id}`,
    `resume:${handle.id}`,
    `shutdown:${handle.id}`,
  ]);
});

test("mutating a foreign Devbox fails closed", async () => {
  const { client, runtime } = fixture();
  client.devboxes.set("foreign", {
    id: "foreign",
    status: "running",
    metadata: { "agent-relay-owner": "someone-else" },
  });
  await assert.rejects(runtime.destroy({ id: "foreign" }), RunloopForeignDevboxError);
});

test("capabilities reflect native async execution, reattach, warm lease, and lifecycle", () => {
  const { runtime } = fixture();
  assert.deepEqual(resolveSandboxRuntimeCapabilities(runtime), {
    asyncExec: true,
    reattach: true,
    detachedLaunch: false,
    warmLease: true,
    lifecycle: true,
    modes: {
      outputStreams: "buffered",
      filesystem: "persistent",
      lifetime: "unknown",
      interactive: "not-exposed",
      snapshots: "not-exposed",
    },
  });
});
