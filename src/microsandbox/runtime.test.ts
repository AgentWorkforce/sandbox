import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import * as pkg from "../index.js";
import {
  MicrosandboxBackendBusyError,
  MicrosandboxCreateTimeoutError,
  MicrosandboxLookupTimeoutError,
  MicrosandboxNameTooLongError,
  MicrosandboxPaginationError,
  MicrosandboxRunLostError,
  MicrosandboxRunNotFinishedError,
  MicrosandboxRuntime,
  MicrosandboxSessionConflictError,
  resolveSandboxRuntimeCapabilities,
} from "../index.js";
import {
  MICROSANDBOX_RUN_ADMIT_SCRIPT,
  MICROSANDBOX_RUN_STATUS_SCRIPT,
} from "./runtime.js";
import type {
  MicrosandboxBackend,
  MicrosandboxRuntimeOptions,
  MicrosandboxSdk,
  RuntimeHandle,
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
  /**
   * Pages returned VERBATIM, bypassing the well-formed `pages` shaping, so a
   * test can hand the adapter the malformed page a real backend can emit.
   * The last entry repeats once the list is exhausted.
   */
  rawPages?: unknown[];
  /** `Sandbox.get` resolution, by name. */
  get?: (name: string) => HandleSpec | null | Promise<HandleSpec | null>;
  /** Delay/hang injected into `Sandbox.get`. */
  onGet?: () => Promise<void>;
  /** Delay/hang injected into `builder.create()`. */
  onCreate?: () => Promise<void>;
  /** Delay/hang injected into `Sandbox.listWith`, before any page is returned. */
  listWith?: () => Promise<void>;
  /** Filesystem behaviour overrides. */
  fs?: {
    onMkdir?: (path: string) => Promise<void>;
    onWrite?: (path: string, data: Uint8Array | string) => Promise<void>;
    onCopyFromHost?: (hostPath: string, guestPath: string) => Promise<void>;
    onCopyToHost?: (guestPath: string, hostPath: string) => Promise<void>;
    onRead?: (path: string) => Promise<Uint8Array>;
  };
};

/**
 * In-guest model of the async-run protocol.
 *
 * The adapter's two shell scripts are the real contract, and they are executed
 * for real against `/bin/sh` further down. This model stands in for the guest
 * in the adapter-level tests: it implements the same state machine — one
 * atomic claim per session directory, adoption of an identical resubmit,
 * refusal of a conflicting one, and an exit code that exists only once the run
 * process has recorded it.
 */
type GuestRun = {
  command: string;
  pid: string;
  bootId: string;
  alive: boolean;
  exit?: string;
  output: string;
};

function createGuest() {
  const runs = new Map<string, GuestRun>();
  const admissions: string[] = [];
  let nextPid = 1000;
  let bootId = "boot-1";

  const admit = (command: string, dir: string) => {
    const existing = runs.get(dir);
    if (!existing) {
      const pid = String(nextPid);
      nextPid += 1;
      runs.set(dir, { command, pid, bootId, alive: true, output: "" });
      admissions.push(dir);
      return { stdout: `ADMITTED ${pid}\n` };
    }
    if (existing.command === command) {
      return { stdout: `CLAIMED ${existing.pid}\n` };
    }
    return { stdout: "CONFLICT\n" };
  };

  const status = (dir: string) => {
    const run = runs.get(dir);
    if (!run) {
      return { stdout: "MISSING\n" };
    }
    if (run.exit !== undefined) {
      return { stdout: `EXIT ${run.exit}\n` };
    }
    if (run.bootId !== bootId) {
      return { stdout: "LOST sandbox-restarted\n" };
    }
    return { stdout: run.alive ? "RUNNING\n" : "LOST process-gone\n" };
  };

  return {
    runs,
    admissions,
    /** The run recorded an exit code, as its wrapper's final act. */
    finish(dir: string, exit: number | string) {
      const run = runs.get(dir);
      assert.ok(run, `no run admitted at ${dir}`);
      run.alive = false;
      run.exit = String(exit);
    },
    /** The run's process died without recording anything. */
    kill(dir: string) {
      const run = runs.get(dir);
      assert.ok(run, `no run admitted at ${dir}`);
      run.alive = false;
    },
    /** The sandbox rebooted, so every recorded pid now belongs to someone else. */
    restartSandbox() {
      bootId = `boot-${bootId.length}`;
    },
    write(dir: string, output: string) {
      const run = runs.get(dir);
      assert.ok(run, `no run admitted at ${dir}`);
      run.output = output;
    },
    exec(argv: string[]): ExecOutcome {
      const script = argv[1] ?? "";
      if (script === MICROSANDBOX_RUN_ADMIT_SCRIPT) {
        return admit(argv[3] ?? "", argv[4] ?? "");
      }
      if (script === MICROSANDBOX_RUN_STATUS_SCRIPT) {
        return status(argv[3] ?? "");
      }
      const tailed = /^tail -c \d+ '(.*)'/.exec(script);
      if (tailed) {
        const path = tailed[1] ?? "";
        for (const [dir, run] of runs) {
          if (path === `${dir}/out`) {
            return { stdout: run.output };
          }
        }
        return { stdout: "" };
      }
      return {};
    },
  };
}

