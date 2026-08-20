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
  freestyleObservedCapabilities,
  freestyleSandboxCapabilities,
  freestyleWorkflowCapabilities,
} from "./capabilities.js";
import type { FreestyleRuntimeOptions } from "./config.js";
import {
  createOfficialFreestyleClient,
  type FreestyleClientFactory,
  type FreestyleClientLike,
  type FreestyleVmLike,
  type FreestyleVmListItem,
} from "./internal/sdk.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CREATE_TIMEOUT_MS = 120_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;
const DEFAULT_LIFECYCLE_SETTLE_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const COMMAND_REQUEST_GRACE_MS = 5_000;

export class FreestyleCreateTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Freestyle create did not complete within ${timeoutMs}ms`);
    this.name = "FreestyleCreateTimeoutError";
  }
}

export class FreestyleLookupTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly operation: string) {
    super(`Freestyle ${operation} did not complete within ${timeoutMs}ms`);
    this.name = "FreestyleLookupTimeoutError";
  }
}

export class FreestyleLifecycleTimeoutError extends Error {
  constructor(
    readonly sandboxId: string,
    readonly expected: string,
    readonly lastState: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Freestyle VM "${sandboxId}" did not reach ${expected} within ${timeoutMs}ms `
        + `(last state: "${lastState}")`,
    );
    this.name = "FreestyleLifecycleTimeoutError";
  }
}

export class FreestyleDestroyVerificationError extends Error {
  constructor(readonly sandboxId: string, readonly timeoutMs: number) {
    super(
      `Freestyle VM "${sandboxId}" delete was accepted but absence was not verified `
        + `within ${timeoutMs}ms`,
    );
    this.name = "FreestyleDestroyVerificationError";
  }
}

export class FreestyleUnknownExitCodeError extends Error {
  constructor() {
    super("Freestyle exec response omitted statusCode; refusing to treat it as success");
    this.name = "FreestyleUnknownExitCodeError";
  }
}

export class FreestyleLaunchEnvironmentUnsupportedError extends Error {
  constructor() {
    super(
      "Freestyle vms.create has no environment field; launch env must be provisioned "
        + "provider-neutrally after create",
    );
    this.name = "FreestyleLaunchEnvironmentUnsupportedError";
  }
}

export class FreestyleCapabilityMismatchError extends Error {
  constructor(message: string) {
    super(`Freestyle capability declaration mismatch: ${message}`);
    this.name = "FreestyleCapabilityMismatchError";
  }
}

export interface FreestyleAttachedVmOptions {
  states?: readonly string[] | null;
  owned?: boolean;
  homeDir?: string;
  workdir?: string;
}

export interface FreestyleListOwnedOptions {
  includeDeleted?: boolean;
  states?: readonly string[] | null;
  timeoutMs?: number;
}

export interface FreestyleOwnedVm {
  id: string;
  name: string;
  state: string;
  deleted: boolean;
  createdAt?: string;
  sizing?: {
    vcpus?: number;
    memoryMiB?: number;
    storageMiB?: number;
  };
}

export interface FreestyleBundleFile {
  /** Host path when a string; exact file content when a Buffer. */
  source: string | Buffer;
  destination: string;
}

export interface FreestyleUploadBundleOptions {
  files: FreestyleBundleFile[];
  manifest?: unknown;
  manifestPath?: string;
}

/** Test-only injection seam. Not exported from the package barrel. */
export interface FreestyleRuntimeDependencies {
  clientFactory?: FreestyleClientFactory;
}

type RegisteredVm = {
  owned: boolean;
  labels: Readonly<Record<string, string>>;
  state?: string;
};

