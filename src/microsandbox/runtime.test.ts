import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { after, describe, it } from "node:test";

import * as pkg from "../index.js";
import {
  MicrosandboxCreateTimeoutError,
  MicrosandboxNameTooLongError,
  MicrosandboxRuntime,
  resolveSandboxRuntimeCapabilities,
} from "../index.js";
import type {
  MicrosandboxBackend,
  MicrosandboxRuntimeOptions,
  MicrosandboxSdk,
  SandboxRuntime,
} from "../index.js";

// ---------------------------------------------------------------------------
// Fake SDK harness.
//
// Every SDK call the adapter can make is recorded into one ordered log, so a
// test can assert both that something DID fire (with the right arguments) and
// that something did NOT — the second half being where the interesting
// regressions live.
// ---------------------------------------------------------------------------

const HOME_DIR = "/home/agent";
const IMAGE = "registry.example/test-image:1";
const CLOUD_BACKEND: MicrosandboxBackend = { kind: "cloud", apiKey: "k-test-not-a-real-key" };

type LogEntry = { fn: string; args: unknown[] };

type ExecOutcome = { code?: number; stdout?: string; stderr?: string };

type SandboxStatus = "running" | "stopped" | "crashed" | "draining";

type HandleSpec = {
  name: string;
  status?: SandboxStatus;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  onStop?: () => Promise<void>;
  onKill?: () => Promise<void>;
  onRemove?: () => Promise<void>;
  onStart?: () => Promise<void>;
  onConnect?: () => Promise<void>;
};

type HarnessConfig = {
  /** Resolve exec output from the argv the adapter built. */
  exec?: (argv: string[]) => ExecOutcome | Promise<ExecOutcome>;
  /** Pages returned by successive `Sandbox.listWith` calls. */
  pages?: Array<{ sandboxes: HandleSpec[]; nextCursor?: string }>;
  /** `Sandbox.get` resolution, by name. */
  get?: (name: string) => HandleSpec | null | Promise<HandleSpec | null>;
  /** Delay/hang injected into `builder.create()`. */
  onCreate?: () => Promise<void>;
  /** Filesystem behaviour overrides. */
  fs?: {
    onMkdir?: (path: string) => Promise<void>;
    onWrite?: (path: string, data: Uint8Array | string) => Promise<void>;
    onCopyFromHost?: (hostPath: string, guestPath: string) => Promise<void>;
    onCopyToHost?: (guestPath: string, hostPath: string) => Promise<void>;
    onRead?: (path: string) => Promise<Uint8Array>;
  };
};

