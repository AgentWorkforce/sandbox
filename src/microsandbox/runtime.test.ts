import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import * as pkg from "../index.js";
import {
  MicrosandboxBackendBusyError,
  MicrosandboxBackendPoisonedError,
  MicrosandboxCreateTimeoutError,
  MicrosandboxLogReadError,
  MicrosandboxLookupTimeoutError,
  MicrosandboxNameTooLongError,
  MicrosandboxPaginationError,
  MicrosandboxRunLostError,
  MicrosandboxRunNotFinishedError,
  MicrosandboxRunTimeoutUnsupportedError,
  MicrosandboxRuntime,
  MicrosandboxSessionConflictError,
  MicrosandboxStatusProbeError,
  MicrosandboxUnknownOutcomeError,
  resolveSandboxRuntimeCapabilities,
} from "../index.js";
import {
  __backendGateWaiterCountForTests,
  __resetBackendGateForTests,
  MICROSANDBOX_RUN_ADMIT_SCRIPT,
  MICROSANDBOX_RUN_LOG_SCRIPT,
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

type ExecOutcome = {
  code?: number;
  stdout?: string;
  stderr?: string;
  /**
   * Model an SDK result that carries NO usable exit code. Real providers do
   * this on a dropped or partially-read result, and it is the case the adapter
   * used to paper over with `?? 0`.
   */
  unknownCode?: boolean;
};

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
  /**
   * Pages generated from the page index, for listings too long to enumerate —
   * an endless one, or a cursor walk that revisits an earlier page. Takes
   * precedence over `rawPages` and `pages`.
   */
  pageAt?: (index: number) => unknown;
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
      if (script === MICROSANDBOX_RUN_LOG_SCRIPT) {
        const path = argv[3] ?? "";
        const cap = Number.parseInt(argv[4] ?? "0", 10);
        for (const [dir, run] of runs) {
          if (path === `${dir}/out`) {
            // `tail -c cap`: the LAST `cap` bytes, so the adapter sees more
            // than its own limit exactly when the log is longer than it.
            const bytes = Buffer.from(run.output, "utf8");
            const tail = bytes.byteLength <= cap
              ? bytes
              : bytes.subarray(bytes.byteLength - cap);
            return { stdout: tail.toString("utf8") };
          }
        }
        // No such run directory: the log file is genuinely absent, which the
        // script reports as success with no output.
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
        if (config.pageAt) {
          const generated = config.pageAt(pageIndex);
          pageIndex += 1;
          return generated as never;
        }
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
  const code = outcome.unknownCode ? (undefined as unknown as number) : outcome.code ?? 0;
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

  it("deregisters every timed-out waiter instead of leaking it", async () => {
    // THE LEAK IS INVISIBLE FROM OUTSIDE, which is why this test reaches for
    // the queue length rather than for behaviour. A waiter that timed out
    // reports the same typed `MicrosandboxBackendBusyError` whether or not it
    // took itself off the queue, and the gate keeps working either way — so a
    // purely behavioural test passes against the bug it is meant to catch.
    // The only signal that discriminates is the size of the queue itself.
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
    __resetBackendGateForTests();
    const cloud = makeRuntime(sdk, { backendQueueTimeoutMs: 20 });
    const local = makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 5_000 });
    try {
      // A holder that never settles: the case the queue bound exists for, and
      // the case in which no release ever comes to sweep the queue.
      const wedged = cloud.launch({ name: "wedged" });
      await waitFor(() => creates === 1, "the holder to enter the scope");

      // While one caller is genuinely queued, the queue must show exactly one.
      const parked = local.launch({ name: "parked" });
      await waitFor(
        () => __backendGateWaiterCountForTests() === 1,
        "the local call to register as a waiter",
      );

      // Now drive eight waiters to their timeout against that wedged holder.
      const shortLived = makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 20 });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await assert.rejects(
          shortLived.launch({ name: `q-${attempt}` }),
          MicrosandboxBackendBusyError,
        );
      }

      // THE ASSERTION THAT FAILS AGAINST THE BUG. With the timed-out waiters
      // left behind, the queue holds the one live waiter plus all eight
      // corpses; only deregistration brings it back to one.
      assert.equal(
        __backendGateWaiterCountForTests(),
        1,
        "eight timed-out waiters must have left the queue, leaving only the live one",
      );

      finishFirstCreate();
      await wedged;
      assert.equal((await parked).id, "parked");
      assert.equal(
        __backendGateWaiterCountForTests(),
        0,
        "a drained gate must hold no waiters at all",
      );
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("stays correct after repeated queue timeouts against a wedged scope", async () => {
    // The behavioural companion to the leak test above: repeated timeouts must
    // not corrupt the queue, and the gate must still work once the holder
    // settles.
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
    const cloud = makeRuntime(sdk, { backendQueueTimeoutMs: 20 });
    const local = makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 20 });

    await assert.rejects(
      cloud.launch({ name: "slow", createTimeoutSeconds: 0.02 }),
      MicrosandboxCreateTimeoutError,
    );
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await assert.rejects(
        local.launch({ name: `q-${attempt}` }),
        MicrosandboxBackendBusyError,
      );
    }

    // The holder finally settles: the gate must hand over cleanly, proving the
    // queue was not left in a corrupt state by the eight timeouts.
    finishFirstCreate();
    const handle = await local.launch({ name: "after" });
    assert.equal(handle.id, "after");
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

describe("backend gate fairness (a queue that cannot be jumped)", () => {
  // The gate's own documentation claimed this property before the code
  // implemented it: "a newly arriving same-backend call joins only when nobody
  // is already waiting". Without that condition, a same-backend call joins the
  // OPEN scope no matter who is queued behind it, and a process with steady
  // traffic on one backend never lets the other one run at all.

  it("makes a same-backend call queue behind a waiter on another backend", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCreate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let creates = 0;
    const { sdk } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates === 1 ? firstCreate : Promise.resolve();
      },
    });
    const cloud = makeRuntime(sdk);
    const local = makeRuntime(sdk, { backend: "local" });

    // Cloud holds the scope.
    const holder = cloud.launch({ name: "cloud-holder" }).then(() => order.push("cloud-holder"));
    await waitFor(() => creates === 1, "the first create to enter the scope");

    // Local queues: a different backend cannot share the open scope.
    const queued = local.launch({ name: "local-queued" }).then(() => order.push("local-queued"));
    await waitFor(() => true, "the local call to reach the queue");
    // Give the queued call a turn of the loop to actually register as a waiter.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A SECOND cloud call now arrives. It wants the backend that is already
    // open — the exact call that used to jump the queue.
    const jumper = cloud.launch({ name: "cloud-jumper" }).then(() => order.push("cloud-jumper"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(creates, 1, "the late same-backend call must not have joined the open scope");

    releaseFirst();
    await Promise.all([holder, queued, jumper]);
    assert.equal(
      order.indexOf("local-queued") < order.indexOf("cloud-jumper"),
      true,
      `the earlier waiter must go first, got: ${order.join(" → ")}`,
    );
  });

  it("does not starve the other backend under a steady same-backend stream", async () => {
    // The discriminating shape: work on one backend keeps arriving while a
    // call on the other is waiting. With queue-jumping, the waiter's own
    // 30s budget expires and it fails; the point of FIFO is that it does not.
    let gate!: () => void;
    const firstCreate = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let creates = 0;
    const { sdk } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates === 1 ? firstCreate : Promise.resolve();
      },
    });
    const cloud = makeRuntime(sdk, { backendQueueTimeoutMs: 2_000 });
    const local = makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 2_000 });

    const holder = cloud.launch({ name: "holder" });
    await waitFor(() => creates === 1, "the holder to enter the scope");
    const starved = local.launch({ name: "starved" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Twenty more cloud calls pile in while local waits.
    const stream = Array.from({ length: 20 }, (_unused, index) =>
      cloud.launch({ name: `stream-${index}` }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(creates, 1, "none of the stream may have joined past the waiter");

    gate();
    // Local gets through on its own merits, not on its timeout.
    assert.equal((await starved).id, "starved");
    await Promise.all([holder, ...stream]);
  });

  it("still lets same-backend calls share one scope when nobody is waiting", async () => {
    // The guard against over-correcting: fairness must not have serialized the
    // common case, which is a single-backend process.
    let releaseBoth!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    let creates = 0;
    const { sdk, log } = createHarness({
      onCreate: () => {
        creates += 1;
        return held;
      },
    });
    const cloud = makeRuntime(sdk);
    const first = cloud.launch({ name: "a" });
    await waitFor(() => creates === 1, "the first create");
    const second = cloud.launch({ name: "b" });
    await waitFor(() => creates === 2, "the second create to run concurrently in the same scope");
    releaseBoth();
    await Promise.all([first, second]);
    // One scope entered, one exited: they shared it rather than taking turns.
    assert.equal(
      log.filter((entry) => entry.fn === "withDefaultBackend:enter").length,
      1,
      names(log).join(", "),
    );
  });
});