function createHarness(config: HarnessConfig = {}) {
  const log: LogEntry[] = [];
  // Unless a test pins an exact exec outcome, the guest model answers.
  const guest = createGuest();
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
        const outcome = config.exec ? await config.exec(argv) : guest.exec(argv);
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
        await config.onGet?.();
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
        await config.listWith?.();
        if (config.rawPages) {
          const raw = config.rawPages[Math.min(pageIndex, config.rawPages.length - 1)];
          pageIndex += 1;
          return raw as never;
        }
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

  return { sdk: sdkWithGlobalSetter, log, guest };
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

/** Poll a predicate that a background continuation is expected to satisfy. */
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${description}`);
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

  // A snapshot source is a LOCAL-backend-only configuration. The SDK boots a
  // sandbox from a snapshot ARTIFACT — a host-local directory under
  // `~/.microsandbox/snapshots/<name>/`, indexed in a local DB cache — which a
  // cloud create has no access to. Accepting the pairing and letting it fail at
  // the provider would surface as an opaque remote error on a path the caller
  // was told existed, so it is refused here instead.
  it("refuses a snapshot on the cloud backend, and refuses it before any SDK call", () => {
    const { sdk, log } = createHarness();
    assert.throws(
      () =>
        new MicrosandboxRuntime({
          backend: CLOUD_BACKEND,
          snapshot: "snap-1",
          homeDir: HOME_DIR,
          sdk,
        }),
      /snapshot/i,
    );
    // MUST NOT FIRE. The refusal rests on a provider fact known without asking
    // the provider, so it has to land before the SDK is touched at all — that
    // is what keeps it distinguishable from a backend outage.
    assert.deepEqual(log, [], "a refused configuration must not reach the SDK");
  });

  it("accepts a snapshot on the local backend", () => {
    const { sdk, log } = createHarness();
    const runtime = new MicrosandboxRuntime({
      backend: "local",
      snapshot: "snap-1",
      homeDir: HOME_DIR,
      sdk,
    });
    assert.equal(runtime.capabilities.snapshots, true);
    assert.deepEqual(log, []);
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

describe("backend gate (the scope is process-global)", () => {
  /** Walk the log and prove no two backends ever hold the scope at once. */
  const assertNoOverlappingScopes = (log: LogEntry[]) => {
    let open: unknown = null;
    for (const entry of log) {
      if (entry.fn === "withDefaultBackend:enter") {
        assert.equal(open, null, "a second backend entered while one was still open");
        open = entry.args[0];
      }
      if (entry.fn === "withDefaultBackend:exit") {
        assert.deepEqual(entry.args[0], open, "the wrong backend left the scope");
        open = null;
      }
    }
  };

  it("makes a call on another backend wait instead of overlapping", async () => {
    // `withDefaultBackend` mutates PROCESS-WIDE state and is documented as not
    // task-local: two overlapping scopes on different backends mean one call
    // runs against the wrong backend.
    let releaseFirst!: () => void;
    let creates = 0;
    const { sdk, log } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates > 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
      },
    });
    const cloud = makeRuntime(sdk);
    const local = makeRuntime(sdk, { backend: "local" });

    const first = cloud.launch({ name: "cloud-1" });
    const second = local.launch({ name: "local-1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      argsFor(log, "withDefaultBackend:enter").map((args) => args[0]),
      [CLOUD_BACKEND],
      "the second backend must not open a scope while the first is held",
    );
    assert.equal(
      argsFor(log, "builder.create").length,
      1,
      "the queued call must not reach the SDK on the wrong backend",
    );

    releaseFirst();
    await Promise.all([first, second]);
    assertNoOverlappingScopes(log);
    assert.deepEqual(
      argsFor(log, "withDefaultBackend:enter").map((args) => args[0]),
      [CLOUD_BACKEND, "local"],
    );
  });

  it("lets two calls on the same backend share one open scope", async () => {
    // Serializing everything would be correct and needlessly slow: calls that
    // want the backend that is already in scope cannot observe a wrong one.
    let releaseFirst!: () => void;
    let creates = 0;
    const { sdk, log } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates > 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
      },
    });
    const runtime = makeRuntime(sdk);
    const first = runtime.launch({ name: "a" });
    const second = runtime.launch({ name: "b" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      argsFor(log, "builder.create").length,
      2,
      "a same-backend call must not queue behind an in-flight one",
    );

    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(
      argsFor(log, "withDefaultBackend:enter").length,
      1,
      "one shared scope, entered once",
    );
    assertNoOverlappingScopes(log);
  });

  it("closes the scope before handing it to a different backend, even on failure", async () => {
    const { sdk, log } = createHarness({
      onCreate: () => Promise.reject(new Error("boot refused")),
    });
    const cloud = makeRuntime(sdk);
    const local = makeRuntime(sdk, { backend: "local" });
    await assert.rejects(cloud.launch({ name: "a" }), /boot refused/);
    await assert.rejects(local.launch({ name: "b" }), /boot refused/);
    assertNoOverlappingScopes(log);
  });

  it("still never reaches for the permanent process-wide setter", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "a" });
    assert.equal(called(log, "setDefaultBackend"), false);
  });

  it("does not hold the process-global gate across a backend-bound instance call", async () => {
    // `Sandbox` and `SandboxHandle` retain the backend they were resolved on
    // (`backendKind` on the instance; every method delegates to that bound
    // native object), so an instance call does NOT read the process default.
    // Holding the gate across one would let a single long exec block every
    // other backend's work in the process for the whole run.
    let releaseExec!: () => void;
    const { sdk } = createHarness({
      exec: () =>
        new Promise<ExecOutcome>((resolve) => {
          releaseExec = () => resolve({ code: 0, stdout: "" });
        }),
    });
    const cloud = makeRuntime(sdk);
    const local = makeRuntime(sdk, { backend: "local" });
    const handle = await cloud.launch({ name: "busy" });
    const running = cloud.runScript(handle, { command: "sleep 100" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const outcome = await Promise.race([
      local.launch({ name: "other" }).then(() => "launched"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 250)),
    ]);
    assert.equal(
      outcome,
      "launched",
      "a backend-bound instance call must not hold the process-global gate",
    );
    releaseExec();
    await running;
  });

  it("fails a queued call rather than waiting forever on an abandoned scope holder", async () => {
    // The create-timeout path is a SUPPORTED outcome, not an exotic one, and
    // the SDK exposes no way to cancel an in-flight create — so after the
    // deadline fires the create is still running. If the gate is held until
    // that abandoned create settles, every OTHER backend in the process is
    // blocked for an unbounded time by a call whose caller already gave up.
    //
    // The scope only has to cover the part that READS the process-global
    // default; it must not cover the wait for a result nobody is waiting for.
    let creates = 0;
    let finishFirstCreate!: () => void;
    const { sdk } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates > 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
            finishFirstCreate = resolve;
          });
      },
    });
    const cloud = makeRuntime(sdk, { backendQueueTimeoutMs: 150 });
    const local = makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 150 });

    await assert.rejects(
      cloud.launch({ name: "slow", createTimeoutSeconds: 0.02 }),
      MicrosandboxCreateTimeoutError,
    );

    // The local call cannot run: the cloud scope is held by a create nobody is
    // waiting for any more. The guarantee is NOT that it succeeds — that would
    // require changing the process default while an SDK call bound to the other
    // backend is still in flight, which is the mis-routing the gate exists to
    // prevent. The guarantee is that it does not hang forever.
    const outcome = await Promise.race([
      local.launch({ name: "local-1" }).then(
        () => "launched",
        (error: unknown) => (error instanceof MicrosandboxBackendBusyError ? "busy" : `other:${error}`),
      ),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 2_000)),
    ]);
    // Release before asserting: a failing assertion throws, and an abandoned
    // create still pending at that point would hold the gate for the rest of
    // the file, turning one honest red into a cascade of cancellations.
    finishFirstCreate();
    assert.equal(
      outcome,
      "busy",
      "a queued call must fail with a typed error, never hang, when the scope holder was abandoned",
    );
  });

  it("does not fail a queued call while the other backend is merely slow", async () => {
    // MUST NOT FIRE. The bound above must not turn ordinary contention into an
    // error: once the holder finishes, the queued call runs normally.
    let creates = 0;
    let finishFirstCreate!: () => void;
    const { sdk } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates > 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
            finishFirstCreate = resolve;
          });
      },
    });
    const cloud = makeRuntime(sdk, { backendQueueTimeoutMs: 5_000 });
    const local = makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 5_000 });
    const slow = cloud.launch({ name: "slow" });
    const queued = local.launch({ name: "local-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    finishFirstCreate();
    await slow;
    assert.equal((await queued).id, "local-1");
  });

  it("keeps interleaved two-runtime static calls on their own backend", async () => {
    // The discriminating one. `withDefaultBackend` mutates ONE process-wide
    // slot; this fake models exactly that slot, and every DEFAULT-DEPENDENT
    // static records the value it observed when it ran. Two runtimes on
    // different backends then interleave real work with an await inside every
    // call, so any overlap of two scopes shows up as a call that observed the
    // other runtime's backend.
    let processBackend: unknown = "unset";
    let depth = 0;
    let maxDepth = 0;
    const observed: Array<{ call: string; owner: string; backend: unknown }> = [];
    const gap = () => new Promise((resolve) => setTimeout(resolve, 1));
    const ownerOf = (name: string) => (name.startsWith("local") ? "local" : "cloud");

    const sdk: MicrosandboxSdk = {
      Sandbox: {
        builder(name: string) {
          // Recorded at BUILDER-CONSTRUCTION time, not at create() time: the
          // SDK constructs the native builder here, so the whole chain has to
          // sit inside one scope.
          const atConstruction = processBackend;
          const builder = {
            image: () => builder,
            fromSnapshot: () => builder,
            cpus: () => builder,
            memory: () => builder,
            workdir: () => builder,
            envs: () => builder,
            labels: () => builder,
            detached: () => builder,
            idleTimeout: () => builder,
            maxDuration: () => builder,
            replace: () => builder,
            async create() {
              await gap();
              observed.push({ call: "builder", owner: ownerOf(name), backend: atConstruction });
              observed.push({ call: "create", owner: ownerOf(name), backend: processBackend });
              return { name, execWith: async () => makeOutput({}), fs: () => ({}) } as never;
            },
          };
          return builder as never;
        },
        async get(name: string) {
          await gap();
          observed.push({ call: "get", owner: ownerOf(name), backend: processBackend });
          return null;
        },
        async listWith(configure) {
          let seen: Record<string, string> = {};
          const listBuilder = {
            limit: () => listBuilder,
            cursor: () => listBuilder,
            labels: (labels: Record<string, string>) => {
              seen = labels;
              return listBuilder;
            },
          };
          configure(listBuilder as never);
          await gap();
          observed.push({ call: "listWith", owner: seen.owner ?? "?", backend: processBackend });
          return { sandboxes: [] } as never;
        },
      },
      async withDefaultBackend(backend, fn) {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        const previous = processBackend;
        processBackend = backend;
        try {
          return await fn();
        } finally {
          processBackend = previous;
          depth -= 1;
        }
      },
    };

    const cloud = makeRuntime(sdk);
    const local = makeRuntime(sdk, { backend: "local" });
    const work: Array<Promise<unknown>> = [];
    for (let round = 0; round < 8; round += 1) {
      work.push(cloud.launch({ name: `cloud-${round}` }));
      work.push(local.launch({ name: `local-${round}` }));
      work.push(cloud.getById(`cloud-get-${round}`));
      work.push(local.getById(`local-get-${round}`));
      work.push(cloud.findAllByLabels({ owner: "cloud" }));
      work.push(local.findAllByLabels({ owner: "local" }));
    }
    await Promise.all(work);

    assert.equal(maxDepth, 1, "two backend scopes were open in the process at once");
    assert.ok(observed.length >= 8 * 6, `expected every call to be observed: ${observed.length}`);
    const wrong = observed.filter((entry) => {
      const expected = entry.owner === "local" ? "local" : CLOUD_BACKEND;
      try {
        assert.deepEqual(entry.backend, expected);
        return false;
      } catch {
        return true;
      }
    });
    assert.deepEqual(
      wrong,
      [],
      "a default-dependent static ran while the other runtime's backend was in scope",
    );
  });

  it("fails closed when the backend scope cannot be entered", async () => {
    // If the scope was never pushed, the process default is whatever someone
    // else set. Running the call anyway sends this runtime's work to an
    // arbitrary backend — the exact failure the gate exists to prevent.
    const reached: string[] = [];
    const sdk: MicrosandboxSdk = {
      Sandbox: {
        builder(name: string) {
          reached.push("builder");
          const builder = new Proxy({}, {
            get: (_target, prop) =>
              prop === "create"
                ? async () => {
                  reached.push("create");
                  return { name } as never;
                }
                : () => builder,
          });
          return builder as never;
        },
        async get() {
          reached.push("get");
          return null;
        },
        async listWith() {
          reached.push("listWith");
          return { sandboxes: [] } as never;
        },
      },
      async withDefaultBackend() {
        throw new Error("native backend scope bindings are unavailable");
      },
    };

    await assert.rejects(
      makeRuntime(sdk).launch({ name: "a" }),
      /native backend scope bindings are unavailable/,
    );
    assert.deepEqual(
      reached,
      [],
      "a call whose backend scope failed must not run on the process default",
    );
  });

  it("stays usable after a backend scope failure", async () => {
    // A gate that keeps its slot after a failed enter wedges every later call
    // in the process, on every backend, for good.
    let failNext = true;
    const sdk: MicrosandboxSdk = {
      Sandbox: {
        builder(name: string) {
          const builder = new Proxy({}, {
            get: (_target, prop) =>
              prop === "create" ? async () => ({ name }) as never : () => builder,
          });
          return builder as never;
        },
        async get() {
          return null;
        },
        async listWith() {
          return { sandboxes: [] } as never;
        },
      },
      withDefaultBackend(_backend, fn) {
        if (failNext) {
          failNext = false;
          // Thrown SYNCHRONOUSLY, exactly as the SDK's own missing-native-
          // binding guard does before it ever returns a promise.
          throw new Error("scope push failed");
        }
        return Promise.resolve().then(fn);
      },
    };

    const runtime = makeRuntime(sdk);
    await assert.rejects(runtime.launch({ name: "a" }), /scope push failed/);
    const outcome = await Promise.race([
      runtime.launch({ name: "b" }).then(() => "recovered"),
      new Promise((resolve) => setTimeout(() => resolve("wedged"), 250)),
    ]);
    assert.equal(outcome, "recovered", "a failed enter must not hold the gate shut");
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
    // Local backend: a snapshot source is only accepted there (see the
    // construction block), because the artifact is a host-local directory.
    await makeRuntime(sdk, { backend: "local", image: undefined, snapshot: "snap-7" })
      .launch({ name: "s1" });
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
    // The create is released at the end rather than left pending forever. An
    // abandoned scope holder really does hold the process-global backend gate
    // — that is a real defect, covered by its own test in "backend gate" — but
    // leaving one behind HERE would poison every later different-backend call
    // in this process and turn one defect into a suite-wide cascade.
    let releaseCreate!: () => void;
    const { sdk } = createHarness({
      onCreate: () => new Promise<void>((resolve) => { releaseCreate = resolve; }),
    });
    try {
      await assert.rejects(
        makeRuntime(sdk).launch({ name: "slow", createTimeoutSeconds: 0.02 }),
        (error: unknown) => {
          assert.ok(error instanceof MicrosandboxCreateTimeoutError);
          assert.equal(error.sandboxName, "slow");
          assert.equal(error.timeoutMs, 20);
          return true;
        },
      );
    } finally {
      releaseCreate();
    }
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

  it("reclaims a create that lands after the deadline instead of leaking it", async () => {
    // The SDK cannot cancel an in-flight create. A sandbox that finishes
    // booting after the caller gave up is a running microVM nobody is waiting
    // for, holding a name the next launch needs.
    let finishCreate!: () => void;
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      onCreate: () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    });
    await assert.rejects(
      makeRuntime(sdk).launch({ name: "slow", createTimeoutSeconds: 0.02 }),
      MicrosandboxCreateTimeoutError,
    );
    assert.equal(called(log, "handle.kill"), false, "nothing to reclaim while the create is in flight");

    finishCreate();
    await waitFor(() => called(log, "handle.remove"), "the late sandbox to be reclaimed");
    assert.deepEqual(firstArgs(log, "handle.kill"), ["slow"]);
    assert.deepEqual(firstArgs(log, "handle.remove"), ["slow"]);
  });

  // Guard rather than a fix: `Promise.race` already consumed the late
  // rejection. It stays because the reclamation path attaches handlers of its
  // own, and losing that consumption would surface as a process-level crash.
  it("leaves no unhandled rejection when the late create fails on its own", async () => {
    let failCreate!: (error: Error) => void;
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      onCreate: () =>
        new Promise<void>((_resolve, reject) => {
          failCreate = reject;
        }),
    });
    const rejections: unknown[] = [];
    const record = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      await assert.rejects(
        makeRuntime(sdk).launch({ name: "slow", createTimeoutSeconds: 0.02 }),
        MicrosandboxCreateTimeoutError,
      );
      failCreate(new Error("boot failed"));
      // Two macrotask turns: Node reports an unhandled rejection one tick after
      // the promise settles with no handler attached.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(rejections, [], "the abandoned create must be consumed, not dropped");
      assert.equal(
        called(log, "handle.kill"),
        false,
        "a create that failed on its own left nothing to reclaim",
      );
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("holds a relaunch of the same name until the reclamation finishes", async () => {
    let finishCreate!: () => void;
    let creates = 0;
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      onCreate: () => {
        creates += 1;
        // Only the first create is held open; the relaunch boots immediately.
        return creates > 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
            finishCreate = resolve;
          });
      },
    });
    const runtime = makeRuntime(sdk);
    await assert.rejects(
      runtime.launch({ name: "slow", createTimeoutSeconds: 0.02 }),
      MicrosandboxCreateTimeoutError,
    );
    finishCreate();
    // The relaunch is issued while the reclamation is still pending; if it did
    // not wait, the reclamation would delete the sandbox it just created.
    await runtime.launch({ name: "slow" });
    const order = names(log).filter(
      (entry) => entry === "handle.remove" || entry === "builder.create",
    );
    assert.deepEqual(order, ["builder.create", "handle.remove", "builder.create"]);
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

  it("keeps looking past a page of excluded sandboxes", async () => {
    // Applying exclusions to an already-capped page answers "nothing warm
    // available" whenever the first page happens to be full of sandboxes the
    // caller already holds — and the caller then launches a cold sandbox it
    // did not need.
    const { sdk } = createHarness({
      pages: [
        { sandboxes: [{ name: "claimed-1" }, { name: "claimed-2" }], nextCursor: "c1" },
        { sandboxes: [{ name: "free" }] },
      ],
    });
    const found = await makeRuntime(sdk).findByLabels(
      {},
      { excludeIds: ["claimed-1", "claimed-2"], pageSize: 2 },
    );
    assert.equal(found?.id, "free");
  });

  it("counts the cap against sandboxes the caller can actually use", async () => {
    const { sdk } = createHarness({
      pages: [{ sandboxes: [{ name: "claimed" }, { name: "free" }] }],
    });
    const handles = await makeRuntime(sdk).findAllByLabels(
      {},
      { excludeIds: ["claimed"], limit: 1 },
    );
    assert.deepEqual(handles.map((handle) => handle.id), ["free"]);
  });

  it("honours exclusions on the full listing too", async () => {
    const { sdk } = createHarness({
      pages: [{ sandboxes: [{ name: "a" }, { name: "b" }] }],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({}, { excludeIds: ["a"] });
    assert.deepEqual(handles.map((handle) => handle.id), ["b"]);
  });

  it("treats pageSize as a request size, not a result cap", async () => {
    // pageSize sizes each request; capping RESULTS by it silently truncates a
    // listing the caller asked to receive in full.
    const { sdk } = createHarness({
      pages: [
        { sandboxes: [{ name: "a" }], nextCursor: "c1" },
        { sandboxes: [{ name: "b" }] },
      ],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({}, { pageSize: 1 });
    assert.deepEqual(handles.map((handle) => handle.id), ["a", "b"]);
  });

  // All three release their hung listing at the end: see the note on the
  // create-deadline test above. The listing genuinely holds the process-global
  // backend gate until it settles, which is covered in "backend gate".
  it("stops draining pages when the lookup deadline elapses", async () => {
    // Without a deadline a listing that never answers hangs the caller's
    // request forever, holding a warm-lease decision open indefinitely.
    let releaseList!: () => void;
    const { sdk } = createHarness({
      listWith: () => new Promise<void>((resolve) => { releaseList = resolve; }),
    });
    try {
      await assert.rejects(
        makeRuntime(sdk).findAllByLabels({}, { timeoutMs: 20 }),
        (error: unknown) => {
          assert.ok(error instanceof MicrosandboxLookupTimeoutError);
          assert.equal(error.timeoutMs, 20);
          return true;
        },
      );
    } finally {
      releaseList();
    }
  });

  it("bounds a count with the same deadline", async () => {
    let releaseList!: () => void;
    const { sdk } = createHarness({
      listWith: () => new Promise<void>((resolve) => { releaseList = resolve; }),
    });
    try {
      await assert.rejects(
        makeRuntime(sdk).countByLabels({}, { timeoutMs: 20 }),
        MicrosandboxLookupTimeoutError,
      );
    } finally {
      releaseList();
    }
  });

  it("applies the runtime's configured lookup deadline when the caller gives none", async () => {
    let releaseList!: () => void;
    const { sdk } = createHarness({
      listWith: () => new Promise<void>((resolve) => { releaseList = resolve; }),
    });
    try {
      await assert.rejects(
        makeRuntime(sdk, { lookupTimeoutMs: 20 }).findByLabels({}),
        MicrosandboxLookupTimeoutError,
      );
    } finally {
      releaseList();
    }
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

describe("pagination fails closed", () => {
  // A warm-lease decision is made from the ANSWER to a listing. A drain that
  // gives up quietly — on a cursor that never advances, or on a page body the
  // adapter cannot read — hands back a short list the caller cannot tell apart
  // from "there is nothing else", and the caller launches a cold sandbox it
  // did not need or under-counts a quota it is enforcing.

  it("refuses a cursor that never advances instead of truncating the listing", async () => {
    const { sdk, log } = createHarness({
      rawPages: [
        { sandboxes: [{ name: "a", status: "running" }], nextCursor: "c1" },
        { sandboxes: [{ name: "b", status: "running" }], nextCursor: "c1" },
      ],
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({}),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxPaginationError);
        assert.match(error.message, /cursor/i);
        return true;
      },
    );
    assert.equal(
      argsFor(log, "Sandbox.listWith").length,
      2,
      "the repeat must be caught on the page that repeats it, not after a spin",
    );
  });

  it("refuses a cursor that is not a string", async () => {
    const { sdk, log } = createHarness({
      rawPages: [{ sandboxes: [], nextCursor: 42 }],
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({}),
      MicrosandboxPaginationError,
    );
    assert.equal(
      called(log, "list.cursor"),
      false,
      "an unreadable cursor must never be sent back to the provider",
    );
  });

  it("refuses a page whose entries are not a listing", async () => {
    const { sdk } = createHarness({ rawPages: [{ sandboxes: null }] });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({}),
      MicrosandboxPaginationError,
    );
  });

  it("refuses a page that is not an object at all", async () => {
    const { sdk } = createHarness({ rawPages: ["not-a-page"] });
    await assert.rejects(
      makeRuntime(sdk).findByLabels({}),
      MicrosandboxPaginationError,
    );
  });

  it("fails a count closed too, rather than under-reporting it", async () => {
    const { sdk } = createHarness({ rawPages: [{ sandboxes: null }] });
    await assert.rejects(
      makeRuntime(sdk).countByLabels({}),
      MicrosandboxPaginationError,
    );
  });

  it("still accepts a well-formed listing that ends without a cursor", async () => {
    const { sdk } = createHarness({
      rawPages: [{ sandboxes: [{ name: "a", status: "running" }] }],
    });
    const handles = await makeRuntime(sdk).findAllByLabels({});
    assert.deepEqual(handles.map((handle) => handle.id), ["a"]);
  });
});

describe("limit / pageSize parity with the other runtimes", () => {
  // Daytona, E2B and the local runtime all resolve the request size the same
  // way — `options.limit ?? options.pageSize` — so a caller that has tuned one
  // provider's lookup gets the same request shape here.

  it("sends limit as the page request size", async () => {
    const { sdk, log } = createHarness({
      pages: [{ sandboxes: [{ name: "a" }, { name: "b" }] }],
    });
    await makeRuntime(sdk).findAllByLabels({}, { limit: 2 });
    assert.deepEqual(argsFor(log, "list.limit"), [[2]]);
  });

  it("prefers limit over pageSize, exactly as the other runtimes do", async () => {
    const { sdk, log } = createHarness({
      pages: [{ sandboxes: [{ name: "a" }, { name: "b" }, { name: "c" }] }],
    });
    await makeRuntime(sdk).findAllByLabels({}, { limit: 3, pageSize: 7 });
    assert.deepEqual(argsFor(log, "list.limit"), [[3]]);
  });

  it("falls back to pageSize when the caller gives no limit", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [] }] });
    await makeRuntime(sdk).findAllByLabels({}, { pageSize: 7 });
    assert.deepEqual(argsFor(log, "list.limit"), [[7]]);
  });

  it("falls back to the runtime's configured page size when given neither", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [] }] });
    await makeRuntime(sdk, { listPageSize: 25 }).findAllByLabels({});
    assert.deepEqual(argsFor(log, "list.limit"), [[25]]);
  });

  it("resolves the request size the same way on a count", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [] }] });
    await makeRuntime(sdk).countByLabels({}, { limit: 4 });
    assert.deepEqual(argsFor(log, "list.limit"), [[4]]);
  });
});

describe("lookup ownership parity with the Daytona adapter", () => {
  // Daytona registers every found sandbox with `owned: options.owned ?? false`
  // (runtime.ts registerSandbox call sites). Dropping that here means an
  // explicit claim is silently ignored and the claimed sandbox can never be
  // torn down — a leaked microVM whose name is also held forever.

  it("honours an ownership claim made through findByLabels", async () => {
    const { sdk, log } = createHarness({
      pages: [{ sandboxes: [{ name: "warm" }] }],
      get: (name) => ({ name }),
    });
    const runtime = makeRuntime(sdk);
    const found = await runtime.findByLabels({ team: "a" }, { owned: true });
    assert.equal(found?.id, "warm");

    await runtime.destroy(found as RuntimeHandle);
    assert.deepEqual(
      names(log).filter((fn) => fn === "handle.kill" || fn === "handle.remove"),
      ["handle.kill", "handle.remove"],
      "a claimed sandbox must be tearable down",
    );
  });

  it("honours an ownership claim made through findAllByLabels", async () => {
    const { sdk, log } = createHarness({
      pages: [{ sandboxes: [{ name: "warm" }] }],
      get: (name) => ({ name }),
    });
    const runtime = makeRuntime(sdk);
    const [found] = await runtime.findAllByLabels({ team: "a" }, { owned: true });
    await runtime.destroy(found as RuntimeHandle);
    assert.deepEqual(
      names(log).filter((fn) => fn === "handle.kill" || fn === "handle.remove"),
      ["handle.kill", "handle.remove"],
    );
  });

  it("never claims a found sandbox by default, so a borrowed lease survives destroy", async () => {
    const { sdk, log } = createHarness({
      pages: [{ sandboxes: [{ name: "borrowed" }] }],
      get: (name) => ({ name }),
    });
    const runtime = makeRuntime(sdk);
    const found = await runtime.findByLabels({ team: "a" });
    await runtime.destroy(found as RuntimeHandle);
    assert.equal(
      called(log, "handle.kill") || called(log, "handle.remove"),
      false,
      "finding a sandbox by label is an attach, not a claim",
    );
  });

  it("keeps a launched sandbox owned even when a later lookup does not claim it", async () => {
    const { sdk, log } = createHarness({
      pages: [{ sandboxes: [{ name: "mine" }] }],
      get: (name) => ({ name }),
    });
    const runtime = makeRuntime(sdk);
    const launched = await runtime.launch({ name: "mine" });
    await runtime.findByLabels({ team: "a" });
    await runtime.destroy(launched);
    assert.deepEqual(
      names(log).filter((fn) => fn === "handle.kill" || fn === "handle.remove"),
      ["handle.kill", "handle.remove"],
      "an unclaimed lookup must not demote a sandbox this runtime launched",
    );
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
  it("admits a run through the guest wrapper and reports its pid", async () => {
    const { sdk, log, guest } = createHarness({ get: (name) => ({ name }) });
    const started = await makeRuntime(sdk).startScript({ id: "s1" }, {
      command: "long-running --job 7",
      sessionId: "sess-1",
    });

    assert.equal(started.sessionId, "sess-1");
    assert.equal(started.commandId, "1000");
    assert.equal(started.reconciled, undefined, "a first admission is not a reconciliation");
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.deepEqual(argv, [
      "-c",
      MICROSANDBOX_RUN_ADMIT_SCRIPT,
      "msb-admit",
      // The command travels as an ARGUMENT, never interpolated into script
      // text, so nothing on the host can rewrite or mis-quote it.
      "long-running --job 7",
      "/tmp/microsandbox-run/sess-1",
      "/tmp/microsandbox-run",
      "/bin/sh",
    ]);
    assert.equal(guest.admissions.length, 1);
  });

  it("honours a custom run state directory", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk, { runStateDir: "/var/run/msb/" }).startScript({ id: "s1" }, {
      command: "true",
      sessionId: "sess-1",
    });
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.equal(argv[4], "/var/run/msb/sess-1");
    assert.equal(argv[5], "/var/run/msb");
  });

  it("passes the configured shell to the guest wrapper", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk, { shell: "/bin/bash" }).startScript({ id: "s1" }, {
      command: "true",
      sessionId: "sess-1",
    });
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.equal(argv[6], "/bin/bash");
    assert.deepEqual(firstArgs(log, "sandbox.execWith"), ["/bin/bash"]);
  });

  it("encodes a session id reversibly instead of sanitizing it", async () => {
    // `a/b` and `a_b` are different sessions. A replace-with-underscore
    // sanitizer maps them onto one directory, which is enough to report one
    // run's exit code as the other's.
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.startScript({ id: "s1" }, { command: "true", sessionId: "a/b" });
    await runtime.startScript({ id: "s1" }, { command: "true", sessionId: "a_b" });
    const dirs = argsFor(log, "exec.args").map((args) => (args[0] as string[])[4]);
    assert.deepEqual(dirs, ["/tmp/microsandbox-run/a%2Fb", "/tmp/microsandbox-run/a_b"]);
    assert.notEqual(dirs[0], dirs[1], "two different session ids must never share a directory");
  });

  it("escapes the percent sign it uses as the escape character", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.startScript({ id: "s1" }, { command: "true", sessionId: "a%2Fb" });
    await runtime.startScript({ id: "s1" }, { command: "true", sessionId: "a/b" });
    const dirs = argsFor(log, "exec.args").map((args) => (args[0] as string[])[4]);
    assert.notEqual(dirs[0], dirs[1], "the encoding must stay reversible");
  });

  it("collapses an over-long session id onto a digest that stays unique", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.startScript({ id: "s1" }, { command: "true", sessionId: `${"x".repeat(200)}a` });
    await runtime.startScript({ id: "s1" }, { command: "true", sessionId: `${"x".repeat(200)}b` });
    const dirs = argsFor(log, "exec.args").map((args) => (args[0] as string[])[4]);
    for (const dir of dirs) {
      const segment = dir.slice("/tmp/microsandbox-run/".length);
      assert.ok(segment.length <= 65, `segment stayed ${segment.length} bytes long`);
      assert.match(segment, /^\.[0-9a-f]{64}$/);
    }
    assert.notEqual(dirs[0], dirs[1]);
  });

  it("generates a session id when the caller supplies none", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name }) });
    const started = await makeRuntime(sdk).startScript({ id: "s1" }, { command: "true" });
    assert.match(started.sessionId, /^run-s1-/);
  });

  it("bounds only the submit call with the caller's timeout", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).startScript({ id: "s1" }, {
      command: "sleep 600",
      sessionId: "sess-1",
      timeoutMs: 5_000,
    });
    // The submit is bounded; the backgrounded run is not, because its lifetime
    // is the sandbox's rather than the submitting request's.
    assert.deepEqual(firstArgs(log, "exec.timeout"), [5_000]);
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.equal(argv[3], "sleep 600");
  });

  it("adopts the existing run when the same session is submitted twice", async () => {
    // The outcome-unknown case: the first submit was admitted but its response
    // was lost, so the caller retries. Adopting is the only answer that does
    // not start a second process or overwrite the first one's state.
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const first = await runtime.startScript({ id: "s1" }, {
      command: "job --once",
      sessionId: "sess-1",
    });
    const second = await runtime.startScript({ id: "s1" }, {
      command: "job --once",
      sessionId: "sess-1",
    });

    assert.equal(second.reconciled, true);
    assert.equal(second.commandId, first.commandId);
    assert.equal(guest.admissions.length, 1, "a retry must not start a second process");
  });

  it("refuses a session id already admitted for a different command", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.startScript({ id: "s1" }, { command: "first", sessionId: "sess-1" });
    await assert.rejects(
      runtime.startScript({ id: "s1" }, { command: "second", sessionId: "sess-1" }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxSessionConflictError);
        assert.equal(error.sessionId, "sess-1");
        return true;
      },
    );
    assert.equal(guest.admissions.length, 1, "a conflicting submit must start nothing");
    assert.equal(
      guest.runs.get("/tmp/microsandbox-run/sess-1")?.command,
      "first",
      "the first run's state must not be overwritten",
    );
  });

  it("never reports a stale run's exit code as the new run's", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const first = await runtime.startScript({ id: "s1" }, {
      command: "job --once",
      sessionId: "sess-1",
    });
    guest.finish("/tmp/microsandbox-run/sess-1", 5);

    // Same session id, different command: the finished run's exit code belongs
    // to the finished run, and the refusal is what keeps it that way.
    await assert.rejects(
      runtime.startScript({ id: "s1" }, { command: "job --again", sessionId: "sess-1" }),
      MicrosandboxSessionConflictError,
    );
    assert.deepEqual(
      await runtime.getScriptStatus({ id: "s1" }, "sess-1", first.commandId),
      { exitCode: 5 },
    );
  });

  it("surfaces an admission that produced no verdict", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 127, stderr: "sh: not found" }),
    });
    await assert.rejects(
      makeRuntime(sdk).startScript({ id: "s1" }, { command: "true", sessionId: "sess-1" }),
      /returned no verdict \(exit 127\): sh: not found/,
    );
  });
});

describe("getScriptStatus", () => {
  it("reports still-running while the run is alive", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, {
      command: "sleep 600",
      sessionId: "sess-1",
    });
    assert.deepEqual(
      await runtime.getScriptStatus({ id: "s1" }, "sess-1", started.commandId),
      { exitCode: null },
    );
  });

  it("reports a zero exit", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, { command: "true", sessionId: "sess-1" });
    guest.finish("/tmp/microsandbox-run/sess-1", 0);
    assert.deepEqual(
      await runtime.getScriptStatus({ id: "s1" }, "sess-1", started.commandId),
      { exitCode: 0 },
    );
  });

  it("reports a non-zero exit", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, { command: "false", sessionId: "sess-1" });
    guest.finish("/tmp/microsandbox-run/sess-1", 137);
    assert.deepEqual(
      await runtime.getScriptStatus({ id: "s1" }, "sess-1", started.commandId),
      { exitCode: 137 },
    );
  });

  it("ends the poll when the run's process is gone without an exit code", async () => {
    // Without this, a run killed by the OOM reaper polls at exitCode:null
    // forever: the exit file it would have written never arrives.
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, {
      command: "sleep 600",
      sessionId: "sess-1",
    });
    guest.kill("/tmp/microsandbox-run/sess-1");
    await assert.rejects(
      runtime.getScriptStatus({ id: "s1" }, "sess-1", started.commandId),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxRunLostError);
        assert.equal(error.sessionId, "sess-1");
        assert.equal(error.commandId, started.commandId);
        assert.match(error.message, /never recorded an exit code/);
        return true;
      },
    );
  });

  it("ends the poll when the run state is gone entirely", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name }) });
    await assert.rejects(
      makeRuntime(sdk).getScriptStatus({ id: "s1" }, "never-started", "1"),
      MicrosandboxRunLostError,
    );
  });

  it("ends the poll when the sandbox restarted under the run", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, {
      command: "sleep 600",
      sessionId: "sess-1",
    });
    guest.restartSandbox();
    await assert.rejects(
      runtime.getScriptStatus({ id: "s1" }, "sess-1", started.commandId),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxRunLostError);
        assert.match(error.message, /sandbox restarted/);
        return true;
      },
    );
  });

  it("never invents an exit code from an unreadable exit record", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, { command: "true", sessionId: "sess-1" });
    guest.finish("/tmp/microsandbox-run/sess-1", "garbage");
    await assert.rejects(
      runtime.getScriptStatus({ id: "s1" }, "sess-1", started.commandId),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxRunLostError);
        assert.match(error.message, /unreadable/);
        return true;
      },
    );
  });

  it("asks the guest through one bounded probe rather than reading files", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, { command: "true", sessionId: "sess-1" });
    log.length = 0;
    await runtime.getScriptStatus({ id: "s1" }, "sess-1", started.commandId);
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.deepEqual(argv, [
      "-c",
      MICROSANDBOX_RUN_STATUS_SCRIPT,
      "msb-status",
      "/tmp/microsandbox-run/sess-1",
    ]);
    assert.equal(called(log, "fs.readToString"), false);
  });

  it("degrades to still-running when the probe itself fails", async () => {
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

  it("degrades to still-running when the probe returns nothing recognizable", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ stdout: "" }),
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

describe("getExecLogs (bootstrap plane)", () => {
  const startedRun = async (sdk: MicrosandboxSdk) => {
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, {
      command: "job",
      sessionId: "sess-1",
    });
    return { runtime, started };
  };

  it("reports the exit code the run actually recorded", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const { runtime, started } = await startedRun(sdk);
    guest.write("/tmp/microsandbox-run/sess-1", "boom\n");
    guest.finish("/tmp/microsandbox-run/sess-1", 7);

    assert.deepEqual(
      await runtime.getExecLogs({ id: "s1" }, "sess-1", started.commandId),
      { output: "boom\n", exitCode: 7 },
    );
  });

  it("refuses to report a still-running run as a success", async () => {
    // `ExecResult.exitCode` is a number, so defaulting the log read's `null`
    // to 0 reports every unfinished run as a clean success.
    const { sdk } = createHarness({ get: (name) => ({ name }) });
    const { runtime, started } = await startedRun(sdk);
    await assert.rejects(
      runtime.getExecLogs({ id: "s1" }, "sess-1", started.commandId),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxRunNotFinishedError);
        assert.equal(error.sessionId, "sess-1");
        return true;
      },
    );
  });

  it("refuses to report a lost run as a success", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const { runtime, started } = await startedRun(sdk);
    guest.kill("/tmp/microsandbox-run/sess-1");
    await assert.rejects(
      runtime.getExecLogs({ id: "s1" }, "sess-1", started.commandId),
      MicrosandboxRunLostError,
    );
  });

  it("reports a zero exit as a zero exit", async () => {
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const { runtime, started } = await startedRun(sdk);
    guest.finish("/tmp/microsandbox-run/sess-1", 0);
    const result = await runtime.getExecLogs({ id: "s1" }, "sess-1", started.commandId);
    assert.equal(result.exitCode, 0);
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
  it("start resumes a sandbox this runtime owns and reports it STARTED", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name, status: "stopped" }) });
    const runtime = makeRuntime(sdk);
    await runtime.getById("s1", { owned: true, states: null });
    const handle = await runtime.start({ id: "s1", state: "STOPPED" });
    assert.equal(handle.state, "STARTED");
    assert.equal(called(log, "handle.start"), true);
  });

  it("start on a vanished owned sandbox is an error, not a silent no-op", async () => {
    const { sdk } = createHarness({ get: () => null });
    const runtime = makeRuntime(sdk);
    await runtime.launch({ name: "ghost" });
    await assert.rejects(runtime.start({ id: "ghost" }), /no longer available/);
  });

  it("never boots a sandbox this runtime does not own", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name, status: "stopped" }) });
    const runtime = makeRuntime(sdk);
    await runtime.getById("borrowed", { states: null });
    await runtime.start({ id: "borrowed" });
    assert.equal(
      called(log, "handle.start"),
      false,
      "a sandbox someone else chose to stop must stay stopped",
    );
  });

  it("stop halts a sandbox this runtime owns", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.launch({ name: "s1" });
    await runtime.stop({ id: "s1" });
    assert.deepEqual(firstArgs(log, "handle.stop"), ["s1"]);
  });

  it("never halts a sandbox this runtime does not own", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.getById("borrowed");
    await runtime.stop({ id: "borrowed" });
    assert.equal(called(log, "handle.stop"), false, "a warm lease is borrowed, not owned");
  });

  it("stop on a vanished owned sandbox is idempotent", async () => {
    const { sdk, log } = createHarness({ get: () => null });
    const runtime = makeRuntime(sdk);
    await runtime.launch({ name: "ghost" });
    await runtime.stop({ id: "ghost" });
    assert.equal(called(log, "handle.stop"), false);
  });
});

describe("destroy", () => {
  const ownedRuntime = async (sdk: MicrosandboxSdk, name = "s1") => {
    const runtime = makeRuntime(sdk);
    await runtime.launch({ name });
    return runtime;
  };

  it("kills and then removes a sandbox it launched, so the name is reusable", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = await ownedRuntime(sdk);
    await runtime.destroy({ id: "s1" });
    const order = names(log).filter((n) => n === "handle.kill" || n === "handle.remove");
    assert.deepEqual(order, ["handle.kill", "handle.remove"]);
  });

  it("deletes nothing for a sandbox this runtime never claimed", async () => {
    // The failure this prevents: a lease-reattach path resolves a sandbox by
    // name and tears it down, deleting a microVM another worker is using.
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.getById("borrowed");
    assert.ok(handle);
    await runtime.destroy(handle);
    assert.equal(called(log, "handle.kill"), false);
    assert.equal(called(log, "handle.remove"), false);
  });

  it("deletes nothing for a handle this runtime has never seen", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).destroy({ id: "someone-elses-sandbox" });
    assert.equal(called(log, "Sandbox.get"), false, "an unknown handle is not this runtime's to delete");
    assert.equal(called(log, "handle.kill"), false);
    assert.equal(called(log, "handle.remove"), false);
  });

  it("deletes a sandbox the caller explicitly claimed on attach", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.getById("adopted", { owned: true });
    assert.ok(handle);
    await runtime.destroy(handle);
    assert.equal(called(log, "handle.kill"), true);
    assert.equal(called(log, "handle.remove"), true);
  });

  it("keeps ownership of a launched sandbox across a later unclaimed attach", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.launch({ name: "s1" });
    await runtime.getById("s1");
    await runtime.destroy({ id: "s1" });
    assert.equal(
      called(log, "handle.kill"),
      true,
      "an attach must not demote a sandbox this runtime launched",
    );
  });

  it("is a no-op for an owned sandbox that is already gone", async () => {
    const { sdk, log } = createHarness({ get: () => null });
    const runtime = await ownedRuntime(sdk, "ghost");
    await runtime.destroy({ id: "ghost" });
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
    const runtime = await ownedRuntime(sdk);
    await runtime.destroy({ id: "s1" });
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
    const runtime = await ownedRuntime(sdk);
    await assert.rejects(runtime.destroy({ id: "s1" }), /hypervisor wedged/);
    assert.equal(
      called(log, "handle.remove"),
      false,
      "removing the record of a sandbox that may still be running would orphan the microVM",
    );
  });

  it("keeps ownership after a failed teardown so the caller can retry it", async () => {
    let failNext = true;
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          if (failNext) {
            failNext = false;
            throw sdkError("runtime", "hypervisor wedged");
          }
        },
      }),
    });
    const runtime = await ownedRuntime(sdk);
    await assert.rejects(runtime.destroy({ id: "s1" }), /hypervisor wedged/);
    await runtime.destroy({ id: "s1" });
    assert.equal(called(log, "handle.remove"), true, "the retry must still be allowed to delete");
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
    const runtime = await ownedRuntime(sdk);
    await runtime.destroy({ id: "s1" });
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
  // The capability set is BACKEND-SENSITIVE, and `snapshots` is the field that
  // differs. Microsandbox snapshot artifacts are host-local — the SDK stores
  // them under `~/.microsandbox/snapshots/<name>/` and `Snapshot.list()` reads
  // a local DB cache — so a cloud create cannot source one. Reporting a flat
  // `snapshots: true` told a caller on the cloud backend that a boot path
  // exists which the provider does not offer.
  it("declares snapshot support on the local backend, where the boot path exists", () => {
    const { sdk } = createHarness();
    assert.deepEqual(makeRuntime(sdk, { backend: "local" }).capabilities, {
      pty: false,
      snapshots: true,
      isolation: "strong",
      persistentHandle: true,
      streamingLogs: false,
    });
  });

  // Cloud differs on BOTH backend-sensitive fields. `isolation: "unknown"` is
  // the honest value: microsandbox's cloud isolation is vendor-documented but
  // this adapter measures nothing about it, and publishing "strong" would be
  // publishing a guarantee nobody here verified.
  it("does NOT declare snapshot support on the cloud backend, and reports isolation as unknown", () => {
    const { sdk } = createHarness();
    assert.deepEqual(makeRuntime(sdk).capabilities, {
      pty: false,
      snapshots: false,
      isolation: "unknown",
      persistentHandle: true,
      streamingLogs: false,
    });
  });

  // Guard against the easy over-correction: "unknown" must not leak onto the
  // local backend, where the microVM boot path IS established.
  it("keeps strong isolation on the local backend", () => {
    const { sdk } = createHarness();
    assert.equal(makeRuntime(sdk, { backend: "local" }).capabilities.isolation, "strong");
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

  // MUST FIRE: the local claim is backed by a real SDK call, not by the mere
  // existence of `fromSnapshot` on the builder type.
  it("backs its local snapshots claim with a real snapshot boot path", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk, { backend: "local", image: undefined, snapshot: "snap-1" })
      .launch({ name: "s1" });
    assert.equal(called(log, "builder.fromSnapshot"), true);
    assert.equal(called(log, "builder.image"), false, "a snapshot boot has no image source");
  });

  // MUST NOT FIRE: a cloud launch never reaches the snapshot boot path, because
  // a cloud runtime cannot be configured with a snapshot in the first place.
  it("never takes the snapshot boot path on the cloud backend", async () => {
    const { sdk, log } = createHarness();
    await makeRuntime(sdk).launch({ name: "s1" });
    assert.equal(called(log, "builder.fromSnapshot"), false);
    assert.equal(called(log, "builder.image"), true);
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

// ---------------------------------------------------------------------------
// Guest run protocol, executed against a real POSIX shell.
//
// The adapter models the guest in every test above; these run the two shell
// scripts themselves, under `/bin/sh`, on real files. No provider, no
// credential, no sandbox — just the guarantees the async-run path is built on:
// one admission per session, adoption of an identical resubmit, refusal of a
// conflicting one, an exit code recorded even when the command exits the
// shell, and a lost run that reads as lost instead of as still running.
// ---------------------------------------------------------------------------

const SHELL_SKIP = process.platform === "win32"
  ? "POSIX shell protocol tests need /bin/sh"
  : false;

function sh(
  script: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", script, "msb-test", ...args],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number"
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`timed out waiting for ${path}`);
}

describe("guest run protocol (real /bin/sh)", { skip: SHELL_SKIP }, () => {
  let root = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "msb-protocol-"));
  });

  after(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const admit = (command: string, session: string) => {
    const dir = join(root, session);
    return sh(MICROSANDBOX_RUN_ADMIT_SCRIPT, [command, dir, root, "/bin/sh"]);
  };
  const probe = (session: string) =>
    sh(MICROSANDBOX_RUN_STATUS_SCRIPT, [join(root, session)]);

  it("admits a run, records it, and captures combined output", async () => {
    const admitted = await admit("printf out; printf err >&2", "captured");
    assert.match(admitted.stdout.trim(), /^ADMITTED \d+$/);

    const dir = join(root, "captured");
    assert.equal(await waitForFile(join(dir, "exit")), "0");
    assert.equal(await readFile(join(dir, "out"), "utf8"), "outerr");
    assert.equal(await readFile(join(dir, "cmd"), "utf8"), "printf out; printf err >&2");
    assert.equal(
      (await probe("captured")).stdout.trim(),
      "EXIT 0",
      "a finished run reports its recorded code",
    );
  });

  it("records an exit code even when the command exits the shell", async () => {
    // `exit 7` inside the command would end the wrapper too if the command ran
    // in the wrapper's own shell — and the exit file would never be written,
    // leaving the caller polling forever.
    await admit("printf hi; exit 7", "exits");
    const dir = join(root, "exits");
    assert.equal(await waitForFile(join(dir, "exit")), "7");
    assert.equal(await readFile(join(dir, "out"), "utf8"), "hi");
    assert.equal((await probe("exits")).stdout.trim(), "EXIT 7");
  });

  it("adopts an identical resubmit instead of starting a second process", async () => {
    const counter = join(root, "counter");
    const command = `printf x >> ${JSON.stringify(counter)}`;
    const first = await admit(command, "adopt");
    await waitForFile(join(root, "adopt", "exit"));

    const second = await admit(command, "adopt");
    assert.equal(second.stdout.trim(), first.stdout.trim().replace("ADMITTED", "CLAIMED"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await readFile(counter, "utf8"), "x", "the command ran exactly once");
  });

  it("refuses a conflicting resubmit and overwrites nothing", async () => {
    const marker = join(root, "conflict-marker");
    await admit(`printf first > ${JSON.stringify(marker)}`, "conflict");
    await waitForFile(join(root, "conflict", "exit"));

    const conflicting = await admit(`printf second > ${JSON.stringify(marker)}`, "conflict");
    assert.equal(conflicting.stdout.trim(), "CONFLICT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await readFile(marker, "utf8"), "first", "the second command never ran");
    assert.equal(
      await readFile(join(root, "conflict", "cmd"), "utf8"),
      `printf first > ${JSON.stringify(marker)}`,
      "the admitted command record is immutable",
    );
  });

  it("reports a live run as running and a killed one as lost", async () => {
    const admitted = await admit("sleep 30", "lost");
    const pid = Number.parseInt(admitted.stdout.trim().split(" ")[1] ?? "", 10);
    assert.ok(Number.isFinite(pid));
    assert.equal((await probe("lost")).stdout.trim(), "RUNNING");

    process.kill(pid, "SIGKILL");
    const gone = () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    await waitFor(gone, "the run process to die");
    assert.equal(
      (await probe("lost")).stdout.trim(),
      "LOST process-gone",
      "a run whose process is gone can never record an exit code",
    );
  });

  it("adopts a resubmit of a command that ends in a newline", async () => {
    // `existing=$(cat "$dir/cmd")` strips EVERY trailing newline, so comparing
    // the recorded command that way makes a byte-identical resubmit look like
    // a different command. The caller then gets a conflict for the one run it
    // is actually entitled to adopt — the outcome-unknown retry the whole
    // admission protocol exists to serve.
    const command = "printf hi\n";
    const first = await admit(command, "trailing-newline");
    assert.match(first.stdout.trim(), /^ADMITTED \d+$/);
    await waitForFile(join(root, "trailing-newline", "exit"));

    const second = await admit(command, "trailing-newline");
    assert.equal(
      second.stdout.trim(),
      first.stdout.trim().replace("ADMITTED", "CLAIMED"),
      "a byte-identical resubmit is adopted, whatever bytes the command ends in",
    );
  });

  it("still refuses a resubmit that differs only by a trailing newline", async () => {
    // The must-not-fire half: the fix has to compare the exact bytes, not
    // normalize both sides into agreeing.
    await admit("printf a", "newline-differs");
    await waitForFile(join(root, "newline-differs", "exit"));

    const conflicting = await admit("printf a\n", "newline-differs");
    assert.equal(conflicting.stdout.trim(), "CONFLICT");
    assert.equal(
      await readFile(join(root, "newline-differs", "cmd"), "utf8"),
      "printf a",
      "the admitted command record is immutable",
    );
  });

  it("records a command that ends in a newline byte-exactly", async () => {
    const command = "printf done\n";
    await admit(command, "newline-record");
    await waitForFile(join(root, "newline-record", "exit"));
    assert.equal(await readFile(join(root, "newline-record", "cmd"), "utf8"), command);
  });

  it("reports a session that was never admitted as missing", async () => {
    assert.equal((await probe("never-admitted")).stdout.trim(), "MISSING");
  });

  it("keeps a command with quotes, newlines and dollars byte-exact", async () => {
    const command = "printf '%s' \"it's $HOME\n\"";
    await admit(command, "quoting");
    await waitForFile(join(root, "quoting", "exit"));
    assert.equal(
      await readFile(join(root, "quoting", "cmd"), "utf8"),
      command,
      "the command reaches the guest as its own bytes, never as interpolated script text",
    );
  });
});

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

  it("still declares the Node floor this adapter documents", async () => {
    // The adapter tells callers the SDK needs Node >= 22 while this package
    // itself supports Node >= 20. If the SDK moves that floor, the message the
    // lazy import prints becomes wrong.
    const manifest = JSON.parse(
      await readFile(new URL("../../node_modules/microsandbox/package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    assert.equal(manifest.engines?.node, ">= 22");
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
