import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSandboxRuntimeCapabilities } from "../port.js";
import type { BoxdRuntimeOptions } from "./config.js";
import type {
  BoxdClientLike,
  BoxdCreateParams,
  BoxdExecResultLike,
  BoxdMachineLike,
} from "./internal/sdk.js";
import {
  BoxdCommandTimeoutError,
  BoxdCreateTimeoutError,
  BoxdDestroyVerificationError,
  BoxdLabelCollisionError,
  BoxdMachineStoppedError,
  BoxdRuntime,
  BoxdUnknownExitCodeError,
  buildBoxdCommand,
  normalizeBoxdState,
} from "./runtime.js";

const BASE_OPTIONS: BoxdRuntimeOptions = {
  apiKey: "unit-test-key-never-sent",
  namePrefix: "relay-test",
  org: "test-org",
  region: "fra",
  pollIntervalMs: 1,
  lifecycleSettleTimeoutMs: 50,
  lookupTimeoutMs: 50,
  requestTimeoutMs: 50,
  createTimeoutMs: 200,
};

type ExecCall = {
  id: string;
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
};

class NamedError extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

class FakeBoxd {
  readonly machines = new Map<string, BoxdMachineLike>();
  readonly creates: BoxdCreateParams[] = [];
  readonly execs: ExecCall[] = [];
  readonly deletes: string[] = [];
  readonly starts: string[] = [];
  readonly stops: string[] = [];
  readonly lists: Array<{ org?: string; labels?: Record<string, string> }> = [];
  readonly writes: Array<{ id: string; path: string; bytes: Buffer }> = [];
  readonly hibernateTimeouts: Array<[string, number]> = [];
  readonly files = new Map<string, Buffer>();
  closed = 0;
  next = 1;
  createImpl?: (params: BoxdCreateParams) => Promise<BoxdMachineLike>;
  execImpl?: (call: ExecCall) => Promise<BoxdExecResultLike>;
  deleteKeepsMachine = false;

  add(machine: Partial<BoxdMachineLike> & { id: string }): BoxdMachineLike {
    const full: BoxdMachineLike = {
      name: machine.id,
      status: "running",
      labels: {},
      createdAt: new Date("2026-11-11T00:00:00Z"),
      ...machine,
    };
    this.machines.set(full.id, full);
    return full;
  }

