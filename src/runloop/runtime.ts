import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
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
import type { RunloopRuntimeOptions } from "./config.js";
import {
  createOfficialRunloopClient,
  type RunloopClientFactory,
  type RunloopClientLike,
  type RunloopDevboxView,
  type RunloopExecutionView,
} from "./internal/sdk.js";

const OWNER_METADATA_KEY = "agent-relay-owner";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export const runloopWorkflowCapabilities: RuntimeCapabilities = Object.freeze({
  pty: false,
  snapshots: false,
  isolation: "unknown",
  persistentHandle: true,
  streamingLogs: false,
});

export class RunloopUnknownExitCodeError extends Error {
  constructor(readonly commandId: string) {
    super(`Runloop execution "${commandId}" completed without an exit status`);
    this.name = "RunloopUnknownExitCodeError";
  }
}

export class RunloopCommandTimeoutError extends Error {
  constructor(readonly commandId: string, readonly timeoutMs: number) {
    super(`Runloop execution "${commandId}" exceeded ${timeoutMs}ms and was killed`);
    this.name = "RunloopCommandTimeoutError";
  }
}

export class RunloopForeignDevboxError extends Error {
  constructor(readonly devboxId: string) {
    super(`Runloop Devbox "${devboxId}" is not owned by this runtime`);
    this.name = "RunloopForeignDevboxError";
  }
}

export class RunloopNotFoundError extends Error {
  constructor(readonly devboxId: string) {
    super(`Runloop Devbox "${devboxId}" was not found`);
    this.name = "RunloopNotFoundError";
  }
}

export class RunloopCreateTimeoutUnsupportedError extends Error {
  constructor() {
    super("Runloop launch cannot enforce createTimeoutSeconds without abandoning a live Devbox");
    this.name = "RunloopCreateTimeoutUnsupportedError";
  }
}

export interface RunloopRuntimeDependencies {
  clientFactory?: RunloopClientFactory;
  sleep?: (ms: number) => Promise<void>;
}

