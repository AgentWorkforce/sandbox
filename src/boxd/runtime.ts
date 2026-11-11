import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import type {
  AsyncRunStartResult,
  AsyncRunStatus,
  RunScriptResult,
  SandboxCapabilityModes,
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
  boxdCapabilityModes,
  boxdObservedCapabilities,
  boxdSandboxCapabilities,
  boxdWorkflowCapabilities,
} from "./capabilities.js";
import type { BoxdMachineSize, BoxdRuntimeOptions } from "./config.js";
import {
  createOfficialBoxdClient,
  isBoxdConflictError,
  isBoxdCreateOutcomeUnknown,
  isBoxdFileNotFoundError,
  isBoxdNotFoundError,
  type BoxdClientFactory,
  type BoxdClientLike,
  type BoxdCreateParams,
  type BoxdMachineLike,
} from "./internal/sdk.js";

const DEFAULT_OWNER_LABEL_KEY = "agent-relay-sandbox";
const DEFAULT_HOME_DIR = "/home/boxd";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CREATE_TIMEOUT_MS = 180_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MAX_NAME_LENGTH = 63;
const DEFAULT_LIFECYCLE_SETTLE_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LOOKUP_LIMIT = 10;
const COMMAND_REQUEST_GRACE_MS = 15_000;
const COMMAND_KILL_GRACE_SECONDS = 5;
/** Exit codes of coreutils `timeout`: 124 after SIGTERM, 137 after SIGKILL. */
const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);
const SIZES: readonly BoxdMachineSize[] = [
  { vcpu: 1, memory: "4G" },
  { vcpu: 2, memory: "8G" },
  { vcpu: 4, memory: "16G" },
  { vcpu: 8, memory: "32G" },
];

export class BoxdCreateTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`boxd machine create did not complete within ${timeoutMs}ms`);
    this.name = "BoxdCreateTimeoutError";
  }
}

export class BoxdOperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly operation: string) {
    super(`boxd ${operation} did not complete within ${timeoutMs}ms`);
    this.name = "BoxdOperationTimeoutError";
  }
}

export class BoxdCommandTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`boxd command did not finish within ${timeoutMs}ms and was terminated`);
    this.name = "BoxdCommandTimeoutError";
  }
}

export class BoxdLifecycleTimeoutError extends Error {
  constructor(
    readonly sandboxId: string,
    readonly expected: string,
    readonly lastState: string,
    readonly timeoutMs: number,
  ) {
    super(
      `boxd machine "${sandboxId}" did not reach ${expected} within ${timeoutMs}ms `
        + `(last state: "${lastState}")`,
    );
    this.name = "BoxdLifecycleTimeoutError";
  }
}

export class BoxdDestroyVerificationError extends Error {
  constructor(readonly sandboxId: string, readonly timeoutMs: number) {
    super(
      `boxd machine "${sandboxId}" delete was accepted but absence was not verified `
        + `within ${timeoutMs}ms`,
    );
    this.name = "BoxdDestroyVerificationError";
  }
}

export class BoxdUnknownExitCodeError extends Error {
  constructor() {
    super("boxd exec ended without an exit code; refusing to treat it as success");
    this.name = "BoxdUnknownExitCodeError";
  }
}

export class BoxdMachineStoppedError extends Error {
  constructor(readonly sandboxId: string) {
    super(
      `boxd machine "${sandboxId}" is stopped and this runtime does not own it; `
        + "start it before running commands",
    );
    this.name = "BoxdMachineStoppedError";
  }
}

export class BoxdWorkdirError extends Error {
  constructor(readonly sandboxId: string, readonly workdir: string, readonly output: string) {
    super(`Could not create workdir "${workdir}" on boxd machine "${sandboxId}": ${output.trim()}`);
    this.name = "BoxdWorkdirError";
  }
}

export class BoxdLabelCollisionError extends Error {
  constructor(readonly key: string) {
    super(`Label "${key}" is reserved for boxd runtime ownership and cannot be set by callers`);
    this.name = "BoxdLabelCollisionError";
  }
}

export class BoxdCapabilityMismatchError extends Error {
  constructor(message: string) {
    super(`boxd capability declaration mismatch: ${message}`);
    this.name = "BoxdCapabilityMismatchError";
  }
}

export interface BoxdAttachedMachineOptions {
  states?: readonly string[] | null;
  /**
   * Destroy and lifecycle authority. Defaults to true only for a machine that
   * carries this runtime's ownership label; `false` always attaches read-only.
   */
  owned?: boolean;
  homeDir?: string;
  workdir?: string;
}

export interface BoxdLookupOptions extends SandboxLookupOptions {
  homeDir?: string;
  workdir?: string;
}

export interface BoxdBundleFile {
  /** Host path when a string; exact file content when a Buffer. */
  source: string | Buffer;
  destination: string;
}