  client(): BoxdClientLike {
    const fake = this;
    return {
      machines: {
        async create(params) {
          fake.creates.push(params);
          if (fake.createImpl) return fake.createImpl(params);
          const id = `m-${fake.next++}`;
          return fake.add({ id, name: params.name, status: "starting", labels: { ...params.labels } });
        },
        async get(id) {
          const machine = fake.machines.get(id);
          if (!machine) throw new NamedError("NotFoundError", `VM not found`);
          if (machine.status === "starting") machine.status = "running";
          return { ...machine };
        },
        async list(params) {
          fake.lists.push(params);
          return [...fake.machines.values()]
            .filter((machine) =>
              Object.entries(params.labels ?? {}).every(([k, v]) => machine.labels?.[k] === v)
            )
            .map((machine) => ({ ...machine }));
        },
        async delete(id) {
          fake.deletes.push(id);
          if (!fake.machines.has(id)) throw new NamedError("NotFoundError");
          if (!fake.deleteKeepsMachine) fake.machines.delete(id);
        },
        async start(id) {
          fake.starts.push(id);
          fake.machines.get(id)!.status = "starting";
        },
        async stop(id) {
          fake.stops.push(id);
          fake.machines.get(id)!.status = "stopped";
        },
        async setAutoHibernateTimeout(id, seconds) {
          fake.hibernateTimeouts.push([id, seconds]);
        },
        async waitUntilReady(id) {
          return { ...fake.machines.get(id)! };
        },
        async exec(id, params) {
          const call: ExecCall = { id, ...params };
          fake.execs.push(call);
          const machine = fake.machines.get(id);
          if (!machine) throw new NamedError("NotFoundError");
          if (machine.status === "stopped") throw new NamedError("ConflictError", "VM is stopped");
          if (fake.execImpl) return fake.execImpl(call);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        fs: {
          async read(id, path) {
            const bytes = fake.files.get(`${id}:${path}`);
            if (!bytes) throw new NamedError("MachineFileNotFoundError", `${path}: No such file`);
            return new Uint8Array(bytes);
          },
          async write(id, path, data) {
            const bytes = Buffer.from(data);
            fake.writes.push({ id, path, bytes });
            fake.files.set(`${id}:${path}`, bytes);
            return {};
          },
        },
      },
      async close() {
        fake.closed += 1;
      },
    };
  }
}

function runtimeWith(
  fake: FakeBoxd,
  options: Partial<BoxdRuntimeOptions> = {},
): BoxdRuntime {
  return new BoxdRuntime(
    { ...BASE_OPTIONS, ...options },
    { clientFactory: () => fake.client(), sleep: async () => {} },
  );
}

/** Exec calls the caller made, without the readiness probes. */
function userExecs(fake: FakeBoxd): ExecCall[] {
  return fake.execs.filter((call) =>
    call.command.join(" ") !== "true" && call.command[0] !== "mkdir"
  );
}

describe("BoxdRuntime construction", () => {
  it("requires an explicit API key and never reads ambient credentials", () => {
    const previous = process.env.BOXD_API_KEY;
    process.env.BOXD_API_KEY = "ambient-should-be-ignored";
    try {
      assert.throws(
        () => new BoxdRuntime({ ...BASE_OPTIONS, apiKey: "" }),
        /boxd API key is required/,
      );
    } finally {
      if (previous === undefined) delete process.env.BOXD_API_KEY;
      else process.env.BOXD_API_KEY = previous;
    }
  });

  it("validates the name prefix, size and owner label key", () => {
    assert.throws(() => new BoxdRuntime({ ...BASE_OPTIONS, namePrefix: "Bad_Prefix" }), /name prefix/);
    assert.throws(
      () => new BoxdRuntime({
        ...BASE_OPTIONS,
        size: { vcpu: 3, memory: "12G" } as unknown as BoxdRuntimeOptions["size"],
      }),
      /size must be one of/,
    );
    assert.throws(() => new BoxdRuntime({ ...BASE_OPTIONS, ownerLabelKey: "bad key" }), /invalid/);
    assert.throws(() => new BoxdRuntime({ ...BASE_OPTIONS, autoSuspendTimeoutSeconds: -1 }), /non-negative/);
    assert.throws(() => new BoxdRuntime({ ...BASE_OPTIONS, deleteAfterSeconds: 0 }), /positive/);
    assert.throws(
      () => new BoxdRuntime({ ...BASE_OPTIONS, fromSnapshot: "s", size: { vcpu: 2, memory: "8G" } }),
      /snapshot's size/,
    );
    for (const key of ["Upper", "trailing-", "boxd/reserved", "a".repeat(64)]) {
      assert.throws(() => new BoxdRuntime({ ...BASE_OPTIONS, ownerLabelKey: key }), /invalid/, key);
    }
  });

  it("declares warm lease, lifecycle and reattach, and no async exec", () => {
    const capabilities = resolveSandboxRuntimeCapabilities(new BoxdRuntime(BASE_OPTIONS));
    assert.equal(capabilities.warmLease, true);
    assert.equal(capabilities.lifecycle, true);
    assert.equal(capabilities.reattach, true);
    assert.equal(capabilities.asyncExec, false);
    assert.equal(capabilities.detachedLaunch, false);
    assert.deepEqual(capabilities.modes, {
      outputStreams: "buffered",
      filesystem: "persistent",
      lifetime: "never-idle",
      interactive: "not-exposed",
      snapshots: "not-exposed",
    });
  });

  it("reports a deadline lifetime when a wall-clock delete timer is configured", () => {
    const runtime = new BoxdRuntime({ ...BASE_OPTIONS, deleteAfterSeconds: 3_600 });
    assert.equal(resolveSandboxRuntimeCapabilities(runtime).modes.lifetime, "deadline");
  });

  it("keeps workflow capabilities to what the port reaches", () => {
    const runtime = new BoxdRuntime(BASE_OPTIONS);
    assert.deepEqual(runtime.capabilities, {
      pty: false,
      snapshots: false,
      isolation: "strong",
      persistentHandle: true,
      streamingLogs: false,
    });
  });
});

describe("BoxdRuntime.launch", () => {
  it("creates an isolated, labelled machine in the configured org and region", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake, { size: { vcpu: 2, memory: "8G" } });
    const handle = await runtime.launch({ labels: { lane: "a" } });

    assert.equal(handle.id, "m-1");
    assert.equal(handle.state, "STARTED");
    assert.equal(handle.homeDir, "/home/boxd");
    const [params] = fake.creates;
    assert.ok(params);
    assert.match(params.name, /^relay-test-[0-9a-f]{12}$/);
    assert.equal(params.org, "test-org");
    assert.equal(params.region, "fra");
    assert.equal(params.isolated, true);
    assert.deepEqual(params.labels, { lane: "a", "agent-relay-sandbox": "relay-test" });
    assert.deepEqual(params.config, { vcpu: 2, memory: "8G", autoSuspendTimeout: 0 });
    // Ready means a command ran, not only that the status said running.
    assert.deepEqual(fake.execs.map((call) => call.command), [["true"]]);
  });

