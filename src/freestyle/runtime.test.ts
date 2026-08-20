import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FreestyleRuntimeOptions } from "./config.js";
import type {
  FreestyleClientLike,
  FreestyleVmLike,
  FreestyleVmListItem,
} from "./internal/sdk.js";
import {
  buildFreestyleCommand,
  FreestyleCreateTimeoutError,
  FreestyleDestroyVerificationError,
  FreestyleLaunchEnvironmentUnsupportedError,
  FreestyleRuntime,
  FreestyleUnknownExitCodeError,
} from "./runtime.js";

const BASE_OPTIONS: FreestyleRuntimeOptions = {
  apiKey: "unit-test-key-never-sent",
  defaultHomeDir: "/root",
  namePrefix: "cmpfree-test",
  persistence: { type: "persistent" },
  pollIntervalMs: 1,
  lifecycleSettleTimeoutMs: 25,
  lookupTimeoutMs: 25,
  requestTimeoutMs: 25,
  createTimeoutMs: 25,
};

type Calls = {
  clientTimeouts: number[];
  create: unknown[];
  delete: string[];
  exec: unknown[];
  list: number;
  ref: string[];
  start: unknown[];
  stop: number;
  writeFile: Array<{ path: string; bytes: Buffer }>;
};

function mockRuntime(options: {
  config?: Partial<FreestyleRuntimeOptions>;
  create?: () => Promise<{ vm: FreestyleVmLike; vmId: string }>;
  exec?: (input: unknown) => Promise<{
    stdout?: string | null;
    stderr?: string | null;
    statusCode?: number | null;
  }>;
  states?: Array<FreestyleVmListItem[]>;
} = {}): {
  runtime: FreestyleRuntime;
  calls: Calls;
  vm: FreestyleVmLike;
} {
  const calls: Calls = {
    clientTimeouts: [],
    create: [],
    delete: [],
    exec: [],
    list: 0,
    ref: [],
    start: [],
    stop: 0,
    writeFile: [],
  };
  let stateIndex = 0;
  const states = options.states ?? [[{
    id: "vm_1",
    name: "cmpfree-test-one",
    state: "running",
    deleted: false,
  }]];
  const vm: FreestyleVmLike = {
    async start(input = {}) {
      calls.start.push(input);
    },
    async stop() {
      calls.stop += 1;
    },
    async exec(input) {
      calls.exec.push(input);
      return options.exec
        ? options.exec(input)
        : { stdout: "", stderr: "", statusCode: 0 };
    },
    fs: {
      async readFile() {
        return Buffer.from("downloaded", "utf8");
      },
      async writeFile(path, bytes) {
        calls.writeFile.push({ path, bytes: Buffer.from(bytes) });
      },
      async readTextFile() {
        return "downloaded";
      },
      async writeTextFile() {},
    },
  };
  const client: FreestyleClientLike = {
    vms: {
      async create(input) {
        calls.create.push(input);
        return options.create
          ? options.create()
          : { vm, vmId: "vm_1", domains: [] };
      },
      async list() {
        calls.list += 1;
        const page = states[Math.min(stateIndex, states.length - 1)] ?? [];
        stateIndex += 1;
        return { vms: page };
      },
      ref({ vmId }) {
        calls.ref.push(vmId);
        return vm;
      },
      async get() {
        throw new Error("vms.get must not be used as a state probe");
      },
      async delete({ vmId }) {
        calls.delete.push(vmId);
      },
    },
  };
  const runtime = new FreestyleRuntime(
    { ...BASE_OPTIONS, ...options.config },
    {
      clientFactory: (timeoutMs) => {
        calls.clientTimeouts.push(timeoutMs);
        return client;
      },
    },
  );
  return { runtime, calls, vm };
}

