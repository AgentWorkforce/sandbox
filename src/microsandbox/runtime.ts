import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  AsyncExecStartResult,
  AsyncExecStatus,
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from "../types.js";
import type {
  AsyncRunStartResult,
  AsyncRunStatus,
  RunScriptResult,
  SandboxCountOptions,
  SandboxLookupOptions,
  SandboxRuntime,
} from "../port.js";

// ---------------------------------------------------------------------------
// Microsandbox provider for the SandboxRuntime + WorkflowRuntime contracts.
//
// The `microsandbox` npm package is imported LAZILY (`await import(...)`),
// never at module top level, so consumers on another provider neither bundle it
// nor need its platform-specific native addon installed. The SDK surface is
// modeled structurally below (read from microsandbox@0.6.11 `dist/*.d.ts`) so
// typecheck and unit tests do not hard-couple to the SDK type graph, and a fake
// SDK can drive every path without a live backend or an API key.
//
// Three provider facts shape this adapter and are worth stating up front,
// because each one breaks an assumption the other adapters in this package are
// allowed to make:
//
//  1. IDENTITY IS A NAME, NOT A SERVER-ASSIGNED ID. `Sandbox.builder(name)`,
//     `Sandbox.get(name)` and `Sandbox.remove(name)` all address a sandbox by a
//     caller-chosen name capped at 128 UTF-8 bytes. `RuntimeHandle.id`
//     therefore carries that name, and an over-long name is rejected rather
//     than truncated — truncating would silently alias two distinct sandboxes
//     onto one identity.
//
//  2. BACKEND SELECTION IS PROCESS-WIDE GLOBAL STATE. The SDK exposes
//     `setDefaultBackend(backend)` (permanent) and `withDefaultBackend(backend,
//     fn)` (scoped, restored in a `finally`). This adapter only ever uses the
//     scoped form, so constructing a runtime never mutates the host process and
//     two runtimes pointed at different backends can coexist. The SDK documents
//     that the scope is not task-local: concurrent work in the same process can
//     observe the temporary backend while the callback runs. That caveat is the
//     SDK's, not something this adapter can fix, and it is why the wrapped
//     region is kept as small as one SDK call.
//
//  3. THERE IS NO CREATE-TIMEOUT SETTER ON THE BUILDER. `maxDuration` and
//     `idleTimeout` are sandbox LIFETIME budgets. Mapping the caller's
//     `createTimeoutSeconds` onto either would kill every long-lived sandbox
//     the moment the boot deadline elapsed, so the create deadline is enforced
//     client-side instead (see `launch`).
// ---------------------------------------------------------------------------

/** Max sandbox name length the SDK accepts, in UTF-8 bytes. */
const MAX_SANDBOX_NAME_BYTES = 128;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_PAGE_SIZE = 100;
const SCRIPT_LOG_READ_MAX_BYTES = 200_000;

/**
 * Where the async-exec wrapper parks its `out`/`exit` files inside the guest.
 *
 * `/tmp` is a POSIX guarantee of the guest filesystem, not a fact about any
 * particular deployment, so it is a safe default rather than baked-in
 * infrastructure. Consumers whose image mounts `/tmp` read-only override it
 * with `runStateDir`.
 */
const DEFAULT_RUN_STATE_DIR = "/tmp/microsandbox-run";

/** POSIX shell used to interpret a `runScript`/`startScript` command string. */
const DEFAULT_SHELL = "/bin/sh";

// --- structural microsandbox SDK surface (microsandbox@0.6.11) --------------

/** `SandboxStatus` — the SDK's own status vocabulary. */
export type MicrosandboxStatus = "running" | "stopped" | "crashed" | "draining";

type MsbExecOutput = {
  readonly code: number;
  readonly success: boolean;
  stdout(): string;
  stderr(): string;
};

type MsbExecOptionsBuilder = {
  args(args: string[]): MsbExecOptionsBuilder;
  cwd(cwd: string): MsbExecOptionsBuilder;
  envs(vars: Record<string, string>): MsbExecOptionsBuilder;
  timeout(ms: number): MsbExecOptionsBuilder;
  tty(enabled: boolean): MsbExecOptionsBuilder;
};