  it("creates the launch workdir after the machine answers", async () => {
    const fake = new FakeBoxd();
    const handle = await runtimeWith(fake).launch({ workdir: "proj" });
    assert.equal(handle.workdir, "/home/boxd/proj");
    assert.deepEqual(fake.execs.map((call) => call.command), [
      ["true"],
      ["mkdir", "-p", "/home/boxd/proj"],
    ]);
  });

  it("deletes the machine when the workdir cannot be created", async () => {
    const fake = new FakeBoxd();
    fake.execImpl = async (call) => call.command[0] === "mkdir"
      ? { stdout: "", stderr: "mkdir: Permission denied\n", exitCode: 1 }
      : { stdout: "", stderr: "", exitCode: 0 };
    await assert.rejects(
      runtimeWith(fake).launch({ workdir: "/workspace" }),
      { name: "BoxdWorkdirError" },
    );
    assert.deepEqual(fake.deletes, ["m-1"]);
  });

  it("sets auto-hibernate only when configured, and sends deleteAfter on create", async () => {
    const fake = new FakeBoxd();
    await runtimeWith(fake).launch();
    await runtimeWith(fake, { autoHibernateTimeoutSeconds: 0, deleteAfterSeconds: 7_200 }).launch();
    assert.deepEqual(fake.hibernateTimeouts, [["m-2", 0]]);
    assert.equal(fake.creates[0]!.deleteAfter, undefined);
    assert.equal(fake.creates[1]!.deleteAfter, 7_200);
  });

  it("isolation stays on unless the caller turns it off", async () => {
    const fake = new FakeBoxd();
    await runtimeWith(fake).launch();
    await runtimeWith(fake, { isolated: false }).launch();
    assert.deepEqual(fake.creates.map((params) => params.isolated), [true, false]);
  });

