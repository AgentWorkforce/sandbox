import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import type {
  AsyncRunStartResult,
  AsyncRunStatus,
  RunScriptResult,
  SandboxCountOptions,
  SandboxLookupOptions,
  SandboxRuntime,
} from "../port.js";
import type {
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeHandle,
  WorkflowRuntime,
} from "../types.js";
import {
  vercelObservedCapabilities,
  vercelSandboxCapabilities,
  vercelWorkflowCapabilities,
} from "./capabilities.js";
import type { VercelRuntimeOptions, VercelSandboxSource } from "./config.js";
import {
  createOfficialVercelSandboxApi,
  currentRequestDeadlineSignal,
  isVercelNotFoundError,
  withRequestDeadline,
  type VercelCommandLike,
  type VercelSandboxApiFactory,
  type VercelSandboxApiLike,
  type VercelSandboxLike,
  type VercelSandboxListItem,
} from "./internal/sdk.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CREATE_TIMEOUT_MS = 180_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 15_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_FILE_TIMEOUT_MS = 60_000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 120_000;
const DEFAULT_DELETE_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_RETRY_DEADLINE_MS = 180_000;
const DEFAULT_LIST_PAGE_SIZE = 100;
const DEFAULT_MAX_LIST_PAGES = 50;

/** The provider caps tags per sandbox; exceeding it is rejected server-side. */
const MAX_TAGS = 5;
/**
 * Conservative client-side bound on generated sandbox names. The provider's
 * exact limit is not documented in the SDK types, so the adapter stays well
 * inside any plausible one rather than discovering it as a create failure.
 */
const MAX_NAME_LENGTH = 63;

export class VercelOperationTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`Vercel ${operation} did not complete within ${timeoutMs}ms`);
    this.name = "VercelOperationTimeoutError";
  }
}

