import { Buffer } from "node:buffer";

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
  RunScriptResult,
  SandboxRuntime,
} from "../port.js";

// ---------------------------------------------------------------------------
// E2B provider for both public runtime planes.
//
// The `e2b` package is imported lazily so a consumer using another provider
// does not eagerly load it. The structural surface below follows the installed
// e2b v2 contract while keeping tests independent from an API key.
// ---------------------------------------------------------------------------

const DEFAULT_RUN_BUDGET_MS = 30 * 60_000;
const DEFAULT_CREATE_TIMEOUT_MS = 120_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;
const ADMISSION_RECONCILIATION_TIMEOUT_MS = 1_000;
const SCRIPT_LOG_READ_MAX_BYTES = 262_144;

type E2BCommandResult = {
  exitCode: number;
  error?: string;
  stdout: string;
  stderr: string;
};

type E2BCommandHandle = { pid: number };

type E2BRunOpts = {
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  /** Command lifetime cap in milliseconds. */
  timeoutMs?: number;
  /** HTTP request cap in milliseconds. */
  requestTimeoutMs?: number;
};

interface E2BSandbox {
  readonly sandboxId: string;
  commands: {
    run(cmd: string, opts?: E2BRunOpts & { background?: false }): Promise<E2BCommandResult>;
    run(cmd: string, opts: E2BRunOpts & { background: true }): Promise<E2BCommandHandle>;
  };
  files: {
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
  };
  setTimeout(timeoutMs: number): Promise<void>;
}

type E2BSandboxState = "running" | "paused";

type E2BSandboxInfo = {
  sandboxId: string;
  metadata?: Record<string, string>;
  startedAt?: Date;
  endAt?: Date;
  state?: E2BSandboxState;
};

interface E2BSandboxPaginator {
  hasNext: boolean;
  nextItems(): Promise<E2BSandboxInfo[]>;
}

type E2BConnectionOpts = {
  apiKey?: string;
  requestTimeoutMs?: number;
  timeoutMs?: number;
};

export interface E2BSandboxStatics {
  create(
    template: string,
    opts?: E2BConnectionOpts & {
      metadata?: Record<string, string>;
      envs?: Record<string, string>;
    },
  ): Promise<E2BSandbox>;
  connect(sandboxId: string, opts?: E2BConnectionOpts): Promise<E2BSandbox>;
  getInfo(sandboxId: string, opts?: E2BConnectionOpts): Promise<E2BSandboxInfo>;
  list(opts?: E2BConnectionOpts & {
    query?: {
      metadata?: Record<string, string>;
      state?: E2BSandboxState[];
    };
    limit?: number;
  }): E2BSandboxPaginator;
  pause(sandboxId: string, opts?: E2BConnectionOpts & { keepMemory?: boolean }): Promise<boolean>;
  kill(sandboxId: string, opts?: E2BConnectionOpts): Promise<boolean>;
}

export interface E2BAttachedSandboxOptions {
  homeDir?: string;
  workdir?: string;
  owned?: boolean;
  states?: readonly string[] | null;
}

export interface E2BFindByLabelsOptions extends E2BAttachedSandboxOptions {
  states?: readonly string[] | null;
  limit?: number;
  /** @deprecated Use limit. */
  pageSize?: number;
  excludeIds?: readonly string[];
  timeoutMs?: number;
}

export interface E2BCountByLabelsOptions {
  states?: readonly string[] | null;
  limit?: number;
  /** @deprecated Use limit. */
  pageSize?: number;
  maxCount?: number;
  timeoutMs?: number;
}

export interface E2BRunScriptOptions extends ExecOptions {
  command: string;
  sessionId?: string;
  suppressInputEcho?: boolean;
}

export interface E2BBundleFile {
  source: string | Buffer;
  destination: string;
}

export interface E2BUploadBundleOptions {
  files: E2BBundleFile[];
  manifest?: unknown;
  manifestPath?: string;
}

export type E2BSandboxRuntimeOptions = {
  apiKey: string;
  /** Account-specific template or snapshot identifier used for every launch. */
  template: string;
  /** Maximum lifetime granted to an asynchronous command and its sandbox. */
  runBudgetMs?: number;
  /** Default timeout for the create HTTP request, not sandbox lifetime. */
  createTimeoutMs?: number;
  /** Injection seam for tests; defaults to lazy `import("e2b")`. */
  sandbox?: E2BSandboxStatics;
};