describe("backend gate handoff (FIFO that a scheduler cannot re-order)", () => {
  it("admits queued callers in strict arrival order", async () => {
    // THE DISCRIMINATING SHAPE. Waking every waiter at once and letting them
    // re-race leaves the winner to microtask scheduling: all of them see a
    // free gate, and the one that happens to be resumed first takes it. With
    // three waiters on three DIFFERENT backends — so none of them can join
    // another's scope — only a gate that hands over to one named waiter at a
    // time produces arrival order every run.
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holderCall = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let creates = 0;
    const { sdk } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates === 1 ? holderCall : Promise.resolve();
      },
    });
    __resetBackendGateForTests();
    try {
      const holder = makeRuntime(sdk).launch({ name: "holder" });
      await waitFor(() => creates === 1, "the holder to enter the scope");

      // Each on its own backend, so every one of them must open its own scope.
      const first = makeRuntime(sdk, { backend: "local" })
        .launch({ name: "first" })
        .then(() => order.push("first"));
      await waitFor(() => __backendGateWaiterCountForTests() === 1, "the first waiter to queue");
      const second = makeRuntime(sdk, { backend: { profile: "p2" } })
        .launch({ name: "second" })
        .then(() => order.push("second"));
      await waitFor(() => __backendGateWaiterCountForTests() === 2, "the second waiter to queue");
      const third = makeRuntime(sdk, { backend: { profile: "p3" } })
        .launch({ name: "third" })
        .then(() => order.push("third"));
      await waitFor(() => __backendGateWaiterCountForTests() === 3, "the third waiter to queue");

      releaseHolder();
      await Promise.all([holder, first, second, third]);
      assert.deepEqual(
        order,
        ["first", "second", "third"],
        `queued callers must run in arrival order, got: ${order.join(" → ")}`,
      );
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("does not let a waking waiter be mistaken for an empty queue", async () => {
    // THE TEST THAT SEPARATES A TICKET HANDOFF FROM WAKING EVERYONE. Emptying
    // the queue to wake it — `splice(0)` — destroys the very fact the
    // starvation guard reads: with the queue momentarily empty, the second
    // same-backend waiter re-checks, sees "nobody is waiting", and joins the
    // first one's scope. Handing the gate to ONE waiter leaves the rest
    // queued, so the second opens its own scope in its own turn.
    //
    // Counting scope entries is what makes the difference observable: two
    // separate turns produce two entries, a queue-jumping join produces one.
    let releaseHolder!: () => void;
    const holderCall = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let creates = 0;
    const { sdk, log } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates === 1 ? holderCall : Promise.resolve();
      },
    });
    __resetBackendGateForTests();
    try {
      const holder = makeRuntime(sdk).launch({ name: "holder" });
      await waitFor(() => creates === 1, "the holder to enter the scope");

      // Two waiters that want the SAME backend as each other, both queued
      // behind a holder on a different one.
      const local = makeRuntime(sdk, { backend: "local" });
      const first = local.launch({ name: "first" });
      await waitFor(() => __backendGateWaiterCountForTests() === 1, "the first waiter to queue");
      const second = local.launch({ name: "second" });
      await waitFor(() => __backendGateWaiterCountForTests() === 2, "the second waiter to queue");

      releaseHolder();
      await Promise.all([holder, first, second]);

      assert.equal(
        log.filter((entry) => entry.fn === "withDefaultBackend:enter").length,
        3,
        "a queued waiter is not 'nobody waiting': each must take its own turn",
      );
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("passes the turn on when the caller it was promised to has already timed out", async () => {
    // The reservation is what makes the handoff ordered, so a waiter that
    // times out in the same tick it is promoted must give the turn back. If it
    // does not, the gate stays reserved for a caller that has left and nothing
    // ever runs again.
    let releaseHolder!: () => void;
    const holderCall = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let creates = 0;
    const { sdk } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates === 1 ? holderCall : Promise.resolve();
      },
    });
    __resetBackendGateForTests();
    try {
      const holder = makeRuntime(sdk).launch({ name: "holder" });
      await waitFor(() => creates === 1, "the holder to enter the scope");

      // A waiter whose budget expires while the holder is still wedged.
      const doomed = assert.rejects(
        makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 20 })
          .launch({ name: "doomed" }),
        MicrosandboxBackendBusyError,
      );
      // And one that is still there when the gate frees.
      const survivor = makeRuntime(sdk, {
        backend: { profile: "survivor" },
        backendQueueTimeoutMs: 60_000,
      }).launch({ name: "survivor" });
      await waitFor(() => __backendGateWaiterCountForTests() >= 1, "the waiters to queue");
      await doomed;

      releaseHolder();
      await holder;
      // The gate was not left reserved for the caller that gave up.
      assert.equal((await survivor).id, "survivor");
      assert.equal(__backendGateWaiterCountForTests(), 0);
    } finally {
      __resetBackendGateForTests();
    }
  });
});

describe("backend gate admission cancellation (a deadline that withdraws the request)", () => {
  it("never issues a queued static once the overall deadline has expired", async () => {
    // Racing a timer against the operation is not cancellation. The gate is a
    // queue, so a lookup that gives up while queued is still queued — it can
    // be admitted later and issue `listWith` against the process default long
    // after the caller stopped waiting for the answer. The signal is what
    // actually withdraws it.
    let releaseHolder!: () => void;
    const holderCall = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let creates = 0;
    const { sdk, log } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates === 1 ? holderCall : Promise.resolve();
      },
      pages: [{ sandboxes: [{ name: "warm", labels: { a: "b" } }] }],
    });
    __resetBackendGateForTests();
    try {
      const holder = makeRuntime(sdk).launch({ name: "holder" });
      await waitFor(() => creates === 1, "the holder to enter the scope");

      // Its whole budget expires while it is stuck behind the wedged holder.
      await assert.rejects(
        makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 60_000 })
          .findAllByLabels({ a: "b" }, { timeoutMs: 30 }),
        MicrosandboxLookupTimeoutError,
      );
      assert.equal(
        __backendGateWaiterCountForTests(),
        0,
        "a cancelled lookup must leave the queue rather than stay admitted",
      );

      // THE ASSERTION THAT FAILS AGAINST THE BUG: releasing the gate must not
      // let the abandoned lookup through afterwards.
      releaseHolder();
      await holder;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        log.filter((entry) => entry.fn === "Sandbox.listWith"),
        [],
        "a lookup cancelled by its deadline must never reach the SDK",
      );
    } finally {
      __resetBackendGateForTests();
    }
  });
});