export class VercelLifecycleTimeoutError extends Error {
  constructor(
    readonly sandboxName: string,
    readonly expected: string,
    readonly lastState: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Vercel sandbox "${sandboxName}" did not reach ${expected} within ${timeoutMs}ms `
        + `(last state: "${lastState}")`,
    );
    this.name = "VercelLifecycleTimeoutError";
  }
}

export class VercelDestroyVerificationError extends Error {
  constructor(readonly sandboxName: string, readonly timeoutMs: number) {
    super(
      `Vercel sandbox "${sandboxName}" delete was accepted but absence was not verified `
        + `within ${timeoutMs}ms`,
    );
    this.name = "VercelDestroyVerificationError";
  }
}

export class VercelUnknownExitCodeError extends Error {
  constructor(readonly cmdId: string) {
    super(
      `Vercel command "${cmdId}" reported no exit code; refusing to treat it as success`,
    );
    this.name = "VercelUnknownExitCodeError";
  }
}

export class VercelForeignSandboxError extends Error {
  constructor(readonly sandboxName: string, readonly namePrefix: string) {
    super(
      `Vercel sandbox "${sandboxName}" is outside the owned prefix "${namePrefix}" `
        + "and will not be mutated by this runtime",
    );
    this.name = "VercelForeignSandboxError";
  }
}

export class VercelDetachedLaunchUnsupportedError extends Error {
  constructor() {
    super(
      "Vercel Sandbox.create resolves only once the sandbox is running; there is no "
        + "mid-boot handle to hand back, so detached launch is not offered",
    );
    this.name = "VercelDetachedLaunchUnsupportedError";
  }
}

export class VercelTagLimitError extends Error {
  constructor(readonly count: number) {
    super(`Vercel sandboxes accept at most ${MAX_TAGS} tags; received ${count}`);
    this.name = "VercelTagLimitError";
  }
}

export class VercelListPageLimitError extends Error {
  constructor(readonly maxPages: number, readonly operation: string) {
    super(
      `Vercel ${operation} exceeded the ${maxPages}-page listing cap; refusing to return `
        + "a silently truncated result",
    );
    this.name = "VercelListPageLimitError";
  }
}

export class VercelCapabilityMismatchError extends Error {
  constructor(message: string) {
    super(`Vercel capability declaration mismatch: ${message}`);
    this.name = "VercelCapabilityMismatchError";
  }
}

export interface VercelAttachedSandboxOptions {
  states?: readonly string[] | null;
  owned?: boolean;
  homeDir?: string;
  workdir?: string;
}

export interface VercelListOwnedOptions {
  states?: readonly string[] | null;
  /**
   * Include sandboxes in a terminal dead state (`failed`, `aborted`). They are
   * excluded by default because they are not usable, but a cleanup audit needs
   * to see them: the provider still lists them, and a name they hold is not
   * free.
   */
  includeTerminated?: boolean;
  timeoutMs?: number;
}

export interface VercelOwnedSandbox {
  name: string;
  state: string;
  /** The provider's own status string, unmapped. */
  providerStatus: string;
  createdAt: string;
  terminated: boolean;
  tags?: Record<string, string>;
  vcpus?: number;
  memoryMiB?: number;
  /** Active-CPU milliseconds billed so far, when the provider reports it. */
  activeCpuMs?: number;
  /** Wall-clock milliseconds so far, when the provider reports it. */
  wallClockMs?: number;
}

export interface VercelBundleFile {
  /** Host path when a string; exact file content when a Buffer. */
  source: string | Buffer;
  destination: string;
}

export interface VercelUploadBundleOptions {
  files: VercelBundleFile[];
  manifest?: unknown;
  manifestPath?: string;
}

export interface VercelRunScriptOptions extends ExecOptions {
  command: string;
  sessionId?: string;
}

/** Test-only injection seam. Not exported from the package barrel. */
export interface VercelRuntimeDependencies {
  apiFactory?: VercelSandboxApiFactory;
}

type RegisteredSandbox = {
  owned: boolean;
  labels: Readonly<Record<string, string>>;
  state?: string;
  /**
   * Create timestamp of the exact sandbox this registration refers to. Delete
   * verification needs it: a row that reappears under the same name with a
   * different `createdAt` is a *different* sandbox, not a survivor.
   */
  createdAtMs?: number;
};

/**
 * Vercel Sandbox provider adapter.
 *
 * Identity note, and it is load-bearing: a Vercel sandbox is addressed by its
 * **name**, unique within a project, not by an opaque server id. `RuntimeHandle.id`
 * therefore carries the sandbox name. That is what makes prefix ownership a real
 * boundary here rather than a labelling convention — the adapter will not mutate
 * a sandbox whose name falls outside its prefix.
 */
export class VercelSandboxRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "vercel";
  readonly capabilities = vercelWorkflowCapabilities;
  readonly declaredCapabilities = vercelSandboxCapabilities;
  readonly observedCapabilities = vercelObservedCapabilities;

  private readonly credentials: {
    token: string;
    teamId: string;
    projectId: string;
  };
  private readonly namePrefix: string;
  private readonly defaultHomeDir: string;
  private readonly source: VercelSandboxSource;
  private readonly vcpus?: number;
  private readonly sandboxTimeoutMs?: number;
  private readonly persistent?: boolean;
  private readonly ports?: number[];
  private readonly env: Readonly<Record<string, string>>;
  private readonly requestTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly lookupTimeoutMs: number;
  private readonly execTimeoutMs: number;
  private readonly fileTimeoutMs: number;
  private readonly lifecycleTimeoutMs: number;
  private readonly deleteTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryDeadlineMs: number;
  private readonly listPageSize: number;
  private readonly maxListPages: number;
  private readonly injectedApiFactory?: VercelSandboxApiFactory;
  private readonly registrations = new Map<string, RegisteredSandbox>();
  private readonly instances = new Map<string, VercelSandboxLike>();
  /**
   * Commands started in this process, kept so status/log reads do not need the
   * SDK's re-resolution path when the live object is right here. Re-resolution
   * still exists for reattach after a restart.
   */
  private readonly commands = new Map<string, VercelCommandLike>();

  constructor(
    options: VercelRuntimeOptions,
    dependencies: VercelRuntimeDependencies = {},
  ) {
    this.credentials = {
      token: required(options.token, "Vercel token"),
      teamId: required(options.teamId, "Vercel team id"),
      projectId: required(options.projectId, "Vercel project id"),
    };
    this.namePrefix = validateNamePrefix(options.namePrefix);
    this.defaultHomeDir = required(
      options.defaultHomeDir,
      "Vercel default home directory",
    );
    this.source = validateSource(options.source);
    this.vcpus = validateVcpus(options.vcpus);
    this.sandboxTimeoutMs = optionalPositive(
      options.sandboxTimeoutMs,
      "Vercel sandboxTimeoutMs",
    );
    this.persistent = options.persistent;
    this.ports = validatePorts(options.ports);
    this.env = validateEnv(options.env ?? {});
    this.requestTimeoutMs = positiveDuration(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.createTimeoutMs = positiveDuration(
      options.createTimeoutMs,
      DEFAULT_CREATE_TIMEOUT_MS,
    );
    this.lookupTimeoutMs = positiveDuration(
      options.lookupTimeoutMs,
      DEFAULT_LOOKUP_TIMEOUT_MS,
    );
    this.execTimeoutMs = positiveDuration(
      options.execTimeoutMs,
      DEFAULT_EXEC_TIMEOUT_MS,
    );
    this.fileTimeoutMs = positiveDuration(
      options.fileTimeoutMs,
      DEFAULT_FILE_TIMEOUT_MS,
    );
    this.lifecycleTimeoutMs = positiveDuration(
      options.lifecycleTimeoutMs,
      DEFAULT_LIFECYCLE_TIMEOUT_MS,
    );
    this.deleteTimeoutMs = positiveDuration(
      options.deleteTimeoutMs,
      DEFAULT_DELETE_TIMEOUT_MS,
    );
    this.pollIntervalMs = positiveDuration(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.retryDeadlineMs = positiveDuration(
      options.retryDeadlineMs,
      DEFAULT_RETRY_DEADLINE_MS,
    );
    this.listPageSize = positiveDuration(
      options.listPageSize,
      DEFAULT_LIST_PAGE_SIZE,
    );
    this.maxListPages = positiveDuration(
      options.maxListPages,
      DEFAULT_MAX_LIST_PAGES,
    );
    this.injectedApiFactory = dependencies.apiFactory;
    assertVercelCapabilityImplementation(this);
  }

  // --- launch ---------------------------------------------------------------

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    const timeoutMs = options.createTimeoutSeconds && options.createTimeoutSeconds > 0
      ? Math.ceil(options.createTimeoutSeconds * 1_000)
      : this.createTimeoutMs;
    const name = this.ownedName(options.name?.trim() || options.label?.trim());
    const labels = validateTags(options.labels ?? {});
    const env = validateEnv({ ...this.env, ...(options.env ?? {}) });
    const created = await this.run(timeoutMs, "create", (signal) =>
      this.api().then((api) =>
        api.create({
          name,
          ...(hasEntries(labels) ? { tags: { ...labels } } : {}),
          ...(hasEntries(env) ? { env: { ...env } } : {}),
          ...(this.ports ? { ports: [...this.ports] } : {}),
          ...(this.sandboxTimeoutMs ? { timeout: this.sandboxTimeoutMs } : {}),
          ...(this.persistent !== undefined
            ? { persistent: this.persistent }
            : {}),
          ...(this.vcpus ? { resources: { vcpus: this.vcpus } } : {}),
          ...(this.source.type === "image" ? { image: this.source.image } : {}),
          ...(this.source.type === "runtime"
            ? { runtime: this.source.runtime }
            : {}),
          signal,
        }),
      ),
    );
    if (!created || typeof created.name !== "string" || !created.name.trim()) {
      throw new Error("Vercel create response is missing a sandbox name");
    }
    this.instances.set(created.name, created);
    this.register(created.name, {
      owned: true,
      labels,
      state: normalizeState(created.status),
      createdAtMs: toMillis(created.createdAt),
    });
    return {
      id: created.name,
      state: normalizeState(created.status),
      homeDir: this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
      ...(created.createdAt ? { createdAt: toIso(created.createdAt) } : {}),
    };
  }

  /**
   * Launch a sandbox bound to the caller's scope.
   *
   * Ergonomic borrowed from the `await using` shape the SDK itself exposes on
   * `Sandbox.create`: the sandbox is destroyed — and its destruction verified —
   * when the scope exits, including on a thrown error. Cleanup you cannot
   * forget is the only kind that survives a crash path.
   *
   * ```ts
   * await using lease = await runtime.acquire({ labels: { job: "build" } });
   * await runtime.exec(lease.handle, "npm test");
   * ```
   */
  async acquire(
    options: LaunchOptions = {},
  ): Promise<{ handle: RuntimeHandle } & AsyncDisposable> {
    const handle = await this.launch(options);
    return {
      handle,
      [Symbol.asyncDispose]: async () => {
        await this.destroy(handle);
      },
    };
  }

  // --- lookup ---------------------------------------------------------------

  async findByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    const matches = await this.findAllByLabels(labels, { ...options, limit: 1 });
    return matches[0] ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const wanted = validateTags(labels);
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const excluded = new Set(options.excludeIds ?? []);
    const items = await this.listAll(
      {
        namePrefix: this.namePrefix,
        ...(hasEntries(wanted) ? { tags: { ...wanted } } : {}),
      },
      options.timeoutMs ?? this.lookupTimeoutMs,
      "label lookup",
      options.pageSize,
    );
    const handles: RuntimeHandle[] = [];
    for (const item of items) {
      if (!this.isOwnedName(item.name) || excluded.has(item.name)) {
        continue;
      }
      // Re-check the tags client-side. The `tags` query parameter is a server
      // filter this adapter has not yet proven; if the provider were to ignore
      // it, an unchecked result would hand the caller someone else's sandbox as
      // a warm lease. Verifying locally costs nothing and removes that class.
      if (!matchesAllTags(item.tags, wanted)) {
        continue;
      }
      if (!matchesState(item.status, states)) {
        continue;
      }
      this.register(item.name, {
        owned: options.owned ?? true,
        labels: item.tags ?? {},
        state: normalizeState(item.status),
        createdAtMs: item.createdAt,
      });
      handles.push(this.toHandle(item));
      if (options.limit && handles.length >= options.limit) {
        break;
      }
    }
    return handles;
  }

  async countByLabels(
    labels: Record<string, string>,
    options: SandboxCountOptions = {},
  ): Promise<number> {
    const matches = await this.findAllByLabels(labels, {
      states: options.states,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.maxCount !== undefined ? { limit: options.maxCount } : {}),
      ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    });
    return matches.length;
  }

  /**
   * Re-resolve a sandbox by name.
   *
   * Deliberately implemented over `list`, not `Sandbox.get`: `get` resumes the
   * session as a side effect, which starts billing and boots a VM. A lookup
   * must not be able to do that — a crash-recovery scan over a hundred handles
   * would otherwise wake every one of them.
   */
  async getById(
    id: string,
    options: VercelAttachedSandboxOptions = {},
  ): Promise<RuntimeHandle | null> {
    const item = await this.remoteByName(id, this.lookupTimeoutMs);
    if (!item) {
      return null;
    }
    const states = options.states === undefined ? null : options.states;
    if (!matchesState(item.status, states)) {
      return null;
    }
    this.register(id, {
      owned: options.owned ?? false,
      labels: item.tags ?? {},
      state: normalizeState(item.status),
      createdAtMs: item.createdAt,
    });
    return this.toHandle(item, options);
  }

  async listOwned(
    options: VercelListOwnedOptions = {},
  ): Promise<VercelOwnedSandbox[]> {
    const items = await this.listAll(
      { namePrefix: this.namePrefix },
      options.timeoutMs ?? this.lookupTimeoutMs,
      "owned sandbox list",
    );
    const states = options.states === undefined ? null : options.states;
    return items
      .filter((item) => this.isOwnedName(item.name))
      .filter(
        (item) => options.includeTerminated || !isTerminated(item.status),
      )
      .filter((item) => matchesState(item.status, states))
      .map((item) => ({
        name: item.name,
        state: normalizeState(item.status),
        providerStatus: item.status,
        createdAt: new Date(item.createdAt).toISOString(),
        terminated: isTerminated(item.status),
        ...(item.tags ? { tags: item.tags } : {}),
        ...(typeof item.vcpus === "number" ? { vcpus: item.vcpus } : {}),
        ...(typeof item.memory === "number" ? { memoryMiB: item.memory } : {}),
        ...(typeof item.totalActiveCpuDurationMs === "number"
          ? { activeCpuMs: item.totalActiveCpuDurationMs }
          : {}),
        ...(typeof item.totalDurationMs === "number"
          ? { wallClockMs: item.totalDurationMs }
          : {}),
      }));
  }

  // --- exec -----------------------------------------------------------------

  async runScript(
    handle: RuntimeHandle,
    options: VercelRunScriptOptions,
  ): Promise<RunScriptResult> {
    this.requireRegistered(handle);
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0
      ? Math.ceil(options.timeoutMs)
      : this.execTimeoutMs;
    const command = await this.run(timeoutMs, "command", (signal) =>
      this.sandbox(handle.id).then((sandbox) =>
        sandbox.runCommand({
          ...this.commandParams(options),
          timeoutMs,
          signal,
        }),
      ),
    );
    return this.collect(command, timeoutMs);
  }

  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, { command, ...options });
    if (result.exitCode === null) {
      throw new VercelUnknownExitCodeError(result.cmdId ?? "unknown");
    }
    return { output: result.output, exitCode: result.exitCode };
  }

  async startScript(
    handle: RuntimeHandle,
    options: VercelRunScriptOptions & { suppressInputEcho?: boolean },
  ): Promise<AsyncRunStartResult> {
    this.requireRegistered(handle);
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0
      ? Math.ceil(options.timeoutMs)
      : this.execTimeoutMs;
    const sandbox = await this.sandbox(handle.id);
    const command = await this.run(this.requestTimeoutMs, "detached command", (
      signal,
    ) =>
      sandbox.runCommand({
        ...this.commandParams(options),
        // The provider enforces the command timeout inside the sandbox, so it
        // still applies to a detached command nobody is awaiting. That matters:
        // a detached run whose caller dies would otherwise burn CPU forever.
        timeoutMs,
        detached: true,
        signal,
      }),
    );
    this.commands.set(command.cmdId, command);
    return {
      sessionId: this.sessionIdOf(sandbox, options.sessionId),
      commandId: command.cmdId,
    };
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    _sessionId: string,
    commandId: string,
  ): Promise<AsyncRunStatus> {
    const command = await this.resolveCommand(handle, commandId);
    return { exitCode: command.exitCode };
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    _sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    const command = await this.resolveCommand(handle, commandId);
    return this.collect(command, this.requestTimeoutMs);
  }

  // --- files ----------------------------------------------------------------

  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    await this.uploadBundle(handle, { files: [{ source, destination }] });
  }

  async uploadBundle(
    handle: RuntimeHandle,
    options: VercelUploadBundleOptions,
  ): Promise<void> {
    this.requireRegistered(handle);
    const files: Array<{ path: string; content: Uint8Array }> = [];
    for (const file of options.files) {
      const content = typeof file.source === "string"
        ? await readFile(file.source)
        : file.source;
      files.push({ path: file.destination, content });
    }
    if (options.manifest !== undefined) {
      files.push({
        path: options.manifestPath ?? "/workspace/manifest.json",
        content: Buffer.from(JSON.stringify(options.manifest, null, 2), "utf8"),
      });
    }
    if (files.length === 0) {
      return;
    }
    const parents = [
      ...new Set(
        files
          .map((file) => parentDirectory(file.path))
          .filter((parent): parent is string => parent !== null),
      ),
    ];
    const sandbox = await this.sandbox(handle.id);
    for (const parent of parents) {
      await this.run(this.fileTimeoutMs, "mkdir", (signal) =>
        sandbox.mkDir(parent, { signal }),
      );
    }
    await this.run(this.fileTimeoutMs, "file upload", (signal) =>
      sandbox.writeFiles(files, { signal }),
    );
    // The write API reports success without telling us what landed. Verify the
    // destinations exist, because a bundle that half-uploaded and reported
    // success is indistinguishable from a working one until the workload fails.
    const verified = await this.runScript(handle, {
      command: files
        .map((file) => `test -f ${shellSingleQuote(file.path)}`)
        .join(" && "),
      timeoutMs: this.fileTimeoutMs,
    });
    if (verified.exitCode !== 0) {
      throw new Error("Failed to verify uploaded Vercel bundle files");
    }
  }

  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    this.requireRegistered(handle);
    const sandbox = await this.sandbox(handle.id);
    const bytes = await this.run(this.fileTimeoutMs, "file download", (signal) =>
      sandbox.readFileToBuffer({ path: source }, { signal }),
    );
    if (bytes === null) {
      throw new Error(
        `Vercel sandbox "${handle.id}" has no file at "${source}"`,
      );
    }
    const buffer = Buffer.from(bytes);
    if (destination) {
      await writeFile(destination, buffer);
      return;
    }
    return buffer;
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    this.requireRegistered(handle);
    handle.homeDir = handle.homeDir ?? this.defaultHomeDir;
    return handle.homeDir;
  }

  // --- lifecycle ------------------------------------------------------------

  async stop(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) {
      return;
    }
    this.requireOwnedName(handle.id);
    const current = await this.requireRemote(handle.id);
    if (isStopped(current.status)) {
      entry.state = "STOPPED";
      handle.state = "STOPPED";
      return;
    }
    if (!isStopping(current.status)) {
      const sandbox = await this.sandbox(handle.id);
      await this.run(this.lifecycleTimeoutMs, "stop", (signal) =>
        sandbox.stop({ signal }),
      );
    }
    await this.waitForSettled(handle.id, isStopped, "stopped");
    entry.state = "STOPPED";
    handle.state = "STOPPED";
  }

  /**
   * Resume a stopped sandbox.
   *
   * Vercel has no explicit start call: `Sandbox.get({ resume: true })` is the
   * resume path, and it is the one place this adapter *wants* that side effect.
   */
  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) {
      return handle;
    }
    this.requireOwnedName(handle.id);
    const current = await this.requireRemote(handle.id);
    if (isTerminated(current.status)) {
      throw new Error(
        `Vercel sandbox "${handle.id}" is ${current.status} and cannot be resumed`,
      );
    }
    if (isStopping(current.status)) {
      await this.waitForSettled(handle.id, isStopped, "stopped");
    }
    const resumed = await this.run(this.lifecycleTimeoutMs, "resume", (signal) =>
      this.api().then((api) =>
        api.get({ name: handle.id, resume: true, signal }),
      ),
    );
    this.instances.set(handle.id, resumed);
    await this.waitForSettled(handle.id, isRunning, "running");
    entry.state = "STARTED";
    handle.state = "STARTED";
    return handle;
  }

  /**
   * Delete a sandbox and verify it is gone.
   *
   * The registration is retained when verification fails, so a caller can retry
   * cleanup. Dropping it would make a leaked sandbox unreachable through this
   * runtime and therefore invisible to every subsequent audit.
   */
  async destroy(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry) {
      return;
    }
    if (!entry.owned) {
      this.forget(handle.id);
      return;
    }
    this.requireOwnedName(handle.id);
    try {
      const sandbox = await this.sandbox(handle.id);
      await this.run(this.deleteTimeoutMs, "delete", (signal) =>
        sandbox.delete({ signal }),
      );
    } catch (error) {
      if (!isVercelNotFoundError(error)) {
        throw error;
      }
      // Already gone. Fall through to verification, which will agree.
    }
    const verified = await this.waitUntilDeleted(handle.id, entry.createdAtMs);
    if (!verified) {
      throw new VercelDestroyVerificationError(handle.id, this.deleteTimeoutMs);
    }
    this.forget(handle.id);
  }

  // Vercel's create resolves only once the sandbox is running, so there is no
  // mid-boot handle to hand back. The optional method is omitted rather than
  // faked, which keeps `detachedLaunch` honestly false in the resolver.
  declare readonly launchDetached?: undefined;

  // --- internals ------------------------------------------------------------

  private async api(): Promise<VercelSandboxApiLike> {
    if (this.injectedApiFactory) {
      return this.injectedApiFactory();
    }
    return createOfficialVercelSandboxApi(this.credentials);
  }

  /**
   * Resolve a live sandbox object, caching it per name.
   *
   * The cached instance holds the SDK client, and that client's fetch reads the
   * ambient operation deadline at call time rather than at construction time —
   * so a cached handle never carries a stale deadline into a later operation.
   */
  private async sandbox(name: string): Promise<VercelSandboxLike> {
    const cached = this.instances.get(name);
    if (cached) {
      return cached;
    }
    const resolved = await this.run(this.lookupTimeoutMs, "attach", (signal) =>
      this.api().then((api) => api.get({ name, signal })),
    );
    this.instances.set(name, resolved);
    return resolved;
  }

  /**
   * Bound one logical operation by an absolute deadline.
   *
   * Two mechanisms, deliberately: the ambient signal aborts the SDK's requests
   * *including its internal retries*, and the race turns whatever comes back
   * into one typed error. Either alone leaves a hole — the signal alone yields
   * an opaque `AbortError`, the race alone leaves the request running.
   */
  private run<T>(
    timeoutMs: number,
    operation: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const budgetMs = Math.min(timeoutMs, this.retryDeadlineMs);
    return withRequestDeadline(budgetMs, async () => {
      const signal = currentRequestDeadlineSignal()!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(signal).catch((error: unknown) => {
            if (isAbortError(error)) {
              throw new VercelOperationTimeoutError(operation, budgetMs);
            }
            throw error;
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new VercelOperationTimeoutError(operation, budgetMs)),
              budgetMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    });
  }

  private commandParams(
    options: VercelRunScriptOptions,
  ): { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> } {
    const env = validateEnv(options.env ?? {});
    return {
      // The port speaks shell scripts; the provider speaks argv. Wrapping in
      // `sh -c` bridges them without interpolating anything into the script:
      // cwd and env go through the provider's own fields, so no caller value is
      // ever spliced into a command string.
      cmd: "sh",
      args: ["-c", options.command],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(hasEntries(env) ? { env: { ...env } } : {}),
    };
  }

  private async collect(
    command: VercelCommandLike,
    timeoutMs: number,
  ): Promise<RunScriptResult> {
    const [stdout, stderr] = await this.run(
      timeoutMs,
      "command output",
      async (signal) => [
        await command.output("stdout", { signal }),
        await command.output("stderr", { signal }),
      ],
    );
    return {
      output: combineOutput(stdout, stderr),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      exitCode: command.exitCode,
      cmdId: command.cmdId,
      // `truncated` is deliberately omitted: the provider does not report a cap,
      // and `undefined` means "not reported", never "known complete".
    };
  }

  private async resolveCommand(
    handle: RuntimeHandle,
    commandId: string,
  ): Promise<VercelCommandLike> {
    this.requireRegistered(handle);
    const live = this.commands.get(commandId);
    if (live && live.exitCode !== null) {
      return live;
    }
    const sandbox = await this.sandbox(handle.id);
    const resolved = await this.run(
      this.requestTimeoutMs,
      "command lookup",
      (signal) => sandbox.getCommand(commandId, { signal }),
    );
    this.commands.set(commandId, resolved);
    return resolved;
  }

  private sessionIdOf(sandbox: VercelSandboxLike, fallback?: string): string {
    try {
      const session = sandbox.currentSession();
      if (session && typeof session.sessionId === "string" && session.sessionId) {
        return session.sessionId;
      }
    } catch {
      // A sandbox with no live session cannot report one. Fall through.
    }
    return fallback ?? sandbox.name;
  }

  private register(name: string, next: RegisteredSandbox): void {
    const existing = this.registrations.get(name);
    this.registrations.set(name, {
      owned: existing?.owned === true || next.owned,
      labels: hasEntries(next.labels)
        ? { ...next.labels }
        : existing?.labels ?? {},
      state: next.state ?? existing?.state,
      createdAtMs: next.createdAtMs ?? existing?.createdAtMs,
    });
  }

  private forget(name: string): void {
    this.registrations.delete(name);
    this.instances.delete(name);
  }

  private requireRegistered(handle: RuntimeHandle): RegisteredSandbox {
    const entry = this.registrations.get(handle.id);
    if (!entry) {
      throw new Error(`Vercel runtime handle "${handle.id}" is not attached`);
    }
    return entry;
  }

  private requireOwnedName(name: string): void {
    if (!this.isOwnedName(name)) {
      throw new VercelForeignSandboxError(name, this.namePrefix);
    }
  }

  private async listAll(
    params: { namePrefix: string; tags?: Record<string, string> },
    timeoutMs: number,
    operation: string,
    pageSize?: number,
  ): Promise<VercelSandboxListItem[]> {
    const limit = pageSize && pageSize > 0
      ? Math.ceil(pageSize)
      : this.listPageSize;
    const deadline = Date.now() + timeoutMs;
    const items: VercelSandboxListItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxListPages; page += 1) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await this.run(remainingMs, operation, (signal) =>
        this.api().then((api) =>
          api.list({
            ...params,
            limit,
            ...(cursor ? { cursor } : {}),
            signal,
          }),
        ),
      );
      if (!response || !Array.isArray(response.sandboxes)) {
        throw new Error("Vercel sandbox list response is malformed");
      }
      const malformed = response.sandboxes.findIndex(
        (item) => !isVercelSandboxListItem(item),
      );
      if (malformed !== -1) {
        throw new Error(`Vercel sandbox list item ${malformed} is malformed`);
      }
      items.push(...response.sandboxes);
      const next = response.pagination?.next;
      if (!next) {
        return items;
      }
      cursor = next;
    }
    throw new VercelListPageLimitError(this.maxListPages, operation);
  }

  private async remoteByName(
    name: string,
    timeoutMs: number,
  ): Promise<VercelSandboxListItem | null> {
    // `namePrefix` narrows server-side; the exact-name match is still done here
    // because a prefix query legitimately returns siblings.
    const items = await this.listAll(
      { namePrefix: name },
      timeoutMs,
      `lookup for sandbox "${name}"`,
    );
    return items.find((item) => item.name === name) ?? null;
  }

  private async requireRemote(name: string): Promise<VercelSandboxListItem> {
    const item = await this.remoteByName(name, this.lookupTimeoutMs);
    if (!item) {
      throw new Error(`Vercel sandbox "${name}" is no longer available`);
    }
    return item;
  }

  private async waitForSettled(
    name: string,
    settled: (status: string) => boolean,
    description: string,
  ): Promise<VercelSandboxListItem> {
    const deadline = Date.now() + this.lifecycleTimeoutMs;
    let lastState = "unknown";
    for (;;) {
      const item = await this.remoteByName(
        name,
        Math.min(this.lookupTimeoutMs, Math.max(1, deadline - Date.now())),
      );
      if (!item) {
        throw new Error(
          `Vercel sandbox "${name}" disappeared while waiting for ${description}`,
        );
      }
      lastState = item.status;
      if (settled(item.status)) {
        return item;
      }
      if (isTerminated(item.status)) {
        throw new Error(
          `Vercel sandbox "${name}" became ${item.status} while waiting for ${description}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new VercelLifecycleTimeoutError(
          name,
          description,
          lastState,
          this.lifecycleTimeoutMs,
        );
      }
      await delay(this.pollIntervalMs);
    }
  }

  /**
   * Poll until the named sandbox is verifiably gone.
   *
   * Vercel deletion removes the row rather than flagging it, so absence is the
   * proof. The `createdAtMs` guard covers the one case absence alone gets
   * wrong: a *new* sandbox created under the same name would otherwise read as
   * our deleted one surviving, and we would report a leak that does not exist —
   * or worse, keep waiting on it and time out a clean teardown.
   */
  private async waitUntilDeleted(
    name: string,
    createdAtMs?: number,
  ): Promise<boolean> {
    const deadline = Date.now() + this.deleteTimeoutMs;
    for (;;) {
      const item = await this.remoteByName(
        name,
        Math.min(this.lookupTimeoutMs, Math.max(1, deadline - Date.now())),
      );
      if (!item) {
        return true;
      }
      if (createdAtMs !== undefined && item.createdAt !== createdAtMs) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(this.pollIntervalMs);
    }
  }

  private toHandle(
    item: VercelSandboxListItem,
    options: VercelAttachedSandboxOptions = {},
  ): RuntimeHandle {
    return {
      id: item.name,
      state: normalizeState(item.status),
      homeDir: options.homeDir ?? this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
      createdAt: new Date(item.createdAt).toISOString(),
      ...(item.updatedAt
        ? { updatedAt: new Date(item.updatedAt).toISOString() }
        : {}),
    };
  }

  private ownedName(requested?: string): string {
    if (!requested) {
      return `${this.namePrefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    }
    if (this.isOwnedName(requested)) {
      return requested;
    }
    // A caller-supplied name is slugged and salted with a digest of the
    // original. Two different requests that slug to the same string therefore
    // still get distinct sandboxes instead of silently colliding on one.
    const digest = createHash("sha256").update(requested).digest("hex").slice(0, 8);
    const room = MAX_NAME_LENGTH - this.namePrefix.length - digest.length - 2;
    const slug = requested
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, Math.max(1, room)) || "sandbox";
    return `${this.namePrefix}-${slug}-${digest}`;
  }

  private isOwnedName(name: string): boolean {
    return name === this.namePrefix || name.startsWith(`${this.namePrefix}-`);
  }
}

/**
 * Construction-time reconciliation between the SDK-free declarations and the
 * surface actually implemented.
 *
 * The registries are exhaustive over every capability key, so adding a key
 * without deciding how it is backed is a type error rather than an unnoticed
 * `false`. A conservative *under*-claim is always allowed — that is how a
 * capability stays false until live evidence promotes it — but a `true` claim
 * without the implementation behind it throws here, at construction, rather
 * than surfacing as a runtime surprise at the call site.
 */
function assertVercelCapabilityImplementation(
  runtime: VercelSandboxRuntime,
): void {
  const workflowRegistry: Record<
    keyof typeof vercelWorkflowCapabilities,
    boolean | string
  > = {
    pty: false,
    snapshots: false,
    isolation: "strong",
    persistentHandle: typeof runtime.getById === "function",
    streamingLogs: false,
  };
  for (const key of Object.keys(workflowRegistry) as Array<
    keyof typeof workflowRegistry
  >) {
    if (workflowRegistry[key] !== vercelWorkflowCapabilities[key]) {
      throw new VercelCapabilityMismatchError(String(key));
    }
  }

  const outerRegistry: Record<
    keyof typeof vercelSandboxCapabilities,
    boolean
  > = {
    warmLease: typeof runtime.findAllByLabels === "function",
    lifecycle:
      typeof runtime.start === "function" && typeof runtime.stop === "function",
  };
  if (vercelSandboxCapabilities.warmLease && !outerRegistry.warmLease) {
    throw new VercelCapabilityMismatchError("warmLease");
  }
  if (vercelSandboxCapabilities.lifecycle && !outerRegistry.lifecycle) {
    throw new VercelCapabilityMismatchError("lifecycle");
  }

  const observedRegistry: Record<
    keyof typeof vercelObservedCapabilities,
    boolean
  > = {
    cleanupVerified:
      typeof runtime.destroy === "function"
      && typeof runtime.listOwned === "function",
    fork: false,
    lifecycle: outerRegistry.lifecycle,
    neverIdle: false,
    ptySurvival: false,
    snapshotCapture: false,
    streamingExec: false,
    warmLease: outerRegistry.warmLease,
  };
  for (const key of Object.keys(observedRegistry) as Array<
    keyof typeof observedRegistry
  >) {
    if (vercelObservedCapabilities[key] && !observedRegistry[key]) {
      throw new VercelCapabilityMismatchError(String(key));
    }
  }
}

// --- helpers ----------------------------------------------------------------

function validateNamePrefix(value: string): string {
  const prefix = required(value, "Vercel name prefix");
  // Lowercase alphanumeric with internal hyphens: the intersection of what
  // Vercel resource names accept and what survives a DNS label, since exposed
  // ports become subdomains derived from the sandbox.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(prefix)) {
    throw new Error(
      "Vercel name prefix must be lowercase alphanumeric, optionally hyphenated",
    );
  }
  if (prefix.length > MAX_NAME_LENGTH - 10) {
    throw new Error(
      `Vercel name prefix must leave room for a suffix within ${MAX_NAME_LENGTH} characters`,
    );
  }
  return prefix;
}

function validateSource(source?: VercelSandboxSource): VercelSandboxSource {
  if (!source) {
    return { type: "default" };
  }
  if (source.type === "default") {
    return { type: "default" };
  }
  if (source.type === "image") {
    return { type: "image", image: required(source.image, "Vercel image") };
  }
  if (source.type === "runtime") {
    return {
      type: "runtime",
      runtime: required(source.runtime, "Vercel runtime"),
    };
  }
  throw new Error("Vercel sandbox source is invalid");
}

function validateVcpus(value?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Vercel vcpus must be a positive integer");
  }
  return value;
}

function validatePorts(ports?: readonly number[]): number[] | undefined {
  if (!ports) {
    return undefined;
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid Vercel port "${port}"`);
    }
  }
  return [...ports];
}