function createHarness(config: HarnessConfig = {}) {
  const log: LogEntry[] = [];
  const rec = (fn: string, ...args: unknown[]) => {
    log.push({ fn, args });
  };

  let pageIndex = 0;

  const makeExecBuilder = () => {
    const builder = {
      args(args: string[]) {
        rec("exec.args", args);
        return builder;
      },
      cwd(cwd: string) {
        rec("exec.cwd", cwd);
        return builder;
      },
      envs(vars: Record<string, string>) {
        rec("exec.envs", vars);
        return builder;
      },
      timeout(ms: number) {
        rec("exec.timeout", ms);
        return builder;
      },
      tty(enabled: boolean) {
        rec("exec.tty", enabled);
        return builder;
      },
    };
    return builder;
  };

  const makeFs = () => ({
    async write(path: string, data: Uint8Array | string) {
      rec("fs.write", path, data);
      await config.fs?.onWrite?.(path, data);
    },
    async read(path: string) {
      rec("fs.read", path);
      return (await config.fs?.onRead?.(path)) ?? new Uint8Array([1, 2, 3]);
    },
    async readToString(path: string) {
      rec("fs.readToString", path);
      return "";
    },
    async mkdir(path: string) {
      rec("fs.mkdir", path);
      await config.fs?.onMkdir?.(path);
    },
    async exists(path: string) {
      rec("fs.exists", path);
      return true;
    },
    async copyFromHost(hostPath: string, guestPath: string) {
      rec("fs.copyFromHost", hostPath, guestPath);
      await config.fs?.onCopyFromHost?.(hostPath, guestPath);
    },
    async copyToHost(guestPath: string, hostPath: string) {
      rec("fs.copyToHost", guestPath, hostPath);
      await config.fs?.onCopyToHost?.(guestPath, hostPath);
    },
  });

  const makeSandbox = (name: string) => {
    const sandbox = {
      name,
      async exec(cmd: string, args?: Iterable<string>) {
        rec("sandbox.exec", cmd, args ? [...args] : undefined);
        return makeOutput({});
      },
      async execWith(
        cmd: string,
        configure: (b: ReturnType<typeof makeExecBuilder>) => ReturnType<typeof makeExecBuilder>,
      ) {
        rec("sandbox.execWith", cmd);
        const before = log.length;
        configure(makeExecBuilder());
        const argv = (log
          .slice(before)
          .find((entry) => entry.fn === "exec.args")?.args[0] ?? []) as string[];
        const outcome = (await config.exec?.(argv)) ?? {};
        return makeOutput(outcome);
      },
      fs: () => makeFs(),
    };
    return sandbox;
  };

  const makeHandle = (spec: HandleSpec) => {
    const handle = {
      name: spec.name,
      status: spec.status ?? ("running" as SandboxStatus),
      createdAt: spec.createdAt ?? null,
      updatedAt: spec.updatedAt ?? null,
      async connect() {
        rec("handle.connect", spec.name);
        await spec.onConnect?.();
        return makeSandbox(spec.name);
      },
      async connectWithTimeout(timeoutMs: number) {
        rec("handle.connectWithTimeout", spec.name, timeoutMs);
        await spec.onConnect?.();
        return makeSandbox(spec.name);
      },
      async start() {
        rec("handle.start", spec.name);
        await spec.onStart?.();
        return makeSandbox(spec.name);
      },
      async startDetached() {
        rec("handle.startDetached", spec.name);
        return makeSandbox(spec.name);
      },
      async stop() {
        rec("handle.stop", spec.name);
        await spec.onStop?.();
      },
      async kill() {
        rec("handle.kill", spec.name);
        await spec.onKill?.();
      },
      async remove() {
        rec("handle.remove", spec.name);
        await spec.onRemove?.();
      },
    };
    return handle;
  };

  const makeSandboxBuilder = (name: string) => {
    const builder = {
      image(image: string) {
        rec("builder.image", image);
        return builder;
      },
      fromSnapshot(pathOrName: string) {
        rec("builder.fromSnapshot", pathOrName);
        return builder;
      },
      cpus(n: number) {
        rec("builder.cpus", n);
        return builder;
      },
      memory(mib: number) {
        rec("builder.memory", mib);
        return builder;
      },
      workdir(path: string) {
        rec("builder.workdir", path);
        return builder;
      },
      envs(vars: Record<string, string>) {
        rec("builder.envs", vars);
        return builder;
      },
      labels(labels: Record<string, string>) {
        rec("builder.labels", labels);
        return builder;
      },
      detached(enabled: boolean) {
        rec("builder.detached", enabled);
        return builder;
      },
      idleTimeout(secs: number) {
        rec("builder.idleTimeout", secs);
        return builder;
      },
      maxDuration(secs: number) {
        rec("builder.maxDuration", secs);
        return builder;
      },
      replace() {
        rec("builder.replace");
        return builder;
      },
      async create() {
        rec("builder.create", name);
        await config.onCreate?.();
        return makeSandbox(name);
      },
    };
    return builder;
  };

  const sdk: MicrosandboxSdk = {
    Sandbox: {
      builder(name: string) {
        rec("Sandbox.builder", name);
        return makeSandboxBuilder(name) as never;
      },
      async get(name: string) {
        rec("Sandbox.get", name);
        const spec = await config.get?.(name);
        return spec ? (makeHandle(spec) as never) : null;
      },
      async listWith(configure) {
        const listBuilder = {
          limit(limit: number) {
            rec("list.limit", limit);
            return listBuilder;
          },
          cursor(cursor: string) {
            rec("list.cursor", cursor);
            return listBuilder;
          },
          labels(labels: Record<string, string>) {
            rec("list.labels", labels);
            return listBuilder;
          },
        };
        rec("Sandbox.listWith");
        configure(listBuilder as never);
        const page = config.pages?.[pageIndex] ?? { sandboxes: [] };
        pageIndex += 1;
        return {
          sandboxes: page.sandboxes.map((spec) => makeHandle(spec)) as never,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      },
    },
    async withDefaultBackend(backend, fn) {
      rec("withDefaultBackend:enter", backend);
      try {
        return await fn();
      } finally {
        rec("withDefaultBackend:exit", backend);
      }
    },
  };

  // `setDefaultBackend` is deliberately present on the fake so a test can prove
  // the adapter never reaches for it. The adapter's typed SDK slice does not
  // include it, so calling it would be a code change, not an accident.
  const sdkWithGlobalSetter = Object.assign(sdk, {
    setDefaultBackend(backend: MicrosandboxBackend) {
      rec("setDefaultBackend", backend);
    },
  });

  return { sdk: sdkWithGlobalSetter, log };
}

function makeOutput(outcome: ExecOutcome) {
  const code = outcome.code ?? 0;
  return {
    code,
    success: code === 0,
    stdout: () => outcome.stdout ?? "",
    stderr: () => outcome.stderr ?? "",
  };
}

function names(log: LogEntry[]): string[] {
  return log.map((entry) => entry.fn);
}

function called(log: LogEntry[], fn: string): boolean {
  return log.some((entry) => entry.fn === fn);
}

function argsFor(log: LogEntry[], fn: string): unknown[][] {
  return log.filter((entry) => entry.fn === fn).map((entry) => entry.args);
}

function firstArgs(log: LogEntry[], fn: string): unknown[] {
  const found = log.find((entry) => entry.fn === fn);
  assert.ok(found, `expected a "${fn}" call in: ${names(log).join(", ")}`);
  return found.args;
}

function makeRuntime(
  sdk: MicrosandboxSdk,
  overrides: Partial<MicrosandboxRuntimeOptions> = {},
): MicrosandboxRuntime {
  return new MicrosandboxRuntime({
    backend: CLOUD_BACKEND,
    image: IMAGE,
    homeDir: HOME_DIR,
    sdk,
    ...overrides,
  });
}

/** An SDK-shaped error carrying the SDK's typed `MicrosandboxErrorCode`. */
function sdkError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------

describe("public barrel", () => {
  it("exports the runtime and its typed errors", () => {
    assert.equal(typeof pkg.MicrosandboxRuntime, "function");
    assert.equal(typeof pkg.MicrosandboxNameTooLongError, "function");
    assert.equal(typeof pkg.MicrosandboxCreateTimeoutError, "function");
  });

  it("is structurally assignable to the SandboxRuntime port", () => {
    const { sdk } = createHarness();
    const runtime: SandboxRuntime = makeRuntime(sdk);
    assert.equal(runtime.id, "microsandbox");
  });
});

describe("construction", () => {
  it("requires a rootfs source", () => {
    const { sdk } = createHarness();
    assert.throws(
      () => new MicrosandboxRuntime({ backend: CLOUD_BACKEND, homeDir: HOME_DIR, sdk }),
      /requires either `image` or `snapshot`/,
    );
  });

  it("rejects image and snapshot together", () => {
    const { sdk } = createHarness();
    assert.throws(
      () =>
        new MicrosandboxRuntime({
          backend: CLOUD_BACKEND,
          image: IMAGE,
          snapshot: "snap-1",
          homeDir: HOME_DIR,
          sdk,
        }),
      /not both/,
    );
  });

  it("touches no SDK surface at construction time", () => {
    const { sdk, log } = createHarness();
    makeRuntime(sdk);
    assert.deepEqual(log, [], "constructing a runtime must not call the SDK");
  });
});

describe("backend scoping", () => {
  it("runs every SDK call inside withDefaultBackend, with the configured backend", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1" });

    const enter = log.findIndex((e) => e.fn === "withDefaultBackend:enter");
    const create = log.findIndex((e) => e.fn === "builder.create");
    const exit = log.findIndex((e) => e.fn === "withDefaultBackend:exit");
    assert.ok(enter >= 0 && create > enter && exit > create, names(log).join(", "));
    assert.deepEqual(firstArgs(log, "withDefaultBackend:enter"), [CLOUD_BACKEND]);
  });

  it("never mutates the process-wide default backend", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({ name, status: "running" }),
    });
    const runtime = makeRuntime(sdk);
    await runtime.launch({ name: "s1" });
    await runtime.runScript({ id: "s1" }, { command: "true" });
    await runtime.destroy({ id: "s1" });

    assert.equal(
      called(log, "setDefaultBackend"),
      false,
      "setDefaultBackend would leak this runtime's backend onto the whole process",
    );
  });

  it("leaves the backend scope even when the SDK call throws", async () => {
    const { sdk, log } = createHarness({
      onCreate: async () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(makeRuntime(sdk).launch({ name: "s1" }), /boom/);
    assert.equal(called(log, "withDefaultBackend:exit"), true);
  });

  it("keeps two runtimes on separate backends", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk, { backend: "local" }).launch({ name: "a" });
    await makeRuntime(sdk, { backend: CLOUD_BACKEND }).launch({ name: "b" });

    const entered = argsFor(log, "withDefaultBackend:enter").map((args) => args[0]);
    assert.deepEqual(entered, ["local", CLOUD_BACKEND]);
  });
});