describe("FreestyleRuntime public contract", () => {
  it("constructs without SDK I/O and advertises only live-observed cleanup", () => {
    let factoryCalls = 0;
    const runtime = new FreestyleRuntime(BASE_OPTIONS, {
      clientFactory: () => {
        factoryCalls += 1;
        throw new Error("must not construct a client");
      },
    });

    assert.equal(factoryCalls, 0);
    assert.deepEqual(runtime.declaredCapabilities, {
      warmLease: false,
      lifecycle: false,
    });
    assert.deepEqual(runtime.capabilities, {
      pty: false,
      snapshots: false,
      isolation: "strong",
      persistentHandle: true,
      streamingLogs: false,
    });
    assert.equal(runtime.observedCapabilities.cleanupVerified, true);
    assert.equal(runtime.observedCapabilities.neverIdle, false);
  });

  it("rejects missing credential/config instead of consulting ambient state", () => {
    for (const patch of [
      { apiKey: "" },
      { defaultHomeDir: "" },
      { namePrefix: "" },
      { namePrefix: "not safe/name" },
    ]) {
      assert.throws(
        () => new FreestyleRuntime({ ...BASE_OPTIONS, ...patch }),
      );
    }
    assert.throws(
      () => new FreestyleRuntime({ ...BASE_OPTIONS, persistence: undefined as never }),
      /persistence policy is required/,
    );
  });

  it("real-SDK contract: pinned runtime exposes methods missing from its public declarations", async () => {
    const { Freestyle } = await import("freestyle");
    const client = new Freestyle({
      apiKey: "contract-only-not-sent",
      fetch: async () => {
        throw new Error("network must not be used by structural contract test");
      },
    });
    const vm = client.vms.ref({ vmId: "structural-only" }) as unknown as Record<string, unknown>;

    for (const method of ["start", "stop", "suspend", "getInfo", "fork", "snapshot", "exec"]) {
      assert.equal(typeof vm[method], "function", `${method} missing from runtime`);
    }
    assert.equal(typeof (vm.pty as Record<string, unknown>).open, "function");
  });
});

describe("FreestyleRuntime launch, lookup, and ownership", () => {
  it("launch forwards the explicit persistence/source/idle policy and caller deadline", async () => {
    const { runtime, calls } = mockRuntime({
      config: {
        snapshotId: "opaque-snapshot-id",
        idleTimeoutSeconds: null,
      },
    });
    const handle = await runtime.launch({
      name: "cmpfree-test-run-001",
      labels: { owner: "unit" },
      createTimeoutSeconds: 3,
      workdir: "/workspace",
    });

    assert.equal(handle.id, "vm_1");
    assert.equal(handle.workdir, "/workspace");
    assert.deepEqual(calls.create, [{
      name: "cmpfree-test-run-001",
      persistence: { type: "persistent" },
      snapshotId: "opaque-snapshot-id",
      idleTimeoutSeconds: null,
    }]);
    assert.equal(calls.clientTimeouts[0], 3_000);
  });

  it("prefixes foreign caller names with a collision-resistant digest", async () => {
    const { runtime, calls } = mockRuntime();
    await runtime.launch({ name: "user supplied name" });
    const name = (calls.create[0] as { name: string }).name;
    assert.match(name, /^cmpfree-test-user-supplied-name-[a-f0-9]{8}$/u);
  });

  it("rejects launch env before any SDK call instead of silently dropping it", async () => {
    const { runtime, calls } = mockRuntime();
    await assert.rejects(
      runtime.launch({ env: { SECRET: "not-actually-secret" } }),
      FreestyleLaunchEnvironmentUnsupportedError,
    );
    assert.equal(calls.create.length, 0);
  });

  it("turns a stalled create into a typed deadline and leaves no false registration", async () => {
    const { runtime } = mockRuntime({
      config: { createTimeoutMs: 5 },
      create: () => new Promise(() => {}),
    });
    await assert.rejects(runtime.launch(), FreestyleCreateTimeoutError);
    await runtime.destroy({ id: "vm_1" });
  });

  it("never turns name ownership into a fake server-side label lease", async () => {
    const { runtime, calls } = mockRuntime();
    assert.equal(await runtime.findByLabels({ owner: "unit" }), null);
    assert.deepEqual(await runtime.findAllByLabels({ owner: "unit" }), []);
    assert.equal(await runtime.countByLabels({ owner: "unit" }), 0);
    assert.equal(calls.list, 0);
  });

  it("lists only prefix-owned live VMs and consumes runtime-only name/sizing fields", async () => {
    const { runtime } = mockRuntime({
      states: [[
        {
          id: "owned",
          name: "cmpfree-test-run-a",
          state: "running",
          sizing: { vcpuCount: 4, memSizeMib: 8192, rootfsSizeMb: 20480 },
        },
        { id: "deleted", name: "cmpfree-test-old", state: "stopped", deleted: true },
        { id: "foreign", name: "somebody-else", state: "running" },
      ]],
    });

    assert.deepEqual(await runtime.listOwned(), [{
      id: "owned",
      name: "cmpfree-test-run-a",
      state: "STARTED",
      deleted: false,
      sizing: { vcpus: 4, memoryMiB: 8192, storageMiB: 20480 },
    }]);
    assert.deepEqual(await runtime.listOwned({ includeDeleted: true, states: null }), [
      {
        id: "owned",
        name: "cmpfree-test-run-a",
        state: "STARTED",
        deleted: false,
        sizing: { vcpus: 4, memoryMiB: 8192, storageMiB: 20480 },
      },
      {
        id: "deleted",
        name: "cmpfree-test-old",
        state: "STOPPED",
        deleted: true,
      },
    ]);
  });

  it("reattaches via the authoritative list, treats deleted:true as gone, and never calls vms.get", async () => {
    const { runtime, calls } = mockRuntime({
      states: [[{ id: "vm_1", name: "cmpfree-test-one", state: "suspended" }]],
    });
    const handle = await runtime.getById("vm_1", { states: ["STOPPED"], owned: true });
    assert.equal(handle?.state, "STOPPED");
    assert.equal(calls.list, 1);

    const { runtime: deletedRuntime } = mockRuntime({
      states: [[{ id: "vm_1", name: "cmpfree-test-one", state: "stopped", deleted: true }]],
    });
    assert.equal(await deletedRuntime.getById("vm_1"), null);
  });
});