  it("turns caller names into owned, valid machine names", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    await runtime.launch({ name: "Fleet Sandbox #1" });
    await runtime.launch({ name: "relay-test-exact" });
    await runtime.launch({ name: "x".repeat(200) });
    await runtime.launch({ name: `relay-test-${"y".repeat(80)}` });
    await runtime.launch({ name: "relay-test-trailing-" });
    assert.match(fake.creates[0]!.name, /^relay-test-fleet-sandbox-1-[0-9a-f]{8}$/);
    assert.equal(fake.creates[1]!.name, "relay-test-exact");
    for (const params of fake.creates.slice(2)) {
      assert.ok(params.name.length <= 63, params.name);
      assert.match(params.name, /^relay-test-[a-z0-9-]*[a-z0-9]$/);
    }
  });

  it("sets launch env on the machine and sends it with every command", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch({ env: { TOKEN: "a b", MODE: "x" } });
    await runtime.exec(handle, "echo", { env: { MODE: "y" } });

    assert.deepEqual(fake.creates[0]!.env, { TOKEN: "a b", MODE: "x" });
    assert.deepEqual(userExecs(fake)[0]!.env, { TOKEN: "a b", MODE: "y" });
  });

  it("restores from a snapshot and still sends launch env with every command", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake, { fromSnapshot: "relay-base" });
    const handle = await runtime.launch({ env: { TOKEN: "t" } });
    await runtime.exec(handle, "echo");

    assert.equal(fake.creates[0]!.fromSnapshot, "relay-base");
    assert.equal(fake.creates[0]!.env, undefined);
    assert.deepEqual(userExecs(fake)[0]!.env, { TOKEN: "t" });
  });

  it("refuses a caller label that would overwrite ownership", async () => {
    const fake = new FakeBoxd();
    await assert.rejects(
      runtimeWith(fake).launch({ labels: { "agent-relay-sandbox": "someone-else" } }),
      BoxdLabelCollisionError,
    );
    assert.equal(fake.creates.length, 0);
  });

  it("rejects invalid env names before creating anything", async () => {
    const fake = new FakeBoxd();
    await assert.rejects(runtimeWith(fake).launch({ env: { "BAD-NAME": "x" } }), /Invalid boxd environment/);
    assert.equal(fake.creates.length, 0);
  });

  it("deletes the machine when it never becomes ready", async () => {
    const fake = new FakeBoxd();
    fake.createImpl = async (params) => {
      // "pending" never advances in the fake, so readiness can only time out.
      return fake.add({ id: "m-stuck", name: params.name, status: "pending", labels: params.labels });
    };
    const runtime = runtimeWith(fake, { createTimeoutMs: 30 });
    await assert.rejects(runtime.launch(), (error: Error & { sandboxId?: string }) => {
      assert.equal(error.sandboxId, "m-stuck");
      return true;
    });
    assert.deepEqual(fake.deletes, ["m-stuck"]);
  });

  it("keeps probing readiness until the deadline, not a fixed number of tries", async () => {
    const fake = new FakeBoxd();
    let probes = 0;
    fake.execImpl = async () => {
      probes += 1;
      if (probes < 25) throw new NamedError("APIStatusError", "agent not ready");
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const handle = await runtimeWith(fake).launch();
    assert.equal(handle.state, "STARTED");
    assert.equal(probes, 25);
  });

  it("finds and deletes a generated-name machine when create fails without an answer", async () => {
    const fake = new FakeBoxd();
    fake.createImpl = async (params) => {
      fake.add({ id: "m-made", name: params.name, labels: params.labels });
      throw new NamedError("APIStatusError", "upstream reset");
    };
    const runtime = runtimeWith(fake);
    await assert.rejects(runtime.launch(), { name: "APIStatusError" });
    await runtime.close();
    assert.deepEqual(fake.deletes, ["m-made"]);
  });

  it("never deletes by name after a conflict or for a caller-chosen name", async () => {
    const fake = new FakeBoxd();
    fake.add({ id: "existing", name: "relay-test-taken", labels: { "agent-relay-sandbox": "relay-test" } });
    fake.createImpl = async () => {
      throw new NamedError("ConflictError", "name taken");
    };
    const runtime = runtimeWith(fake);
    await assert.rejects(runtime.launch({ name: "relay-test-taken" }), { name: "ConflictError" });
    fake.createImpl = async () => {
      throw new NamedError("APIStatusError", "upstream reset");
    };
    await assert.rejects(runtime.launch({ name: "relay-test-taken" }), { name: "APIStatusError" });
    await runtime.close();
    assert.deepEqual(fake.deletes, []);
  });

  it("deletes a machine whose create finishes after the deadline", async () => {
    const fake = new FakeBoxd();
    let finish!: () => void;
    fake.createImpl = (params) => new Promise((resolve) => {
      finish = () => resolve(fake.add({ id: "m-late", name: params.name, labels: params.labels }));
    });
    const runtime = runtimeWith(fake, { createTimeoutMs: 5 });
    await assert.rejects(runtime.launch(), BoxdCreateTimeoutError);
    finish();
    await runtime.close();
    assert.deepEqual(fake.deletes, ["m-late"]);
    assert.equal(fake.machines.has("m-late"), false);
  });
});

