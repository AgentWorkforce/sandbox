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
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from "../types.js";
import type { BlaxelRuntimeOptions } from "./config.js";
import {
  createOfficialBlaxelClient,
  type BlaxelClientFactory,
  type BlaxelClientLike,
  type BlaxelProcessView,
  type BlaxelSandboxView,
} from "./internal/sdk.js";

const OWNER_LABEL = "agent-relay-owner";
const ATTRIBUTION_LABEL = "_sandbox.attributionTag";
const EPHEMERAL_UNTIL_LABEL = "_sandbox.ephemeralUntil";
const DEFAULT_DESTROY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export const blaxelWorkflowCapabilities: RuntimeCapabilities = Object.freeze({
  pty: false,
  snapshots: false,
  isolation: "unknown",
  persistentHandle: true,
  streamingLogs: false,
});

export class BlaxelForeignSandboxError extends Error {
  constructor(readonly sandboxId: string) {
    super(`Blaxel Sandbox "${sandboxId}" is not owned by this runtime`);
    this.name = "BlaxelForeignSandboxError";
  }
}

export class BlaxelNotFoundError extends Error {
  constructor(readonly sandboxId: string) {
    super(`Blaxel Sandbox "${sandboxId}" was not found`);
    this.name = "BlaxelNotFoundError";
  }
}

export class BlaxelUnknownExitCodeError extends Error {
  constructor(readonly processId: string) {
    super(`Blaxel process "${processId}" completed without an exit code`);
    this.name = "BlaxelUnknownExitCodeError";
  }
}

export class BlaxelCreateTimeoutUnsupportedError extends Error {
  constructor() {
    super("Blaxel launch cannot enforce createTimeoutSeconds without abandoning a live Sandbox");
    this.name = "BlaxelCreateTimeoutUnsupportedError";
  }
}

export class BlaxelDestroyVerificationError extends Error {
  constructor(readonly sandboxId: string, readonly timeoutMs: number) {
    super(`Blaxel Sandbox "${sandboxId}" deletion was not verified within ${timeoutMs}ms`);
    this.name = "BlaxelDestroyVerificationError";
  }
}

export interface BlaxelRuntimeDependencies {
  clientFactory?: BlaxelClientFactory;
  sleep?: (ms: number) => Promise<void>;
}