describe("sandbox naming (identity is a name, not a server id)", () => {
  it("uses the caller's name as the handle id", async () => {
    const { sdk, log } = createHarness();
    const handle = await makeRuntime(sdk).launch({ name: "issue-greeter" });
    assert.equal(handle.id, "issue-greeter");
    assert.deepEqual(firstArgs(log, "Sandbox.builder"), ["issue-greeter"]);
  });

  it("generates a name when the caller supplies none, honouring namePrefix", async () => {
    const { sdk, log } = createHarness();
    const handle = await makeRuntime(sdk, { namePrefix: "agent-" }).launch();
    assert.match(handle.id, /^agent-[0-9a-f-]{36}$/);
    assert.deepEqual(firstArgs(log, "Sandbox.builder"), [handle.id]);
  });

  it("rejects a name over the 128-byte cap instead of truncating it", async () => {
    const { sdk, log } = createHarness();
    const tooLong = "n".repeat(129);
    await assert.rejects(
      makeRuntime(sdk).launch({ name: tooLong }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxNameTooLongError);
        assert.equal(error.byteLength, 129);
        assert.equal(error.maxByteLength, 128);
        return true;
      },
    );
    assert.equal(
      called(log, "Sandbox.builder"),
      false,
      "an over-long name must be rejected before any SDK call",
    );
  });

  it("counts UTF-8 BYTES, not characters", async () => {
    const { sdk } = createHarness();
    // 65 two-byte characters = 130 bytes but only 65 JS characters, so a
    // length check on `.length` would wrongly let this through.
    const multibyte = "é".repeat(65);
    assert.equal(multibyte.length, 65);
    assert.equal(Buffer.byteLength(multibyte, "utf8"), 130);
    await assert.rejects(
      makeRuntime(sdk).launch({ name: multibyte }),
      MicrosandboxNameTooLongError,
    );
  });

  it("accepts a name at exactly the 128-byte boundary", async () => {
    const { sdk } = createHarness();
    const exact = "n".repeat(128);
    const handle = await makeRuntime(sdk).launch({ name: exact });
    assert.equal(handle.id, exact);
  });
});

describe("launch", () => {
  it("boots from the configured image and never from a snapshot", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1" });
    assert.deepEqual(firstArgs(log, "builder.image"), [IMAGE]);
    assert.equal(called(log, "builder.fromSnapshot"), false);
  });

  it("boots from a snapshot and never from an image when configured that way", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk, { image: undefined, snapshot: "snap-7" }).launch({ name: "s1" });
    assert.deepEqual(firstArgs(log, "builder.fromSnapshot"), ["snap-7"]);
    assert.equal(called(log, "builder.image"), false);
  });

  it("applies every configured resource knob", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk, {
      cpus: 4,
      memoryMiB: 2048,
      idleTimeoutSeconds: 300,
      maxDurationSeconds: 3600,
      workdir: "/workspace",
    }).launch({ name: "s1", env: { A: "1" }, labels: { purpose: "test" } });

    assert.deepEqual(firstArgs(log, "builder.cpus"), [4]);
    assert.deepEqual(firstArgs(log, "builder.memory"), [2048]);
    assert.deepEqual(firstArgs(log, "builder.idleTimeout"), [300]);
    assert.deepEqual(firstArgs(log, "builder.maxDuration"), [3600]);
    assert.deepEqual(firstArgs(log, "builder.workdir"), ["/workspace"]);
    assert.deepEqual(firstArgs(log, "builder.envs"), [{ A: "1" }]);
    assert.deepEqual(firstArgs(log, "builder.labels"), [{ purpose: "test" }]);
  });

  it("omits every knob the caller did not configure", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1", env: {}, labels: {} });
    for (const fn of [
      "builder.cpus",
      "builder.memory",
      "builder.idleTimeout",
      "builder.maxDuration",
      "builder.workdir",
      "builder.envs",
      "builder.labels",
    ]) {
      assert.equal(called(log, fn), false, `${fn} must not fire when unconfigured`);
    }
  });

  it("folds LaunchOptions.label into the label set", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1", label: "greeter", labels: { team: "a" } });
    assert.deepEqual(firstArgs(log, "builder.labels"), [{ team: "a", label: "greeter" }]);
  });

  it("does not replace a same-named sandbox by default", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1" });
    assert.equal(
      called(log, "builder.replace"),
      false,
      "replacing on a name collision would destroy a sandbox this caller may not own",
    );
  });

  it("replaces only when explicitly opted in", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk, { replaceExisting: true }).launch({ name: "s1" });
    assert.equal(called(log, "builder.replace"), true);
  });

  it("returns a handle carrying the injected home directory", async () => {
    const { sdk } = createHarness();
    const handle = await makeRuntime(sdk, { workdir: "/workspace" }).launch({ name: "s1" });
    assert.deepEqual(handle, {
      id: "s1",
      state: "STARTED",
      homeDir: HOME_DIR,
      workdir: "/workspace",
    });
  });
});

describe("launchDetached", () => {
  it("sets detached(true)", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launchDetached({ name: "s1" });
    assert.deepEqual(firstArgs(log, "builder.detached"), [true]);
  });

  it("plain launch does NOT set detached", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1" });
    assert.equal(called(log, "builder.detached"), false);
  });
});

describe("create deadline", () => {
  it("fails with a typed error when the create deadline elapses", async () => {
    const { sdk } = createHarness({
      onCreate: () => new Promise<void>(() => {}),
    });
    await assert.rejects(
      makeRuntime(sdk).launch({ name: "slow", createTimeoutSeconds: 0.02 }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxCreateTimeoutError);
        assert.equal(error.sandboxName, "slow");
        assert.equal(error.timeoutMs, 20);
        return true;
      },
    );
  });

  it("never maps the create deadline onto a sandbox LIFETIME budget", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1", createTimeoutSeconds: 120 });
    // maxDuration/idleTimeout cap how long the sandbox may LIVE. Mapping a
    // boot deadline onto either would kill every long-lived sandbox the moment
    // the boot deadline elapsed.
    assert.equal(called(log, "builder.maxDuration"), false);
    assert.equal(called(log, "builder.idleTimeout"), false);
  });

  it("keeps the configured lifetime budgets untouched by the create deadline", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk, { maxDurationSeconds: 3600 }).launch({
      name: "s1",
      createTimeoutSeconds: 5,
    });
    assert.deepEqual(firstArgs(log, "builder.maxDuration"), [3600]);
  });

  it("does not impose a deadline when the caller supplies none", async () => {
    const { sdk } = createHarness({
      onCreate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    const handle = await makeRuntime(sdk).launch({ name: "s1" });
    assert.equal(handle.id, "s1");
  });
});