describe("BoxdRuntime commands", () => {
  async function launched(fake: FakeBoxd, options: Partial<BoxdRuntimeOptions> = {}) {
    const runtime = runtimeWith(fake, options);
    const handle = await runtime.launch({ workdir: "/home/boxd/work" });
    return { runtime, handle };
  }

  it("runs the command in a login bash with the handle's workdir", async () => {
    const fake = new FakeBoxd();
    const { runtime, handle } = await launched(fake);
    fake.execImpl = async () => ({ stdout: "out\n", stderr: "err\n", exitCode: 3 });
    const result = await runtime.runScript(handle, { command: "make test" });

    const [call] = userExecs(fake);
    assert.deepEqual(call!.command, ["bash", "-lc", "make test"]);
    assert.equal(call!.cwd, "/home/boxd/work");
    assert.equal(call!.timeout, undefined);
    assert.deepEqual(result, { output: "out\nerr\n", stdout: "out\n", stderr: "err\n", exitCode: 3 });
  });

  it("ends a command at its timeout inside the machine and reports it", async () => {
    const fake = new FakeBoxd();
    const { runtime, handle } = await launched(fake);
    fake.execImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { stdout: "partial", stderr: "", exitCode: 124 };
    };
    await assert.rejects(
      runtime.runScript(handle, { command: "sleep 100", timeoutMs: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof BoxdCommandTimeoutError);
        assert.equal(error.stdout, "partial");
        return true;
      },
    );
    const call = userExecs(fake)[0]!;
    assert.deepEqual(call.command, ["timeout", "-k", "5s", "1s", "bash", "-lc", "sleep 100"]);
    assert.ok(call.timeout! > 10);
  });

  it("reports a command killed after ignoring the timeout signal as a timeout", async () => {
    const fake = new FakeBoxd();
    const { runtime, handle } = await launched(fake);
    fake.execImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { stdout: "", stderr: "", exitCode: 137 };
    };
    await assert.rejects(
      runtime.runScript(handle, { command: "trap '' TERM; sleep 100", timeoutMs: 10 }),
      BoxdCommandTimeoutError,
    );
  });

  it("keeps a fast exit code 124 as the command's own result", async () => {
    const fake = new FakeBoxd();
    const { runtime, handle } = await launched(fake);
    fake.execImpl = async () => ({ stdout: "", stderr: "", exitCode: 124 });
    const result = await runtime.runScript(handle, { command: "exit 124", timeoutMs: 60_000 });
    assert.equal(result.exitCode, 124);
  });

  it("refuses to treat a missing exit code as success", async () => {
    const fake = new FakeBoxd();
    const { runtime, handle } = await launched(fake);
    fake.execImpl = async () => ({ stdout: "", stderr: "", exitCode: -1 });
    assert.equal((await runtime.runScript(handle, { command: "x" })).exitCode, null);
    await assert.rejects(runtime.exec(handle, "x"), BoxdUnknownExitCodeError);
  });

  it("starts a stopped owned machine and runs the command", async () => {
    const fake = new FakeBoxd();
    const { runtime, handle } = await launched(fake);
    fake.machines.get(handle.id)!.status = "stopped";
    const result = await runtime.exec(handle, "echo hi");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.starts, [handle.id]);
    assert.equal(handle.state, "STARTED");
  });

  it("does not start a stopped machine it does not own", async () => {
    const fake = new FakeBoxd();
    fake.add({ id: "foreign", status: "running" });
    const runtime = runtimeWith(fake);
    const handle = (await runtime.getById("foreign"))!;
    fake.machines.get("foreign")!.status = "stopped";
    await assert.rejects(runtime.exec(handle, "echo"), BoxdMachineStoppedError);
    assert.deepEqual(fake.starts, []);
  });

  it("rejects commands on handles it never attached", async () => {
    const fake = new FakeBoxd();
    await assert.rejects(runtimeWith(fake).exec({ id: "m-x" }, "echo"), /not attached/);
  });

  it("builds argv without interpolating the command", () => {
    assert.deepEqual(buildBoxdCommand("echo '$HOME'"), ["bash", "-lc", "echo '$HOME'"]);
    assert.deepEqual(buildBoxdCommand("x", 1_500), ["timeout", "-k", "5s", "2s", "bash", "-lc", "x"]);
    assert.throws(() => buildBoxdCommand("  "), /non-empty/);
  });
});