export class BlaxelRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "blaxel";
  readonly capabilities = blaxelWorkflowCapabilities;
  readonly declaredCapabilities = Object.freeze({ warmLease: false, lifecycle: false });
  readonly declaredCapabilityModes = Object.freeze({
    outputStreams: "buffered" as const,
    filesystem: "persistent" as const,
    lifetime: "deadline" as const,
    interactive: "not-exposed" as const,
    snapshots: "not-exposed" as const,
  });

  private readonly options: BlaxelRuntimeOptions;
  private readonly clientFactory: BlaxelClientFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly destroyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private clientPromise?: Promise<BlaxelClientLike>;

  constructor(
    options: BlaxelRuntimeOptions,
    dependencies: BlaxelRuntimeDependencies = {},
  ) {
    this.options = validateOptions(options);
    this.clientFactory = dependencies.clientFactory ?? createOfficialBlaxelClient;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.destroyTimeoutMs = positiveDuration(options.destroyTimeoutMs, DEFAULT_DESTROY_TIMEOUT_MS);
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    if (options.createTimeoutSeconds !== undefined) {
      throw new BlaxelCreateTimeoutUnsupportedError();
    }
    assertValidEnvironment(options.env);
    const created = await (await this.client()).create({
      name: ownedName(this.options.namePrefix, options.name ?? options.label),
      ...(this.options.image ? { image: this.options.image } : {}),
      ...(this.options.memoryMb ? { memoryMb: this.options.memoryMb } : {}),
      ...(options.env ? { env: options.env } : {}),
      labels: {
        ...(options.labels ?? {}),
        ...(options.attributionTag !== undefined
          ? { [ATTRIBUTION_LABEL]: options.attributionTag }
          : {}),
        ...(options.ephemeralUntil !== undefined
          ? { [EPHEMERAL_UNTIL_LABEL]: normalizedDeadline(options.ephemeralUntil) }
          : {}),
        [OWNER_LABEL]: this.options.ownerTag,
      },
      maxAge: this.options.maxAge,
      ...(options.ephemeralUntil !== undefined
        ? { expiresAt: new Date(Number(normalizedDeadline(options.ephemeralUntil))).toISOString() }
        : {}),
      ...(this.options.terminatedRetention
        ? { terminatedRetention: this.options.terminatedRetention }
        : {}),
    });
    return this.handle(created, options.workdir);
  }

  async getById(
    id: string,
    options: { owned?: boolean; homeDir?: string; workdir?: string; states?: readonly string[] | null } = {},
  ): Promise<RuntimeHandle | null> {
    const found = await (await this.client()).get(required(id, "Blaxel Sandbox ID"));
    if (!found) return null;
    if (options.owned !== false && !this.isOwned(found)) return null;
    if (options.states && (!found.state || !options.states.includes(found.state))) return null;
    return {
      ...this.handle(found, options.workdir),
      homeDir: options.homeDir ?? this.options.defaultHomeDir,
    };
  }

  async findByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    return (await this.findAllByLabels(labels, { ...options, limit: 1 }))[0] ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const limit = positiveIntegerOrUndefined(options.limit);
    const states = options.states ?? null;
    const excluded = new Set(options.excludeIds ?? []);
    const matches: RuntimeHandle[] = [];
    for (const sandbox of await (await this.client()).list()) {
      if (!this.isOwned(sandbox) || excluded.has(sandbox.id)) continue;
      if (states && (!sandbox.state || !states.includes(sandbox.state))) continue;
      if (!metadataIncludes(sandbox.labels, labels)) continue;
      matches.push(this.handle(sandbox));
      if (limit !== undefined && matches.length >= limit) break;
    }
    return matches;
  }

  async countByLabels(
    labels: Record<string, string>,
    options: SandboxCountOptions = {},
  ): Promise<number> {
    const cap = positiveIntegerOrUndefined(options.maxCount ?? options.limit);
    return (await this.findAllByLabels(labels, {
      states: options.states,
      limit: cap,
    })).length;
  }

  async exec(handle: RuntimeHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.runScript(handle, { command, ...options });
    if (result.exitCode === null) throw new BlaxelUnknownExitCodeError(result.cmdId ?? "unknown");
    return { output: result.output, exitCode: result.exitCode };
  }

  async runScript(
    handle: RuntimeHandle,
    options: { command: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string },
  ): Promise<RunScriptResult> {
    await this.requireOwned(handle.id);
    assertValidEnvironment(options.env);
    const process = await (await this.client()).execute(handle.id, {
      command: required(options.command, "command"),
      ...((options.cwd ?? handle.workdir) ? { cwd: options.cwd ?? handle.workdir } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.timeoutMs ? { timeoutSeconds: millisecondsToSeconds(options.timeoutMs) } : {}),
      waitForCompletion: true,
    });
    if (typeof process.exitCode !== "number") {
      throw new BlaxelUnknownExitCodeError(process.id);
    }
    return {
      output: process.output,
      ...(process.stdout !== undefined ? { stdout: process.stdout } : {}),
      ...(process.stderr !== undefined ? { stderr: process.stderr } : {}),
      exitCode: process.exitCode,
      cmdId: process.id,
    };
  }

  async startExec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions & { sessionId?: string } = {},
  ): Promise<AsyncRunStartResult> {
    return await this.startScript(handle, { command, ...options });
  }

  async startScript(
    handle: RuntimeHandle,
    options: { command: string; sessionId?: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string },
  ): Promise<AsyncRunStartResult> {
    await this.requireOwned(handle.id);
    assertValidEnvironment(options.env);
    const sessionId = safeProcessName(options.sessionId ?? randomUUID());
    const process = await (await this.client()).execute(handle.id, {
      command: required(options.command, "command"),
      name: sessionId,
      ...((options.cwd ?? handle.workdir) ? { cwd: options.cwd ?? handle.workdir } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.timeoutMs ? { timeoutSeconds: millisecondsToSeconds(options.timeoutMs) } : {}),
      waitForCompletion: false,
    });
    return { sessionId, commandId: required(process.id, "Blaxel process ID") };
  }

  async getExecStatus(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<AsyncRunStatus> {
    return await this.getScriptStatus(handle, sessionId, commandId);
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    _sessionId: string,
    commandId: string,
  ): Promise<AsyncRunStatus> {
    await this.requireOwned(handle.id);
    const process = await (await this.client()).getProcess(handle.id, commandId);
    if (!isTerminalProcess(process.status)) return { exitCode: null };
    if (typeof process.exitCode !== "number") throw new BlaxelUnknownExitCodeError(commandId);
    return { exitCode: process.exitCode };
  }

  async getExecLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<ExecResult> {
    const result = await this.getScriptLogs(handle, sessionId, commandId);
    return { output: result.output, exitCode: result.exitCode ?? -1 };
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    _sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    await this.requireOwned(handle.id);
    const client = await this.client();
    const [process, output] = await Promise.all([
      client.getProcess(handle.id, commandId),
      client.getProcessLogs(handle.id, commandId),
    ]);
    if (isTerminalProcess(process.status) && typeof process.exitCode !== "number") {
      throw new BlaxelUnknownExitCodeError(commandId);
    }
    return {
      output,
      exitCode: isTerminalProcess(process.status) ? process.exitCode! : null,
      cmdId: commandId,
    };
  }

  async uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void> {
    await this.requireOwned(handle.id);
    const content = typeof source === "string" ? await readFile(source) : source;
    await (await this.client()).upload(handle.id, required(destination, "destination"), content);
  }

  async uploadBundle(
    handle: RuntimeHandle,
    options: { files: Array<{ source: string | Buffer; destination: string }> },
  ): Promise<void> {
    for (const file of options.files) {
      await this.uploadFile(handle, file.source, file.destination);
    }
  }

  async downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void> {
    await this.requireOwned(handle.id);
    const content = await (await this.client()).download(handle.id, required(source, "source"));
    if (destination) {
      await writeFile(destination, content);
      return;
    }
    return content;
  }

  async getHomeDir(_handle: RuntimeHandle): Promise<string> {
    return this.options.defaultHomeDir;
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    await this.requireOwned(handle.id);
    const client = await this.client();
    await client.delete(handle.id);
    const deadline = Date.now() + this.destroyTimeoutMs;
    for (;;) {
      const current = await client.get(handle.id);
      if (!current || current.state === "TERMINATED") return;
      if (Date.now() >= deadline) {
        throw new BlaxelDestroyVerificationError(handle.id, this.destroyTimeoutMs);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async requireOwned(id: string): Promise<BlaxelSandboxView> {
    const found = await (await this.client()).get(required(id, "Blaxel Sandbox ID"));
    if (!found) throw new BlaxelNotFoundError(id);
    if (!this.isOwned(found)) throw new BlaxelForeignSandboxError(id);
    return found;
  }

  private isOwned(sandbox: BlaxelSandboxView): boolean {
    return sandbox.labels?.[OWNER_LABEL] === this.options.ownerTag
      && sandbox.id.startsWith(`${this.options.namePrefix}-`);
  }

  private handle(sandbox: BlaxelSandboxView, workdir?: string): RuntimeHandle {
    return {
      id: sandbox.id,
      state: sandbox.state,
      ...(sandbox.createdAt ? { createdAt: sandbox.createdAt } : {}),
      homeDir: this.options.defaultHomeDir,
      ...(workdir ? { workdir } : {}),
    };
  }

  private async client(): Promise<BlaxelClientLike> {
    this.clientPromise ??= Promise.resolve(this.clientFactory(this.options));
    return await this.clientPromise;
  }
}

function validateOptions(options: BlaxelRuntimeOptions): BlaxelRuntimeOptions {
  const namePrefix = required(options.namePrefix, "Blaxel name prefix").toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,19}$/u.test(namePrefix)) {
    throw new Error("Blaxel namePrefix must be a lowercase provider-safe label up to 20 characters");
  }
  if (options.memoryMb !== undefined && (!Number.isFinite(options.memoryMb) || options.memoryMb <= 0)) {
    throw new Error("Blaxel memoryMb must be positive");
  }
  return {
    ...options,
    apiKey: required(options.apiKey, "Blaxel API key"),
    workspace: required(options.workspace, "Blaxel workspace"),
    defaultHomeDir: required(options.defaultHomeDir, "Blaxel default home directory"),
    ownerTag: required(options.ownerTag, "Blaxel owner tag"),
    namePrefix,
    maxAge: requiredDuration(options.maxAge, "Blaxel maxAge"),
    ...(options.terminatedRetention
      ? { terminatedRetention: requiredDuration(options.terminatedRetention, "Blaxel terminatedRetention") }
      : {}),
  };
}

function ownedName(prefix: string, requested?: string): string {
  const slug = (requested ?? "sandbox")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 15) || "sandbox";
  const salt = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 10);
  return `${prefix}-${slug}-${salt}`;
}

function safeProcessName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 49)
    || `run-${randomUUID().slice(0, 12)}`;
}

function millisecondsToSeconds(value: number): number {
  return Math.max(1, Math.ceil(positiveDuration(value, value) / 1_000));
}

function assertValidEnvironment(env: Record<string, string> | undefined): void {
  for (const key of Object.keys(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
  }
}

function isTerminalProcess(status: string): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "stopped";
}

function metadataIncludes(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function normalizedDeadline(value: number | string): string {
  const millis = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("ephemeralUntil must be a valid deadline");
  return String(millis);
}

function requiredDuration(value: string, name: string): string {
  const normalized = required(value, name);
  if (!/^\d+(?:s|m|h|d)$/u.test(normalized)) {
    throw new Error(`${name} must use a duration like 30m, 2h, or 7d`);
  }
  return normalized;
}

function required(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("duration must be positive");
  return Math.ceil(value);
}

function positiveIntegerOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error("limit must be a positive integer");
  return value;
}