describe("label lookup", () => {
  it("drains every cursor page", async () => {
    const { sdk, log } = createHarness({
      pages: [
        { sandboxes: [{ name: "a" }], nextCursor: "c1" },
        { sandboxes: [{ name: "b" }], nextCursor: "c2" },
        { sandboxes: [{ name: "c" }] },
      ],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({ team: "a" });
    assert.deepEqual(handles.map((h) => h.id), ["a", "b", "c"]);
    assert.deepEqual(argsFor(log, "list.cursor"), [["c1"], ["c2"]]);
    assert.deepEqual(firstArgs(log, "list.labels"), [{ team: "a" }]);
  });

  it("keeps only running sandboxes under the default state filter", async () => {
    const { sdk } = createHarness({
      pages: [
        {
          sandboxes: [
            { name: "run", status: "running" },
            { name: "stop", status: "stopped" },
            { name: "crash", status: "crashed" },
            { name: "drain", status: "draining" },
          ],
        },
      ],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({ team: "a" });
    assert.deepEqual(handles.map((h) => h.id), ["run"]);
  });

  it("treats a draining sandbox as unusable rather than warm", async () => {
    const { sdk } = createHarness({
      pages: [{ sandboxes: [{ name: "drain", status: "draining" }] }],
    });
    const found = await makeRuntime(sdk).findByLabels({ team: "a" });
    assert.equal(found, null, "a draining sandbox is on its way down, not a warm lease");
  });

  it("returns every state when states is null", async () => {
    const { sdk } = createHarness({
      pages: [
        {
          sandboxes: [
            { name: "run", status: "running" },
            { name: "stop", status: "stopped" },
          ],
        },
      ],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({ team: "a" }, { states: null });
    assert.deepEqual(handles.map((h) => h.id), ["run", "stop"]);
  });

  it("normalizes SDK statuses onto the STARTED/STOPPED vocabulary", async () => {
    const { sdk } = createHarness({
      pages: [
        {
          sandboxes: [
            { name: "run", status: "running" },
            { name: "stop", status: "stopped" },
            { name: "crash", status: "crashed" },
            { name: "drain", status: "draining" },
          ],
        },
      ],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({}, { states: null });
    assert.deepEqual(
      handles.map((h) => [h.id, h.state]),
      [["run", "STARTED"], ["stop", "STOPPED"], ["crash", "STOPPED"], ["drain", "STOPPED"]],
    );
  });

  it("surfaces timestamps as ISO strings when the SDK provides them", async () => {
    const created = new Date("2026-01-02T03:04:05.000Z");
    const { sdk } = createHarness({
      pages: [{ sandboxes: [{ name: "a", createdAt: created, updatedAt: created }] }],
    });
    const [handle] = await makeRuntime(sdk).findAllByLabels({});
    assert.equal(handle?.createdAt, "2026-01-02T03:04:05.000Z");
    assert.equal(handle?.updatedAt, "2026-01-02T03:04:05.000Z");
  });

  it("stops paging once the limit is reached", async () => {
    const { sdk, log } = createHarness({
      pages: [
        { sandboxes: [{ name: "a" }, { name: "b" }], nextCursor: "c1" },
        { sandboxes: [{ name: "c" }] },
      ],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({}, { limit: 1 });
    assert.deepEqual(handles.map((h) => h.id), ["a"]);
    assert.equal(
      argsFor(log, "Sandbox.listWith").length,
      1,
      "a satisfied limit must not fetch the next page",
    );
  });

  it("excludes ids the caller has already claimed", async () => {
    const { sdk } = createHarness({
      pages: [{ sandboxes: [{ name: "a" }, { name: "b" }] }],
    });
    const found = await makeRuntime(sdk).findByLabels({}, { excludeIds: ["a"] });
    assert.equal(found?.id, "b");
  });

  it("answers a zero maxCount without any SDK call", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [{ name: "a" }] }] });
    assert.equal(await makeRuntime(sdk).countByLabels({}, { maxCount: 0 }), 0);
    assert.equal(called(log, "Sandbox.listWith"), false);
  });

  it("caps countByLabels at maxCount", async () => {
    const { sdk } = createHarness({
      pages: [{ sandboxes: [{ name: "a" }, { name: "b" }, { name: "c" }] }],
    });
    assert.equal(await makeRuntime(sdk).countByLabels({}, { maxCount: 2 }), 2);
  });

  it("omits the label filter entirely when no labels are given", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [] }] });
    await makeRuntime(sdk).findAllByLabels({});
    assert.equal(called(log, "list.labels"), false);
  });
});

describe("getById", () => {
  it("resolves a sandbox by name", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name, status: "running" }) });
    const handle = await makeRuntime(sdk).getById("s1");
    assert.equal(handle?.id, "s1");
    assert.equal(handle?.state, "STARTED");
  });

  it("returns a stopped sandbox when the caller did not filter states", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name, status: "stopped" }) });
    const handle = await makeRuntime(sdk).getById("s1");
    assert.equal(handle?.state, "STOPPED");
  });

  it("filters out a sandbox that fails the requested state filter", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name, status: "stopped" }) });
    assert.equal(await makeRuntime(sdk).getById("s1", { states: ["STARTED"] }), null);
  });

  it("returns null when the SDK resolves nothing", async () => {
    const { sdk } = createHarness({ get: () => null });
    assert.equal(await makeRuntime(sdk).getById("s1"), null);
  });

  it("returns null on the SDK's typed sandboxNotFound error", async () => {
    const { sdk } = createHarness({
      get: () => {
        throw sdkError("sandboxNotFound", "sandbox \"s1\" not found");
      },
    });
    assert.equal(await makeRuntime(sdk).getById("s1"), null);
  });

  it("propagates an unrelated SDK error instead of reporting it as absent", async () => {
    const { sdk } = createHarness({
      get: () => {
        throw sdkError("runtime", "hypervisor unavailable");
      },
    });
    await assert.rejects(makeRuntime(sdk).getById("s1"), /hypervisor unavailable/);
  });

  it("trusts the typed code over a misleading message", async () => {
    const { sdk } = createHarness({
      get: () => {
        // A transport failure whose text happens to contain "not found" must
        // NOT be laundered into "this sandbox does not exist" — that is how a
        // live sandbox gets orphaned and a duplicate launched in its place.
        throw sdkError("http", "upstream route not found");
      },
    });
    await assert.rejects(makeRuntime(sdk).getById("s1"), /upstream route not found/);
  });

  it("still recognises a not-found error carrying no typed code", async () => {
    const { sdk } = createHarness({
      get: () => {
        throw Object.assign(new Error("sandbox not found"), {
          name: "SandboxNotFoundError",
        });
      },
    });
    assert.equal(await makeRuntime(sdk).getById("s1"), null);
  });

  it("carries caller-supplied homeDir and workdir onto the handle", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name }) });
    const handle = await makeRuntime(sdk).getById("s1", {
      homeDir: "/home/other",
      workdir: "/w",
    });
    assert.equal(handle?.homeDir, "/home/other");
    assert.equal(handle?.workdir, "/w");
  });
});