describe("BoxdRuntime files", () => {
  it("uploads with parent directories and resolves relative paths against the workdir", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch({ workdir: "/home/boxd/w" });
    await runtime.uploadFile(handle, Buffer.from("abc"), "/home/boxd/a/b/c.txt");
    await runtime.uploadFile(handle, Buffer.from("rel"), "d/e.txt");
    assert.deepEqual(fake.writes.map((w) => [w.path, w.bytes.toString()]), [
      ["/home/boxd/a/b/c.txt", "abc"],
      ["/home/boxd/w/d/e.txt", "rel"],
    ]);
    const downloaded = await runtime.downloadFile(handle, "/home/boxd/a/b/c.txt");
    assert.equal((downloaded as Buffer).toString(), "abc");
  });

  it("rejects a missing file instead of returning empty bytes", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch();
    await assert.rejects(
      runtime.downloadFile(handle, "/home/boxd/missing"),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "ENOENT");
        return true;
      },
    );
  });

  it("writes the default bundle manifest under the workdir", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch({ workdir: "/home/boxd/job" });
    await runtime.uploadBundle(handle, { files: [], manifest: { a: 1 } });
    assert.equal(fake.writes[0]!.path, "/home/boxd/job/manifest.json");
  });

  it("verifies every bundle file after upload", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch();
    await runtime.uploadBundle(handle, {
      files: [{ source: Buffer.from("1"), destination: "/home/boxd/x y.txt" }],
      manifest: { a: 1 },
      manifestPath: "/home/boxd/manifest.json",
    });
    assert.equal(
      userExecs(fake).at(-1)!.command.at(-1),
      "test -f '/home/boxd/x y.txt' && test -f '/home/boxd/manifest.json'",
    );
  });
});