type RegisteredSandbox = {
  sandbox?: E2BSandbox;
  owned: boolean;
  state?: E2BSandboxState;
};

export class E2BSandboxRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "e2b";

  readonly capabilities: RuntimeCapabilities = {
    // The SDK has a PTY API, but this adapter does not expose one through the
    // public runtime contract.
    pty: false,
    // Launches always use the caller-provided template/snapshot identifier.
    snapshots: true,
    isolation: "strong",
    // Handles can be resolved by id in a later process/request.
    persistentHandle: true,
    // Polling returns bounded snapshots; it does not expose a streaming API.
    streamingLogs: false,
  };

  // E2B v2 performs metadata-filtered server-side lookup, and stop/start map
  // to pause/connect (connect resumes a paused sandbox).
  readonly declaredCapabilities = { warmLease: true, lifecycle: true } as const;

  private readonly apiKey: string;
  private readonly template: string;
  private readonly runBudgetMs: number;
  private readonly createTimeoutMs: number;
  private readonly injectedStatics?: E2BSandboxStatics;
  private staticsPromise?: Promise<E2BSandboxStatics>;
  private readonly registrations = new Map<string, RegisteredSandbox>();

  constructor(options: E2BSandboxRuntimeOptions) {
    const template = options.template.trim();
    if (!template) {
      throw new Error("E2B sandbox template is required");
    }
    this.apiKey = options.apiKey;
    this.template = template;
    this.runBudgetMs = positiveDuration(options.runBudgetMs, DEFAULT_RUN_BUDGET_MS);
    this.createTimeoutMs = positiveDuration(options.createTimeoutMs, DEFAULT_CREATE_TIMEOUT_MS);
    this.injectedStatics = options.sandbox;
  }

  async findByLabels(
    labels: Record<string, string>,
    options: E2BFindByLabelsOptions = {},
  ): Promise<RuntimeHandle | null> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const providerStates = toE2BStates(states);
    if (providerStates?.length === 0) {
      return null;
    }
    const excludedIds = new Set(options.excludeIds ?? []);
    const deadline = lookupDeadline(options.timeoutMs);
    const paginator = await this.listSandboxes(labels, providerStates, pageSize(options));

    while (paginator.hasNext) {
      const page = await awaitLookupOperation(
        paginator.nextItems(),
        deadline,
        "listing matching E2B sandboxes",
      );
      for (const info of page) {
        if (!matchesState(info.state, states) || excludedIds.has(info.sandboxId)) {
          continue;
        }
        return this.registerInfo(info, options);
      }
    }
    return null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: E2BFindByLabelsOptions = {},
  ): Promise<RuntimeHandle[]> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const providerStates = toE2BStates(states);
    if (providerStates?.length === 0) {
      return [];
    }
    const deadline = lookupDeadline(options.timeoutMs);
    const paginator = await this.listSandboxes(labels, providerStates, pageSize(options));
    const handles: RuntimeHandle[] = [];

    while (paginator.hasNext) {
      const page = await awaitLookupOperation(
        paginator.nextItems(),
        deadline,
        "listing matching E2B sandboxes",
      );
      for (const info of page) {
        if (matchesState(info.state, states)) {
          handles.push(this.registerInfo(info, options));
        }
      }
    }
    return handles;
  }

  async countByLabels(
    labels: Record<string, string>,
    options: E2BCountByLabelsOptions = {},
  ): Promise<number> {
    const maxCount = options.maxCount === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxCount));
    if (maxCount === 0) {
      return 0;
    }
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const providerStates = toE2BStates(states);
    if (providerStates?.length === 0) {
      return 0;
    }
    const deadline = lookupDeadline(options.timeoutMs);
    const paginator = await this.listSandboxes(labels, providerStates, pageSize(options));
    let count = 0;

    while (paginator.hasNext) {
      const page = await awaitLookupOperation(
        paginator.nextItems(),
        deadline,
        "counting matching E2B sandboxes",
      );
      for (const info of page) {
        if (!matchesState(info.state, states)) {
          continue;
        }
        count += 1;
        if (count >= maxCount) {
          return count;
        }
      }
    }
    return count;
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    const statics = await this.statics();
    const name = options.name?.trim() || options.label?.trim();
    const metadata = {
      ...(options.labels ?? {}),
      ...(name ? { name } : {}),
    };
    const requestTimeoutMs = options.createTimeoutSeconds && options.createTimeoutSeconds > 0
      ? Math.ceil(options.createTimeoutSeconds * 1000)
      : this.createTimeoutMs;
    const sandbox = await statics.create(this.template, {
      apiKey: this.apiKey,
      requestTimeoutMs,
      ...(hasEntries(metadata) ? { metadata } : {}),
      ...(hasEntries(options.env) ? { envs: options.env } : {}),
    });
    return this.registerSandbox(sandbox, {
      owned: true,
      workdir: options.workdir,
    });
  }

  async getById(
    id: string,
    options: E2BAttachedSandboxOptions = {},
  ): Promise<RuntimeHandle | null> {
    const statics = await this.statics();
    let info: E2BSandboxInfo;
    try {
      info = await statics.getInfo(id, { apiKey: this.apiKey });
    } catch (error) {
      if (isSandboxNotFound(error)) {
        return null;
      }
      throw error;
    }
    const states = options.states === undefined ? null : options.states;
    if (!matchesState(info.state, states)) {
      return null;
    }
    return this.registerInfo(info, options);
  }

  attachSandbox(
    sandbox: E2BSandbox,
    options: E2BAttachedSandboxOptions = {},
  ): RuntimeHandle {
    return this.registerSandbox(sandbox, {
      owned: options.owned ?? false,
      homeDir: options.homeDir,
      workdir: options.workdir,
    });
  }

  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, { command, ...options });
    return {
      output: result.output,
      exitCode: result.exitCode ?? 0,
    };
  }

  async runScript(
    handle: RuntimeHandle,
    options: E2BRunScriptOptions,
  ): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    try {
      const result = await sandbox.commands.run(options.command, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
        ...(hasEntries(options.env) ? { envs: options.env } : {}),
      });
      return commandResult(result);
    } catch (error) {
      const normalized = normalizeCommandError(error);
      if (normalized) {
        return normalized;
      }
      throw error;
    }
  }

  async startScript(
    handle: RuntimeHandle,
    options: E2BRunScriptOptions,
  ): Promise<AsyncExecStartResult> {
    const sandbox = await this.requireSandbox(handle);
    const sessionId = options.sessionId ?? `run-${handle.id}-${Date.now()}`;
    const paths = scriptRunPaths(sessionId);

    // A deterministic session may be reused after a caller crash. Clear every
    // durable artifact before admission so a later reconciliation cannot
    // mistake a stale command for the command submitted by this attempt.
    const cleanup = await this.runScript(handle, {
      command: `rm -rf ${shellSingleQuote(paths.dir)} && mkdir -p ${shellSingleQuote(paths.dir)}`,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: 30_000,
    });
    if (cleanup.exitCode !== 0) {
      throw new Error(
        `Failed to prepare E2B async session ${sessionId}: ${cleanup.output || "cleanup failed"}`,
      );
    }

    const wrapped = [
      `printf '%s\\n' "$$" > ${shellSingleQuote(paths.admissionTmp)}`,
      `mv ${shellSingleQuote(paths.admissionTmp)} ${shellSingleQuote(paths.admission)}`,
      "{",
      options.command,
      `} > ${shellSingleQuote(paths.output)} 2>&1`,
      "e2b_run_status=$?",
      `printf '%s\\n' "$e2b_run_status" > ${shellSingleQuote(paths.exitTmp)}`,
      `mv ${shellSingleQuote(paths.exitTmp)} ${shellSingleQuote(paths.exit)}`,
      'exit "$e2b_run_status"',
    ].join("\n");

    await sandbox.setTimeout(this.runBudgetMs);
    try {
      const started = await sandbox.commands.run(wrapped, {
        background: true,
        timeoutMs: this.runBudgetMs,
        ...(options.timeoutMs && options.timeoutMs > 0
          ? { requestTimeoutMs: options.timeoutMs }
          : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(hasEntries(options.env) ? { envs: options.env } : {}),
      });
      if (!Number.isInteger(started.pid) || started.pid <= 0) {
        throw new Error("E2B async command did not return a process id");
      }
      return { sessionId, commandId: String(started.pid) };
    } catch (error) {
      if (isOutcomeUnknownAdmissionError(error)) {
        const admittedPid = parseProcessId(await this.readFileBestEffort(
          sandbox,
          paths.admission,
          64,
          ADMISSION_RECONCILIATION_TIMEOUT_MS,
        ));
        if (admittedPid !== null) {
          return {
            sessionId,
            commandId: String(admittedPid),
            reconciled: true,
          };
        }
      }
      throw error;
    }
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    sessionId: string,
    _commandId: string,
  ): Promise<AsyncExecStatus> {
    const sandbox = await this.requireSandbox(handle);
    const raw = await this.readFileBestEffort(
      sandbox,
      scriptRunPaths(sessionId).exit,
      64,
    );
    return { exitCode: parseShellExitCode(raw) };
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    const output = await this.readFileBestEffort(
      sandbox,
      scriptRunPaths(sessionId).output,
      SCRIPT_LOG_READ_MAX_BYTES,
    );
    return { output, exitCode: null, cmdId: commandId };
  }

  startExec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions & { sessionId?: string } = {},
  ): Promise<AsyncExecStartResult> {
    return this.startScript(handle, {
      command,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      sessionId: options.sessionId,
      suppressInputEcho: true,
    });
  }

  getExecStatus(
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
    const logs = await this.getScriptLogs(handle, sessionId, commandId);
    return { output: logs.output, exitCode: logs.exitCode ?? 0 };
  }

  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    const sandbox = await this.requireSandbox(handle);
    const bytes = typeof source === "string"
      ? await import("node:fs/promises").then((fs) => fs.readFile(source))
      : source;
    await sandbox.files.write(destination, toArrayBuffer(bytes));
  }

  async uploadBundle(
    handle: RuntimeHandle,
    options: E2BUploadBundleOptions,
  ): Promise<void> {
    for (const file of options.files) {
      await this.uploadFile(handle, file.source, file.destination);
    }
    const destinations = options.files.map((file) => file.destination);
    if (options.manifest !== undefined) {
      const manifestPath = options.manifestPath ?? "/workspace/manifest.json";
      await this.uploadFile(
        handle,
        Buffer.from(JSON.stringify(options.manifest, null, 2), "utf8"),
        manifestPath,
      );
      destinations.push(manifestPath);
    }
    await this.verifyUploadedBundleFiles(handle, destinations);
  }

  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    const sandbox = await this.requireSandbox(handle);
    const bytes = await sandbox.files.read(source, { format: "bytes" });
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (destination) {
      await import("node:fs/promises").then((fs) => fs.writeFile(destination, buffer));
      return;
    }
    return buffer;
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    if (handle.homeDir) {
      return handle.homeDir;
    }
    const result = await this.runScript(handle, {
      command: `printf '%s' "$HOME"`,
      timeoutMs: 30_000,
    });
    const homeDir = result.exitCode === 0 ? result.stdout?.trim() ?? "" : "";
    if (!homeDir) {
      throw new Error(`Failed to resolve home directory for E2B sandbox "${handle.id}"`);
    }
    handle.homeDir = homeDir;
    return homeDir;
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) {
      return;
    }
    const statics = await this.statics();
    await statics.pause(handle.id, { apiKey: this.apiKey });
    entry.sandbox = undefined;
    entry.state = "paused";
    handle.state = "STOPPED";
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) {
      return handle;
    }
    const statics = await this.statics();
    const sandbox = await statics.connect(handle.id, { apiKey: this.apiKey });
    entry.sandbox = sandbox;
    entry.state = "running";
    handle.state = "STARTED";
    return handle;
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry) {
      return;
    }
    if (!entry.owned) {
      this.registrations.delete(handle.id);
      return;
    }
    const statics = await this.statics();
    await statics.kill(handle.id, { apiKey: this.apiKey });
    this.registrations.delete(handle.id);
  }

  private async statics(): Promise<E2BSandboxStatics> {
    if (this.injectedStatics) {
      return this.injectedStatics;
    }
    if (!this.staticsPromise) {
      this.staticsPromise = import("e2b").then(
        (mod) => (mod as unknown as { Sandbox: E2BSandboxStatics }).Sandbox,
      );
    }
    return this.staticsPromise;
  }

  private async listSandboxes(
    labels: Record<string, string>,
    states: E2BSandboxState[] | null,
    limit: number,
  ): Promise<E2BSandboxPaginator> {
    const statics = await this.statics();
    const query = {
      ...(hasEntries(labels) ? { metadata: labels } : {}),
      ...(states ? { state: states } : {}),
    };
    return statics.list({
      apiKey: this.apiKey,
      limit,
      ...(hasEntries(query) ? { query } : {}),
    });
  }

  private registerInfo(
    info: E2BSandboxInfo,
    options: E2BAttachedSandboxOptions,
  ): RuntimeHandle {
    const existing = this.registrations.get(info.sandboxId);
    this.registrations.set(info.sandboxId, {
      ...(existing?.sandbox ? { sandbox: existing.sandbox } : {}),
      owned: options.owned ?? false,
      state: info.state,
    });
    return {
      ...handleFromE2BInfo(info),
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.workdir ? { workdir: options.workdir } : {}),
    };
  }

  private registerSandbox(
    sandbox: E2BSandbox,
    options: E2BAttachedSandboxOptions & { owned: boolean },
  ): RuntimeHandle {
    this.registrations.set(sandbox.sandboxId, {
      sandbox,
      owned: options.owned,
      state: "running",
    });
    return {
      id: sandbox.sandboxId,
      state: "STARTED",
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.workdir ? { workdir: options.workdir } : {}),
    };
  }

  private async requireSandbox(handle: RuntimeHandle): Promise<E2BSandbox> {
    const registered = this.registrations.get(handle.id);
    if (registered?.state === "paused") {
      throw new Error(`E2B sandbox "${handle.id}" is paused; call start() before using it`);
    }
    if (registered?.sandbox) {
      return registered.sandbox;
    }
    const statics = await this.statics();
    try {
      const sandbox = await statics.connect(handle.id, { apiKey: this.apiKey });
      this.registrations.set(handle.id, {
        sandbox,
        owned: registered?.owned ?? false,
        state: "running",
      });
      return sandbox;
    } catch (error) {
      if (isSandboxNotFound(error)) {
        throw new Error(`E2B sandbox "${handle.id}" is no longer available`, { cause: error });
      }
      throw error;
    }
  }

  private async verifyUploadedBundleFiles(
    handle: RuntimeHandle,
    destinations: string[],
  ): Promise<void> {
    if (destinations.length === 0) {
      return;
    }
    const result = await this.runScript(handle, {
      command: destinations
        .map((destination) => `test -f ${shellSingleQuote(destination)}`)
        .join(" && "),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to verify uploaded E2B bundle files: ${result.output || "remote file check failed"}`,
      );
    }
  }

  private async readFileBestEffort(
    sandbox: E2BSandbox,
    path: string,
    maxBytes: number,
    requestTimeoutMs?: number,
  ): Promise<string> {
    try {
      const result = await sandbox.commands.run(
        `tail -c ${maxBytes} ${shellSingleQuote(path)} 2>/dev/null || true`,
        requestTimeoutMs
          ? { timeoutMs: requestTimeoutMs, requestTimeoutMs }
          : undefined,
      );
      return result.stdout ?? "";
    } catch {
      return "";
    }
  }
}

function commandResult(result: E2BCommandResult): RunScriptResult {
  return {
    output: combineOutput(result.stdout, result.stderr),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
  };
}

function handleFromE2BInfo(info: E2BSandboxInfo): RuntimeHandle {
  return {
    id: info.sandboxId,
    ...(info.state ? { state: normalizeE2BState(info.state) } : {}),
    ...(info.startedAt ? { createdAt: info.startedAt.toISOString() } : {}),
  };
}

function normalizeE2BState(state: E2BSandboxState): string {
  return state === "running" ? "STARTED" : "STOPPED";
}

function normalizeRequestedState(state: string): string {
  const normalized = state.toUpperCase();
  if (normalized === "RUNNING") {
    return "STARTED";
  }
  if (normalized === "PAUSED") {
    return "STOPPED";
  }
  return normalized;
}

function matchesState(
  state: E2BSandboxState | undefined,
  states: readonly string[] | null,
): boolean {
  if (states === null) {
    return true;
  }
  if (!state) {
    return false;
  }
  const actual = normalizeE2BState(state);
  return states.some((candidate) => normalizeRequestedState(candidate) === actual);
}

function toE2BStates(states: readonly string[] | null): E2BSandboxState[] | null {
  if (states === null) {
    return null;
  }
  const providerStates = new Set<E2BSandboxState>();
  for (const state of states) {
    const normalized = normalizeRequestedState(state);
    if (normalized === "STARTED") {
      providerStates.add("running");
    } else if (normalized === "STOPPED") {
      providerStates.add("paused");
    }
  }
  return [...providerStates];
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return stdout.endsWith("\n") || stderr.startsWith("\n")
      ? `${stdout}${stderr}`
      : `${stdout}\n${stderr}`;
  }
  return stdout || stderr || "";
}

type CommandErrorLike = {
  exitCode?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
};

function normalizeCommandError(error: unknown): RunScriptResult | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as CommandErrorLike;
  if (typeof candidate.exitCode !== "number") {
    return null;
  }
  const stdout = typeof candidate.stdout === "string" ? candidate.stdout : "";
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr : "";
  const output = combineOutput(stdout, stderr);
  return {
    output: output || (typeof candidate.message === "string" ? candidate.message : ""),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    exitCode: candidate.exitCode,
  };
}

function isOutcomeUnknownAdmissionError(error: unknown): boolean {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; name?: unknown; message?: unknown }
    : null;
  const code = typeof record?.code === "string" ? record.code.toUpperCase() : "";
  const name = typeof record?.name === "string" ? record.name : "";
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : String(error);
  return (
    code === "ECONNABORTED"
    || code === "ETIMEDOUT"
    || code === "ECONNRESET"
    || name === "TimeoutError"
    || /\btimed out\b/iu.test(message)
    || /\bnetwork connection lost\b/iu.test(message)
    || /\bsocket hang up\b/iu.test(message)
    || /\bfetch failed\b/iu.test(message)
  );
}

function isSandboxNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  return (
    record.name === "NotFoundError"
    || record.name === "SandboxNotFoundError"
    || record.status === 404
    || record.statusCode === 404
    || (typeof record.message === "string" && /not\s*found/i.test(record.message))
  );
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function hasEntries(record?: object): boolean {
  return !!record && Object.keys(record).length > 0;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.ceil(value)
    : fallback;
}

function pageSize(options: { limit?: number; pageSize?: number }): number {
  const value = options.limit ?? options.pageSize ?? 10;
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 10;
}

type LookupDeadline = {
  endsAt: number;
  timeoutMs: number;
};

function lookupDeadline(timeoutMs: number | undefined): LookupDeadline {
  const normalized = positiveDuration(timeoutMs, DEFAULT_LOOKUP_TIMEOUT_MS);
  return { endsAt: Date.now() + normalized, timeoutMs: normalized };
}

async function awaitLookupOperation<T>(
  operation: Promise<T>,
  deadline: LookupDeadline,
  description: string,
): Promise<T> {
  const remainingMs = deadline.endsAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`E2B sandbox lookup exceeded ${deadline.timeoutMs}ms while ${description}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `E2B sandbox lookup exceeded ${deadline.timeoutMs}ms while ${description}`,
          ));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function parseShellExitCode(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d{1,3}$/u.test(normalized)) {
    return null;
  }
  const exitCode = Number(normalized);
  return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
    ? exitCode
    : null;
}

function parseProcessId(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    return null;
  }
  const pid = Number(normalized);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function scriptRunPaths(sessionId: string): {
  dir: string;
  output: string;
  exit: string;
  exitTmp: string;
  admission: string;
  admissionTmp: string;
} {
  // Base64url is filesystem-safe and collision-free for the original UTF-8
  // bytes, unlike replacing punctuation with underscores.
  const safe = Buffer.from(sessionId, "utf8").toString("base64url") || "empty";
  const dir = `/tmp/e2b-run/${safe}`;
  return {
    dir,
    output: `${dir}/out`,
    exit: `${dir}/exit`,
    exitTmp: `${dir}/exit.tmp`,
    admission: `${dir}/admission`,
    admissionTmp: `${dir}/admission.tmp`,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