describe("runScript", () => {
  it("runs the command through the configured shell with -c", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).runScript({ id: "s1" }, { command: "echo hi" });
    assert.deepEqual(firstArgs(log, "sandbox.execWith"), ["/bin/sh"]);
    assert.deepEqual(firstArgs(log, "exec.args"), [["-c", "echo hi"]]);
  });

  it("honours a custom shell", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk, { shell: "/bin/bash" }).runScript({ id: "s1" }, { command: "echo hi" });
    assert.deepEqual(firstArgs(log, "sandbox.execWith"), ["/bin/bash"]);
  });

  it("applies cwd, env and timeout when supplied", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).runScript(
      { id: "s1" },
      { command: "true", cwd: "/app", env: { A: "1" }, timeoutMs: 5_000 },
    );
    assert.deepEqual(firstArgs(log, "exec.cwd"), ["/app"]);
    assert.deepEqual(firstArgs(log, "exec.envs"), [{ A: "1" }]);
    assert.deepEqual(firstArgs(log, "exec.timeout"), [5_000]);
  });

  it("falls back to the handle workdir when no cwd is given", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).runScript({ id: "s1", workdir: "/handle-wd" }, { command: "true" });
    assert.deepEqual(firstArgs(log, "exec.cwd"), ["/handle-wd"]);
  });

  it("omits cwd, env and timeout when not supplied", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).runScript({ id: "s1" }, { command: "true", env: {}, timeoutMs: 0 });
    assert.equal(called(log, "exec.cwd"), false);
    assert.equal(called(log, "exec.envs"), false);
    assert.equal(called(log, "exec.timeout"), false);
  });

  it("never allocates a tty", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).runScript({ id: "s1" }, { command: "true" });
    assert.equal(
      called(log, "exec.tty"),
      false,
      "capabilities.pty is declared false, so no exec path may allocate one",
    );
  });

  it("returns a non-zero exit as a result rather than throwing", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 42, stdout: "out", stderr: "err" }),
    });
    const result = await makeRuntime(sdk).runScript({ id: "s1" }, { command: "false" });
    assert.equal(result.exitCode, 42);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.output, "out\nerr");
  });

  it("omits empty stdout/stderr keys", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name }), exec: () => ({ code: 0 }) });
    const result = await makeRuntime(sdk).runScript({ id: "s1" }, { command: "true" });
    assert.equal("stdout" in result, false);
    assert.equal("stderr" in result, false);
    assert.equal(result.output, "");
  });

  it("does not insert a separator when stdout already ends in a newline", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ stdout: "out\n", stderr: "err" }),
    });
    const result = await makeRuntime(sdk).runScript({ id: "s1" }, { command: "true" });
    assert.equal(result.output, "out\nerr");
  });

  it("throws when the sandbox is gone", async () => {
    const { sdk } = createHarness({ get: () => null });
    await assert.rejects(
      makeRuntime(sdk).runScript({ id: "ghost" }, { command: "true" }),
      /no longer available/,
    );
  });
});

describe("exec (bootstrap plane)", () => {
  it("narrows runScript onto the ExecResult shape", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 3, stdout: "hello" }),
    });
    const result = await makeRuntime(sdk).exec({ id: "s1" }, "echo hello");
    assert.deepEqual(result, { output: "hello", exitCode: 3 });
  });
});

describe("startScript (durable async exec)", () => {
  it("backgrounds the run and captures output and exit code to guest files", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ stdout: "4242\n" }),
    });
    const started = await makeRuntime(sdk).startScript(
      { id: "s1" },
      { command: "long-job", sessionId: "sess-1" },
    );
    assert.deepEqual(started, { sessionId: "sess-1", commandId: "4242" });

    const [argv] = firstArgs(log, "exec.args") as [string[]];
    const script = argv[1] ?? "";
    // The inner script is single-quoted for `sh -c`, so its own quoting shows
    // up in the POSIX `'\''` escaped form.
    assert.ok(script.startsWith("mkdir -p '/tmp/microsandbox-run/sess-1';"));
    assert.ok(script.includes("nohup '/bin/sh' -c "));
    assert.ok(script.includes(`> '\\''/tmp/microsandbox-run/sess-1/out'\\'' 2>&1`));
    assert.ok(script.includes(`echo $? > '\\''/tmp/microsandbox-run/sess-1/exit'\\''`));
    assert.ok(script.endsWith("> /dev/null 2>&1 & echo $!"));
  });

  it("honours a custom run state directory", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }), exec: () => ({ stdout: "1" }) });
    await makeRuntime(sdk, { runStateDir: "/var/run/msb/" }).startScript(
      { id: "s1" },
      { command: "job", sessionId: "sess-1" },
    );
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.match(argv[1] ?? "", /^mkdir -p '\/var\/run\/msb\/sess-1';/);
  });

  it("sanitizes a session id before using it as a path segment", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }), exec: () => ({ stdout: "1" }) });
    await makeRuntime(sdk).startScript(
      { id: "s1" },
      { command: "job", sessionId: "../../etc/passwd" },
    );
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.match(argv[1] ?? "", /'\/tmp\/microsandbox-run\/______etc_passwd'/);
    assert.doesNotMatch(argv[1] ?? "", /\.\./);
  });

  it("generates a session id when the caller supplies none", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name }), exec: () => ({ stdout: "9" }) });
    const started = await makeRuntime(sdk).startScript({ id: "s1" }, { command: "job" });
    assert.match(started.sessionId, /^run-s1-[0-9a-f-]{36}$/);
  });

  it("bounds only the submit call with the caller's timeout", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }), exec: () => ({ stdout: "1" }) });
    await makeRuntime(sdk).startScript(
      { id: "s1" },
      { command: "long-job", sessionId: "sess-1", timeoutMs: 2_000 },
    );
    assert.deepEqual(firstArgs(log, "exec.timeout"), [2_000]);
    // The backgrounded command must NOT inherit that deadline: `nohup ... &`
    // detaches it, and nothing in the wrapper caps its lifetime.
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    const script = argv[1] ?? "";
    assert.doesNotMatch(script, /timeout 2/);
    assert.ok(script.includes("nohup "));
    assert.ok(script.endsWith("& echo $!"));
  });

  it("escapes a command containing single quotes", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }), exec: () => ({ stdout: "1" }) });
    await makeRuntime(sdk).startScript(
      { id: "s1" },
      { command: "echo 'hi'", sessionId: "sess-1" },
    );
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.match(argv[1] ?? "", /'\\''hi'\\''/);
  });
});