describe("BoxdRuntime lookups", () => {
  it("finds owned machines by label, filtered by state, exclusions and limit", async () => {
    const fake = new FakeBoxd();
    const owner = { "agent-relay-sandbox": "relay-test" };
    fake.add({ id: "a", labels: { ...owner, pool: "p" }, status: "running" });
    fake.add({ id: "b", labels: { ...owner, pool: "p" }, status: "hibernated" });
    fake.add({ id: "c", labels: { ...owner, pool: "p" }, status: "stopped" });
    fake.add({ id: "d", labels: { ...owner, pool: "p" }, status: "running" });
    fake.add({ id: "e", labels: { pool: "p" }, status: "running" });
    const runtime = runtimeWith(fake);

    const handles = await runtime.findAllByLabels({ pool: "p" }, { excludeIds: ["d"] });
    assert.deepEqual(handles.map((h) => h.id), ["a", "b"]);
    assert.deepEqual(fake.lists[0], { org: "test-org", labels: { pool: "p", ...owner } });
    assert.equal((await runtime.findByLabels({ pool: "p" }))!.id, "a");
    assert.equal(await runtime.countByLabels({ pool: "p" }), 3);
    assert.equal(await runtime.countByLabels({ pool: "p" }, { states: null }), 4);
    assert.equal(await runtime.countByLabels({ pool: "p" }, { maxCount: 2 }), 2);
    assert.deepEqual(
      (await runtime.findAllByLabels({ pool: "p" }, { limit: 1 })).map((h) => h.id),
      ["a"],
    );

    // The owned machine found by label can be destroyed.
    await runtime.destroy(handles[0]!);
    assert.deepEqual(fake.deletes, ["a"]);
  });

  it("attaches machines from an unscoped lookup without destroy authority", async () => {
    const fake = new FakeBoxd();
    fake.add({ id: "e", labels: { pool: "p" }, status: "running" });
    const runtime = runtimeWith(fake);
    const [handle] = await runtime.findAllByLabels({ pool: "p" }, { owned: false });
    assert.equal(handle!.id, "e");
    await runtime.destroy(handle!);
    await runtime.stop(handle!);
    assert.deepEqual(fake.deletes, []);
    assert.deepEqual(fake.stops, []);
  });

  it("keeps authority over a machine it launched even when a lookup passes owned: false", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const launched = await runtime.launch({ labels: { pool: "p" } });
    const [found] = await runtime.findAllByLabels({ pool: "p" }, { owned: false });
    assert.equal(found!.id, launched.id);
    await runtime.destroy(found!);
    assert.deepEqual(fake.deletes, [launched.id]);
  });

  it("never hands out a machine whose labels do not match", async () => {
    const fake = new FakeBoxd();
    fake.add({ id: "x", labels: { pool: "other", "agent-relay-sandbox": "relay-test" } });
    const client = fake.client();
    const unfiltered: BoxdClientLike = {
      ...client,
      machines: { ...client.machines, list: async () => [...fake.machines.values()] },
    };
    const runtime = new BoxdRuntime(BASE_OPTIONS, { clientFactory: () => unfiltered });
    assert.deepEqual(await runtime.findAllByLabels({ pool: "p" }), []);
  });

  it("fails closed on a malformed listing", async () => {
    const fake = new FakeBoxd();
    const client = fake.client();
    const malformed = {
      ...client,
      machines: { ...client.machines, list: async () => [{ name: "no-id" }] },
    } as unknown as BoxdClientLike;
    const runtime = new BoxdRuntime(BASE_OPTIONS, { clientFactory: () => malformed });
    await assert.rejects(runtime.countByLabels({}), /malformed/);
  });

  it("reattaches by id, owned only when the machine carries this runtime's label", async () => {
    const fake = new FakeBoxd();
    fake.add({ id: "mine", labels: { "agent-relay-sandbox": "relay-test" } });
    fake.add({ id: "theirs", labels: { "agent-relay-sandbox": "other" } });
    const runtime = runtimeWith(fake);

    assert.equal(await runtime.getById("missing"), null);
    assert.equal(await runtime.getById("mine", { states: ["STOPPED"] }), null);
    const mine = (await runtime.getById("mine"))!;
    const theirs = (await runtime.getById("theirs"))!;
    await runtime.destroy(theirs);
    await runtime.destroy(mine);
    assert.deepEqual(fake.deletes, ["mine"]);
  });

  it("maps boxd states onto the shared vocabulary", () => {
    assert.equal(normalizeBoxdState("running"), "STARTED");
    assert.equal(normalizeBoxdState("suspended"), "STARTED");
    assert.equal(normalizeBoxdState("hibernated"), "STARTED");
    assert.equal(normalizeBoxdState("starting"), "STARTING");
    assert.equal(normalizeBoxdState("pending"), "STARTING");
    assert.equal(normalizeBoxdState("stopped"), "STOPPED");
    assert.equal(normalizeBoxdState("failed"), "FAILED");
  });
});

describe("BoxdRuntime lifecycle", () => {
  it("stops and starts an owned machine", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch();
    await runtime.stop(handle);
    assert.equal(handle.state, "STOPPED");
    assert.equal(fake.machines.get(handle.id)!.status, "stopped");
    await runtime.start(handle);
    assert.equal(handle.state, "STARTED");
    assert.deepEqual(fake.stops, [handle.id]);
    assert.deepEqual(fake.starts, [handle.id]);
  });

  it("destroy verifies the machine is gone", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch();
    await runtime.destroy(handle);
    assert.equal(fake.machines.has(handle.id), false);
    // A second destroy of a forgotten handle is a no-op.
    await runtime.destroy(handle);
    assert.deepEqual(fake.deletes, [handle.id]);
  });

  it("keeps ownership when absence cannot be verified, so cleanup can be retried", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    const handle = await runtime.launch();
    fake.deleteKeepsMachine = true;
    await assert.rejects(runtime.destroy(handle), BoxdDestroyVerificationError);
    fake.deleteKeepsMachine = false;
    await runtime.destroy(handle);
    assert.deepEqual(fake.deletes, [handle.id, handle.id]);
  });

  it("close drains background cleanup and closes the client once", async () => {
    const fake = new FakeBoxd();
    const runtime = runtimeWith(fake);
    await runtime.launch();
    await runtime.close();
    await runtime.close();
    assert.equal(fake.closed, 1);
  });
});