function validateEnv(
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  for (const name of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid Vercel environment variable name "${name}"`);
    }
  }
  return env;
}

function validateTags(
  tags: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const keys = Object.keys(tags);
  if (keys.length > MAX_TAGS) {
    throw new VercelTagLimitError(keys.length);
  }
  for (const key of keys) {
    if (!key.trim()) {
      throw new Error("Vercel tag keys must be non-empty");
    }
    if (typeof tags[key] !== "string") {
      throw new Error(`Vercel tag "${key}" must have a string value`);
    }
  }
  return tags;
}

function required(value: string, description: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${description} is required`);
  }
  return normalized;
}

function optionalPositive(
  value: number | undefined,
  description: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${description} must be a positive number`);
  }
  return Math.ceil(value);
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : fallback;
}

function hasEntries(value?: object): boolean {
  return !!value && Object.keys(value).length > 0;
}

function isVercelSandboxListItem(
  value: unknown,
): value is VercelSandboxListItem {
  return Boolean(
    value
      && typeof value === "object"
      && typeof (value as { name?: unknown }).name === "string"
      && (value as { name: string }).name.trim()
      && typeof (value as { status?: unknown }).status === "string"
      && (value as { status: string }).status.trim()
      && typeof (value as { createdAt?: unknown }).createdAt === "number",
  );
}

function matchesAllTags(
  actual: Record<string, string> | undefined,
  wanted: Readonly<Record<string, string>>,
): boolean {
  const entries = Object.entries(wanted);
  if (entries.length === 0) {
    return true;
  }
  if (!actual) {
    return false;
  }
  return entries.every(([key, value]) => actual[key] === value);
}

/**
 * Map a provider status onto the port's uppercase state vocabulary.
 *
 * `snapshotting` maps to STOPPING because that is what it is from a caller's
 * perspective — the VM is on its way down and cannot take work.
 */
function normalizeState(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
      return "STARTED";
    case "pending":
      return "STARTING";
    case "stopping":
    case "snapshotting":
      return "STOPPING";
    case "stopped":
      return "STOPPED";
    case "failed":
    case "aborted":
      return "FAILED";
    default:
      return status.toUpperCase();
  }
}

function normalizeRequestedState(state: string): string {
  const normalized = state.toUpperCase();
  if (normalized === "RUNNING") return "STARTED";
  if (normalized === "PAUSED" || normalized === "SUSPENDED") return "STOPPED";
  return normalized;
}

function matchesState(status: string, states: readonly string[] | null): boolean {
  if (states === null) {
    return true;
  }
  const actual = normalizeState(status);
  return states.some((state) => normalizeRequestedState(state) === actual);
}

function isRunning(status: string): boolean {
  return status.toLowerCase() === "running";
}

function isStopped(status: string): boolean {
  return status.toLowerCase() === "stopped";
}

function isStopping(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "stopping" || normalized === "snapshotting";
}

function isTerminated(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "failed" || normalized === "aborted";
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function toMillis(value: Date | undefined): number | undefined {
  return value instanceof Date ? value.getTime() : undefined;
}

function toIso(value: Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return stdout.endsWith("\n") || stderr.startsWith("\n")
      ? `${stdout}${stderr}`
      : `${stdout}\n${stderr}`;
  }
  return stdout || stderr || "";
}

function parentDirectory(destination: string): string | null {
  const normalized = destination.trim().replace(/\/+$/gu, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