describe("getScriptStatus", () => {
  const statusRuntime = (exitFileContents: string) =>
    createHarness({
      get: (name) => ({ name }),
      exec: (argv) => {
        const script = argv[1] ?? "";
        return script.includes("/exit") ? { stdout: exitFileContents } : { stdout: "" };
      },
    });

  it("reports still-running while the exit file is absent", async () => {
    const { sdk } = statusRuntime("");
    assert.deepEqual(
      await makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      { exitCode: null },
    );
  });

  it("reports a zero exit", async () => {
    const { sdk } = statusRuntime("0\n");
    assert.deepEqual(
      await makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      { exitCode: 0 },
    );
  });

  it("reports a non-zero exit", async () => {
    const { sdk } = statusRuntime("137\n");
    assert.deepEqual(
      await makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      { exitCode: 137 },
    );
  });

  it("never invents an exit code from unparseable contents", async () => {
    const { sdk } = statusRuntime("garbage\n");
    assert.deepEqual(
      await makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      { exitCode: null },
    );
  });

  it("reads through a bounded tail rather than an unbounded file read", async () => {
    const { sdk, log } = statusRuntime("0");
    await makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1");
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.match(argv[1] ?? "", /^tail -c 64 /);
    assert.equal(called(log, "fs.readToString"), false);
  });

  it("degrades to still-running when the read itself fails", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => {
        throw new Error("transport reset");
      },
    });
    assert.deepEqual(
      await makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      { exitCode: null },
    );
  });
});

describe("getScriptLogs", () => {
  it("returns captured output and defers the exit code to getScriptStatus", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ stdout: "captured output" }),
    });
    const result = await makeRuntime(sdk).getScriptLogs({ id: "s1" }, "sess-1", "cmd-9");
    assert.equal(result.output, "captured output");
    assert.equal(result.exitCode, null, "status is the single source of truth for the exit code");
    assert.equal(result.cmdId, "cmd-9");
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.match(argv[1] ?? "", /^tail -c 200000 '\/tmp\/microsandbox-run\/sess-1\/out'/);
  });
});

describe("file transfer", () => {
  it("treats a string source as a HOST PATH", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).uploadFile({ id: "s1" }, "./local.txt", "/app/local.txt");
    assert.deepEqual(firstArgs(log, "fs.copyFromHost"), ["./local.txt", "/app/local.txt"]);
    assert.equal(called(log, "fs.write"), false);
  });

  it("treats a Buffer source as file CONTENT", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).uploadFile({ id: "s1" }, Buffer.from("hello"), "/app/f.txt");
    const [path, data] = firstArgs(log, "fs.write");
    assert.equal(path, "/app/f.txt");
    assert.ok(data instanceof Uint8Array);
    assert.equal(Buffer.from(data as Uint8Array).toString("utf8"), "hello");
    assert.equal(called(log, "fs.copyFromHost"), false);
  });

  it("creates the destination's parent directory first", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).uploadFile({ id: "s1" }, Buffer.from("x"), "/app/nested/f.txt");
    assert.deepEqual(firstArgs(log, "fs.mkdir"), ["/app/nested"]);
    assert.ok(
      names(log).indexOf("fs.mkdir") < names(log).indexOf("fs.write"),
      "mkdir must precede the write",
    );
  });

  it("does not fail the upload when the parent directory already exists", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      fs: {
        onMkdir: async () => {
          throw new Error("EEXIST: file exists");
        },
      },
    });
    await makeRuntime(sdk).uploadFile({ id: "s1" }, Buffer.from("x"), "/app/f.txt");
    assert.equal(called(log, "fs.write"), true);
  });

  it("skips mkdir for a root-level destination", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).uploadFile({ id: "s1" }, Buffer.from("x"), "/f.txt");
    assert.equal(called(log, "fs.mkdir"), false);
  });

  it("uploads every file in a bundle", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).uploadBundle({ id: "s1" }, {
      files: [
        { source: Buffer.from("a"), destination: "/app/a" },
        { source: "./b", destination: "/app/b" },
      ],
    });
    assert.deepEqual(argsFor(log, "fs.write").map((a) => a[0]), ["/app/a"]);
    assert.deepEqual(argsFor(log, "fs.copyFromHost").map((a) => a[1]), ["/app/b"]);
  });

  it("downloads to a host path when one is given", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const result = await makeRuntime(sdk).downloadFile({ id: "s1" }, "/app/out", "./out");
    assert.equal(result, undefined);
    assert.deepEqual(firstArgs(log, "fs.copyToHost"), ["/app/out", "./out"]);
    assert.equal(called(log, "fs.read"), false);
  });

  it("returns a Buffer when no host path is given", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      fs: { onRead: async () => new Uint8Array([104, 105]) },
    });
    const result = await makeRuntime(sdk).downloadFile({ id: "s1" }, "/app/out");
    assert.ok(Buffer.isBuffer(result));
    assert.equal((result as Buffer).toString("utf8"), "hi");
    assert.equal(called(log, "fs.copyToHost"), false);
  });
});

describe("getHomeDir", () => {
  it("prefers the handle's own home directory", async () => {
    const { sdk } = createHarness();
    assert.equal(
      await makeRuntime(sdk).getHomeDir({ id: "s1", homeDir: "/home/other" }),
      "/home/other",
    );
  });

  it("falls back to the injected default", async () => {
    const { sdk } = createHarness();
    assert.equal(await makeRuntime(sdk).getHomeDir({ id: "s1" }), HOME_DIR);
  });
});

describe("lifecycle", () => {
  it("start resumes the sandbox and reports it STARTED", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name, status: "stopped" }) });
    const handle = await makeRuntime(sdk).start({ id: "s1", state: "STOPPED" });
    assert.equal(handle.state, "STARTED");
    assert.equal(called(log, "handle.start"), true);
  });

  it("start on a vanished sandbox is an error, not a silent no-op", async () => {
    const { sdk } = createHarness({ get: () => null });
    await assert.rejects(makeRuntime(sdk).start({ id: "ghost" }), /no longer available/);
  });

  it("stop halts the sandbox", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).stop({ id: "s1" });
    assert.deepEqual(firstArgs(log, "handle.stop"), ["s1"]);
  });

  it("stop on a vanished sandbox is idempotent", async () => {
    const { sdk, log } = createHarness({ get: () => null });
    await makeRuntime(sdk).stop({ id: "ghost" });
    assert.equal(called(log, "handle.stop"), false);
  });
});