export class RunloopRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "runloop";
  readonly capabilities = runloopWorkflowCapabilities;
  readonly declaredCapabilities = Object.freeze({ warmLease: true, lifecycle: true });
  readonly declaredCapabilityModes = Object.freeze({
    outputStreams: "buffered" as const,
    filesystem: "persistent" as const,
    lifetime: "unknown" as const,
    interactive: "not-exposed" as const,
    snapshots: "not-exposed" as const,
  });

  private readonly options: RunloopRuntimeOptions;
  private readonly pollIntervalMs: number;
  private readonly clientFactory: RunloopClientFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private clientPromise?: Promise<RunloopClientLike>;

  constructor(
    options: RunloopRuntimeOptions,
    dependencies: RunloopRuntimeDependencies = {},
  ) {
    this.options = validateOptions(options);
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.clientFactory = dependencies.clientFactory ?? createOfficialRunloopClient;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    if (options.createTimeoutSeconds !== undefined) {
      throw new RunloopCreateTimeoutUnsupportedError();
    }
    const client = await this.client();
    const created = await client.create({
      ...(options.name || options.label ? { name: (options.name || options.label)!.trim() } : {}),
      ...(options.env && Object.keys(options.env).length > 0
        ? { environment_variables: options.env }
        : {}),
      metadata: {
        ...(options.labels ?? {}),
        ...(options.attributionTag !== undefined
          ? { "_sandbox.attributionTag": options.attributionTag }
          : {}),
        ...(options.ephemeralUntil !== undefined
          ? { "_sandbox.ephemeralUntil": normalizedDeadline(options.ephemeralUntil) }
          : {}),
        [OWNER_METADATA_KEY]: this.options.ownerTag,
      },
      ...(this.options.blueprintId ? { blueprint_id: this.options.blueprintId } : {}),
      ...(this.options.blueprintName ? { blueprint_name: this.options.blueprintName } : {}),
      ...(this.options.snapshotId ? { snapshot_id: this.options.snapshotId } : {}),
    });
    return this.handle(created, options.workdir);
  }

  async getById(
    id: string,
    options: { owned?: boolean; homeDir?: string; workdir?: string; states?: readonly string[] | null } = {},
  ): Promise<RuntimeHandle | null> {
    const found = await (await this.client()).get(required(id, "Runloop Devbox ID"));
    if (!found) return null;
    if (options.owned !== false && !this.isOwned(found)) return null;
    if (options.states && !options.states.includes(found.status)) return null;
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
    const excludeIds = new Set(options.excludeIds ?? []);
    const listed = await (await this.client()).list();
    const matches: RuntimeHandle[] = [];
    for (const devbox of listed) {
      if (!this.isOwned(devbox) || excludeIds.has(devbox.id)) continue;
      if (states && !states.includes(devbox.status)) continue;
      if (!metadataIncludes(devbox.metadata, labels)) continue;
      matches.push(this.handle(devbox));
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
    return {
      output: result.output,
      exitCode: result.exitCode ?? -1,
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    };
  }

  async runScript(
    handle: RuntimeHandle,
    options: { command: string; sessionId?: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string },
  ): Promise<RunScriptResult> {
    const started = await this.startScript(handle, options);
    const execution = await this.waitForExecution(handle.id, started.commandId, options.timeoutMs);
    return executionResult(execution);
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
    const sessionId = sanitizeSessionId(options.sessionId ?? randomUUID());
    const command = composeCommand(options.command, options.cwd ?? handle.workdir, options.env);
    const execution = await (await this.client()).executeAsync(handle.id, command, sessionId);
    if (!execution.execution_id?.trim()) {
      throw new Error("Runloop execute response is missing execution_id");
    }
    return { sessionId, commandId: execution.execution_id };
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
    const execution = await (await this.client()).getExecution(handle.id, commandId);
    if (execution.status !== "completed") return { exitCode: null };
    if (typeof execution.exit_status !== "number") {
      throw new RunloopUnknownExitCodeError(commandId);
    }
    return { exitCode: execution.exit_status };
  }

  async getExecLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<ExecResult> {
    const result = await this.getScriptLogs(handle, sessionId, commandId);
    return {
      output: result.output,
      exitCode: result.exitCode ?? -1,
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    };
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    _sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    await this.requireOwned(handle.id);
    return executionResult(await (await this.client()).getExecution(handle.id, commandId));
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

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    await this.requireOwned(handle.id);
    return this.handle(await (await this.client()).resume(handle.id), handle.workdir);
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    await this.requireOwned(handle.id);
    await (await this.client()).suspend(handle.id);
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    await this.requireOwned(handle.id);
    await (await this.client()).shutdown(handle.id);
  }

  private async waitForExecution(
    devboxId: string,
    commandId: string,
    timeoutMs?: number,
  ): Promise<RunloopExecutionView> {
    const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : null;
    const client = await this.client();
    for (;;) {
      const execution = await client.getExecution(devboxId, commandId);
      if (execution.status === "completed") return execution;
      if (deadline !== null && Date.now() >= deadline) {
        await client.killExecution(devboxId, commandId);
        throw new RunloopCommandTimeoutError(commandId, timeoutMs!);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async requireOwned(id: string): Promise<RunloopDevboxView> {
    const found = await (await this.client()).get(required(id, "Runloop Devbox ID"));
    if (!found) throw new RunloopNotFoundError(id);
    if (!this.isOwned(found)) throw new RunloopForeignDevboxError(id);
    return found;
  }

  private isOwned(devbox: RunloopDevboxView): boolean {
    return devbox.metadata?.[OWNER_METADATA_KEY] === this.options.ownerTag;
  }

  private handle(devbox: RunloopDevboxView, workdir?: string): RuntimeHandle {
    return {
      id: devbox.id,
      state: devbox.status,
      ...(typeof devbox.create_time_ms === "number"
        ? { createdAt: new Date(devbox.create_time_ms).toISOString() }
        : {}),
      homeDir: this.options.defaultHomeDir,
      ...(workdir ? { workdir } : {}),
    };
  }

  private async client(): Promise<RunloopClientLike> {
    this.clientPromise ??= Promise.resolve(this.clientFactory(this.options));
    return await this.clientPromise;
  }
}

function validateOptions(options: RunloopRuntimeOptions): RunloopRuntimeOptions {
  const selected = [options.blueprintId, options.blueprintName, options.snapshotId]
    .filter((value) => typeof value === "string" && value.trim()).length;
  if (selected > 1) {
    throw new Error("Runloop accepts only one of blueprintId, blueprintName, or snapshotId");
  }
  return {
    ...options,
    apiKey: required(options.apiKey, "Runloop API key"),
    defaultHomeDir: required(options.defaultHomeDir, "Runloop default home directory"),
    ownerTag: required(options.ownerTag, "Runloop owner tag"),
    ...(options.baseUrl ? { baseUrl: required(options.baseUrl, "Runloop base URL") } : {}),
    requestTimeoutMs: positiveDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
  };
}

function executionResult(execution: RunloopExecutionView): RunScriptResult {
  if (execution.status !== "completed") {
    return { output: combinedOutput(execution), exitCode: null };
  }
  if (typeof execution.exit_status !== "number") {
    throw new RunloopUnknownExitCodeError(execution.execution_id);
  }
  const stdout = execution.stdout ?? "";
  const stderr = execution.stderr ?? "";
  return {
    output: combinedOutput(execution),
    stdout,
    stderr,
    exitCode: execution.exit_status,
    truncated: Boolean(execution.stdout_truncated || execution.stderr_truncated),
  };
}

function combinedOutput(execution: RunloopExecutionView): string {
  const stdout = execution.stdout ?? "";
  const stderr = execution.stderr ?? "";
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

function composeCommand(command: string, cwd?: string, env?: Record<string, string>): string {
  const parts: string[] = [];
  if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
  if (env && Object.keys(env).length > 0) {
    parts.push(`export ${Object.entries(env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error(`Invalid environment variable name: ${key}`);
      }
      return `${key}=${shellQuote(value)}`;
    }).join(" ")}`);
  }
  parts.push(required(command, "command"));
  return parts.join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sanitizeSessionId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 80);
  return normalized || randomUUID();
}

function metadataIncludes(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function normalizedDeadline(value: number | string): string {
  const millis = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("ephemeralUntil must be a valid deadline");
  return String(millis);
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