export interface BoxdUploadBundleOptions {
  files: BoxdBundleFile[];
  manifest?: unknown;
  manifestPath?: string;
}

/** Test-only injection seam. Not exported from the package barrel. */
export interface BoxdRuntimeDependencies {
  clientFactory?: BoxdClientFactory;
  sleep?: (ms: number) => Promise<void>;
}

type RegisteredMachine = {
  owned: boolean;
  env: Readonly<Record<string, string>>;
  state?: string;
};

/**
 * Runs sandboxes as boxd machines: full virtual machines with a persistent
 * disk, created through the official `@boxd-sh/sdk` client.
 */
export class BoxdRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "boxd";
  readonly capabilities = boxdWorkflowCapabilities;
  readonly declaredCapabilities = boxdSandboxCapabilities;
  readonly declaredCapabilityModes: SandboxCapabilityModes;
  readonly observedCapabilities = boxdObservedCapabilities;

  private readonly apiKey: string;
  private readonly org?: string;
  private readonly region?: string;
  private readonly baseUrl?: string;
  private readonly namePrefix: string;
  private readonly ownerLabelKey: string;
  private readonly defaultHomeDir: string;
  private readonly size?: BoxdMachineSize;
  private readonly isolated: boolean;
  private readonly fromSnapshot?: string;
  private readonly autoSuspendTimeoutSeconds: number;
  private readonly autoHibernateTimeoutSeconds?: number;
  private readonly deleteAfterSeconds?: number;
  private readonly transferTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly lookupTimeoutMs: number;
  private readonly lifecycleSettleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly injectedClientFactory?: BoxdClientFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly registrations = new Map<string, RegisteredMachine>();
  private readonly reconciliations = new Set<Promise<void>>();
  private clientPromise?: Promise<BoxdClientLike>;

  constructor(options: BoxdRuntimeOptions, dependencies: BoxdRuntimeDependencies = {}) {
    this.apiKey = required(options.apiKey, "boxd API key");
    this.namePrefix = validateNamePrefix(options.namePrefix);
    this.ownerLabelKey = validateLabelKey(
      options.ownerLabelKey ?? DEFAULT_OWNER_LABEL_KEY,
      "boxd owner label key",
    );
    this.org = optionalTrimmed(options.org);
    this.region = optionalTrimmed(options.region);
    this.baseUrl = optionalTrimmed(options.baseUrl);
    this.defaultHomeDir = optionalTrimmed(options.defaultHomeDir) ?? DEFAULT_HOME_DIR;
    this.size = validateSize(options.size);
    if (this.size && optionalTrimmed(options.fromSnapshot)) {
      throw new Error("boxd size cannot be set with fromSnapshot; the machine gets the snapshot's size");
    }
    this.isolated = options.isolated ?? true;
    this.fromSnapshot = optionalTrimmed(options.fromSnapshot);
    this.autoSuspendTimeoutSeconds = nonNegativeSeconds(
      options.autoSuspendTimeoutSeconds,
      0,
      "autoSuspendTimeoutSeconds",
    );
    this.autoHibernateTimeoutSeconds = options.autoHibernateTimeoutSeconds === undefined
      ? undefined
      : nonNegativeSeconds(options.autoHibernateTimeoutSeconds, 0, "autoHibernateTimeoutSeconds");
    this.deleteAfterSeconds = options.deleteAfterSeconds === undefined
      ? undefined
      : positiveSeconds(options.deleteAfterSeconds, "deleteAfterSeconds");
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.createTimeoutMs = positiveDuration(options.createTimeoutMs, DEFAULT_CREATE_TIMEOUT_MS);
    this.lookupTimeoutMs = positiveDuration(options.lookupTimeoutMs, DEFAULT_LOOKUP_TIMEOUT_MS);
    this.transferTimeoutMs = positiveDuration(
      options.transferTimeoutMs,
      DEFAULT_TRANSFER_TIMEOUT_MS,
    );
    this.lifecycleSettleTimeoutMs = positiveDuration(
      options.lifecycleSettleTimeoutMs,
      DEFAULT_LIFECYCLE_SETTLE_TIMEOUT_MS,
    );
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.injectedClientFactory = dependencies.clientFactory;
    this.sleep = dependencies.sleep ?? delay;
    this.declaredCapabilityModes = {
      ...boxdCapabilityModes,
      // A wall-clock delete timer is a deadline that always exists.
      ...(this.deleteAfterSeconds !== undefined ? { lifetime: "deadline" } : {}),
    };
    assertBoxdCapabilityImplementation(this);
  }

  /**
   * Create a machine and wait until it runs commands.
   *
   * Launch env is set on the machine and also sent with every command this
   * runtime runs on it, so it applies whichever way the machine was created.
   */
  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    const env = validateEnv(options.env);
    const timeoutMs = options.createTimeoutSeconds && options.createTimeoutSeconds > 0
      ? Math.ceil(options.createTimeoutSeconds * 1_000)
      : this.createTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const callerName = options.name?.trim() || options.label?.trim();
    const name = this.ownedName(callerName);
    const labels = this.ownedLabels(options.labels ?? {});
    const client = await this.client();
    const params: BoxdCreateParams = {
      name,
      ...(this.org ? { org: this.org } : {}),
      ...(this.region ? { region: this.region } : {}),
      isolated: this.isolated,
      labels,
      ...(this.fromSnapshot
        ? { fromSnapshot: this.fromSnapshot }
        : hasEntries(env) ? { env: { ...env } } : {}),
      ...(this.deleteAfterSeconds !== undefined ? { deleteAfter: this.deleteAfterSeconds } : {}),
      config: {
        ...(this.size ? { vcpu: this.size.vcpu, memory: this.size.memory } : {}),
        autoSuspendTimeout: this.autoSuspendTimeoutSeconds,
      },
    };
    // Hold the raw create promise so it outlives the client-side deadline. If
    // the deadline wins and boxd still creates the machine, the background
    // reconciliation deletes it instead of leaving it running unregistered.
    const pending = client.machines.create(params);
    let created: BoxdMachineLike;
    try {
      created = await withDeadline(
        pending,
        timeoutMs,
        () => new BoxdCreateTimeoutError(timeoutMs),
      );
    } catch (error) {
      if (error instanceof BoxdCreateTimeoutError) {
        this.trackReconciliation(this.reconcileOrphanedCreate(pending, callerName ? null : name));
      } else if (!callerName && isBoxdCreateOutcomeUnknown(error)) {
        // The request failed without saying whether boxd made the machine.
        // Only a generated name is safe to look up and delete: it is unique.
        this.trackReconciliation(this.reconcileOrphanedCreate(Promise.reject(error), name));
      }
      throw error;
    }
    if (!created || typeof created.id !== "string" || !created.id.trim()) {
      throw new Error("boxd create response is missing the machine id");
    }
    const id = created.id.trim();
    this.register(id, { owned: true, env, state: normalizeState(created.status) });
    const handle: RuntimeHandle = {
      id,
      state: normalizeState(created.status),
      homeDir: this.defaultHomeDir,
      ...(created.createdAt ? { createdAt: created.createdAt.toISOString() } : {}),
    };
    const workdir = options.workdir?.trim()
      ? requireAbsolutePath(options.workdir, handle)
      : undefined;
    if (workdir) handle.workdir = workdir;
    try {
      await this.waitUntilRunnable(id, Math.max(1, deadline - Date.now()));
      if (this.autoHibernateTimeoutSeconds !== undefined) {
        await withDeadline(
          client.machines.setAutoHibernateTimeout(id, this.autoHibernateTimeoutSeconds),
          this.requestTimeoutMs,
          () => new BoxdOperationTimeoutError(this.requestTimeoutMs, "auto-hibernate setting"),
        );
      }
      if (workdir) {
        const made = await client.machines.exec(id, {
          command: ["mkdir", "-p", workdir],
          timeout: this.requestTimeoutMs,
        });
        if (made.exitCode !== 0) {
          throw new BoxdWorkdirError(id, workdir, made.stderr || made.stdout);
        }
      }
    } catch (error) {
      // The caller never receives this handle, so nothing else could clean it
      // up. Delete it here and report the readiness failure.
      try {
        await this.destroy(handle);
      } catch {
        // The original failure is the useful one; the machine id is on it.
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        sandboxId: id,
      });
    }
    handle.state = "STARTED";
    this.register(id, { owned: true, env, state: "STARTED" });
    return handle;
  }

  async findByLabels(
    labels: Record<string, string>,
    options: BoxdLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    const [first] = await this.findAllByLabels(labels, { ...options, limit: 1 });
    return first ?? null;
  }

  /**
   * Server-side label lookup. Scoped to machines this runtime owns unless
   * `owned: false` asks for every machine with the labels, which then attach
   * without destroy or lifecycle authority.
   */
  async findAllByLabels(
    labels: Record<string, string>,
    options: BoxdLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const limit = positiveCount(options.limit ?? options.pageSize, DEFAULT_LOOKUP_LIMIT);
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const excluded = new Set(options.excludeIds ?? []);
    const machines = await this.listMachines(
      this.lookupLabels(labels, options.owned),
      options.timeoutMs ?? this.lookupTimeoutMs,
      "machine lookup",
    );
    const handles: RuntimeHandle[] = [];
    for (const machine of machines) {
      if (handles.length >= limit) break;
      if (excluded.has(machine.id) || !matchesState(machine.status, states)) continue;
      handles.push(this.attach(machine, {
        owned: options.owned !== false && this.carriesOwnerLabel(machine),
        homeDir: options.homeDir,
        workdir: options.workdir,
      }));
    }
    return handles;
  }

  async countByLabels(
    labels: Record<string, string>,
    options: SandboxCountOptions = {},
  ): Promise<number> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const maxCount = options.maxCount === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxCount));
    if (maxCount === 0) return 0;
    const machines = await this.listMachines(
      this.lookupLabels(labels, undefined),
      options.timeoutMs ?? this.lookupTimeoutMs,
      "machine count",
    );
    const count = machines.filter((machine) => matchesState(machine.status, states)).length;
    return Math.min(count, maxCount);
  }

  async getById(
    id: string,
    options: BoxdAttachedMachineOptions = {},
  ): Promise<RuntimeHandle | null> {
    const machine = await this.remoteById(id, this.lookupTimeoutMs);
    if (!machine) return null;
    const states = options.states === undefined ? null : options.states;
    if (!matchesState(machine.status, states)) return null;
    return this.attach(machine, {
      owned: options.owned === true
        || (options.owned !== false && this.carriesOwnerLabel(machine)),
      homeDir: options.homeDir,
      workdir: options.workdir,
    });
  }

  async runScript(
    handle: RuntimeHandle,
    options: ExecOptions & { command: string; sessionId?: string },
  ): Promise<RunScriptResult> {
    const entry = this.requireRegistered(handle);
    const env = validateEnv({ ...entry.env, ...(options.env ?? {}) });
    const commandTimeoutMs = options.timeoutMs && options.timeoutMs > 0
      ? Math.ceil(options.timeoutMs)
      : undefined;
    const cwd = options.cwd ?? handle.workdir;
    const argv = buildBoxdCommand(options.command, commandTimeoutMs);
    // With a command timeout, `timeout` in the machine ends the process and
    // the request deadline only covers transport. Without one, the command
    // may run as long as it needs.
    const requestTimeoutMs = commandTimeoutMs === undefined
      ? undefined
      : commandTimeoutMs + COMMAND_KILL_GRACE_SECONDS * 1_000 + COMMAND_REQUEST_GRACE_MS;
    const run = async () => {
      const client = await this.client();
      return client.machines.exec(handle.id, {
        command: argv,
        ...(hasEntries(env) ? { env } : {}),
        ...(cwd ? { cwd } : {}),
        ...(requestTimeoutMs !== undefined ? { timeout: requestTimeoutMs } : {}),
      });
    };
    const startedAt = Date.now();
    let result;
    try {
      result = await run();
    } catch (error) {
      if (!isBoxdConflictError(error)) throw error;
      // A stopped machine refuses exec. Start it when this runtime owns it,
      // then run the command once more.
      await this.startStoppedForExec(handle, entry);
      result = await run();
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const exitCode = typeof result.exitCode === "number" && result.exitCode >= 0
      ? result.exitCode
      : null;
    if (
      commandTimeoutMs !== undefined
      && exitCode !== null
      && TIMEOUT_EXIT_CODES.has(exitCode)
      && Date.now() - startedAt >= commandTimeoutMs
    ) {
      throw new BoxdCommandTimeoutError(commandTimeoutMs, stdout, stderr);
    }
    return {
      output: combineOutput(stdout, stderr),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      exitCode,
    };
  }

  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, { command, ...options });
    if (result.exitCode === null) {
      throw new BoxdUnknownExitCodeError();
    }
    return { output: result.output, exitCode: result.exitCode };
  }

  /** Write a file, creating missing parent directories. */
  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    this.requireRegistered(handle);
    const path = requireAbsolutePath(destination, handle);
    const bytes = typeof source === "string" ? await readFile(source) : source;
    const client = await this.client();
    await withDeadline(
      client.machines.fs.write(handle.id, path, new Uint8Array(bytes)),
      this.transferTimeoutMs,
      () => new BoxdOperationTimeoutError(this.transferTimeoutMs, "file upload"),
    );
  }

  async uploadBundle(handle: RuntimeHandle, options: BoxdUploadBundleOptions): Promise<void> {
    const destinations: string[] = [];
    for (const file of options.files) {
      await this.uploadFile(handle, file.source, file.destination);
      destinations.push(file.destination);
    }
    if (options.manifest !== undefined) {
      const path = options.manifestPath
        ?? `${(handle.workdir ?? handle.homeDir ?? this.defaultHomeDir).replace(/\/+$/u, "")}/manifest.json`;
      await this.uploadFile(
        handle,
        Buffer.from(JSON.stringify(options.manifest, null, 2), "utf8"),
        path,
      );
      destinations.push(path);
    }
    if (destinations.length > 0) {
      const verified = await this.runScript(handle, {
        command: destinations
          .map((path) => `test -f ${shellSingleQuote(requireAbsolutePath(path, handle))}`)
          .join(" && "),
        timeoutMs: 30_000,
      });
      if (verified.exitCode !== 0) {
        throw new Error("Failed to verify uploaded boxd bundle files");
      }
    }
  }

  /** Read a file. A missing file rejects; it never reads as empty. */
  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    this.requireRegistered(handle);
    const path = requireAbsolutePath(source, handle);
    const client = await this.client();
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await withDeadline(
        client.machines.fs.read(handle.id, path),
        this.transferTimeoutMs,
        () => new BoxdOperationTimeoutError(this.transferTimeoutMs, "file download"),
      ));
    } catch (error) {
      if (isBoxdFileNotFoundError(error)) {
        throw Object.assign(new Error(`boxd file "${path}" does not exist`), {
          code: "ENOENT",
          cause: error,
        });
      }
      throw error;
    }
    if (destination) {
      await writeFile(destination, bytes);
      return;
    }
    return bytes;
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    this.requireRegistered(handle);
    handle.homeDir = handle.homeDir ?? this.defaultHomeDir;
    return handle.homeDir;
  }

  /** Stop an owned machine. Its disk is kept; `start` boots it again. */
  async stop(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) return;
    const current = await this.requireRemote(handle.id);
    if (current.status !== "stopped") {
      const client = await this.client();
      await withDeadline(
        client.machines.stop(handle.id),
        this.requestTimeoutMs,
        () => new BoxdOperationTimeoutError(this.requestTimeoutMs, "stop request"),
      );
      await this.waitForStatus(handle.id, new Set(["stopped"]), "stopped");
    }
    entry.state = "STOPPED";
    handle.state = "STOPPED";
  }

  /** Start an owned machine and wait until it runs commands. */
  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) return handle;
    const current = await this.requireRemote(handle.id);
    if (current.status === "failed") {
      throw new Error(`boxd machine "${handle.id}" has failed and cannot be started`);
    }
    if (current.status === "stopped") {
      const client = await this.client();
      await withDeadline(
        client.machines.start(handle.id),
        this.requestTimeoutMs,
        () => new BoxdOperationTimeoutError(this.requestTimeoutMs, "start request"),
      );
    }
    await this.waitUntilRunnable(handle.id, this.lifecycleSettleTimeoutMs);
    entry.state = "STARTED";
    handle.state = "STARTED";
    return handle;
  }

  /**
   * Delete an owned machine and verify it is gone. Attached machines that
   * this runtime does not own are only forgotten.
   */
  async destroy(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry) return;
    if (!entry.owned) {
      this.registrations.delete(handle.id);
      return;
    }
    const client = await this.client();
    let deleteError: unknown;
    try {
      await withDeadline(
        client.machines.delete(handle.id),
        this.requestTimeoutMs,
        () => new BoxdOperationTimeoutError(this.requestTimeoutMs, "delete request"),
      );
    } catch (error) {
      if (!isBoxdNotFoundError(error)) deleteError = error;
    }
    const verified = await this.waitUntilDeleted(handle.id);
    if (!verified) {
      // Keep the registration so the caller can retry cleanup.
      if (deleteError !== undefined) throw deleteError;
      throw new BoxdDestroyVerificationError(handle.id, this.lifecycleSettleTimeoutMs);
    }
    this.registrations.delete(handle.id);
    handle.state = "DESTROYED";
  }

  /**
   * Wait for background cleanup of creates that outlived their deadline, then
   * close the SDK client. Safe to call more than once.
   */
  async close(): Promise<void> {
    if (this.reconciliations.size > 0) {
      await Promise.allSettled([...this.reconciliations]);
    }
    const pending = this.clientPromise;
    this.clientPromise = undefined;
    if (pending) {
      try {
        await (await pending).close?.();
      } catch {
        // Closing is best effort.
      }
    }
  }

  // This adapter runs commands to completion. Omit the optional async methods
  // rather than expose a submit that cannot be polled.
  declare readonly startScript?: (
    handle: RuntimeHandle,
    options: {
      command: string;
      sessionId?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      suppressInputEcho?: boolean;
    },
  ) => Promise<AsyncRunStartResult>;
  declare readonly getScriptStatus?: (
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ) => Promise<AsyncRunStatus>;

  /**
   * Delete a machine whose create outlived its deadline or failed without a
   * clear answer. Uses the id if the create still returns one; otherwise, for
   * a generated (unique) name only, finds the machine by name.
   */
  private async reconcileOrphanedCreate(
    pending: Promise<BoxdMachineLike>,
    generatedName: string | null,
  ): Promise<void> {
    let id: string | undefined;
    try {
      const created = await pending;
      id = typeof created?.id === "string" && created.id.trim() ? created.id.trim() : undefined;
    } catch {
      // No id came back. Fall through to the name lookup.
    }
    if (!id && generatedName) {
      try {
        const owned = await this.listMachines(this.ownedLabels({}), this.lookupTimeoutMs, "orphan lookup");
        id = owned.find((machine) => machine.name === generatedName)?.id;
      } catch {
        return;
      }
    }
    if (!id) return;
    this.register(id, { owned: true, env: {}, state: "STARTING" });
    try {
      await this.destroy({ id, homeDir: this.defaultHomeDir });
    } catch {
      // Best effort: launch() already rejected, so there is no caller to tell.
      // The machine carries the ownership label, so a label lookup finds it.
    }
  }

  private trackReconciliation(work: Promise<void>): void {
    this.reconciliations.add(work);
    void work.finally(() => this.reconciliations.delete(work));
  }

  private client(): Promise<BoxdClientLike> {
    if (!this.clientPromise) {
      const created = this.injectedClientFactory
        ? Promise.resolve(this.injectedClientFactory())
        : createOfficialBoxdClient(
            {
              apiKey: this.apiKey,
              ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
              ...(this.region ? { region: this.region } : {}),
            },
            // The SDK applies this to every unary call, create included.
            Math.max(this.requestTimeoutMs, this.createTimeoutMs),
          );
      // A failed import or construction must not be cached forever.
      this.clientPromise = created.catch((error: unknown) => {
        this.clientPromise = undefined;
        throw error;
      });
    }
    return this.clientPromise;
  }

  private attach(
    machine: BoxdMachineLike,
    options: { owned: boolean; homeDir?: string; workdir?: string },
  ): RuntimeHandle {
    const state = normalizeState(machine.status);
    this.register(machine.id, { owned: options.owned, env: {}, state });
    return {
      id: machine.id,
      state,
      homeDir: options.homeDir ?? this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
      ...(machine.createdAt ? { createdAt: machine.createdAt.toISOString() } : {}),
    };
  }

  private register(id: string, next: RegisteredMachine): void {
    const existing = this.registrations.get(id);
    this.registrations.set(id, {
      owned: existing?.owned === true || next.owned,
      env: hasEntries(next.env) ? { ...next.env } : existing?.env ?? {},
      state: next.state ?? existing?.state,
    });
  }

  private requireRegistered(handle: RuntimeHandle): RegisteredMachine {
    const entry = this.registrations.get(handle.id);
    if (!entry) {
      throw new Error(`boxd runtime handle "${handle.id}" is not attached`);
    }
    return entry;
  }

  private async startStoppedForExec(
    handle: RuntimeHandle,
    entry: RegisteredMachine,
  ): Promise<void> {
    const current = await this.requireRemote(handle.id);
    if (current.status !== "stopped") {
      // Not a stopped machine; wait for it to settle instead.
      await this.waitUntilRunnable(handle.id, this.lifecycleSettleTimeoutMs);
      return;
    }
    if (!entry.owned) {
      throw new BoxdMachineStoppedError(handle.id);
    }
    await this.start(handle);
  }

  /** Wait for `running`, then probe exec until the machine answers. */
  private async waitUntilRunnable(id: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.waitForStatus(id, new Set(["running"]), "running", timeoutMs);
    const client = await this.client();
    let lastError: unknown;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      try {
        const probe = await withDeadline(
          client.machines.exec(id, { command: ["true"], timeout: remainingMs }),
          remainingMs,
          () => new BoxdOperationTimeoutError(timeoutMs, "readiness probe"),
        );
        if (probe.exitCode === 0) return;
        lastError = new Error(`readiness probe exited with ${probe.exitCode}`);
      } catch (error) {
        lastError = error;
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw lastError instanceof Error
      ? lastError
      : new BoxdOperationTimeoutError(timeoutMs, "readiness probe");
  }

  private async listMachines(
    labels: Record<string, string>,
    timeoutMs: number,
    operation: string,
  ): Promise<BoxdMachineLike[]> {
    const client = await this.client();
    const machines = await withDeadline(
      client.machines.list({ ...(this.org ? { org: this.org } : {}), labels }),
      timeoutMs,
      () => new BoxdOperationTimeoutError(timeoutMs, operation),
    );
    if (!Array.isArray(machines)) {
      throw new Error("boxd machine list response is malformed");
    }
    const malformed = machines.findIndex((machine) => !isMachine(machine));
    if (malformed !== -1) {
      throw new Error(`boxd machine list item ${malformed} is malformed`);
    }
    // The server filters by labels; check again so a response that ignored
    // the filter can never hand out a machine that does not match.
    return machines.filter((machine) =>
      Object.entries(labels).every(([key, value]) => machine.labels?.[key] === value)
      && machine.status !== "destroyed"
    );
  }

  private async remoteById(id: string, timeoutMs: number): Promise<BoxdMachineLike | null> {
    const client = await this.client();
    try {
      const machine = await withDeadline(
        client.machines.get(id),
        timeoutMs,
        () => new BoxdOperationTimeoutError(timeoutMs, `lookup for machine "${id}"`),
      );
      if (!isMachine(machine)) {
        throw new Error(`boxd machine "${id}" response is malformed`);
      }
      return machine.status === "destroyed" ? null : machine;
    } catch (error) {
      if (isBoxdNotFoundError(error)) return null;
      throw error;
    }
  }

  private async requireRemote(id: string): Promise<BoxdMachineLike> {
    const machine = await this.remoteById(id, this.lookupTimeoutMs);
    if (!machine) {
      throw new Error(`boxd machine "${id}" is no longer available`);
    }
    return machine;
  }

  private async waitForStatus(
    id: string,
    expected: ReadonlySet<string>,
    description: string,
    timeoutMs = this.lifecycleSettleTimeoutMs,
  ): Promise<BoxdMachineLike> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "unknown";
    for (;;) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const machine = await this.remoteById(id, Math.min(this.lookupTimeoutMs, remainingMs));
      if (!machine) {
        throw new Error(`boxd machine "${id}" disappeared while waiting for ${description}`);
      }
      lastStatus = machine.status;
      if (expected.has(machine.status)) return machine;
      // Standby and hibernation keep the machine; exec wakes it.
      if (expected.has("running") && isAsleep(machine.status)) return machine;
      if (machine.status === "failed") {
        throw new Error(`boxd machine "${id}" failed while waiting for ${description}`);
      }
      if (Date.now() >= deadline) {
        throw new BoxdLifecycleTimeoutError(id, description, lastStatus, timeoutMs);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async waitUntilDeleted(id: string): Promise<boolean> {
    const deadline = Date.now() + this.lifecycleSettleTimeoutMs;
    for (;;) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const machine = await this.remoteById(id, Math.min(this.lookupTimeoutMs, remainingMs));
      if (!machine) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(this.pollIntervalMs);
    }
  }

  private ownedLabels(labels: Record<string, string>): Record<string, string> {
    if (Object.hasOwn(labels, this.ownerLabelKey)) {
      throw new BoxdLabelCollisionError(this.ownerLabelKey);
    }
    for (const key of Object.keys(labels)) validateLabelKey(key, "boxd label key");
    return { ...labels, [this.ownerLabelKey]: this.namePrefix };
  }

  private lookupLabels(
    labels: Record<string, string>,
    owned: boolean | undefined,
  ): Record<string, string> {
    // `owned: false` is an explicit opt-out for audits across runtimes.
    return owned === false ? { ...labels } : this.ownedLabels(labels);
  }

  private carriesOwnerLabel(machine: BoxdMachineLike): boolean {
    return machine.labels?.[this.ownerLabelKey] === this.namePrefix;
  }

  private ownedName(requested?: string): string {
    if (!requested) {
      return `${this.namePrefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    }
    if (
      requested.startsWith(`${this.namePrefix}-`)
      && requested.length <= MAX_NAME_LENGTH
      && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u.test(requested)
    ) {
      return requested;
    }
    // prefix + "-" + slug + "-" + 8 hex digits fits in one DNS label.
    const slugLength = MAX_NAME_LENGTH - this.namePrefix.length - 10;
    const slug = requested
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, slugLength)
      .replace(/-+$/gu, "") || "sandbox";
    const digest = createHash("sha256").update(requested).digest("hex").slice(0, 8);
    return `${this.namePrefix}-${slug}-${digest}`;
  }
}

/**
 * Construction-time check that every declared capability has the methods
 * behind it. A true claim is never allowed without an implementation.
 */
function assertBoxdCapabilityImplementation(runtime: BoxdRuntime): void {
  const workflowRegistry: Record<keyof typeof boxdWorkflowCapabilities, boolean | string> = {
    pty: false,
    snapshots: false,
    isolation: "strong",
    persistentHandle: typeof runtime.getById === "function",
    streamingLogs: false,
  };
  for (const key of Object.keys(workflowRegistry) as Array<keyof typeof workflowRegistry>) {
    if (workflowRegistry[key] !== boxdWorkflowCapabilities[key]) {
      throw new BoxdCapabilityMismatchError(String(key));
    }
  }
  const outerRegistry: Record<keyof typeof boxdSandboxCapabilities, boolean> = {
    warmLease: typeof runtime.findAllByLabels === "function"
      && typeof runtime.countByLabels === "function",
    lifecycle: typeof runtime.start === "function" && typeof runtime.stop === "function",
  };
  for (const key of Object.keys(outerRegistry) as Array<keyof typeof outerRegistry>) {
    if (boxdSandboxCapabilities[key] && !outerRegistry[key]) {
      throw new BoxdCapabilityMismatchError(String(key));
    }
  }
  const observedRegistry: Record<keyof typeof boxdObservedCapabilities, boolean> = {
    cleanupVerified: typeof runtime.destroy === "function",
    fork: false,
    lifecycle: outerRegistry.lifecycle,
    neverIdle: true,
    ptySurvival: false,
    snapshotCapture: false,
    streamingExec: false,
    warmLease: outerRegistry.warmLease,
  };
  for (const key of Object.keys(observedRegistry) as Array<keyof typeof observedRegistry>) {
    if (boxdObservedCapabilities[key] && !observedRegistry[key]) {
      throw new BoxdCapabilityMismatchError(String(key));
    }
  }
}

/**
 * The argv sent to the machine: the command runs in a login bash, and with a
 * timeout `timeout` ends it (then kills it after a short grace period).
 */
export function buildBoxdCommand(command: string, timeoutMs?: number): string[] {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("boxd runScript requires a non-empty command");
  }
  const shell = ["bash", "-lc", command];
  if (timeoutMs === undefined) return shell;
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  return ["timeout", "-k", `${COMMAND_KILL_GRACE_SECONDS}s`, `${seconds}s`, ...shell];
}

/**
 * boxd states mapped onto the vocabulary the other adapters use. A machine in
 * standby or hibernation keeps memory and disk and wakes on the next command,
 * so it counts as started.
 */
export function normalizeBoxdState(status: string): string {
  return normalizeState(status);
}

function normalizeState(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
    case "suspended":
    case "hibernated":
      return "STARTED";
    case "pending":
    case "starting":
    case "migrating":
      return "STARTING";
    case "stopped":
      return "STOPPED";
    case "failed":
      return "FAILED";
    case "destroyed":
      return "DESTROYED";
    default:
      return status.toUpperCase();
  }
}

function normalizeRequestedState(state: string): string {
  const normalized = state.toUpperCase();
  if (normalized === "RUNNING") return "STARTED";
  return normalized;
}

function matchesState(status: string, states: readonly string[] | null): boolean {
  if (states === null) return true;
  const actual = normalizeState(status);
  return states.some((state) => normalizeRequestedState(state) === actual);
}

function isAsleep(status: string): boolean {
  return status === "suspended" || status === "hibernated";
}

function isMachine(value: unknown): value is BoxdMachineLike {
  return Boolean(
    value
      && typeof value === "object"
      && typeof (value as { id?: unknown }).id === "string"
      && (value as { id: string }).id.trim()
      && typeof (value as { status?: unknown }).status === "string",
  );
}

function validateSize(size: BoxdMachineSize | undefined): BoxdMachineSize | undefined {
  if (size === undefined) return undefined;
  const match = SIZES.find((candidate) =>
    candidate.vcpu === size.vcpu && candidate.memory === size.memory
  );
  if (!match) {
    throw new Error(
      `boxd size must be one of ${SIZES.map((s) => `${s.vcpu} vCPU/${s.memory}`).join(", ")}`,
    );
  }
  return match;
}

function validateNamePrefix(value: string): string {
  const prefix = required(value, "boxd name prefix");
  if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u.test(prefix)) {
    throw new Error(
      "boxd name prefix must be 2-32 lowercase letters, digits or hyphens, "
        + "starting with a letter",
    );
  }
  return prefix;
}

/** boxd label keys: 1-63 of `a-z 0-9 . _ / -`, letter or digit at both ends, no `boxd/`. */
function validateLabelKey(value: string, description: string): string {
  const key = required(value, description);
  if (
    key.length > 63
    || !/^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$/u.test(key)
    || key.startsWith("boxd/")
  ) {
    throw new Error(`${description} "${key}" is invalid`);
  }
  return key;
}

function validateEnv(env: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid boxd environment variable name "${name}"`);
    }
    if (typeof value !== "string") {
      throw new Error(`boxd environment variable "${name}" must be a string`);
    }
    result[name] = value;
  }
  return result;
}

function requireAbsolutePath(path: string, handle: RuntimeHandle): string {
  const trimmed = path?.trim();
  if (!trimmed) throw new Error("boxd file path is required");
  if (trimmed.startsWith("/")) return trimmed;
  const base = (handle.workdir ?? handle.homeDir ?? DEFAULT_HOME_DIR).replace(/\/+$/u, "");
  return `${base}/${trimmed.replace(/^\.\//u, "")}`;
}

function required(value: string, description: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${description} is required`);
  }
  return normalized;
}

function optionalTrimmed(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : fallback;
}

function positiveCount(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeSeconds(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`boxd ${name} must be a non-negative number of seconds`);
  }
  return Math.ceil(value);
}

function positiveSeconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`boxd ${name} must be a positive number of seconds`);
  }
  return Math.ceil(value);
}

function hasEntries(value?: object): boolean {
  return !!value && Object.keys(value).length > 0;
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return stdout.endsWith("\n") || stderr.startsWith("\n")
      ? `${stdout}${stderr}`
      : `${stdout}\n${stderr}`;
  }
  return stdout || stderr || "";
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