describe("destroy", () => {
  it("kills and then removes, so the name is reusable", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).destroy({ id: "s1" });
    const order = names(log).filter((n) => n === "handle.kill" || n === "handle.remove");
    assert.deepEqual(order, ["handle.kill", "handle.remove"]);
  });

  it("is a no-op for a sandbox that is already gone", async () => {
    const { sdk, log } = createHarness({ get: () => null });
    await makeRuntime(sdk).destroy({ id: "ghost" });
    assert.equal(called(log, "handle.kill"), false);
    assert.equal(called(log, "handle.remove"), false);
  });

  it("still removes when the kill fails because it was already stopped", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw new Error("sandbox is already stopped");
        },
      }),
    });
    await makeRuntime(sdk).destroy({ id: "s1" });
    assert.equal(
      called(log, "handle.remove"),
      true,
      "a stopped sandbox still holds its name until it is removed",
    );
  });

  it("does not remove after an unexplained kill failure", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("runtime", "hypervisor wedged");
        },
      }),
    });
    await assert.rejects(makeRuntime(sdk).destroy({ id: "s1" }), /hypervisor wedged/);
    assert.equal(
      called(log, "handle.remove"),
      false,
      "removing the record of a sandbox that may still be running would orphan the microVM",
    );
  });

  it("tolerates a remove that races another destroy", async () => {
    const { sdk } = createHarness({
      get: (name) => ({
        name,
        onRemove: async () => {
          throw sdkError("sandboxNotFound", "already removed");
        },
      }),
    });
    await makeRuntime(sdk).destroy({ id: "s1" });
  });

  it("drops the cached instance so a later call re-resolves by name", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.launch({ name: "s1" });
    await runtime.destroy({ id: "s1" });
    await runtime.runScript({ id: "s1" }, { command: "true" });
    assert.equal(called(log, "handle.connectWithTimeout"), true);
  });
});

describe("reattach", () => {
  it("reuses the instance cached by launch without a round trip", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.launch({ name: "s1" });
    await runtime.runScript(handle, { command: "true" });
    assert.equal(called(log, "Sandbox.get"), false);
  });

  it("re-resolves by name from a cold runtime, without taking lifecycle ownership", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).runScript({ id: "s1" }, { command: "true" });
    assert.deepEqual(firstArgs(log, "Sandbox.get"), ["s1"]);
    assert.deepEqual(firstArgs(log, "handle.connectWithTimeout"), ["s1", 10_000]);
    assert.equal(
      called(log, "handle.start"),
      false,
      "reattaching must not implicitly boot a stopped sandbox",
    );
  });

  it("honours a configured connect timeout", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk, { connectTimeoutMs: 2_500 }).runScript({ id: "s1" }, { command: "true" });
    assert.deepEqual(firstArgs(log, "handle.connectWithTimeout"), ["s1", 2_500]);
  });
});

describe("capabilities", () => {
  it("declares the bootstrap-plane capability set this adapter actually implements", () => {
    const { sdk } = createHarness();
    assert.deepEqual(makeRuntime(sdk).capabilities, {
      pty: false,
      snapshots: true,
      isolation: "strong",
      persistentHandle: true,
      streamingLogs: false,
    });
  });

  it("declares warm-lease and lifecycle support", () => {
    const { sdk } = createHarness();
    assert.deepEqual(makeRuntime(sdk).declaredCapabilities, {
      warmLease: true,
      lifecycle: true,
    });
  });

  it("resolves to the full orchestration-plane capability set", () => {
    const { sdk } = createHarness();
    assert.deepEqual(resolveSandboxRuntimeCapabilities(makeRuntime(sdk)), {
      asyncExec: true,
      reattach: true,
      detachedLaunch: true,
      warmLease: true,
      lifecycle: true,
    });
  });

  it("backs its asyncExec claim with all four required methods", () => {
    const { sdk } = createHarness();
    const runtime = makeRuntime(sdk);
    for (const method of ["startScript", "getById", "getScriptStatus", "getScriptLogs"] as const) {
      assert.equal(typeof runtime[method], "function", `${method} is required by asyncExec`);
    }
  });

  it("backs its snapshots claim with a real snapshot boot path", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk, { image: undefined, snapshot: "snap-1" }).launch({ name: "s1" });
    assert.equal(called(log, "builder.fromSnapshot"), true);
  });
});

// ---------------------------------------------------------------------------
// Real-SDK contract.
//
// The adapter binds to a structurally-modeled slice of `microsandbox` rather
// than to the SDK's type graph, which keeps unit tests credential-free but
// would let the model silently drift from the package. These checks pin the
// model against the installed SDK: they need no API key, no backend and no
// hypervisor, because every assertion is about module shape or about
// `withDefaultBackend`, which is pure process-local state.
//
// Skipped rather than failed when the platform-specific native addon cannot
// load, so the suite stays green on an unsupported platform.
// ---------------------------------------------------------------------------

type RealSdkModule = Record<string, unknown> & {
  Sandbox: Record<string, unknown>;
  SandboxStatuses: readonly string[];
  SandboxNotFoundError: new (message: string) => Error;
  withDefaultBackend: <T>(backend: unknown, fn: () => T | Promise<T>) => Promise<T>;
  defaultBackendKind: () => string;
};

let realSdk: RealSdkModule | null = null;
let realSdkLoadError = "";
try {
  realSdk = (await import("microsandbox")) as unknown as RealSdkModule;
} catch (error) {
  realSdkLoadError = error instanceof Error ? error.message : String(error);
}
const REAL_SDK_SKIP = realSdk
  ? false
  : `microsandbox native addon unavailable: ${realSdkLoadError}`;

