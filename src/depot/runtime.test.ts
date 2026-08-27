import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { resolveSandboxRuntimeCapabilities } from "../port.js";
import type {
  DepotClientLike,
  DepotCommandResult,
  DepotSandboxView,
} from "./internal/sdk.js";
import {
  DepotCommandTimeoutError,
  DepotForeignSandboxError,
  DepotRuntime,
} from "./runtime.js";

class FakeDepotClient implements DepotClientLike {
  readonly sandboxes = new Map<string, DepotSandboxView>();
  readonly commands: Array<{ id: string; command: string; cwd?: string; env?: Record<string, string> }> = [];
  readonly files = new Map<string, Buffer>();
  readonly killed: string[] = [];
  nextExecution: Promise<DepotCommandResult> = Promise.resolve({
    commandId: "cmd-1",
    output: "ok\n",
    exitCode: 0,
  });

  async create(options: { name: string; env: Record<string, string> }): Promise<DepotSandboxView> {
    const sandbox = {
      id: `sandbox-${this.sandboxes.size + 1}`,
      status: "running",
      name: options.name,
      env: { ...options.env },
      createdAt: "2026-08-27T00:00:00.000Z",
    } satisfies DepotSandboxView;
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async get(id: string): Promise<DepotSandboxView | null> {
    return this.sandboxes.get(id) ?? null;
  }

  async execute(
    id: string,
    command: string,
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<DepotCommandResult> {
    this.commands.push({ id, command, ...options });
    return await this.nextExecution;
  }

  async upload(id: string, destination: string, content: Buffer): Promise<void> {
    this.files.set(`${id}:${destination}`, Buffer.from(content));
  }

  async download(id: string, source: string): Promise<Buffer> {
    return Buffer.from(this.files.get(`${id}:${source}`) ?? Buffer.alloc(0));
  }

  async kill(id: string): Promise<DepotSandboxView> {
    this.killed.push(id);
    const updated = { ...this.sandboxes.get(id)!, status: "cancelled" };
    this.sandboxes.set(id, updated);
    return updated;
  }
}

function fixture(client = new FakeDepotClient()): {
  client: FakeDepotClient;
  runtime: DepotRuntime;
} {
  return {
    client,
    runtime: new DepotRuntime({
      token: "test-token",
      defaultHomeDir: "/root",
      ownerTag: "matrix-dev",
      namePrefix: "relay-matrix",
      pollIntervalMs: 1,
      destroyTimeoutMs: 10,
    }, {
      clientFactory: () => client,
      sleep: async () => {},
    }),
  };
}

test("launch creates an owned unique name and persists cleanup attribution in env", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({
    name: "Proof Cell",
    env: { USER_VALUE: "yes", AGENT_RELAY_SANDBOX_OWNER: "spoofed" },
    attributionTag: "proof:dev",
    ephemeralUntil: 1_900_000_000_000,
  });
  const sandbox = client.sandboxes.get(handle.id)!;
  assert.match(sandbox.name!, /^relay-matrix-proof-cell-[a-f0-9]{10}$/u);
  assert.deepEqual(sandbox.env, {
    USER_VALUE: "yes",
    AGENT_RELAY_SANDBOX_OWNER: "matrix-dev",
    AGENT_RELAY_SANDBOX_ATTRIBUTION: "proof:dev",
    AGENT_RELAY_SANDBOX_EPHEMERAL_UNTIL: "1900000000000",
  });
});

test("getById reattaches only to provider records owned by this runtime", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  client.sandboxes.set("foreign", {
    id: "foreign",
    status: "running",
    name: "relay-matrix-foreign-123",
    env: { AGENT_RELAY_SANDBOX_OWNER: "other" },
  });
  assert.equal((await runtime.getById(handle.id))?.id, handle.id);
  assert.equal(await runtime.getById("foreign"), null);
});

test("runScript uses provider cwd/env fields and preserves combined output", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({ workdir: "/workspace" });
  const result = await runtime.runScript(handle, {
    command: "npm test",
    env: { CI: "1" },
  });
  assert.deepEqual(client.commands, [{
    id: handle.id,
    command: "npm test",
    cwd: "/workspace",
    env: { CI: "1" },
  }]);
  assert.deepEqual(result, { output: "ok\n", exitCode: 0, cmdId: "cmd-1" });
});

test("a command timeout kills the whole task-scoped Sandbox", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  client.nextExecution = new Promise(() => {});
  await assert.rejects(
    runtime.runScript(handle, { command: "sleep 30", timeoutMs: 1 }),
    DepotCommandTimeoutError,
  );
  assert.deepEqual(client.killed, [handle.id]);
});

test("binary upload/download uses the provider filesystem", async () => {
  const { runtime } = fixture();
  const handle = await runtime.launch();
  const bytes = Buffer.from([0, 1, 255]);
  await runtime.uploadFile(handle, bytes, "/tmp/proof.bin");
  assert.deepEqual(await runtime.downloadFile(handle, "/tmp/proof.bin"), bytes);
});

test("destroy kills and verifies a terminal provider state", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  await runtime.destroy(handle);
  assert.deepEqual(client.killed, [handle.id]);
  assert.equal(client.sandboxes.get(handle.id)?.status, "cancelled");
});

test("mutating a foreign Sandbox fails closed", async () => {
  const { client, runtime } = fixture();
  client.sandboxes.set("foreign", {
    id: "foreign",
    status: "running",
    name: "not-ours",
    env: {},
  });
  await assert.rejects(runtime.destroy({ id: "foreign" }), DepotForeignSandboxError);
});

test("capabilities omit warm lease, restart lifecycle, and non-replayable detached exec", () => {
  const { runtime } = fixture();
  assert.equal("startScript" in runtime, false);
  assert.equal("start" in runtime, false);
  assert.equal("stop" in runtime, false);
  assert.deepEqual(resolveSandboxRuntimeCapabilities(runtime), {
    asyncExec: false,
    reattach: true,
    detachedLaunch: false,
    warmLease: false,
    lifecycle: false,
    modes: {
      outputStreams: "buffered",
      filesystem: "ephemeral",
      lifetime: "deadline",
      interactive: "not-exposed",
      snapshots: "not-exposed",
    },
  });
});