describe("FreestyleRuntime exec and files", () => {
  it("passes cwd/env through quoted shell syntax and propagates command/request timeouts", async () => {
    const { runtime, calls } = mockRuntime({
      config: { requestTimeoutMs: 10 },
      exec: async () => ({ stdout: "out\n", stderr: "err\n", statusCode: 7 }),
    });
    const handle = await runtime.launch();
    const result = await runtime.runScript(handle, {
      command: "printf done",
      cwd: "/tmp/a b",
      env: { VALUE: "it's safe" },
      timeoutMs: 50,
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.output, "out\nerr\n");
    assert.deepEqual(calls.exec.at(-1), {
      command: "export VALUE='it'\\''s safe'\ncd '/tmp/a b' || exit $?\nprintf done",
      timeoutMs: 50,
    });
    assert.equal(calls.clientTimeouts.at(-1), 5_050);
  });

  it("rejects shell-unsafe env names before vm.exec", async () => {
    const { runtime, calls } = mockRuntime();
    const handle = await runtime.launch();
    await assert.rejects(
      runtime.runScript(handle, { command: "true", env: { "BAD-NAME": "x" } }),
      /Invalid Freestyle environment variable name/,
    );
    assert.equal(calls.exec.length, 0);
  });

  it("preserves missing statusCode as unknown and exec never fabricates zero", async () => {
    const { runtime } = mockRuntime({ exec: async () => ({ stdout: "maybe" }) });
    const handle = await runtime.launch();
    assert.equal((await runtime.runScript(handle, { command: "true" })).exitCode, null);
    await assert.rejects(runtime.exec(handle, "true"), FreestyleUnknownExitCodeError);
  });

  it("uploads exact bytes, creates the parent, verifies the bundle, and downloads bytes", async () => {
    let execIndex = 0;
    const { runtime, calls } = mockRuntime({
      exec: async () => {
        execIndex += 1;
        return { stdout: "", stderr: "", statusCode: 0 };
      },
    });
    const handle = await runtime.launch();
    await runtime.uploadBundle(handle, {
      files: [{ source: Buffer.from([0, 1, 2, 255]), destination: "/workspace/a.bin" }],
    });
    assert.equal(execIndex, 2);
    assert.equal(calls.writeFile[0]?.path, "/workspace/a.bin");
    assert.deepEqual([...calls.writeFile[0]!.bytes], [0, 1, 2, 255]);
    assert.equal((await runtime.downloadFile(handle, "/workspace/a.bin") as Buffer).toString(), "downloaded");
  });

  it("buildFreestyleCommand rejects unsafe names and quotes values/cwd", () => {
    assert.equal(
      buildFreestyleCommand("echo ok", { cwd: "/a b", env: { A: "x'y" } }),
      "export A='x'\\''y'\ncd '/a b' || exit $?\necho ok",
    );
    assert.throws(
      () => buildFreestyleCommand("true", { env: { "A;touch /tmp/pwn": "x" } }),
    );
  });
});

describe("FreestyleRuntime lifecycle and verified cleanup", () => {
  it("stop waits for the provider's accepted request to settle", async () => {
    const { runtime, calls } = mockRuntime({
      states: [
        [{ id: "vm_1", name: "cmpfree-test-one", state: "running" }],
        [{ id: "vm_1", name: "cmpfree-test-one", state: "stopping" }],
        [{ id: "vm_1", name: "cmpfree-test-one", state: "stopped" }],
      ],
    });
    const handle = await runtime.launch();
    await runtime.stop(handle);
    assert.equal(calls.stop, 1);
    assert.equal(handle.state, "STOPPED");
    assert.ok(calls.list >= 3);
  });

  it("start waits out a transitional stop and reapplies null idle timeout exactly", async () => {
    const { runtime, calls } = mockRuntime({
      config: { idleTimeoutSeconds: null },
      states: [
        [{ id: "vm_1", name: "cmpfree-test-one", state: "stopping" }],
        [{ id: "vm_1", name: "cmpfree-test-one", state: "stopping" }],
        [{ id: "vm_1", name: "cmpfree-test-one", state: "stopped" }],
        [{ id: "vm_1", name: "cmpfree-test-one", state: "stopped" }],
        [{ id: "vm_1", name: "cmpfree-test-one", state: "running" }],
      ],
    });
    const handle = await runtime.launch();
    await runtime.start(handle);
    assert.deepEqual(calls.start, [{ idleTimeoutSeconds: null }]);
    assert.equal(handle.state, "STARTED");
  });

  it("default-unowned attachments cannot start, stop, or delete a foreign VM", async () => {
    const { runtime, calls } = mockRuntime();
    const handle = await runtime.getById("vm_1");
    assert.ok(handle);
    await runtime.stop(handle!);
    await runtime.start(handle!);
    await runtime.destroy(handle!);
    assert.equal(calls.stop, 0);
    assert.equal(calls.start.length, 0);
    assert.equal(calls.delete.length, 0);
  });

  it("destroy accepts deleted:true as verified absence and drops ownership only afterward", async () => {
    const { runtime, calls } = mockRuntime({
      states: [[{ id: "vm_1", name: "cmpfree-test-one", state: "stopped", deleted: true }]],
    });
    const handle = await runtime.launch();
    await runtime.destroy(handle);
    await runtime.destroy(handle);
    assert.deepEqual(calls.delete, ["vm_1"]);
  });

  it("retains ownership when delete cannot be verified so cleanup can retry", async () => {
    const { runtime, calls } = mockRuntime({
      config: { lifecycleSettleTimeoutMs: 4, pollIntervalMs: 1 },
      states: [[{ id: "vm_1", name: "cmpfree-test-one", state: "stopped", deleted: false }]],
    });
    const handle = await runtime.launch();
    await assert.rejects(runtime.destroy(handle), FreestyleDestroyVerificationError);
    await assert.rejects(runtime.destroy(handle), FreestyleDestroyVerificationError);
    assert.deepEqual(calls.delete, ["vm_1", "vm_1"]);
  });
});