describe("real-SDK contract", () => {
  it("exposes every Sandbox static the adapter calls", { skip: REAL_SDK_SKIP }, () => {
    const statics = realSdk!.Sandbox;
    for (const name of ["builder", "get", "listWith"]) {
      assert.equal(typeof statics[name], "function", `Sandbox.${name} is gone`);
    }
  });

  it("exposes every builder setter the adapter calls", { skip: REAL_SDK_SKIP }, () => {
    const builder = (realSdk!.Sandbox["builder"] as (n: string) => Record<string, unknown>)(
      "contract-probe",
    );
    for (const name of [
      "image",
      "fromSnapshot",
      "cpus",
      "memory",
      "workdir",
      "envs",
      "labels",
      "detached",
      "idleTimeout",
      "maxDuration",
      "replace",
      "create",
    ]) {
      assert.equal(typeof builder[name], "function", `SandboxBuilder.${name} is gone`);
    }
  });

  it("exposes every list-builder setter the adapter calls", { skip: REAL_SDK_SKIP }, () => {
    const listBuilder = (realSdk!["SandboxListBuilder"] as { prototype: Record<string, unknown> })
      .prototype;
    for (const name of ["limit", "cursor", "labels"]) {
      assert.equal(typeof listBuilder[name], "function", `SandboxListBuilder.${name} is gone`);
    }
  });

  it("still uses the status vocabulary this adapter normalizes", { skip: REAL_SDK_SKIP }, () => {
    // A new status would fall through `normalizeStatus` to STOPPED, silently
    // excluding those sandboxes from every warm-lease lookup.
    assert.deepEqual([...realSdk!.SandboxStatuses].sort(), [
      "crashed",
      "draining",
      "running",
      "stopped",
    ]);
  });

  it("still tags a missing sandbox with the code the adapter matches", { skip: REAL_SDK_SKIP }, () => {
    const error = new realSdk!.SandboxNotFoundError("probe");
    assert.equal(
      (error as unknown as { code: string }).code,
      "sandboxNotFound",
      "getById relies on this exact code to tell absent from broken",
    );
  });

  it("scopes and restores the default backend", { skip: REAL_SDK_SKIP }, async () => {
    // No credential involved: this drives the real scoping primitive the
    // adapter depends on, using the local backend as an inert value.
    const before = realSdk!.defaultBackendKind();
    const inside = await realSdk!.withDefaultBackend("local", () =>
      realSdk!.defaultBackendKind(),
    );
    assert.equal(inside, "local");
    assert.equal(realSdk!.defaultBackendKind(), before, "the scope must be restored");
  });
});

// ---------------------------------------------------------------------------
// Live smoke.
//
// Gated OFF by default and skipped unless the operator supplies both an image
// and a backend, because there is no image or endpoint this package may assume.
// Inject the API key with `op run` so it reaches the process environment only
// and never argv:
//
//   op run --env-file=./smoke.env -- \
//     env MICROSANDBOX_SMOKE_IMAGE=alpine npm test
//
// where `smoke.env` holds `MSB_API_KEY=op://<vault>/<item>/API_KEY`. Nothing
// below reads, prints, or asserts on the key's value — only on whether one is
// present.
//
// The real SDK is reached through the adapter's own lazy import, so a normal
// (skipped) test run never loads the platform-specific native addon.
// ---------------------------------------------------------------------------

const smokeImage = process.env.MICROSANDBOX_SMOKE_IMAGE?.trim();
const smokeApiKeyPresent = Boolean(process.env.MSB_API_KEY?.trim());
const smokeWantsLocal = process.env.MICROSANDBOX_SMOKE_BACKEND?.trim() === "local";
const smokeHomeDir = process.env.MICROSANDBOX_SMOKE_HOME_DIR?.trim() ?? "/root";
const HAS_MICROSANDBOX = Boolean(smokeImage) && (smokeApiKeyPresent || smokeWantsLocal);
const SMOKE_SKIP_REASON = !smokeImage
  ? "MICROSANDBOX_SMOKE_IMAGE is not set"
  : "neither MSB_API_KEY nor MICROSANDBOX_SMOKE_BACKEND=local is set";
const SMOKE_LABEL = "microsandbox-runner-smoke";

describe("MicrosandboxRuntime smoke", { concurrency: false }, () => {
  let runtime: MicrosandboxRuntime | undefined;
  let handle: { id: string } | undefined;

  if (HAS_MICROSANDBOX) {
    const backend: MicrosandboxBackend = smokeWantsLocal
      ? "local"
      // Read straight out of the process environment at the moment of use. The
      // value is never logged, never interpolated into a command, and never
      // written anywhere.
      : { kind: "cloud", apiKey: process.env.MSB_API_KEY as string };
    runtime = new MicrosandboxRuntime({
      backend,
      image: smokeImage as string,
      homeDir: smokeHomeDir,
    });
  }

  it(
    "launches, execs, round-trips a file, polls an async run, and tears down",
    { skip: HAS_MICROSANDBOX ? false : SMOKE_SKIP_REASON, timeout: 300_000 },
    async () => {
      assert.ok(runtime, "runtime should be constructed when the smoke gate is open");

      handle = await runtime.launch({
        labels: { purpose: SMOKE_LABEL },
        createTimeoutSeconds: 180,
      });
      assert.ok(handle.id.length > 0);

      const sync = await runtime.runScript(handle, { command: "echo ok" });
      assert.equal(sync.exitCode, 0, `expected exit 0, got ${sync.exitCode}: ${sync.output}`);
      assert.match(sync.output, /\bok\b/);

      const nonZero = await runtime.runScript(handle, { command: "exit 7" });
      assert.equal(nonZero.exitCode, 7, "a non-zero exit must arrive as a result, not a throw");

      await runtime.uploadFile(handle, Buffer.from("round-trip"), "/tmp/smoke/f.txt");
      const downloaded = await runtime.downloadFile(handle, "/tmp/smoke/f.txt");
      assert.equal(Buffer.from(downloaded as Buffer).toString("utf8"), "round-trip");

      const started = await runtime.startScript(handle, {
        command: "sleep 1; echo async-done; exit 3",
      });
      let status = await runtime.getScriptStatus(handle, started.sessionId, started.commandId);
      for (let attempt = 0; attempt < 60 && status.exitCode === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        status = await runtime.getScriptStatus(handle, started.sessionId, started.commandId);
      }
      assert.equal(status.exitCode, 3, "the durable exit file must carry the real exit code");
      const logs = await runtime.getScriptLogs(handle, started.sessionId, started.commandId);
      assert.match(logs.output, /async-done/);

      const found = await runtime.findAllByLabels({ purpose: SMOKE_LABEL });
      assert.ok(
        found.some((entry) => entry.id === handle?.id),
        "server-side label search must find the sandbox this test launched",
      );

      const byId = await runtime.getById(handle.id);
      assert.equal(byId?.id, handle.id);
      assert.equal(byId?.state, "STARTED");
    },
  );

  after(async () => {
    if (runtime && handle) {
      try {
        await runtime.destroy(handle);
      } catch {
        // Best-effort cleanup; a leaked sandbox surfaces in the provider console.
      }
    }
  });
});