export class FreestyleRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "freestyle";
  readonly capabilities = freestyleWorkflowCapabilities;
  readonly declaredCapabilities = freestyleSandboxCapabilities;
  readonly observedCapabilities = freestyleObservedCapabilities;

  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly defaultHomeDir: string;
  private readonly namePrefix: string;
  private readonly snapshotId?: string;
  private readonly persistence: FreestyleRuntimeOptions["persistence"];
  private readonly idleTimeoutSeconds?: number | null;
  private readonly requestTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly lookupTimeoutMs: number;
  private readonly lifecycleSettleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly injectedClientFactory?: FreestyleClientFactory;
  private readonly registrations = new Map<string, RegisteredVm>();

  constructor(
    options: FreestyleRuntimeOptions,
    dependencies: FreestyleRuntimeDependencies = {},
  ) {
    this.apiKey = required(options.apiKey, "Freestyle API key");
    this.defaultHomeDir = required(options.defaultHomeDir, "Freestyle default home directory");
    this.namePrefix = validateNamePrefix(options.namePrefix);
    this.baseUrl = optionalTrimmed(options.baseUrl);
    this.snapshotId = optionalTrimmed(options.snapshotId);
    this.persistence = validatePersistence(options.persistence);
    this.idleTimeoutSeconds = validateIdleTimeout(options.idleTimeoutSeconds);
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.createTimeoutMs = positiveDuration(options.createTimeoutMs, DEFAULT_CREATE_TIMEOUT_MS);
    this.lookupTimeoutMs = positiveDuration(options.lookupTimeoutMs, DEFAULT_LOOKUP_TIMEOUT_MS);
    this.lifecycleSettleTimeoutMs = positiveDuration(
      options.lifecycleSettleTimeoutMs,
      DEFAULT_LIFECYCLE_SETTLE_TIMEOUT_MS,
    );
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.injectedClientFactory = dependencies.clientFactory;
    assertFreestyleCapabilityImplementation(this);
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    if (hasEntries(options.env)) {
      throw new FreestyleLaunchEnvironmentUnsupportedError();
    }
    const timeoutMs = options.createTimeoutSeconds && options.createTimeoutSeconds > 0
      ? Math.ceil(options.createTimeoutSeconds * 1_000)
      : this.createTimeoutMs;
    const name = this.ownedName(options.name?.trim() || options.label?.trim());
    const client = await this.client(timeoutMs);
    const created = await withDeadline(
      client.vms.create({
        name,
        persistence: this.persistence,
        ...(this.snapshotId ? { snapshotId: this.snapshotId } : {}),
        ...(this.idleTimeoutSeconds !== undefined
          ? { idleTimeoutSeconds: this.idleTimeoutSeconds }
          : {}),
      }),
      timeoutMs,
      () => new FreestyleCreateTimeoutError(timeoutMs),
    );
    if (!created || typeof created.vmId !== "string" || !created.vmId.trim()) {
      throw new Error("Freestyle create response is missing vmId");
    }
    const id = created.vmId.trim();
    this.register(id, {
      owned: true,
      labels: options.labels ?? {},
      state: "STARTED",
    });
    return {
      id,
      state: "STARTED",
      homeDir: this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
    };
  }

  async findByLabels(
    _labels: Record<string, string>,
    _options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    // Freestyle vms.create has no label field. Returning a name-based guess here
    // would turn ownership naming into a false warm-lease capability.
    return null;
  }

  async findAllByLabels(
    _labels: Record<string, string>,
    _options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    return [];
  }

  async countByLabels(
    _labels: Record<string, string>,
    _options: SandboxCountOptions = {},
  ): Promise<number> {
    return 0;
  }

  async listOwned(options: FreestyleListOwnedOptions = {}): Promise<FreestyleOwnedVm[]> {
    const items = await this.listRemote(options.timeoutMs ?? this.lookupTimeoutMs, "owned VM list");
    const states = options.states === undefined ? null : options.states;
    return items
      .filter((item) => typeof item.name === "string" && this.isOwnedName(item.name))
      .filter((item) => options.includeDeleted || !item.deleted)
      .filter((item) => matchesListedState(item, states, options.includeDeleted === true))
      .map((item) => ({
        id: item.id,
        name: item.name!,
        state: normalizeState(item.state),
        deleted: Boolean(item.deleted),
        ...(item.createdAt ? { createdAt: item.createdAt } : {}),
        ...(item.sizing
          ? {
              sizing: {
                ...(typeof item.sizing.vcpuCount === "number"
                  ? { vcpus: item.sizing.vcpuCount }
                  : {}),
                ...(typeof item.sizing.memSizeMib === "number"
                  ? { memoryMiB: item.sizing.memSizeMib }
                  : {}),
                ...(typeof item.sizing.rootfsSizeMb === "number"
                  ? { storageMiB: item.sizing.rootfsSizeMb }
                  : {}),
              },
            }
          : {}),
      }));
  }

  async getById(
    id: string,
    options: FreestyleAttachedVmOptions = {},
  ): Promise<RuntimeHandle | null> {
    const item = await this.remoteById(id, this.lookupTimeoutMs);
    if (!item || item.deleted) {
      return null;
    }
    const states = options.states === undefined ? null : options.states;
    if (!matchesState(item, states)) {
      return null;
    }
    this.register(id, {
      owned: options.owned ?? false,
      labels: {},
      state: normalizeState(item.state),
    });
    return {
      id,
      state: normalizeState(item.state),
      homeDir: options.homeDir ?? this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
      ...(item.createdAt ? { createdAt: item.createdAt } : {}),
      ...(item.lastNetworkActivity ? { lastActivityAt: item.lastNetworkActivity } : {}),
    };
  }

  async runScript(
    handle: RuntimeHandle,
    options: ExecOptions & { command: string; sessionId?: string },
  ): Promise<RunScriptResult> {
    this.requireRegistered(handle);
    const command = buildFreestyleCommand(options.command, options);
    const commandTimeoutMs = options.timeoutMs && options.timeoutMs > 0
      ? Math.ceil(options.timeoutMs)
      : undefined;
    const requestTimeoutMs = commandTimeoutMs
      ? Math.max(this.requestTimeoutMs, commandTimeoutMs + COMMAND_REQUEST_GRACE_MS)
      : this.requestTimeoutMs;
    const vm = await this.vm(handle.id, requestTimeoutMs);
    const result = await withDeadline(
      vm.exec({
        command,
        ...(commandTimeoutMs ? { timeoutMs: commandTimeoutMs } : {}),
      }),
      requestTimeoutMs,
      () => new FreestyleLookupTimeoutError(requestTimeoutMs, "exec request"),
    );
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    return {
      output: combineOutput(stdout, stderr),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      exitCode: typeof result.statusCode === "number" ? result.statusCode : null,
    };
  }

  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, { command, ...options });
    if (result.exitCode === null) {
      throw new FreestyleUnknownExitCodeError();
    }
    return { output: result.output, exitCode: result.exitCode };
  }

  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    this.requireRegistered(handle);
    const bytes = typeof source === "string" ? await readFile(source) : source;
    const parent = parentDirectory(destination);
    if (parent) {
      const mkdir = await this.runScript(handle, {
        command: `mkdir -p ${shellSingleQuote(parent)}`,
        timeoutMs: 30_000,
      });
      if (mkdir.exitCode !== 0) {
        throw new Error(`Failed to create Freestyle upload directory "${parent}"`);
      }
    }
    const vm = await this.vm(handle.id, this.requestTimeoutMs);
    await withDeadline(
      vm.fs.writeFile(destination, bytes),
      this.requestTimeoutMs,
      () => new FreestyleLookupTimeoutError(this.requestTimeoutMs, "file upload"),
    );
  }

  async uploadBundle(
    handle: RuntimeHandle,
    options: FreestyleUploadBundleOptions,
  ): Promise<void> {
    const destinations: string[] = [];
    for (const file of options.files) {
      await this.uploadFile(handle, file.source, file.destination);
      destinations.push(file.destination);
    }
    if (options.manifest !== undefined) {
      const path = options.manifestPath ?? "/workspace/manifest.json";
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
          .map((path) => `test -f ${shellSingleQuote(path)}`)
          .join(" && "),
        timeoutMs: 30_000,
      });
      if (verified.exitCode !== 0) {
        throw new Error("Failed to verify uploaded Freestyle bundle files");
      }
    }
  }

  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    this.requireRegistered(handle);
    const vm = await this.vm(handle.id, this.requestTimeoutMs);
    const bytes = Buffer.from(await withDeadline(
      vm.fs.readFile(source),
      this.requestTimeoutMs,
      () => new FreestyleLookupTimeoutError(this.requestTimeoutMs, "file download"),
    ));
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

  async stop(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) {
      return;
    }
    const current = await this.requireRemote(handle.id);
    if (current.state === "stopped" || current.state === "suspended") {
      entry.state = "STOPPED";
      handle.state = "STOPPED";
      return;
    }
    if (current.state === "stopping") {
      await this.waitForState(handle.id, new Set(["stopped"]), "stopped");
    } else if (current.state === "suspending") {
      await this.waitForState(handle.id, new Set(["suspended"]), "suspended");
    } else {
      const vm = await this.vm(handle.id, this.requestTimeoutMs);
      await withDeadline(
        vm.stop(),
        this.requestTimeoutMs,
        () => new FreestyleLookupTimeoutError(this.requestTimeoutMs, "stop request"),
      );
      await this.waitForState(handle.id, new Set(["stopped"]), "stopped");
    }
    entry.state = "STOPPED";
    handle.state = "STOPPED";
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const entry = this.registrations.get(handle.id);
    if (!entry || !entry.owned) {
      return handle;
    }
    let current = await this.requireRemote(handle.id);
    if (current.state === "running") {
      handle.state = "STARTED";
      entry.state = "STARTED";
      return handle;
    }
    if (current.state === "starting" || current.state === "building") {
      await this.waitForState(handle.id, new Set(["running"]), "running");
      handle.state = "STARTED";
      entry.state = "STARTED";
      return handle;
    }
    if (current.state === "suspending") {
      await this.waitForState(handle.id, new Set(["suspended"]), "suspended");
      current = await this.requireRemote(handle.id);
    } else if (current.state === "stopping") {
      await this.waitForState(handle.id, new Set(["stopped"]), "stopped");
      current = await this.requireRemote(handle.id);
    }
    if (current.state === "lost") {
      throw new Error(`Freestyle VM "${handle.id}" is lost and cannot be started`);
    }
    const vm = await this.vm(handle.id, this.requestTimeoutMs);
    await withDeadline(
      vm.start(
        this.idleTimeoutSeconds !== undefined
          ? { idleTimeoutSeconds: this.idleTimeoutSeconds }
          : {},
      ),
      this.requestTimeoutMs,
      () => new FreestyleLookupTimeoutError(this.requestTimeoutMs, "start request"),
    );
    await this.waitForState(handle.id, new Set(["running"]), "running");
    entry.state = "STARTED";
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
    const client = await this.client(this.requestTimeoutMs);
    await withDeadline(
      client.vms.delete({ vmId: handle.id }),
      this.requestTimeoutMs,
      () => new FreestyleLookupTimeoutError(this.requestTimeoutMs, "delete request"),
    );
    const verified = await this.waitUntilDeleted(handle.id);
    if (!verified) {
      // Retain the registration so a caller can retry cleanup.
      throw new FreestyleDestroyVerificationError(
        handle.id,
        this.lifecycleSettleTimeoutMs,
      );
    }
    this.registrations.delete(handle.id);
  }

  // Freestyle has no durable async process object through this adapter. Omit
  // the four optional async methods rather than exposing an unpollable submit.
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

  private async client(requestTimeoutMs: number): Promise<FreestyleClientLike> {
    if (this.injectedClientFactory) {
      return this.injectedClientFactory(requestTimeoutMs);
    }
    return createOfficialFreestyleClient(
      { apiKey: this.apiKey, ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}) },
      requestTimeoutMs,
    );
  }

  private async vm(id: string, requestTimeoutMs: number): Promise<FreestyleVmLike> {
    const client = await this.client(requestTimeoutMs);
    return client.vms.ref({ vmId: id });
  }

  private register(id: string, next: RegisteredVm): void {
    const existing = this.registrations.get(id);
    this.registrations.set(id, {
      owned: existing?.owned === true || next.owned,
      labels: hasEntries(next.labels) ? { ...next.labels } : existing?.labels ?? {},
      state: next.state ?? existing?.state,
    });
  }

  private requireRegistered(handle: RuntimeHandle): RegisteredVm {
    const entry = this.registrations.get(handle.id);
    if (!entry) {
      throw new Error(`Freestyle runtime handle "${handle.id}" is not attached`);
    }
    return entry;
  }

  private async listRemote(timeoutMs: number, operation: string): Promise<FreestyleVmListItem[]> {
    const client = await this.client(timeoutMs);
    const response = await withDeadline(
      client.vms.list(),
      timeoutMs,
      () => new FreestyleLookupTimeoutError(timeoutMs, operation),
    );
    if (!response || !Array.isArray(response.vms)) {
      throw new Error("Freestyle VM list response is malformed");
    }
    const malformedIndex = response.vms.findIndex((item) => !isFreestyleVmListItem(item));
    if (malformedIndex !== -1) {
      throw new Error(`Freestyle VM list item ${malformedIndex} is malformed`);
    }
    return response.vms;
  }

  private async remoteById(id: string, timeoutMs: number): Promise<FreestyleVmListItem | null> {
    const items = await this.listRemote(timeoutMs, `lookup for VM "${id}"`);
    return items.find((item) => item.id === id) ?? null;
  }

  private async requireRemote(id: string): Promise<FreestyleVmListItem> {
    const item = await this.remoteById(id, this.lookupTimeoutMs);
    if (!item || item.deleted) {
      throw new Error(`Freestyle VM "${id}" is no longer available`);
    }
    return item;
  }

  private async waitForState(
    id: string,
    expected: ReadonlySet<string>,
    description: string,
  ): Promise<FreestyleVmListItem> {
    const deadline = Date.now() + this.lifecycleSettleTimeoutMs;
    let lastState = "unknown";
    for (;;) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const item = await this.remoteById(id, Math.min(this.lookupTimeoutMs, remainingMs));
      if (!item || item.deleted) {
        throw new Error(`Freestyle VM "${id}" disappeared while waiting for ${description}`);
      }
      lastState = item.state;
      if (expected.has(item.state)) {
        return item;
      }
      if (item.state === "lost") {
        throw new Error(`Freestyle VM "${id}" became lost while waiting for ${description}`);
      }
      if (Date.now() >= deadline) {
        throw new FreestyleLifecycleTimeoutError(
          id,
          description,
          lastState,
          this.lifecycleSettleTimeoutMs,
        );
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async waitUntilDeleted(id: string): Promise<boolean> {
    const deadline = Date.now() + this.lifecycleSettleTimeoutMs;
    for (;;) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const item = await this.remoteById(id, Math.min(this.lookupTimeoutMs, remainingMs));
      // Freestyle may keep a soft-deleted row in vms.list; deleted:true is as
      // authoritative as absence and must not be mistaken for a leaked VM.
      if (!item || item.deleted === true) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(this.pollIntervalMs);
    }
  }

  private ownedName(requested?: string): string {
    if (!requested) {
      return `${this.namePrefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    }
    if (this.isOwnedName(requested)) {
      return requested;
    }
    const slug = requested
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "sandbox";
    const digest = createHash("sha256").update(requested).digest("hex").slice(0, 8);
    return `${this.namePrefix}-${slug}-${digest}`;
  }

  private isOwnedName(name: string): boolean {
    return name === this.namePrefix || name.startsWith(`${this.namePrefix}-`);
  }
}

/**
 * Construction-time reconciliation between SDK-free declarations and the
 * implemented surface. The registry is exhaustive over every capability key.
 * Behavioral false claims (warmLease/lifecycle) may retain probe methods; a
 * true claim is never allowed without the necessary implementation.
 */
function assertFreestyleCapabilityImplementation(runtime: FreestyleRuntime): void {
  const workflowRegistry: Record<keyof typeof freestyleWorkflowCapabilities, boolean | string> = {
    pty: false,
    snapshots: false,
    isolation: "strong",
    persistentHandle: typeof runtime.getById === "function",
    streamingLogs: false,
  };
  for (const key of Object.keys(workflowRegistry) as Array<keyof typeof workflowRegistry>) {
    if (workflowRegistry[key] !== freestyleWorkflowCapabilities[key]) {
      throw new FreestyleCapabilityMismatchError(String(key));
    }
  }
  const outerRegistry: Record<keyof typeof freestyleSandboxCapabilities, boolean> = {
    warmLease: false,
    lifecycle: typeof runtime.start === "function" && typeof runtime.stop === "function",
  };
  if (freestyleSandboxCapabilities.warmLease && !outerRegistry.warmLease) {
    throw new FreestyleCapabilityMismatchError("warmLease");
  }
  if (freestyleSandboxCapabilities.lifecycle && !outerRegistry.lifecycle) {
    throw new FreestyleCapabilityMismatchError("lifecycle");
  }
  const observedRegistry: Record<keyof typeof freestyleObservedCapabilities, boolean> = {
    cleanupVerified:
      typeof runtime.destroy === "function" && typeof runtime.listOwned === "function",
    fork: false,
    lifecycle: outerRegistry.lifecycle,
    neverIdle: false,
    ptySurvival: false,
    snapshotCapture: false,
    streamingExec: false,
    warmLease: outerRegistry.warmLease,
  };
  for (const key of Object.keys(observedRegistry) as Array<keyof typeof observedRegistry>) {
    if (freestyleObservedCapabilities[key] && !observedRegistry[key]) {
      throw new FreestyleCapabilityMismatchError(String(key));
    }
  }
}

export function buildFreestyleCommand(command: string, options: ExecOptions = {}): string {
  const statements: string[] = [];
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid Freestyle environment variable name "${name}"`);
    }
    statements.push(`export ${name}=${shellSingleQuote(value)}`);
  }
  if (options.cwd) {
    statements.push(`cd ${shellSingleQuote(options.cwd)} || exit $?`);
  }
  statements.push(command);
  return statements.join("\n");
}