describe("backend gate poisoning (a restore that failed)", () => {
  // `withDefaultBackend` sets one process-global slot and restores it on the
  // way out. When the RESTORE is what failed, the slot holds an unknown value.
  // Swallowing that — which is what the adapter used to do, because its
  // rejection handler could not tell a failed entry from a failed exit — hands
  // the gate to the next backend as though the previous one had been cleanly
  // restored, and that call then runs against whatever the slot actually holds.

  /** An SDK whose scope RUNS the callback and then fails to restore. */
  function restoreFailingSdk(base: MicrosandboxSdk, error: Error): MicrosandboxSdk {
    return {
      Sandbox: base.Sandbox,
      async withDefaultBackend(_backend, fn) {
        await fn();
        throw error;
      },
    };
  }

  it("propagates the restore failure instead of completing quietly", async () => {
    const { sdk } = createHarness({ get: (name) => ({ name }) });
    const failing = restoreFailingSdk(sdk, new Error("could not pop the backend scope"));
    try {
      await assert.rejects(
        makeRuntime(failing).getById("s1"),
        /could not pop the backend scope/,
      );
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("refuses every later backend-dependent static, with a typed error", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    const failing = restoreFailingSdk(sdk, new Error("restore exploded"));
    try {
      await assert.rejects(makeRuntime(failing).getById("s1"), /restore exploded/);

      // A DIFFERENT runtime, on a DIFFERENT backend, sharing the same process
      // — which is the whole reason the poison is module-scoped rather than
      // per-instance. The damage is to the SDK's process-global slot.
      const healthy = makeRuntime(sdk, { backend: "local" });
      const before = log.length;
      await assert.rejects(
        healthy.getById("s2"),
        (error: unknown) => {
          assert.ok(error instanceof MicrosandboxBackendPoisonedError);
          assert.match(error.message, /restore exploded/);
          return true;
        },
      );
      // And it refused WITHOUT issuing the call: no static reached the SDK.
      assert.deepEqual(log.slice(before), [], "a poisoned gate must not call the SDK at all");

      await assert.rejects(healthy.launch({ name: "x" }), MicrosandboxBackendPoisonedError);
      await assert.rejects(healthy.findAllByLabels({ a: "b" }), MicrosandboxBackendPoisonedError);
      await assert.rejects(healthy.countByLabels({ a: "b" }), MicrosandboxBackendPoisonedError);
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("frees a queued waiter immediately rather than making it wait out its budget", async () => {
    // Poisoning while somebody is queued must convert their wait into a typed
    // refusal now, not leave them parked until the queue timeout.
    let releaseHolder!: () => void;
    const holderCall = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let gets = 0;
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      onGet: () => {
        gets += 1;
        return gets === 1 ? holderCall : Promise.resolve();
      },
    });
    const failing = restoreFailingSdk(sdk, new Error("restore failed under load"));
    try {
      const holder = assert.rejects(makeRuntime(failing).getById("held"), /restore failed under load/);
      await waitFor(() => gets === 1, "the holder to enter the scope");
      // A different backend queues behind it, with a budget far longer than
      // this test is willing to wait.
      const queued = makeRuntime(failing, {
        backend: "local",
        backendQueueTimeoutMs: 60_000,
      }).getById("queued");
      await new Promise((resolve) => setTimeout(resolve, 10));

      releaseHolder();
      await holder;
      await assert.rejects(queued, MicrosandboxBackendPoisonedError);
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("poisons and releases queued callers when restore throws synchronously after entry", async () => {
    // `Promise.resolve(withDefaultBackend(...))` never sees a promise here:
    // the SDK invokes the callback, then throws while restoring the process
    // default on the same stack. Callback entry still proves the global slot
    // was mutated, so this is poison just like an asynchronous restore
    // rejection.
    let releaseHolder!: () => void;
    const holderCall = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const { sdk, log } = createHarness({
      get: (name) => ({ name }),
      onGet: () => holderCall,
    });
    const syncRestoreFailure: MicrosandboxSdk = {
      Sandbox: sdk.Sandbox,
      withDefaultBackend<T>(_backend, fn): Promise<T> {
        fn();
        throw new Error("synchronous restore failure");
      },
    };
    __resetBackendGateForTests();
    try {
      const holder = makeRuntime(sdk).getById("holder");
      await waitFor(() => called(log, "Sandbox.get"), "the healthy holder to enter the gate");

      const failing = makeRuntime(syncRestoreFailure, {
        backend: "local",
        backendQueueTimeoutMs: 60_000,
      }).getById("sync-failure");
      const queued = makeRuntime(sdk, {
        backend: { profile: "queued-after-sync-failure" },
        backendQueueTimeoutMs: 60_000,
      }).getById("queued");
      await waitFor(
        () => __backendGateWaiterCountForTests() === 2,
        "both callers to queue behind the holder",
      );

      releaseHolder();
      assert.equal((await holder)?.id, "holder");
      await assert.rejects(failing, /synchronous restore failure/);
      await assert.rejects(queued, MicrosandboxBackendPoisonedError);
      assert.deepEqual(
        argsFor(log, "Sandbox.get"),
        [["holder"]],
        "neither the failed scope nor a caller released by poison may issue its static",
      );

      const before = log.length;
      await assert.rejects(
        makeRuntime(sdk).getById("later"),
        MicrosandboxBackendPoisonedError,
      );
      assert.deepEqual(log.slice(before), [], "later statics must fail before touching the SDK");
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("poisons the gate even when the restore rejected with no value at all", async () => {
    // THE SENTINEL BUG. Recording the rejection reason and treating "no reason
    // recorded" as "not poisoned" collapses on exactly the rejections that
    // carry nothing — `Promise.reject()`, `reject(null)`. Those destroy the
    // process default just as thoroughly as a rejection with an `Error`, and a
    // gate that reads its own poison out of the cause silently reopens.
    for (const reason of [null, undefined]) {
      const { sdk, log } = createHarness({ get: (name) => ({ name }) });
      const valueless: MicrosandboxSdk = {
        Sandbox: sdk.Sandbox,
        async withDefaultBackend(_backend, fn) {
          await fn();
          throw reason;
        },
      };
      __resetBackendGateForTests();
      try {
        // The participant that closed the scope is told, even though there is
        // nothing to tell it beyond the fact of the failure.
        await assert.rejects(makeRuntime(valueless).getById("s1"));

        const healthy = makeRuntime(sdk, { backend: "local" });
        const before = log.length;
        await assert.rejects(healthy.getById("s2"), MicrosandboxBackendPoisonedError);
        assert.deepEqual(
          log.slice(before),
          [],
          `a gate poisoned by a ${String(reason)} rejection must not call the SDK`,
        );
      } finally {
        __resetBackendGateForTests();
      }
    }
  });

  it("tells every participant in a shared scope that the restore failed", async () => {
    // Same-backend callers share ONE scope, so they share its restore. The
    // participant that happens to finish first has historically been allowed
    // to return success and walk away — but the scope it ran in went on to
    // fail its restore, so it was told the call completed cleanly when the
    // process default it ran against is now unknown. Both must hear it.
    let releaseEarly!: () => void;
    let releaseLate!: () => void;
    const earlyCall = new Promise<void>((resolve) => {
      releaseEarly = resolve;
    });
    const lateCall = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let gets = 0;
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      onGet: () => {
        gets += 1;
        // Both callers are held inside the SAME scope until the test lets them
        // out, one at a time — which is the only way to get a genuine early
        // leaver rather than two scopes opened back to back.
        return gets === 1 ? earlyCall : lateCall;
      },
    });
    const failing: MicrosandboxSdk = {
      Sandbox: sdk.Sandbox,
      async withDefaultBackend(_backend, fn) {
        await fn();
        throw new Error("restore failed for the shared scope");
      },
    };
    __resetBackendGateForTests();
    try {
      const runtime = makeRuntime(failing);
      // Rejection handlers are attached NOW: these settle while the test is
      // still awaiting other things, and an unhandled rejection in between
      // would be reported against whichever test happens to be running.
      const early = runtime.getById("early").then(() => "resolved" as const, (error: unknown) => error);
      await waitFor(() => gets === 1, "the first caller to enter the scope");
      const late = runtime.getById("late").then(() => "resolved" as const, (error: unknown) => error);
      await waitFor(() => gets === 2, "the second caller to join the same scope");

      // The early leaver finishes its own call first, while the scope stays
      // open for the caller still inside it.
      releaseEarly();
      releaseLate();

      // THE ASSERTION THAT FAILS AGAINST THE BUG: the early leaver used to
      // resolve here, reporting a clean success from a scope whose restore
      // failed.
      const earlyOutcome = await early;
      assert.notEqual(
        earlyOutcome,
        "resolved",
        "the early leaver must not report success from a scope that failed to restore",
      );
      assert.match(String((earlyOutcome as Error).message), /restore failed for the shared scope/);
      const lateOutcome = await late;
      assert.notEqual(lateOutcome, "resolved");
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("leaves an already-resolved sandbox instance usable", async () => {
    // The SDK binds each sandbox to the backend it was resolved on ("backend
    // retained by this sandbox"), so instance calls read no global state. The
    // poison must not spread to them — refusing work that is provably safe is
    // its own kind of wrong answer.
    const { sdk } = createHarness({ get: (name) => ({ name }), exec: () => ({ code: 0, stdout: "hi" }) });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.launch({ name: "bound" });
    const failing = restoreFailingSdk(sdk, new Error("restore failed later"));
    try {
      await assert.rejects(makeRuntime(failing).getById("other"), /restore failed later/);
      // The instance resolved BEFORE the poison still execs.
      const result = await runtime.exec(handle, "echo hi");
      assert.deepEqual(result, { output: "hi", exitCode: 0 });
    } finally {
      __resetBackendGateForTests();
    }
  });

  it("does not poison the gate when the scope failed to open in the first place", async () => {
    // The other half of the distinction. A rejection BEFORE the callback ran
    // means the process default was never changed, so the gate is still
    // trustworthy — and an existing test already proves the runtime stays
    // usable after one. This asserts the poison specifically stays clear.
    const { sdk } = createHarness({ get: (name) => ({ name }) });
    const neverEnters: MicrosandboxSdk = {
      Sandbox: sdk.Sandbox,
      withDefaultBackend() {
        throw new Error("could not push the backend scope");
      },
    };
    await assert.rejects(makeRuntime(neverEnters).getById("s1"), /could not push/);
    // Same process, healthy SDK: works, and is NOT a poisoned-gate error.
    assert.equal((await makeRuntime(sdk).getById("s1"))?.id, "s1");
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

  it("withdraws a timed-out create while it is queued behind another backend", async () => {
    // The create deadline is an admission deadline too. If it expires before
    // this backend owns the process-global gate, releasing the holder later
    // must not construct a builder or start a provider create for a caller
    // that already received a timeout.
    let releaseHolder!: () => void;
    const holderCall = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let creates = 0;
    const { sdk, log } = createHarness({
      onCreate: () => {
        creates += 1;
        return creates === 1 ? holderCall : Promise.resolve();
      },
    });
    __resetBackendGateForTests();
    try {
      const holder = makeRuntime(sdk).launch({ name: "holder" });
      await waitFor(() => creates === 1, "the first backend's create to hold the gate");

      await assert.rejects(
        makeRuntime(sdk, { backend: "local", backendQueueTimeoutMs: 60_000 }).launch({
          name: "withdrawn",
          createTimeoutSeconds: 0.03,
        }),
        MicrosandboxCreateTimeoutError,
      );
      assert.equal(__backendGateWaiterCountForTests(), 0, "the timed-out create must leave the queue");

      releaseHolder();
      await holder;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(argsFor(log, "Sandbox.builder"), [["holder"]]);
      assert.deepEqual(argsFor(log, "builder.create"), [["holder"]]);
    } finally {
      __resetBackendGateForTests();
    }
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

  // -------------------------------------------------------------------------
  // The late-create reclamation used to swallow every teardown error in a
  // bare `try {} catch {}`, so a hosted-backend leak (kill unsupported →
  // rethrow → catch) surfaced with zero signal. The `onReclaimFailure` hook
  // makes the failure observable while keeping the reclamation promise
  // detached (so a hook throwing does not become an unhandled rejection).
  //
  // The must-fire (control) is the reclamation-fails path: with a broken
  // teardown the hook receives the error. The must-not-fire is the happy
  // path: with a working teardown the hook is never called, because there
  // was no failure to report.
  // -------------------------------------------------------------------------
  it("reports a failed reclamation through onReclaimFailure instead of swallowing it", async () => {
    let finishCreate!: () => void;
    const { sdk } = createHarness({
      get: (name) => ({
        name,
        // Reproduces the cloud shape without a second-step fallback: the
        // reclamation MUST fail so the hook is what proves the failure was
        // observable at all.
        onKill: async () => {
          throw sdkError("unsupported", "kill not supported");
        },
        onStop: async () => {
          throw sdkError("runtime", "backend refused stop");
        },
      }),
      onCreate: () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    });
    const observations: Array<{ name: string; code?: unknown; message?: string }> = [];
    const runtime = makeRuntime(sdk, {
      onReclaimFailure: (name, error) => {
        observations.push({
          name,
          ...(typeof error === "object" && error !== null && "code" in error
            ? { code: (error as { code?: unknown }).code }
            : {}),
          ...(error instanceof Error ? { message: error.message } : {}),
        });
      },
    });
    await assert.rejects(
      runtime.launch({ name: "wedged", createTimeoutSeconds: 0.02 }),
      MicrosandboxCreateTimeoutError,
    );
    finishCreate();
    await waitFor(() => observations.length > 0, "the reclamation to notify the hook");
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.name, "wedged");
    // The hook is CALLED WITH the underlying error object, so a downstream
    // logger can dispatch by SDK error code — the machine-readable half of
    // the observability guarantee.
    assert.equal(observations[0]?.code, "runtime");
  });

  it("does not call onReclaimFailure when the reclamation succeeds", async () => {
    // Must-not-fire control. If the hook fires on a happy reclamation, every
    // operator that wires it up as a leak alert starts paging on non-leaks.
    let finishCreate!: () => void;
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      onCreate: () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    });
    const observations: string[] = [];
    const runtime = makeRuntime(sdk, {
      onReclaimFailure: (name) => {
        observations.push(name);
      },
    });
    await assert.rejects(
      runtime.launch({ name: "slow", createTimeoutSeconds: 0.02 }),
      MicrosandboxCreateTimeoutError,
    );
    finishCreate();
    // Wait for the reclamation to actually complete, otherwise a fast
    // must-not-fire misses the failure it was supposed to catch.
    await waitFor(() => {
      // A working reclamation calls kill+remove; wait for the last step.
      return true;
    }, "reclamation to progress");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(observations, []);
  });

  it("does not surface a throwing hook as an unhandled rejection", async () => {
    // A misbehaving onReclaimFailure must not escalate a background
    // reclamation failure into a process-level crash — the reclamation
    // promise is detached and any rejection here has no `.catch` to reach.
    let finishCreate!: () => void;
    const { sdk } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("unsupported", "kill not supported");
        },
        onStop: async () => {
          throw sdkError("runtime", "backend refused stop");
        },
      }),
      onCreate: () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    });
    const rejections: unknown[] = [];
    const record = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      const runtime = makeRuntime(sdk, {
        onReclaimFailure: () => {
          throw new Error("hook exploded");
        },
      });
      await assert.rejects(
        runtime.launch({ name: "boom", createTimeoutSeconds: 0.02 }),
        MicrosandboxCreateTimeoutError,
      );
      finishCreate();
      // Two macrotask turns: Node schedules unhandled-rejection reports one
      // tick after the promise settles.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(rejections, [], "a throwing hook must not escape the reclamation catch");
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("reclaims through the fallback stop when the backend refuses kill", async () => {
    // End-to-end regression matching what the live probe checks against
    // Microsandbox cloud: launch with a boot deadline shorter than the SDK
    // create, watch the reclamation land through the stop+remove fallback,
    // and confirm no hook was fired because nothing failed.
    let finishCreate!: () => void;
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("unsupported", "kill not supported");
        },
      }),
      onCreate: () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    });
    const observations: string[] = [];
    const runtime = makeRuntime(sdk, {
      onReclaimFailure: (name) => {
        observations.push(name);
      },
    });
    await assert.rejects(
      runtime.launch({ name: "recover", createTimeoutSeconds: 0.02 }),
      MicrosandboxCreateTimeoutError,
    );
    finishCreate();
    await waitFor(() => called(log, "handle.remove"), "the fallback stop+remove to complete");
    assert.deepEqual(firstArgs(log, "handle.stop"), ["recover"]);
    assert.deepEqual(firstArgs(log, "handle.remove"), ["recover"]);
    assert.deepEqual(observations, [], "a successful reclamation must not page anyone");
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

describe("pagination cycles, bounds and unusable entries", () => {
  const started = (name: string) => ({ name, status: "running" as const });

  it("refuses a cursor walk that revisits a page it already served", async () => {
    // A → B → A. Every individual step ADVANCES, so comparing each cursor only
    // against the one just used sees progress forever while re-serving the same
    // two pages: the drain ends on the safety bound at best, and duplicates
    // every sandbox it collected on the way.
    const { sdk } = createHarness({
      pageAt: (index) => ({
        sandboxes: [started(`s-${index}`)],
        nextCursor: index % 2 === 0 ? "cursor-b" : "cursor-a",
      }),
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({ role: "worker" }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxPaginationError);
        assert.match(error.message, /already served|cycling/);
        return true;
      },
    );
  });

  it("refuses a three-step cycle too, not just an immediate repeat", async () => {
    const walk = ["c1", "c2", "c3", "c1"];
    const { sdk } = createHarness({
      pageAt: (index) => ({
        sandboxes: [started(`s-${index}`)],
        ...(index < walk.length ? { nextCursor: walk[index] } : {}),
      }),
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({ role: "worker" }),
      MicrosandboxPaginationError,
    );
  });

  it("throws at the page bound instead of returning what it collected", async () => {
    // The old behaviour returned the collected handles, which is INDISTINGUISH-
    // ABLE from a complete listing: the caller under-counts a quota, or decides
    // nothing warm exists, from a drain that simply gave up.
    let pagesServed = 0;
    const { sdk } = createHarness({
      pageAt: (index) => {
        pagesServed += 1;
        return { sandboxes: [started(`s-${index}`)], nextCursor: `cursor-${index}` };
      },
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({ role: "worker" }, { timeoutMs: 60_000 }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxPaginationError);
        assert.equal(error.pages, 1_000);
        assert.match(error.message, /safety bound/);
        assert.match(error.message, /no partial result/);
        return true;
      },
    );
    assert.equal(pagesServed, 1_000, "the bound is 1000 pages, and it is a failure rather than a stop");
  });

  it("fails a count at the bound too, rather than under-reporting it", async () => {
    const { sdk } = createHarness({
      pageAt: (index) => ({ sandboxes: [started(`s-${index}`)], nextCursor: `c-${index}` }),
    });
    await assert.rejects(
      makeRuntime(sdk).countByLabels({ role: "worker" }, { timeoutMs: 60_000 }),
      MicrosandboxPaginationError,
    );
  });

  it("refuses a page entry with no usable name", async () => {
    // An array of unusable entries is exactly as unreadable as a missing array,
    // and it fails the same silent way: every entry is dropped by the state
    // filter and the caller is told there is nothing warm.
    const { sdk } = createHarness({
      rawPages: [{ sandboxes: [{ name: "", status: "running" }] }],
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({ role: "worker" }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxPaginationError);
        assert.match(error.message, /no usable sandbox name/);
        return true;
      },
    );
  });

  it("refuses a page entry whose name is whitespace", async () => {
    const { sdk } = createHarness({
      rawPages: [{ sandboxes: [{ name: "   ", status: "running" }] }],
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({ role: "worker" }),
      MicrosandboxPaginationError,
    );
  });

  it("refuses a page entry with no usable status", async () => {
    // Without a status the state filter cannot judge it, and the entry would be
    // silently dropped as "not started".
    const { sdk } = createHarness({
      rawPages: [{ sandboxes: [{ name: "s-1" }] }],
    });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({ role: "worker" }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxPaginationError);
        assert.match(error.message, /without a usable status/);
        return true;
      },
    );
  });

  it("refuses an entry that is not an object at all", async () => {
    const { sdk } = createHarness({ rawPages: [{ sandboxes: ["s-1", null] }] });
    await assert.rejects(
      makeRuntime(sdk).findAllByLabels({ role: "worker" }),
      MicrosandboxPaginationError,
    );
  });

  it("still accepts a well-formed page, so the validation is not just a wall", async () => {
    const { sdk } = createHarness({
      rawPages: [{ sandboxes: [{ name: "s-1", status: "running" }] }],
    });
    const found = await makeRuntime(sdk).findAllByLabels({ role: "worker" });
    assert.deepEqual(found.map((handle) => handle.id), ["s-1"]);
  });

  it("accepts a status outside the SDK vocabulary rather than rejecting it", async () => {
    // "Usable" means present and readable, not a member of a closed set: a
    // provider that adds a status must not break the drain, it must just not
    // match the STARTED filter.
    const { sdk } = createHarness({
      rawPages: [{ sandboxes: [{ name: "s-1", status: "hibernating" }] }],
    });
    const found = await makeRuntime(sdk).findAllByLabels({ role: "worker" }, { states: null });
    assert.deepEqual(found.map((handle) => handle.state), ["STOPPED"]);
  });
});

describe("zero and negative lookup bounds", () => {
  const started = (name: string) => ({ name, status: "running" as const });

  it("answers a zero limit with nothing, and without a call", async () => {
    // It used to return ONE result: the cap was checked only after an entry had
    // already been collected, so `limit: 0` meant "at least one".
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [started("s-1"), started("s-2")] }] });
    assert.deepEqual(await makeRuntime(sdk).findAllByLabels({ a: "b" }, { limit: 0 }), []);
    assert.equal(called(log, "Sandbox.listWith"), false, names(log).join(", "));
  });

  it("answers a negative limit the same way", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [started("s-1")] }] });
    assert.deepEqual(await makeRuntime(sdk).findAllByLabels({ a: "b" }, { limit: -5 }), []);
    assert.equal(called(log, "Sandbox.listWith"), false);
  });

  it("floors a fractional limit rather than passing it through", async () => {
    const { sdk, log } = createHarness({
      pages: [{ sandboxes: [started("s-1"), started("s-2"), started("s-3")] }],
    });
    const found = await makeRuntime(sdk).findAllByLabels({ a: "b" }, { limit: 2.7 });
    assert.equal(found.length, 2);
    assert.deepEqual(firstArgs(log, "list.limit"), [2]);
  });

  it("answers a negative maxCount with zero, and without a call", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [started("s-1")] }] });
    assert.equal(await makeRuntime(sdk).countByLabels({ a: "b" }, { maxCount: -1 }), 0);
    assert.equal(called(log, "Sandbox.listWith"), false);
  });

  it("does not send a zero page size to the provider", async () => {
    // Zero is not a page size, and the two plausible readings of it —
    // "everything" and "nothing" — are opposite, so it is not the adapter's to
    // guess. The configured default is sent instead.
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [started("s-1")] }] });
    await makeRuntime(sdk, { listPageSize: 42 }).findAllByLabels({ a: "b" }, { pageSize: 0 });
    assert.deepEqual(firstArgs(log, "list.limit"), [42]);
  });

  it("does not send a negative page size either", async () => {
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [started("s-1")] }] });
    await makeRuntime(sdk, { listPageSize: 42 }).findAllByLabels({ a: "b" }, { pageSize: -3 });
    assert.deepEqual(firstArgs(log, "list.limit"), [42]);
  });

  it("keeps a zero limit from becoming a zero page size on findByLabels", async () => {
    // `findByLabels` caps at one regardless, so a zero `limit` here is only a
    // request size — and must not be sent as one.
    const { sdk, log } = createHarness({ pages: [{ sandboxes: [started("s-1")] }] });
    const found = await makeRuntime(sdk, { listPageSize: 7 }).findByLabels({ a: "b" }, { limit: 0 });
    assert.equal(found?.id, "s-1");
    assert.deepEqual(firstArgs(log, "list.limit"), [7]);
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
      // The guest's process table, passed as an argument rather than written
      // into the script, and never taken from caller-supplied environment.
      "/proc",
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

  it("refuses a command timeout it cannot honour, before submitting anything", async () => {
    // The port defines `timeoutMs` as the COMMAND's lifetime. This adapter used
    // to apply it to the submit call, which is a different thing entirely: the
    // caller asked for a 5s command and got a 5s submit plus a command that
    // runs forever, with nothing in the result saying so. Refusing is the
    // honest answer, and it has to happen before submission — a refusal after
    // a process exists is not a refusal.
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await assert.rejects(
      makeRuntime(sdk).startScript({ id: "s1" }, {
        command: "sleep 600",
        sessionId: "sess-1",
        timeoutMs: 5_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxRunTimeoutUnsupportedError);
        assert.equal(error.timeoutMs, 5_000);
        assert.equal(error.sessionId, "sess-1");
        return true;
      },
    );
    // NOTHING was submitted: no admission, and no exec of any kind.
    assert.equal(called(log, "sandbox.execWith"), false, `submitted anyway: ${names(log).join(", ")}`);
    assert.equal(called(log, "exec.timeout"), false);
  });

  it("submits normally when no command timeout is asked for", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).startScript({ id: "s1" }, {
      command: "sleep 600",
      sessionId: "sess-1",
    });
    // And still never sets a submit-call timeout that would masquerade as one.
    assert.equal(called(log, "exec.timeout"), false);
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.equal(argv[3], "sleep 600");
  });

  it("treats a zero timeout as no timeout rather than as an instant one", async () => {
    const { sdk, log } = createHarness({ get: (name) => ({ name }) });
    await makeRuntime(sdk).startScript({ id: "s1" }, {
      command: "job",
      sessionId: "sess-1",
      timeoutMs: 0,
    });
    assert.equal(called(log, "exec.timeout"), false);
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
      "/proc",
    ]);
    assert.equal(called(log, "fs.readToString"), false);
  });

  it("refuses to report a failed probe as still running", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => {
        throw new Error("transport reset");
      },
    });
    // NOT `{ exitCode: null }`. That value means "asked, and it is still
    // running" — a positive observation this probe did not make. A poll loop
    // reading it treats a broken transport as a healthy long-running command
    // and waits out an outcome that may already exist.
    await assert.rejects(
      makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxStatusProbeError);
        assert.equal(error.reason, "transport");
        assert.equal(error.retryable, true);
        assert.equal(error.sessionId, "sess-1");
        assert.equal(error.commandId, "1");
        assert.match(error.message, /transport reset/);
        return true;
      },
    );
  });

  it("refuses to invent a verdict when the probe exits non-zero", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      // Delivered, but the probe script itself failed — an unreadable run
      // directory, a guest missing /bin/sh. Stdout may even look plausible.
      exec: () => ({ code: 2, stdout: "", stderr: "sh: cannot open" }),
    });
    await assert.rejects(
      makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxStatusProbeError);
        assert.equal(error.reason, "transport");
        assert.match(error.message, /exited 2/);
        return true;
      },
    );
  });

  it("refuses to report an off-protocol answer as still running", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ stdout: "PROBABLY_FINE" }),
    });
    // An unrecognized marker is the failure that never ends: reported as
    // pending, a poll loop asks forever and the run is never reaped.
    await assert.rejects(
      makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxStatusProbeError);
        assert.equal(error.reason, "unrecognized");
        assert.match(error.message, /PROBABLY_FINE/);
        return true;
      },
    );
  });

  it("refuses an empty probe answer too, which is the same non-answer", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ stdout: "" }),
    });
    await assert.rejects(
      makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "1"),
      MicrosandboxStatusProbeError,
    );
  });

  it("reports an unreadable recorded process identity as a retryable probe error", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ stdout: "UNKNOWN starttime-unreadable\n" }),
    });
    await assert.rejects(
      makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "123"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxStatusProbeError);
        assert.equal(error.reason, "transport");
        assert.equal(error.retryable, true);
        assert.match(error.message, /start time/i);
        assert.match(error.message, /could not be read/i);
        return true;
      },
    );
  });

  it("does not report a probe error for a run it can actually read", async () => {
    // The guard against over-correcting: the three refusals above must not
    // have made a healthy RUNNING unreachable.
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.startScript({ id: "s1" }, { command: "job", sessionId: "sess-1" });
    assert.deepEqual(
      await runtime.getScriptStatus({ id: "s1" }, "sess-1", "1000"),
      { exitCode: null },
    );
    guest.finish("/tmp/microsandbox-run/sess-1", 0);
    assert.deepEqual(
      await runtime.getScriptStatus({ id: "s1" }, "sess-1", "1000"),
      { exitCode: 0 },
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
    assert.equal(result.truncated, undefined, "a complete log carries no truncation flag at all");
    const [argv] = firstArgs(log, "exec.args") as [string[]];
    assert.equal(argv[1], MICROSANDBOX_RUN_LOG_SCRIPT);
    assert.equal(argv[3], "/tmp/microsandbox-run/sess-1/out");
    // One byte MORE than the cap, which is what makes a longer log detectable
    // instead of silently tailed.
    assert.equal(argv[4], "200001");
  });

  it("reports a truncated log as truncated instead of passing a tail off as the whole thing", async () => {
    // The failure this replaces is invisible by construction: a 200KB tail of a
    // 1MB log looks exactly like a command that printed 200KB.
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.startScript({ id: "s1" }, { command: "noisy", sessionId: "sess-1" });
    const dir = "/tmp/microsandbox-run/sess-1";
    guest.write(dir, "A".repeat(200_000) + "TAIL-END");
    const result = await runtime.getScriptLogs({ id: "s1" }, "sess-1", "cmd-1");
    assert.equal(result.truncated, true);
    assert.equal(Buffer.byteLength(result.output, "utf8"), 200_000);
    assert.ok(result.output.endsWith("TAIL-END"), "the TAIL is what is kept, not the head");
  });

  it("does not flag a log that exactly fills the cap", async () => {
    // The boundary: at exactly the cap nothing was dropped, so claiming
    // truncation would be as wrong as hiding it.
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    await runtime.startScript({ id: "s1" }, { command: "noisy", sessionId: "sess-1" });
    guest.write("/tmp/microsandbox-run/sess-1", "B".repeat(200_000));
    const result = await runtime.getScriptLogs({ id: "s1" }, "sess-1", "cmd-1");
    assert.equal(result.truncated, undefined);
    assert.equal(Buffer.byteLength(result.output, "utf8"), 200_000);
  });

  it("reports an unreadable log as a failure, not as empty output", async () => {
    // An empty log is a legitimate result — a command that printed nothing has
    // one — so answering "" to a failed read is indistinguishable from the
    // truth, and the caller records "produced no output" as a fact.
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => {
        throw new Error("guest call dropped");
      },
    });
    await assert.rejects(
      makeRuntime(sdk).getScriptLogs({ id: "s1" }, "sess-1", "cmd-1"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxLogReadError);
        assert.equal(error.sessionId, "sess-1");
        assert.equal(error.path, "/tmp/microsandbox-run/sess-1/out");
        assert.match(error.message, /guest call dropped/);
        return true;
      },
    );
  });

  it("reports a non-zero log read as a failure too", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 1, stdout: "", stderr: "tail: cannot open" }),
    });
    await assert.rejects(
      makeRuntime(sdk).getScriptLogs({ id: "s1" }, "sess-1", "cmd-1"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxLogReadError);
        assert.match(error.message, /exited 1/);
        assert.match(error.message, /tail: cannot open/);
        return true;
      },
    );
  });

  it("still returns empty output for a log that is genuinely absent", async () => {
    // The one case where empty IS the truth: the run has written nothing yet.
    // It must stay distinguishable from the failures above by NOT throwing.
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 0, stdout: "" }),
    });
    const result = await makeRuntime(sdk).getScriptLogs({ id: "s1" }, "sess-1", "cmd-1");
    assert.equal(result.output, "");
    assert.equal(result.truncated, undefined);
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