type MsbFsOps = {
  write(path: string, data: Uint8Array | string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  readToString(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  copyFromHost(hostPath: string, guestPath: string): Promise<void>;
  copyToHost(guestPath: string, hostPath: string): Promise<void>;
};

type MsbSandbox = {
  readonly name: string;
  exec(cmd: string, args?: Iterable<string>): Promise<MsbExecOutput>;
  execWith(
    cmd: string,
    configure: (b: MsbExecOptionsBuilder) => MsbExecOptionsBuilder,
  ): Promise<MsbExecOutput>;
  fs(): MsbFsOps;
  detach?(): Promise<void>;
};

type MsbSandboxHandle = {
  readonly name: string;
  readonly status: MicrosandboxStatus;
  readonly createdAt?: Date | null;
  readonly updatedAt?: Date | null;
  connect(): Promise<MsbSandbox>;
  connectWithTimeout(timeoutMs: number): Promise<MsbSandbox>;
  start(): Promise<MsbSandbox>;
  startDetached(): Promise<MsbSandbox>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  remove(): Promise<void>;
};

type MsbSandboxPage = {
  sandboxes: MsbSandboxHandle[];
  nextCursor?: string;
};

type MsbSandboxListBuilder = {
  limit(limit: number): MsbSandboxListBuilder;
  cursor(cursor: string): MsbSandboxListBuilder;
  labels(labels: Record<string, string>): MsbSandboxListBuilder;
};

type MsbSandboxBuilder = {
  image(image: string): MsbSandboxBuilder;
  fromSnapshot(pathOrName: string): MsbSandboxBuilder;
  cpus(n: number): MsbSandboxBuilder;
  memory(mib: number): MsbSandboxBuilder;
  workdir(path: string): MsbSandboxBuilder;
  envs(vars: Record<string, string>): MsbSandboxBuilder;
  labels(labels: Record<string, string>): MsbSandboxBuilder;
  detached(enabled: boolean): MsbSandboxBuilder;
  idleTimeout(secs: number): MsbSandboxBuilder;
  maxDuration(secs: number): MsbSandboxBuilder;
  replace(): MsbSandboxBuilder;
  create(): Promise<MsbSandbox>;
};

type MsbSandboxStatics = {
  builder(name: string): MsbSandboxBuilder;
  get(name: string): Promise<MsbSandboxHandle | null>;
  listWith(
    configure: (b: MsbSandboxListBuilder) => MsbSandboxListBuilder,
  ): Promise<MsbSandboxPage>;
};

/**
 * The slice of the `microsandbox` module this adapter binds to.
 *
 * Exported so a consumer can supply a double (tests, a proxy that adds
 * tracing) through {@link MicrosandboxRuntimeOptions.sdk} without depending on
 * the SDK's internal type graph.
 */
export type MicrosandboxSdk = {
  Sandbox: MsbSandboxStatics;
  withDefaultBackend<T>(
    backend: MicrosandboxBackend,
    fn: () => Promise<T> | T,
  ): Promise<T>;
};

/**
 * Backend routing for one runtime instance — mirrors the SDK's
 * `DefaultBackend`.
 *
 * There is deliberately no default: `"local"` would silently run workloads on
 * the caller's host, and a cloud URL is deployment-specific. The API key is
 * accepted here as a value the caller supplies at construction from its own
 * secret store; this package never reads an environment variable, never logs
 * the key, and never writes it to disk.
 */
export type MicrosandboxBackend =
  | "local"
  | {
      kind: "cloud";
      /** Hosted API endpoint. Omit to use the SDK's own default endpoint. */
      url?: string;
      apiKey: string;
    }
  | { kind: "cloud"; profile: string };

export type MicrosandboxRuntimeOptions = {
  /**
   * Backend this runtime routes every SDK call through. Required: see
   * {@link MicrosandboxBackend}.
   */
  backend: MicrosandboxBackend;
  /**
   * OCI image to boot. Required unless {@link snapshot} is given: images are
   * registry- and consumer-specific, so no default is correct for anyone else.
   */
  image?: string;
  /**
   * Snapshot to boot from instead of an image. Mutually exclusive with
   * {@link image}.
   */
  snapshot?: string;
  /**
   * Home directory inside the guest, reported by `getHomeDir`. Required: it is
   * a property of the image, which this package does not choose.
   */
  homeDir: string;
  /** Default working directory for launched sandboxes. */
  workdir?: string;
  /** vCPU count applied at create time. Omit to accept the image default. */
  cpus?: number;
  /** Guest memory in MiB applied at create time. */
  memoryMiB?: number;
  /** Idle-shutdown budget in seconds, applied at create time. */
  idleTimeoutSeconds?: number;
  /** Hard sandbox lifetime in seconds, applied at create time. */
  maxDurationSeconds?: number;
  /**
   * Replace a same-named sandbox at create time. Defaults to `false`: names are
   * the identity here, so replacing on collision would destroy a sandbox this
   * caller may not own.
   */
  replaceExisting?: boolean;
  /** Prefix for generated sandbox names when the caller supplies none. */
  namePrefix?: string;
  /** Guest directory holding async-run state files. Defaults to `/tmp/microsandbox-run`. */
  runStateDir?: string;
  /** Shell used to interpret command strings. Defaults to `/bin/sh`. */
  shell?: string;
  /** Timeout for `connect` to an already-running sandbox. Defaults to 10s. */
  connectTimeoutMs?: number;
  /** Page size used when draining label listings. Defaults to 100. */
  listPageSize?: number;
  /** Injection seam for tests / a wrapping adapter — defaults to lazy `import("microsandbox")`. */
  sdk?: MicrosandboxSdk;
};

/**
 * A sandbox name exceeded the SDK's 128 UTF-8 byte cap.
 *
 * Raised instead of truncating: the name IS the identity, so a truncated name
 * would collide two distinct sandboxes onto one addressable handle.
 */
export class MicrosandboxNameTooLongError extends Error {
  override readonly name = "MicrosandboxNameTooLongError";
  readonly sandboxName: string;
  readonly byteLength: number;
  readonly maxByteLength = MAX_SANDBOX_NAME_BYTES;

  constructor(sandboxName: string, byteLength: number) {
    super(
      `Microsandbox sandbox name is ${byteLength} UTF-8 bytes, exceeding the ${MAX_SANDBOX_NAME_BYTES}-byte limit`,
    );
    this.sandboxName = sandboxName;
    this.byteLength = byteLength;
  }
}

/**
 * The create deadline supplied by the caller elapsed before the sandbox
 * finished booting.
 *
 * The sandbox may still be booting under {@link sandboxName}; it is
 * deterministically addressable, so a caller can reattach with `getById` or
 * reclaim it with `destroy`.
 */
export class MicrosandboxCreateTimeoutError extends Error {
  override readonly name = "MicrosandboxCreateTimeoutError";
  readonly sandboxName: string;
  readonly timeoutMs: number;

  constructor(sandboxName: string, timeoutMs: number) {
    super(
      `Microsandbox sandbox "${sandboxName}" did not finish creating within ${timeoutMs}ms`,
    );
    this.sandboxName = sandboxName;
    this.timeoutMs = timeoutMs;
  }
}

export class MicrosandboxRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "microsandbox";

  /**
   * Bootstrap-plane capabilities. These describe what THIS ADAPTER exposes
   * through the port, not everything the SDK can do — the same convention the
   * Daytona adapter follows.
   *
   *  - `pty: false` — the SDK's `ExecOptionsBuilder.tty(true)` and
   *    `ExecHandle.resize()` are real, but the port has no pty method and this
   *    adapter never allocates one.
   *  - `snapshots: true` — `launch` can source a sandbox from a snapshot via
   *    the builder's `fromSnapshot`.
   *  - `isolation: 'strong'` — microsandbox boots each sandbox as a microVM
   *    with its own guest Linux kernel (hardware virtualization), per the
   *    provider's published requirements: KVM on Linux, Apple Silicon on
   *    macOS, WHP on Windows.
   *  - `persistentHandle: true` — a sandbox is re-resolvable by name from a
   *    fresh process via `Sandbox.get(name)` + `connect()`, and
   *    `launchDetached` sets `detached(true)` so it outlives this process.
   *  - `streamingLogs: false` — the SDK ships `logStream({follow:true})` and
   *    `execStream`, but this adapter's log path is a durable file read, so
   *    claiming a streaming capability here would be claiming a code path that
   *    does not exist.
   */
  readonly capabilities: RuntimeCapabilities = {
    pty: false,
    snapshots: true,
    isolation: "strong",
    persistentHandle: true,
    streamingLogs: false,
  };

  /**
   * Both true, and declared rather than left to default so the reasoning is on
   * the record. `warmLease`: `Sandbox.listWith(b => b.labels(...))` is a real
   * server-side label query with cursor pagination, so a warm-lease lookup is
   * meaningful. `lifecycle`: `start`/`stop` map onto `SandboxHandle.start()` /
   * `SandboxHandle.stop()`, which genuinely resume and halt a microVM — unlike
   * the E2B adapter, where both are no-ops.
   */
  readonly declaredCapabilities = { warmLease: true, lifecycle: true } as const;

  private readonly backend: MicrosandboxBackend;
  private readonly image?: string;
  private readonly snapshot?: string;
  private readonly homeDir: string;
  private readonly defaultWorkdir?: string;
  private readonly cpus?: number;
  private readonly memoryMiB?: number;
  private readonly idleTimeoutSeconds?: number;
  private readonly maxDurationSeconds?: number;
  private readonly replaceExisting: boolean;
  private readonly namePrefix: string;
  private readonly runStateDir: string;
  private readonly shell: string;
  private readonly connectTimeoutMs: number;
  private readonly listPageSize: number;
  private readonly injectedSdk?: MicrosandboxSdk;
  private sdkPromise?: Promise<MicrosandboxSdk>;

  // Live `Sandbox` instances resolved in this process. A cross-request access
  // (an async-exec poll tick) that misses this cache re-resolves by name via
  // `Sandbox.get(name).connect()` — the reattach that lets a run outlive the
  // request that started it.
  private readonly sandboxes = new Map<string, MsbSandbox>();

  constructor(options: MicrosandboxRuntimeOptions) {
    if (!options.image && !options.snapshot) {
      throw new Error(
        "MicrosandboxRuntime requires either `image` or `snapshot`: neither has a default that is correct for another consumer",
      );
    }
    if (options.image && options.snapshot) {
      throw new Error(
        "MicrosandboxRuntime accepts `image` or `snapshot`, not both: a sandbox has exactly one rootfs source",
      );
    }
    this.backend = options.backend;
    if (options.image !== undefined) {
      this.image = options.image;
    }
    if (options.snapshot !== undefined) {
      this.snapshot = options.snapshot;
    }
    this.homeDir = options.homeDir;
    if (options.workdir !== undefined) {
      this.defaultWorkdir = options.workdir;
    }
    if (options.cpus !== undefined) {
      this.cpus = options.cpus;
    }
    if (options.memoryMiB !== undefined) {
      this.memoryMiB = options.memoryMiB;
    }
    if (options.idleTimeoutSeconds !== undefined) {
      this.idleTimeoutSeconds = options.idleTimeoutSeconds;
    }
    if (options.maxDurationSeconds !== undefined) {
      this.maxDurationSeconds = options.maxDurationSeconds;
    }
    this.replaceExisting = options.replaceExisting ?? false;
    this.namePrefix = options.namePrefix ?? "";
    this.runStateDir = (options.runStateDir ?? DEFAULT_RUN_STATE_DIR).replace(/\/+$/, "");
    this.shell = options.shell ?? DEFAULT_SHELL;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.listPageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    if (options.sdk !== undefined) {
      this.injectedSdk = options.sdk;
    }
  }

  // --- lookup --------------------------------------------------------------

  async findByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    const handles = await this.findAllByLabels(labels, options);
    const excluded = new Set(options.excludeIds ?? []);
    return handles.find((handle) => !excluded.has(handle.id)) ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const cap = options.limit ?? options.pageSize;
    return this.collectByLabels(labels, states, cap, options.pageSize);
  }

  async countByLabels(
    labels: Record<string, string>,
    options: SandboxCountOptions = {},
  ): Promise<number> {
    const maxCount = options.maxCount === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxCount));
    if (maxCount === 0) {
      // Short-circuit: a cap of zero can be answered without a network call.
      return 0;
    }
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const cap = Number.isFinite(maxCount) ? maxCount : undefined;
    const handles = await this.collectByLabels(labels, states, cap, options.pageSize);
    return handles.length;
  }

  /**
   * Drain the cursor-paginated, server-side label listing, keep the entries
   * matching `states`, and stop as soon as `cap` handles are collected.
   */
  private async collectByLabels(
    labels: Record<string, string>,
    states: readonly string[] | null,
    cap: number | undefined,
    pageSize: number | undefined,
  ): Promise<RuntimeHandle[]> {
    const limit = pageSize ?? this.listPageSize;
    const handles: RuntimeHandle[] = [];
    let cursor: string | undefined;
    // Bounded so a backend that keeps handing back the same cursor cannot spin
    // this loop forever.
    for (let page = 0; page < 1_000; page += 1) {
      const cursorForPage = cursor;
      const result = await this.withBackend((sdk) =>
        sdk.Sandbox.listWith((builder) => {
          let configured = builder.limit(limit);
          if (hasEntries(labels)) {
            configured = configured.labels(labels);
          }
          if (cursorForPage) {
            configured = configured.cursor(cursorForPage);
          }
          return configured;
        }),
      );
      for (const entry of result.sandboxes ?? []) {
        if (!matchesState(entry.status, states)) {
          continue;
        }
        handles.push(handleFromSandboxHandle(entry));
        if (cap !== undefined && handles.length >= cap) {
          return handles;
        }
      }
      if (!result.nextCursor) {
        return handles;
      }
      cursor = result.nextCursor;
    }
    return handles;
  }

  async getById(
    id: string,
    options: {
      states?: readonly string[] | null;
      owned?: boolean;
      homeDir?: string;
      workdir?: string;
    } = {},
  ): Promise<RuntimeHandle | null> {
    const entry = await this.lookupHandle(id);
    if (!entry) {
      return null;
    }
    // `undefined` means "the caller did not filter"; `null` means "any state".
    const states = options.states === undefined ? null : options.states;
    if (!matchesState(entry.status, states)) {
      return null;
    }
    const handle = handleFromSandboxHandle(entry);
    if (options.homeDir !== undefined) {
      handle.homeDir = options.homeDir;
    }
    if (options.workdir !== undefined) {
      handle.workdir = options.workdir;
    }
    return handle;
  }

  // --- launch --------------------------------------------------------------

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    return this.createSandbox(options, false);
  }

  async launchDetached(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    // A detached sandbox keeps running after this Node process exits, so a
    // short-lived request context can return before the workload finishes and a
    // later tick can reattach by name.
    return this.createSandbox(options, true);
  }

  private async createSandbox(
    options: LaunchOptions,
    detached: boolean,
  ): Promise<RuntimeHandle> {
    const name = this.resolveName(options.name);
    const workdir = options.workdir ?? this.defaultWorkdir;
    const create = this.withBackend(async (sdk) => {
      let builder = sdk.Sandbox.builder(name);
      builder = this.snapshot
        ? builder.fromSnapshot(this.snapshot)
        : builder.image(this.image as string);
      if (this.cpus !== undefined) {
        builder = builder.cpus(this.cpus);
      }
      if (this.memoryMiB !== undefined) {
        builder = builder.memory(this.memoryMiB);
      }
      if (this.idleTimeoutSeconds !== undefined) {
        builder = builder.idleTimeout(this.idleTimeoutSeconds);
      }
      if (this.maxDurationSeconds !== undefined) {
        builder = builder.maxDuration(this.maxDurationSeconds);
      }
      if (workdir !== undefined) {
        builder = builder.workdir(workdir);
      }
      if (hasEntries(options.env)) {
        builder = builder.envs(options.env);
      }
      const labels = mergeLabels(options.labels, options.label);
      if (hasEntries(labels)) {
        builder = builder.labels(labels);
      }
      if (detached) {
        builder = builder.detached(true);
      }
      if (this.replaceExisting) {
        builder = builder.replace();
      }
      return builder.create();
    });

    // The builder has no create-timeout setter, and `maxDuration` is a sandbox
    // LIFETIME budget — mapping the caller's boot deadline onto it would kill
    // every long-lived sandbox the moment that deadline elapsed. So the create
    // deadline is enforced here instead, and the still-booting sandbox stays
    // addressable under its deterministic name.
    const sandbox = options.createTimeoutSeconds
      ? await withDeadline(create, options.createTimeoutSeconds * 1000, name)
      : await create;

    this.sandboxes.set(name, sandbox);
    const handle: RuntimeHandle = { id: name, state: "STARTED", homeDir: this.homeDir };
    if (workdir !== undefined) {
      handle.workdir = workdir;
    }
    return handle;
  }

  private resolveName(requested?: string): string {
    const name = requested ?? `${this.namePrefix}${randomUUID()}`;
    const byteLength = Buffer.byteLength(name, "utf8");
    if (byteLength > MAX_SANDBOX_NAME_BYTES) {
      throw new MicrosandboxNameTooLongError(name, byteLength);
    }
    return name;
  }

  // --- exec ----------------------------------------------------------------

  /** Bootstrap-plane exec. Same call as `runScript`, narrower result shape. */
  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, {
      command,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { output: result.output, exitCode: result.exitCode ?? 0 };
  }

  async runScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    const cwd = options.cwd ?? handle.workdir;
    // `shell(script)` takes no options, so a configurable POSIX shell with
    // `-c` is what carries cwd / env / timeout onto a command string.
    const output = await this.withBackend(() =>
      sandbox.execWith(this.shell, (builder) => {
        let configured = builder.args(["-c", options.command]);
        if (cwd !== undefined) {
          configured = configured.cwd(cwd);
        }
        if (hasEntries(options.env)) {
          configured = configured.envs(options.env);
        }
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          configured = configured.timeout(options.timeoutMs);
        }
        return configured;
      }),
    );
    const stdout = output.stdout();
    const stderr = output.stderr();
    // A non-zero exit is a RESULT here, not an exception: the SDK resolves
    // `ExecOutput` with `code`/`success` rather than throwing.
    return {
      output: combineOutput(stdout, stderr),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      exitCode: typeof output.code === "number" ? output.code : null,
    };
  }

  async startScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    suppressInputEcho?: boolean;
  }): Promise<AsyncRunStartResult> {
    const sandbox = await this.requireSandbox(handle);
    const sessionId = options.sessionId ?? `run-${handle.id}-${randomUUID()}`;
    const dir = this.scriptRunDir(sessionId);
    const outPath = `${dir}/out`;
    const exitPath = `${dir}/exit`;
    const cwd = options.cwd ?? handle.workdir;
    // Durable-file wrapper: the SDK's streaming `ExecHandle` is process-local
    // and has no server-side id to poll from a fresh process, so combined
    // output and the final exit code are captured to guest files that survive
    // disconnect and reconnect across poll ticks. `nohup ... &` detaches the
    // run from the submit call so the submit returns immediately.
    const wrapped =
      `mkdir -p ${shellSingleQuote(dir)}; ` +
      `nohup ${shellSingleQuote(this.shell)} -c ` +
      shellSingleQuote(
        `{ ${options.command}\n} > ${shellSingleQuote(outPath)} 2>&1; ` +
        `echo $? > ${shellSingleQuote(exitPath)}`,
      ) +
      ` > /dev/null 2>&1 & echo $!`;
    const output = await this.withBackend(() =>
      sandbox.execWith(this.shell, (builder) => {
        let configured = builder.args(["-c", wrapped]);
        if (cwd !== undefined) {
          configured = configured.cwd(cwd);
        }
        if (hasEntries(options.env)) {
          configured = configured.envs(options.env);
        }
        // The caller's `timeoutMs` bounds the SUBMIT call only. It is
        // deliberately NOT applied to the backgrounded command: the command's
        // lifetime is the sandbox's, and applying the submit deadline here
        // would kill every long-running run the moment submission completed.
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          configured = configured.timeout(options.timeoutMs);
        }
        return configured;
      }),
    );
    return { sessionId, commandId: output.stdout().trim() };
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    sessionId: string,
    _commandId: string,
  ): Promise<AsyncRunStatus> {
    const sandbox = await this.requireSandbox(handle);
    const exitPath = `${this.scriptRunDir(sessionId)}/exit`;
    // The durable exit file is the source of truth: missing or empty means the
    // run has not finished, never "finished with an unknown code".
    const raw = await this.readFileBestEffort(sandbox, exitPath, 64);
    const trimmed = raw.trim();
    if (!trimmed) {
      return { exitCode: null };
    }
    const parsed = Number.parseInt(trimmed, 10);
    return { exitCode: Number.isFinite(parsed) ? parsed : null };
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    const outPath = `${this.scriptRunDir(sessionId)}/out`;
    const output = await this.readFileBestEffort(sandbox, outPath, SCRIPT_LOG_READ_MAX_BYTES);
    // exitCode stays null: `getScriptStatus` is the single source of truth for
    // the exit code, matching the Daytona, E2B and local adapters.
    return { output, exitCode: null, cmdId: commandId };
  }

  // --- bootstrap-plane async exec aliases ----------------------------------

  async startExec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions & { sessionId?: string } = {},
  ): Promise<AsyncExecStartResult> {
    return this.startScript(handle, { command, ...options });
  }

  async getExecStatus(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<AsyncExecStatus> {
    return this.getScriptStatus(handle, sessionId, commandId);
  }

  async getExecLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<ExecResult> {
    const result = await this.getScriptLogs(handle, sessionId, commandId);
    return { output: result.output, exitCode: result.exitCode ?? 0 };
  }

  // --- files ---------------------------------------------------------------

  /**
   * Put one file into the guest.
   *
   * A `string` source is a HOST PATH and a `Buffer` source is file CONTENT —
   * the same split the Daytona adapter uses, so this class's `uploadFile` and
   * `uploadBundle` cannot disagree with each other.
   */
  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    const sandbox = await this.requireSandbox(handle);
    const fs = sandbox.fs();
    await this.ensureParentDir(fs, destination);
    if (typeof source === "string") {
      await this.withBackend(() => fs.copyFromHost(source, destination));
      return;
    }
    await this.withBackend(() => fs.write(destination, toUint8Array(source)));
  }

  async uploadBundle(handle: RuntimeHandle, options: {
    files: Array<{ source: string | Buffer; destination: string }>;
  }): Promise<void> {
    for (const file of options.files) {
      await this.uploadFile(handle, file.source, file.destination);
    }
  }

  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    const sandbox = await this.requireSandbox(handle);
    const fs = sandbox.fs();
    if (destination) {
      await this.withBackend(() => fs.copyToHost(source, destination));
      return;
    }
    const bytes = await this.withBackend(() => fs.read(source));
    return Buffer.from(bytes);
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    // The guest home directory is a property of the image, which this package
    // does not choose, so it is injected rather than probed.
    return handle.homeDir ?? this.homeDir;
  }

  // --- lifecycle -----------------------------------------------------------

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const entry = await this.lookupHandle(handle.id);
    if (!entry) {
      throw new Error(`Microsandbox sandbox "${handle.id}" is no longer available`);
    }
    const sandbox = await this.withBackend(() => entry.start());
    this.sandboxes.set(handle.id, sandbox);
    return { ...handle, state: "STARTED" };
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    const entry = await this.lookupHandle(handle.id);
    if (!entry) {
      // Already gone: stopping is idempotent, so this is success, not an error.
      return;
    }
    this.sandboxes.delete(handle.id);
    await this.withBackend(() => entry.stop());
  }

  /**
   * Halt the sandbox AND drop its database record.
   *
   * Both halves matter: the name is the identity, so leaving a stopped record
   * behind would make the next `launch` under that name collide.
   */
  async destroy(handle: RuntimeHandle): Promise<void> {
    const entry = await this.lookupHandle(handle.id);
    this.sandboxes.delete(handle.id);
    if (!entry) {
      return;
    }
    try {
      await this.withBackend(() => entry.kill());
    } catch (error) {
      // `remove` requires a stopped sandbox; a kill that failed because it was
      // already stopped must not block the removal that frees the name.
      if (!isSandboxNotFound(error) && !isAlreadyStopped(error)) {
        throw error;
      }
    }
    try {
      await this.withBackend(() => entry.remove());
    } catch (error) {
      if (!isSandboxNotFound(error)) {
        throw error;
      }
    }
  }

  // --- internals -----------------------------------------------------------

  private async sdk(): Promise<MicrosandboxSdk> {
    if (this.injectedSdk) {
      return this.injectedSdk;
    }
    if (!this.sdkPromise) {
      // Lazy — keeps `microsandbox` and its platform-specific native addon out
      // of every non-microsandbox consumer.
      this.sdkPromise = import("microsandbox").then(
        (mod) => mod as unknown as MicrosandboxSdk,
      );
    }
    return this.sdkPromise;
  }

  /**
   * Run one SDK call with this runtime's backend in scope.
   *
   * `withDefaultBackend` restores the previous backend in a `finally`, so
   * constructing a runtime never mutates process-wide state — the reason
   * `setDefaultBackend` is never called from this adapter.
   */
  private async withBackend<T>(fn: (sdk: MicrosandboxSdk) => Promise<T> | T): Promise<T> {
    const sdk = await this.sdk();
    return sdk.withDefaultBackend(this.backend, () => fn(sdk));
  }

  private async lookupHandle(name: string): Promise<MsbSandboxHandle | null> {
    try {
      return (await this.withBackend((sdk) => sdk.Sandbox.get(name))) ?? null;
    } catch (error) {
      if (isSandboxNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async requireSandbox(handle: RuntimeHandle): Promise<MsbSandbox> {
    const cached = this.sandboxes.get(handle.id);
    if (cached) {
      return cached;
    }
    const entry = await this.lookupHandle(handle.id);
    if (!entry) {
      throw new Error(`Microsandbox sandbox "${handle.id}" is no longer available`);
    }
    // `connect` attaches WITHOUT taking lifecycle ownership, so a poll tick
    // that reattaches cannot accidentally stop a sandbox it did not launch.
    const sandbox = await this.withBackend(() =>
      entry.connectWithTimeout(this.connectTimeoutMs),
    );
    this.sandboxes.set(handle.id, sandbox);
    return sandbox;
  }

  private async ensureParentDir(fs: MsbFsOps, destination: string): Promise<void> {
    const parent = parentDir(destination);
    if (!parent) {
      return;
    }
    try {
      await this.withBackend(() => fs.mkdir(parent));
    } catch {
      // Best effort: an already-present directory is the common case and must
      // not fail the upload that follows.
    }
  }

  private async readFileBestEffort(
    sandbox: MsbSandbox,
    path: string,
    maxBytes: number,
  ): Promise<string> {
    // Read through a bounded `tail -c` rather than `fs.readToString`: it yields
    // "" instead of throwing while the file is still absent, and caps the bytes
    // pulled back to the caller.
    try {
      const output = await this.withBackend(() =>
        sandbox.execWith(this.shell, (builder) =>
          builder.args([
            "-c",
            `tail -c ${maxBytes} ${shellSingleQuote(path)} 2>/dev/null || true`,
          ]),
        ),
      );
      return output.stdout() ?? "";
    } catch {
      return "";
    }
  }

  private scriptRunDir(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
    return `${this.runStateDir}/${safe}`;
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * Normalize an SDK status onto the `STARTED`/`STOPPED` vocabulary the delivery
 * path reasons about.
 *
 * `draining` reads as STOPPED on purpose: a draining sandbox is on its way
 * down, so handing it back as a warm lease would hand a caller a sandbox that
 * is about to disappear underneath it.
 */
function normalizeStatus(status: MicrosandboxStatus | undefined): string {
  return status === "running" ? "STARTED" : "STOPPED";
}

function matchesState(
  status: MicrosandboxStatus | undefined,
  states: readonly string[] | null,
): boolean {
  if (states === null) {
    return true;
  }
  return states.includes(normalizeStatus(status));
}

function handleFromSandboxHandle(entry: MsbSandboxHandle): RuntimeHandle {
  return {
    id: entry.name,
    state: normalizeStatus(entry.status),
    ...(entry.createdAt ? { createdAt: entry.createdAt.toISOString() } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt.toISOString() } : {}),
  };
}

function mergeLabels(
  labels: Record<string, string> | undefined,
  label: string | undefined,
): Record<string, string> {
  return {
    ...(labels ?? {}),
    ...(label ? { label } : {}),
  };
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return stdout.endsWith("\n") || stderr.startsWith("\n")
      ? `${stdout}${stderr}`
      : `${stdout}\n${stderr}`;
  }
  return stdout || stderr || "";
}

/** Exact when the SDK's typed error code is present; textual only as a fallback. */
function isSandboxNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    // The SDK tags every error with a `MicrosandboxErrorCode`, so when a code is
    // present it is authoritative and no message sniffing happens at all.
    return code === "sandboxNotFound";
  }
  const name = (error as { name?: unknown }).name;
  if (name === "SandboxNotFoundError") {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /sandbox\s+not\s+found/i.test(message);
}

function isAlreadyStopped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /already\s+stopped|not\s+running/i.test(message);
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  sandboxName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MicrosandboxCreateTimeoutError(sandboxName, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function parentDir(path: string): string | null {
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return null;
  }
  return path.slice(0, index);
}

function toUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function hasEntries(record?: Record<string, string>): record is Record<string, string> {
  return !!record && Object.keys(record).length > 0;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