function validatePersistence(
  value: FreestyleRuntimeOptions["persistence"],
): FreestyleRuntimeOptions["persistence"] {
  if (!value || typeof value !== "object") {
    throw new Error("Freestyle persistence policy is required");
  }
  if (value.type === "persistent" || value.type === "ephemeral") {
    return { type: value.type };
  }
  if (
    value.type === "sticky"
    && Number.isFinite(value.priority)
    && Number.isInteger(value.priority)
  ) {
    return { type: "sticky", priority: value.priority };
  }
  throw new Error("Freestyle persistence policy is invalid");
}

function validateIdleTimeout(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Freestyle idleTimeoutSeconds must be null or a non-negative number");
  }
  return Math.ceil(value);
}

function validateNamePrefix(value: string): string {
  const prefix = required(value, "Freestyle name prefix");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(prefix)) {
    throw new Error(
      "Freestyle name prefix must contain only letters, numbers, dot, underscore, or hyphen",
    );
  }
  return prefix;
}

function required(value: string, description: string): string {
  const normalized = value?.trim();
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

function hasEntries(value?: object): boolean {
  return !!value && Object.keys(value).length > 0;
}

function isFreestyleVmListItem(value: unknown): value is FreestyleVmListItem {
  return Boolean(
    value
      && typeof value === "object"
      && typeof (value as { id?: unknown }).id === "string"
      && (value as { id: string }).id.trim()
      && typeof (value as { state?: unknown }).state === "string"
      && (value as { state: string }).state.trim(),
  );
}

function normalizeState(state: string): string {
  switch (state.toLowerCase()) {
    case "running":
      return "STARTED";
    case "stopped":
    case "suspended":
      return "STOPPED";
    case "building":
    case "starting":
      return "STARTING";
    case "stopping":
    case "suspending":
      return "STOPPING";
    case "lost":
      return "FAILED";
    default:
      return state.toUpperCase();
  }
}

function normalizeRequestedState(state: string): string {
  const normalized = state.toUpperCase();
  if (normalized === "RUNNING") return "STARTED";
  if (normalized === "PAUSED" || normalized === "SUSPENDED") return "STOPPED";
  return normalized;
}

function matchesState(
  item: Pick<FreestyleVmListItem, "state" | "deleted">,
  states: readonly string[] | null,
): boolean {
  if (item.deleted) return false;
  if (states === null) return true;
  const actual = normalizeState(item.state);
  return states.some((state) => normalizeRequestedState(state) === actual);
}

function matchesListedState(
  item: Pick<FreestyleVmListItem, "state" | "deleted">,
  states: readonly string[] | null,
  includeDeleted: boolean,
): boolean {
  if (item.deleted && !includeDeleted) return false;
  if (states === null) return true;
  const actual = normalizeState(item.state);
  return states.some((state) => normalizeRequestedState(state) === actual);
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
