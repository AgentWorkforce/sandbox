import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { resolveSandboxRuntimeCapabilities } from "../port.js";
import type {
  KernelBrowserView,
  KernelClientLike,
  KernelExecView,
} from "./internal/sdk.js";
import {
  KernelForeignBrowserError,
  KernelRuntime,
} from "./runtime.js";

class FakeKernelClient implements KernelClientLike {
  readonly browsers = new Map<string, KernelBrowserView>();
  readonly commands: Array<{
    id: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
  }> = [];
  readonly files = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  readonly listFilters: Record<string, string>[] = [];
  nextExec: KernelExecView = { stdout: "ok\n", stderr: "", exitCode: 0 };
  nextId = 1;

  async create(options: {
    name: string;
    tags: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<KernelBrowserView> {
    const browser = {
      id: `browser-${this.nextId++}`,
      name: options.name,
      state: "active",
      tags: { ...options.tags },
      createdAt: "2026-08-27T00:00:00.000Z",
      timeoutSeconds: options.timeoutSeconds,
    } satisfies KernelBrowserView;
    this.browsers.set(browser.id, browser);
    return browser;
  }

  async get(id: string): Promise<KernelBrowserView | null> {
    return this.browsers.get(id) ?? null;
  }

  async list(tags: Record<string, string>): Promise<KernelBrowserView[]> {
    this.listFilters.push({ ...tags });
    return [...this.browsers.values()].filter((browser) =>
      Object.entries(tags).every(([key, value]) => browser.tags[key] === value)
    );
  }

  async execute(
    id: string,
    options: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutSeconds?: number;
    },
  ): Promise<KernelExecView> {
    this.commands.push({ id, ...options });
    return { ...this.nextExec };
  }

  async upload(id: string, destination: string, content: Buffer): Promise<void> {
    this.files.set(`${id}:${destination}`, Buffer.from(content));
  }

  async download(id: string, source: string): Promise<Buffer> {
    return Buffer.from(this.files.get(`${id}:${source}`) ?? Buffer.alloc(0));
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
    this.browsers.delete(id);
  }
}

function fixture(client = new FakeKernelClient()): {
  client: FakeKernelClient;
  runtime: KernelRuntime;
} {
  return {
    client,
    runtime: new KernelRuntime({
      apiKey: "test-key",
      defaultHomeDir: "/home/kernel",
      ownerTag: "matrix-dev",
      namePrefix: "relay-matrix",
      timeoutSeconds: 3_600,
      pollIntervalMs: 1,
      destroyTimeoutMs: 10,
    }, {
      clientFactory: () => client,
      sleep: async () => {},
    }),
  };
}

test("launch persists ownership, labels, exact reap deadline, and environment", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({
    name: "Proof Cell",
    labels: { lane: "dev", "agent-relay-owner": "spoofed" },
    attributionTag: "proof:dev",
    ephemeralUntil: "2030-01-01T00:00:00.000Z",
    env: { TOKEN: "value with ' quote" },
  });
  const browser = client.browsers.get(handle.id)!;
  assert.match(browser.name!, /^relay-matrix-proof-cell-[a-f0-9]{10}$/u);
  assert.deepEqual(browser.tags, {
    lane: "dev",
    "agent-relay-owner": "matrix-dev",
    "_sandbox.attributionTag": "proof:dev",
    "_sandbox.ephemeralUntil": String(Date.parse("2030-01-01T00:00:00.000Z")),
  });
  assert.equal(browser.timeoutSeconds, 3_600);
  assert.equal(
    client.files.get(`${handle.id}:/home/kernel/.agent-relay-env`)?.toString("utf8"),
    "export TOKEN='value with '\"'\"' quote'\n",
  );
});

test("launch destroys the browser if environment persistence fails", async () => {
  const { client, runtime } = fixture();
  client.nextExec = { stdout: "", stderr: "mkdir failed", exitCode: 1 };
  await assert.rejects(runtime.launch({ env: { TOKEN: "value" } }), /persistence failed/u);
  assert.deepEqual(client.deleted, ["browser-1"]);
  assert.equal(await client.get("browser-1"), null);
});

test("reattach and server-side label lookup fail closed on ownership", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({ labels: { lane: "wanted" } });
  client.browsers.set("foreign", {
    id: "foreign",
    name: "relay-matrix-foreign",
    state: "active",
    tags: { lane: "wanted", "agent-relay-owner": "other" },
    createdAt: "2026-08-27T00:00:00.000Z",
    timeoutSeconds: 3_600,
  });
  assert.equal((await runtime.getById(handle.id))?.id, handle.id);
  assert.equal(await runtime.getById("foreign"), null);
  assert.deepEqual((await runtime.findAllByLabels({ lane: "wanted" })).map(({ id }) => id), [handle.id]);
  assert.deepEqual(client.listFilters, [{ lane: "wanted", "agent-relay-owner": "matrix-dev" }]);
});

test("runScript uses a shell, persistent launch env, cwd, overrides, and native deadline", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch({ workdir: "/workspace" });
  const result = await runtime.runScript(handle, {
    command: "npm test",
    env: { CI: "1" },
    timeoutMs: 1_001,
  });
  assert.deepEqual(client.commands, [{
    id: handle.id,
    command: "sh",
    args: ["-lc", "if [ -f '/home/kernel/.agent-relay-env' ]; then . '/home/kernel/.agent-relay-env'; fi\nexport CI='1'\nnpm test"],
    cwd: "/workspace",
    timeoutSeconds: 2,
  }]);
  assert.deepEqual(result, {
    output: "ok\n",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
  });
});

test("stdout and stderr stay separately available and combine deterministically", async () => {
  const { client, runtime } = fixture();
  const handle = await runtime.launch();
  client.nextExec = { stdout: "out", stderr: "err\n", exitCode: 7 };
  assert.deepEqual(await runtime.runScript(handle, { command: "fail" }), {
    output: "out\nerr\n",
    stdout: "out",
    stderr: "err\n",
    exitCode: 7,
  });
});

test("binary transfer uses the native browser filesystem", async () => {
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

test("mutating a foreign browser fails closed", async () => {
  const { client, runtime } = fixture();
  client.browsers.set("foreign", {
    id: "foreign",
    name: "foreign",
    state: "active",
    tags: {},
    createdAt: "2026-08-27T00:00:00.000Z",
    timeoutSeconds: 3_600,
  });
  await assert.rejects(runtime.destroy({ id: "foreign" }), KernelForeignBrowserError);
});

test("capabilities expose reattach without inventing durable async logs or lifecycle", () => {
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
      lifetime: "idle-timeout",
      interactive: "not-exposed",
      snapshots: "not-exposed",
    },
  });
});
