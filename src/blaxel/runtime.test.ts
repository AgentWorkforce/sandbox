import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { resolveSandboxRuntimeCapabilities } from "../port.js";
import type {
  BlaxelClientLike,
  BlaxelProcessView,
  BlaxelSandboxView,
} from "./internal/sdk.js";
import {
  BlaxelForeignSandboxError,
  BlaxelRuntime,
} from "./runtime.js";

class FakeBlaxelClient implements BlaxelClientLike {
  readonly sandboxes = new Map<string, BlaxelSandboxView>();
  readonly processes = new Map<string, BlaxelProcessView>();
  readonly commands: Array<{
    id: string;
    command: string;
    name?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    waitForCompletion: boolean;
  }> = [];
  readonly files = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  nextProcess: BlaxelProcessView = {
    id: "process-1",
    status: "completed",
    exitCode: 0,
    output: "ok\n",
    stdout: "ok\n",
    stderr: "",
  };

  async create(options: { name: string; labels: Record<string, string> }): Promise<BlaxelSandboxView> {
    const sandbox = {
      id: options.name,
      state: "DEPLOYED",
      labels: { ...options.labels },
      createdAt: "2026-08-27T00:00:00.000Z",
    } satisfies BlaxelSandboxView;
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async get(id: string): Promise<BlaxelSandboxView | null> {
    return this.sandboxes.get(id) ?? null;
  }

  async list(): Promise<BlaxelSandboxView[]> {
    return [...this.sandboxes.values()];
  }

  async execute(
    id: string,
    options: {
      command: string;
      name?: string;
      cwd?: string;
      env?: Record<string, string>;
      timeoutSeconds?: number;
      waitForCompletion: boolean;
    },
  ): Promise<BlaxelProcessView> {
    this.commands.push({ id, ...options });
    const process = { ...this.nextProcess };
    this.processes.set(process.id, process);
    return process;
  }

  async getProcess(_id: string, processId: string): Promise<BlaxelProcessView> {
    return this.processes.get(processId) ?? this.nextProcess;
  }

  async getProcessLogs(_id: string, processId: string): Promise<string> {
    return (this.processes.get(processId) ?? this.nextProcess).output;
  }

  async killProcess(_id: string, processId: string): Promise<void> {
    const process = this.processes.get(processId)!;
    this.processes.set(processId, { ...process, status: "killed", exitCode: 137 });
  }

  async upload(id: string, destination: string, content: Buffer): Promise<void> {
    this.files.set(`${id}:${destination}`, Buffer.from(content));
  }

  async download(id: string, source: string): Promise<Buffer> {
    return Buffer.from(this.files.get(`${id}:${source}`) ?? Buffer.alloc(0));
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
    this.sandboxes.delete(id);
  }
}

function fixture(client = new FakeBlaxelClient()): {
  client: FakeBlaxelClient;
  runtime: BlaxelRuntime;
} {
  return {
    client,
    runtime: new BlaxelRuntime({
      apiKey: "test-key",
      workspace: "test-workspace",
      defaultHomeDir: "/root",
      ownerTag: "matrix-dev",
      namePrefix: "relay-matrix",
      maxAge: "2h",
      pollIntervalMs: 1,
      destroyTimeoutMs: 10,
    }, {
      clientFactory: () => client,
      sleep: async () => {},
    }),
  };
}

test("launch persists ownership, labels, and exact reap deadline", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({
    name: "Proof Cell",
    labels: { lane: "dev", "agent-relay-owner": "spoofed" },
    attributionTag: "proof:dev",
    ephemeralUntil: "2030-01-01T00:00:00.000Z",
  });
  assert.match(handle.id, /^relay-matrix-proof-cell-[a-f0-9]{10}$/u);
  assert.deepEqual(client.sandboxes.get(handle.id)?.labels, {
    lane: "dev",
    "agent-relay-owner": "matrix-dev",
    "_sandbox.attributionTag": "proof:dev",
    "_sandbox.ephemeralUntil": String(Date.parse("2030-01-01T00:00:00.000Z")),
  });
});

test("reattach and local label lookup fail closed on ownership", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({ labels: { lane: "wanted" } });
  client.sandboxes.set("foreign", {
    id: "foreign",
    state: "DEPLOYED",
    labels: { lane: "wanted", "agent-relay-owner": "other" },
  });
  assert.equal((await runtime.getById(handle.id))?.id, handle.id);
  assert.equal(await runtime.getById("foreign"), null);
  assert.deepEqual((await runtime.findAllByLabels({ lane: "wanted" })).map(({ id }) => id), [handle.id]);
});

test("runScript uses native cwd/env/deadline and returns provider streams", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({ workdir: "/workspace" });
  const result = await runtime.runScript(handle, {
    command: "npm test",
    env: { CI: "1" },
    timeoutMs: 1_001,
  });
  assert.deepEqual(client.commands, [{
    id: handle.id,
    command: "npm test",
    cwd: "/workspace",
    env: { CI: "1" },
    timeoutSeconds: 2,
    waitForCompletion: true,
  }]);
  assert.deepEqual(result, {
    output: "ok\n",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    cmdId: "process-1",
  });
});

test("native async process IDs support submit, status, and logs after reattach", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  client.nextProcess = { id: "process-async", status: "running", output: "partial" };
  const started = await runtime.startScript(handle, {
    command: "node worker.js",
    sessionId: "proof/session",
  });
  assert.deepEqual(started, { sessionId: "proof-session", commandId: "process-async" });
  assert.deepEqual(await runtime.getScriptStatus(handle, started.sessionId, started.commandId), {
    exitCode: null,
  });
  assert.deepEqual(await runtime.getScriptLogs(handle, started.sessionId, started.commandId), {
    output: "partial",
    exitCode: null,
    cmdId: "process-async",
  });

  client.processes.set("process-async", {
    id: "process-async",
    status: "completed",
    exitCode: 0,
    output: "done",
  });
  assert.deepEqual(await runtime.getScriptStatus(handle, started.sessionId, started.commandId), {
    exitCode: 0,
  });
});

test("binary transfer uses the native filesystem", async () => {
  const { runtime } = fixture();
  const handle = await runtime.launch();
  const bytes = Buffer.from([0, 1, 255]);
  await runtime.uploadFile(handle, bytes, "/tmp/proof.bin");
  assert.deepEqual(await runtime.downloadFile(handle, "/tmp/proof.bin"), bytes);
});

test("destroy deletes and verifies provider absence", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  await runtime.destroy(handle);
  assert.deepEqual(client.deleted, [handle.id]);
  assert.equal(await client.get(handle.id), null);
});

test("mutating a foreign Sandbox fails closed", async () => {
  const { client, runtime } = fixture();
  client.sandboxes.set("foreign", { id: "foreign", state: "DEPLOYED", labels: {} });
  await assert.rejects(runtime.destroy({ id: "foreign" }), BlaxelForeignSandboxError);
});

test("capabilities expose native async exec and reattach without inventing lifecycle", () => {
  const { runtime } = fixture();
  assert.equal("start" in runtime, false);
  assert.equal("stop" in runtime, false);
  assert.deepEqual(resolveSandboxRuntimeCapabilities(runtime), {
    asyncExec: true,
    reattach: true,
    detachedLaunch: false,
    warmLease: false,
    lifecycle: false,
    modes: {
      outputStreams: "buffered",
      filesystem: "persistent",
      lifetime: "deadline",
      interactive: "not-exposed",
      snapshots: "not-exposed",
    },
  });
});