describe("exec outcome truth", () => {
  it("refuses to report a missing exit code as a success", async () => {
    // `ExecResult.exitCode` is a `number`, so a missing one had to be invented,
    // and the invention was `0` — the value that means "this worked". A command
    // whose outcome the provider never reported is not a command that
    // succeeded, and the caller cannot tell the two apart by looking.
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ unknownCode: true, stdout: "partial" }),
    });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.launch({ name: "s1" });
    await assert.rejects(
      runtime.exec(handle, "do-something"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxUnknownOutcomeError);
        assert.equal(error.sandboxName, "s1");
        assert.match(error.message, /rather than defaulted to success/);
        return true;
      },
    );
  });

  it("still reports a genuine zero as a zero", async () => {
    // The guard: refusing an ABSENT code must not have made a real success
    // unreachable.
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 0, stdout: "ok" }),
    });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.launch({ name: "s1" });
    assert.deepEqual(await runtime.exec(handle, "true"), { output: "ok", exitCode: 0 });
  });

  it("still reports a genuine non-zero as itself", async () => {
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 3, stderr: "nope" }),
    });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.launch({ name: "s1" });
    assert.deepEqual(await runtime.exec(handle, "false"), { output: "nope", exitCode: 3 });
  });

  it("leaves runScript free to report the unknown code as null", async () => {
    // The port planes differ on purpose: `RunScriptResult.exitCode` is
    // `number | null`, so it can say "unknown" without inventing anything, and
    // only the bootstrap plane has to raise.
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ unknownCode: true, stdout: "partial" }),
    });
    const runtime = makeRuntime(sdk);
    const handle = await runtime.launch({ name: "s1" });
    const result = await runtime.runScript(handle, { command: "do-something" });
    assert.equal(result.exitCode, null);
    assert.equal(result.output, "partial");
  });

  it("maps a recycled pid onto a terminal lost verdict, not a pending one", async () => {
    // The adapter half of the start-time check: the guest can now answer
    // `LOST pid-reused`, and it has to end the poll rather than being filed
    // under "unrecognized".
    const { sdk } = createHarness({
      get: (name) => ({ name }),
      exec: () => ({ code: 0, stdout: "LOST pid-reused\n" }),
    });
    await assert.rejects(
      makeRuntime(sdk).getScriptStatus({ id: "s1" }, "sess-1", "cmd-1"),
      (error: unknown) => {
        assert.ok(error instanceof MicrosandboxRunLostError);
        assert.equal(error.reason, "its process is gone and the guest has since reused its pid for something else");
        return true;
      },
    );
  });

  it("carries a truncated log through to the bootstrap plane", async () => {
    // Both planes describe the same shortened log the same way, or a caller
    // moving between them reads a tail as a whole output on one of them.
    const { sdk, guest } = createHarness({ get: (name) => ({ name }) });
    const runtime = makeRuntime(sdk);
    const started = await runtime.startScript({ id: "s1" }, { command: "noisy", sessionId: "sess-1" });
    const dir = "/tmp/microsandbox-run/sess-1";
    guest.write(dir, "C".repeat(200_050));
    guest.finish(dir, 0);
    const result = await runtime.getExecLogs({ id: "s1" }, "sess-1", started.commandId);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.equal(Buffer.byteLength(result.output, "utf8"), 200_000);
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

  // -------------------------------------------------------------------------
  // Cloud-backend fidelity: the hosted backend does not implement
  // `SandboxHandle.kill` and answers it with `UnsupportedError` (code
  // `"unsupported"`, message `"Sandbox::kill is not supported by this
  // backend: use Sandbox::stop"`). The previous forceDestroy re-threw that
  // error before `remove()` was ever reached, so every cloud destroy left the
  // sandbox running. These tests reproduce the SDK-shaped failure the cloud
  // backend surfaces and assert the destroy still tears the sandbox down.
  //
  // The assertions run IN THE TEST BODY. The regression the smoke suite
  // missed at src/microsandbox/runtime.test.ts:4646-4653 was hidden by an
  // `after()` that swallowed cleanup errors, so the resource stayed on the
  // provider without any test going red. Every check below is on the
  // synchronous return path of `runtime.destroy`, not on an after-hook.
  // -------------------------------------------------------------------------
  it("falls back to stop+remove when the backend answers kill with Unsupported", async () => {
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("unsupported", "Sandbox::kill is not supported by this backend: use Sandbox::stop");
        },
      }),
    });
    const runtime = await ownedRuntime(sdk);
    // Must NOT throw — a rejection here is the exact leak PR #10 was blocked
    // on: the sandbox was left running and no `remove` ever fired.
    await runtime.destroy({ id: "s1" });
    // Order matters: kill is tried first (cheaper on backends that support
    // it), then stop as the fallback, then remove clears the record. If the
    // fallback stop is missing, remove would run against a still-running
    // sandbox and the provider would reject it.
    const teardown = names(log).filter(
      (n) => n === "handle.kill" || n === "handle.stop" || n === "handle.remove",
    );
    assert.deepEqual(teardown, ["handle.kill", "handle.stop", "handle.remove"]);
  });

  it("also falls back on UnsupportedOperation, which the SDK reserves for related refusals", async () => {
    // Not observed on cloud today, but the SDK's `MicrosandboxErrorCode`
    // enumerates both `"unsupported"` and `"unsupportedOperation"` under the
    // same neighborhood, so the fallback classifier accepts either.
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("unsupportedOperation", "operation not supported");
        },
      }),
    });
    const runtime = await ownedRuntime(sdk);
    await runtime.destroy({ id: "s1" });
    assert.equal(called(log, "handle.stop"), true);
    assert.equal(called(log, "handle.remove"), true);
  });

  it("still removes when the fallback stop reports the sandbox already stopped", async () => {
    // The stop fallback ONLY runs on kill-unsupported, so the stop path also
    // has to accept `already-stopped`/`not-found` — a common race with an
    // idle-timeout that stopped the sandbox in the window between the two
    // calls. Otherwise the removed-name would not be reclaimed.
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("unsupported", "kill not supported");
        },
        onStop: async () => {
          throw new Error("sandbox is already stopped");
        },
      }),
    });
    const runtime = await ownedRuntime(sdk);
    await runtime.destroy({ id: "s1" });
    assert.equal(called(log, "handle.remove"), true);
  });

  it("does not remove when the fallback stop fails for any other reason", async () => {
    // A stop that fails for an unrelated reason means the sandbox may still be
    // running — remove would then fail against a running sandbox and orphan
    // its record. Surface the underlying error so the caller retains
    // responsibility.
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("unsupported", "kill not supported");
        },
        onStop: async () => {
          throw sdkError("runtime", "backend refused stop");
        },
      }),
    });
    const runtime = await ownedRuntime(sdk);
    await assert.rejects(runtime.destroy({ id: "s1" }), /backend refused stop/);
    assert.equal(called(log, "handle.remove"), false);
  });

  it("keeps ownership when the cloud teardown fails so the caller can retry", async () => {
    // Same guarantee as the local `hypervisor wedged` case: after a failed
    // teardown, the registry still marks the sandbox as owned, so a retry
    // can still tear it down. Cloud-shaped this time: kill throws
    // `unsupported`, stop throws `runtime`.
    let failNext = true;
    const { sdk, log } = createHarness({
      get: (name) => ({
        name,
        onKill: async () => {
          throw sdkError("unsupported", "kill not supported");
        },
        onStop: async () => {
          if (failNext) {
            failNext = false;
            throw sdkError("runtime", "backend refused stop");
          }
        },
      }),
    });
    const runtime = await ownedRuntime(sdk);
    await assert.rejects(runtime.destroy({ id: "s1" }), /backend refused stop/);
    await runtime.destroy({ id: "s1" });
    assert.equal(called(log, "handle.remove"), true, "the retry must still be allowed to delete");
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
  // the honest value: this adapter observes nothing about how a cloud sandbox
  // is isolated — it has no host-local artifact to read, the way the local
  // backend does — and publishing "strong" would be publishing a guarantee
  // this adapter cannot make.
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
      // This adapter declares no capability modes, so every one resolves to
      // "unknown". Filling them in here would be a claim about microsandbox
      // that no live probe in this repository supports.
      modes: {
        outputStreams: "unknown",
        filesystem: "unknown",
        lifetime: "unknown",
        interactive: "unknown",
        snapshots: "unknown",
      },
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

/**
 * Start-time identity comes from `/proc/<pid>/stat`, so the tests that assert
 * it only mean something on a host that has procfs. The adapter's documented
 * FALLBACK — pid liveness alone, when no start time was recorded — is asserted
 * unconditionally, so a host without procfs still covers the path it takes.
 */
const PROCFS_SKIP = existsSync("/proc/self/stat")
  ? false
  : "start-time identity needs procfs (/proc/<pid>/stat)";

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

  const admit = (command: string, session: string, procRoot = "/proc") => {
    const dir = join(root, session);
    return sh(MICROSANDBOX_RUN_ADMIT_SCRIPT, [command, dir, root, "/bin/sh", procRoot]);
  };
  const probe = (session: string, procRoot = "/proc") =>
    sh(MICROSANDBOX_RUN_STATUS_SCRIPT, [join(root, session), procRoot]);

  /**
   * A synthetic procfs holding one pid's `stat` line, so the start-time
   * identity check is executable on a host that has no real `/proc` — which is
   * every macOS developer machine, and was where these assertions silently
   * skipped and proved nothing.
   *
   * `comm` defaults to a name containing BOTH a space and a closing paren,
   * because that is the case a left-to-right field split gets wrong: every
   * field after `comm` is numeric, so the LAST `") "` is the real separator.
   */
  async function fakeProc(
    pid: string,
    startTicks: string,
    comm = "my (odd) proc",
  ): Promise<string> {
    const procRoot = join(root, `proc-${pid}-${startTicks}`);
    await mkdir(join(procRoot, pid), { recursive: true });
    const fields = [pid, `(${comm})`, "S"];
    // Pad to field 22 overall; start time is the 20th field after `comm`.
    for (let field = 4; field <= 21; field += 1) {
      fields.push(String(field));
    }
    fields.push(startTicks);
    fields.push("trailing");
    await writeFile(join(procRoot, pid, "stat"), `${fields.join(" ")}\n`);
    return procRoot;
  }


  // --- run identity: pid alone is not an identity ---------------------------
  //
  // Start time is gated on procfs because that is where it comes from. On a
  // host without `/proc` the admission records none and the probe degrades to
  // boot id + pid liveness, which the fallback test below asserts RUNS THERE —
  // so neither platform is left without coverage of the path it actually takes.

  it("parses a start time out of a stat line whose comm holds a space and a paren", async () => {
    // The parse a naive left-to-right field split gets wrong. `comm` is the
    // only field that can hold arbitrary bytes, and every field after it is
    // numeric, so the LAST `") "` is the real separator. Reading the wrong
    // field makes every liveness comparison noise.
    //
    // The DISCRIMINATING half is the second assertion: a parse that failed
    // outright yields nothing, which the script treats as "cannot tell" and
    // reports RUNNING — so only a probe that detects a genuine MISMATCH proves
    // the field was actually found.
    await admit("sleep 5", "comm-parse");
    const dir = join(root, "comm-parse");
    const pid = (await waitForFile(join(dir, "pid"))).trim();
    await writeFile(join(dir, "start"), "778899");
    assert.equal(
      (await probe("comm-parse", await fakeProc(pid, "778899"))).stdout.trim(),
      "RUNNING",
      "a matching start time behind an awkward comm must read as still running",
    );
    assert.equal(
      (await probe("comm-parse", await fakeProc(pid, "778900"))).stdout.trim(),
      "LOST pid-reused",
      "a differing start time must be DETECTED, which only a correct parse can do",
    );
  });

  it("records the run's start time alongside its pid", async () => {
    // Uses the REAL procfs when the host has one; a host without procfs takes
    // the documented fallback, which the next-but-one test covers.
    if (PROCFS_SKIP) {
      return;
    }
    await admit("sleep 5", "identity");
    const recorded = (await waitForFile(join(root, "identity", "start"))).trim();
    assert.match(recorded, /^\d+$/, "a start time is a tick count");
    assert.equal((await probe("identity")).stdout.trim(), "RUNNING");
  });

  it("calls a run lost when its pid is alive but is no longer its process", async () => {
    // Real pid reuse cannot be provoked on demand, so both halves are supplied:
    // the run is admitted normally, its pid is genuinely alive, and the
    // recorded start time is one the process does not have. That is exactly the
    // state a recycled pid leaves behind — and without this check the probe
    // reports RUNNING forever, so the poll loop never ends.
    await admit("sleep 5", "reused");
    const dir = join(root, "reused");
    const pid = (await waitForFile(join(dir, "pid"))).trim();
    await writeFile(join(dir, "start"), "111111");
    const procRoot = await fakeProc(pid, "999999");
    assert.equal((await probe("reused", procRoot)).stdout.trim(), "LOST pid-reused");
  });

  it("keeps reporting RUNNING when the recorded start time still matches", async () => {
    // The guard against a check that fires on everything: same pid, same start
    // time, so nothing has been recycled and the run is simply still going.
    await admit("sleep 5", "unchanged");
    const dir = join(root, "unchanged");
    const pid = (await waitForFile(join(dir, "pid"))).trim();
    await writeFile(join(dir, "start"), "555555");
    const procRoot = await fakeProc(pid, "555555");
    assert.equal((await probe("unchanged", procRoot)).stdout.trim(), "RUNNING");
  });

  it("reports unknown when a recorded start time cannot be read from procfs", async () => {
    // The fallback is chosen by the ABSENCE of a recorded start time, never by
    // a failure to read the current one. The latter proves neither RUNNING nor
    // pid reuse, so the adapter must receive an explicit retryable non-verdict.
    await admit("sleep 5", "unreadable-now");
    const dir = join(root, "unreadable-now");
    await waitForFile(join(dir, "pid"));
    await writeFile(join(dir, "start"), "444444");
    const emptyProc = join(root, "proc-empty");
    await mkdir(emptyProc, { recursive: true });
    assert.equal(
      (await probe("unreadable-now", emptyProc)).stdout.trim(),
      "UNKNOWN starttime-unreadable",
    );
  });

  it("reports unknown when the current procfs stat record is malformed", async () => {
    await admit("sleep 5", "malformed-now");
    const dir = join(root, "malformed-now");
    const pid = (await waitForFile(join(dir, "pid"))).trim();
    await writeFile(join(dir, "start"), "555555");
    const procRoot = join(root, "proc-malformed");
    await mkdir(join(procRoot, pid), { recursive: true });
    await writeFile(join(procRoot, pid, "stat"), "not a process stat line\n");
    assert.equal(
      (await probe("malformed-now", procRoot)).stdout.trim(),
      "UNKNOWN starttime-unreadable",
    );
  });

  it("falls back to pid liveness when no start time was recorded", async () => {
    // The documented degradation: a guest without procfs records nothing, and
    // the probe must work exactly as it did before start time existed.
    await admit("sleep 5", "no-starttime");
    const dir = join(root, "no-starttime");
    await waitForFile(join(dir, "pid"));
    await rm(join(dir, "start"), { force: true });
    const pid = (await readFile(join(dir, "pid"), "utf8")).trim();
    // A synthetic procfs that WOULD mismatch is supplied deliberately: with no
    // recorded start time there is nothing to compare, so it must be ignored.
    const procRoot = await fakeProc(pid, "123123");
    assert.equal((await probe("no-starttime", procRoot)).stdout.trim(), "RUNNING");

    process.kill(Number(pid), "SIGKILL");
    let verdict = "";
    for (let attempt = 0; attempt < 200 && verdict !== "LOST process-gone"; attempt += 1) {
      verdict = (await probe("no-starttime", procRoot)).stdout.trim();
      if (verdict !== "LOST process-gone") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(verdict, "LOST process-gone", "a killed run with no start time still reports lost");
  });

  it("prefers a recorded exit code over any liveness reasoning", async () => {
    // Ordering guard: the exit file is checked FIRST, so a finished run is
    // never re-examined for pid reuse and reported lost after the fact.
    await admit("printf hi", "finished");
    const dir = join(root, "finished");
    assert.equal(await waitForFile(join(dir, "exit")), "0");
    await writeFile(join(dir, "start"), "999999999");
    assert.equal((await probe("finished")).stdout.trim(), "EXIT 0");
  });

  // --- log read: absence is not failure -------------------------------------

  it("reads a log through the bounded tail", async () => {
    const path = join(root, "log-plain.txt");
    await writeFile(path, "hello log");
    const result = await sh(MICROSANDBOX_RUN_LOG_SCRIPT, [path, "1024"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hello log");
  });

  it("returns the LAST bytes when the file is longer than the cap", async () => {
    const path = join(root, "log-long.txt");
    await writeFile(path, "0123456789");
    const result = await sh(MICROSANDBOX_RUN_LOG_SCRIPT, [path, "4"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "6789");
  });

  it("succeeds with no output for a log that does not exist yet", async () => {
    // The one case where empty is the truth. It must be a SUCCESS, because the
    // adapter distinguishes it from a failure by the exit code alone.
    const result = await sh(MICROSANDBOX_RUN_LOG_SCRIPT, [join(root, "never-written.txt"), "1024"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });

  it("succeeds with no output for an empty regular log file", async () => {
    const path = join(root, "empty-log.txt");
    await writeFile(path, "");
    const result = await sh(MICROSANDBOX_RUN_LOG_SCRIPT, [path, "1024"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });

  it("fails rather than reporting empty when the path is not a readable file", async () => {
    // A directory where a log should be: readable-empty and unreadable have to
    // be distinguishable, or a failed read is recorded as "printed nothing".
    const path = join(root, "log-as-dir");
    await mkdir(path, { recursive: true });
    const result = await sh(MICROSANDBOX_RUN_LOG_SCRIPT, [path, "1024"]);
    assert.notEqual(result.code, 0, "an existing directory is a read failure, not an absent log");
    assert.equal(result.stdout, "");
  });

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
