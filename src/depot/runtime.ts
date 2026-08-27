import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import type {
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
import type { DepotRuntimeOptions } from "./config.js";
import {
  createOfficialDepotClient,
  type DepotClientFactory,
  type DepotClientLike,
  type DepotSandboxView,
} from "./internal/sdk.js";

const OWNER_ENV_KEY = "AGENT_RELAY_SANDBOX_OWNER";
const ATTRIBUTION_ENV_KEY = "AGENT_RELAY_SANDBOX_ATTRIBUTION";
const EPHEMERAL_UNTIL_ENV_KEY = "AGENT_RELAY_SANDBOX_EPHEMERAL_UNTIL";
const DEFAULT_DESTROY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export const depotWorkflowCapabilities: RuntimeCapabilities = Object.freeze({
  pty: false,
  snapshots: false,
  isolation: "unknown",
  persistentHandle: true,
  streamingLogs: false,
});

export class DepotForeignSandboxError extends Error {
  constructor(readonly sandboxId: string) {
    super(`Depot Sandbox "${sandboxId}" is not owned by this runtime`);
    this.name = "DepotForeignSandboxError";
  }
}

export class DepotNotFoundError extends Error {
  constructor(readonly sandboxId: string) {
    super(`Depot Sandbox "${sandboxId}" was not found`);
    this.name = "DepotNotFoundError";
  }
}

export class DepotCreateTimeoutUnsupportedError extends Error {
  constructor() {
    super("Depot launch cannot enforce createTimeoutSeconds without abandoning a live Sandbox");
    this.name = "DepotCreateTimeoutUnsupportedError";
  }
}

export class DepotCommandTimeoutError extends Error {
  constructor(readonly sandboxId: string, readonly timeoutMs: number) {
    super(`Depot command exceeded ${timeoutMs}ms; Sandbox "${sandboxId}" was killed`);
    this.name = "DepotCommandTimeoutError";
  }
}

export class DepotDestroyVerificationError extends Error {
  constructor(readonly sandboxId: string, readonly timeoutMs: number) {
    super(`Depot Sandbox "${sandboxId}" did not reach a terminal state within ${timeoutMs}ms`);
    this.name = "DepotDestroyVerificationError";
  }
}

export interface DepotRuntimeDependencies {
  clientFactory?: DepotClientFactory;
  sleep?: (ms: number) => Promise<void>;
}

export class DepotRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "depot";
  readonly capabilities = depotWorkflowCapabilities;
  readonly declaredCapabilities = Object.freeze({ warmLease: false, lifecycle: false });
  readonly declaredCapabilityModes = Object.freeze({
    outputStreams: "buffered" as const,
    filesystem: "ephemeral" as const,
    lifetime: "deadline" as const,
    interactive: "not-exposed" as const,
    snapshots: "not-exposed" as const,
  });

  private readonly options: DepotRuntimeOptions;
  private readonly clientFactory: DepotClientFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly destroyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private clientPromise?: Promise<DepotClientLike>;

  constructor(
    options: DepotRuntimeOptions,
    dependencies: DepotRuntimeDependencies = {},
  ) {
    this.options = validateOptions(options);
    this.clientFactory = dependencies.clientFactory ?? createOfficialDepotClient;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.destroyTimeoutMs = positiveDuration(options.destroyTimeoutMs, DEFAULT_DESTROY_TIMEOUT_MS);
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    if (options.createTimeoutSeconds !== undefined) {
      throw new DepotCreateTimeoutUnsupportedError();
    }
    assertValidEnvironment(options.env);
    const created = await (await this.client()).create({
      name: ownedName(this.options.namePrefix, options.name ?? options.label),
      env: {
        ...(options.env ?? {}),
        [OWNER_ENV_KEY]: this.options.ownerTag,
        ...(options.attributionTag !== undefined
          ? { [ATTRIBUTION_ENV_KEY]: options.attributionTag }
          : {}),
        ...(options.ephemeralUntil !== undefined
          ? { [EPHEMERAL_UNTIL_ENV_KEY]: normalizedDeadline(options.ephemeralUntil) }
          : {}),
      },
      ...(this.options.imageRef ? { imageRef: this.options.imageRef } : {}),
      ...(this.options.resources ? { resources: this.options.resources } : {}),
      ...(this.options.timeoutMinutes ? { timeoutMinutes: this.options.timeoutMinutes } : {}),
    });
    return this.handle(created, options.workdir);
  }

  async getById(
    id: string,
    options: { owned?: boolean; homeDir?: string; workdir?: string; states?: readonly string[] | null } = {},
  ): Promise<RuntimeHandle | null> {
    const found = await (await this.client()).get(required(id, "Depot Sandbox ID"));
    if (!found) return null;
    if (options.owned !== false && !this.isOwned(found)) return null;
    if (options.states && (!found.status || !options.states.includes(found.status))) return null;
    return {
      ...this.handle(found, options.workdir),
      homeDir: options.homeDir ?? this.options.defaultHomeDir,
    };
  }

  async findByLabels(
    _labels: Record<string, string>,
    _options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
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

  async exec(handle: RuntimeHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.runScript(handle, { command, ...options });
    return { output: result.output, exitCode: result.exitCode ?? -1 };
  }

  async runScript(
    handle: RuntimeHandle,
    options: { command: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string },
  ): Promise<RunScriptResult> {
    await this.requireOwned(handle.id);
    assertValidEnvironment(options.env);
    const execution = (await this.client()).execute(
      handle.id,
      required(options.command, "command"),
      {
        ...((options.cwd ?? handle.workdir) ? { cwd: options.cwd ?? handle.workdir } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
    );
    if (!options.timeoutMs) {
      const result = await execution;
      return { output: result.output, exitCode: result.exitCode, cmdId: result.commandId };
    }
    const timeoutMs = positiveDuration(options.timeoutMs, options.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(async () => {
        try {
          await (await this.client()).kill(handle.id);
          reject(new DepotCommandTimeoutError(handle.id, timeoutMs));
        } catch (error) {
          reject(error);
        }
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([execution, deadline]);
      return { output: result.output, exitCode: result.exitCode, cmdId: result.commandId };
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    const found = await this.requireOwned(handle.id);
    if (!isTerminal(found.status)) {
      await (await this.client()).kill(handle.id);
    }
    const deadline = Date.now() + this.destroyTimeoutMs;
    for (;;) {
      const current = await (await this.client()).get(handle.id);
      if (!current || isTerminal(current.status)) return;
      if (Date.now() >= deadline) {
        throw new DepotDestroyVerificationError(handle.id, this.destroyTimeoutMs);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async requireOwned(id: string): Promise<DepotSandboxView> {
    const found = await (await this.client()).get(required(id, "Depot Sandbox ID"));
    if (!found) throw new DepotNotFoundError(id);
    if (!this.isOwned(found)) throw new DepotForeignSandboxError(id);
    return found;
  }

  private isOwned(sandbox: DepotSandboxView): boolean {
    return sandbox.env?.[OWNER_ENV_KEY] === this.options.ownerTag
      && typeof sandbox.name === "string"
      && sandbox.name.startsWith(`${this.options.namePrefix}-`);
  }

  private handle(sandbox: DepotSandboxView, workdir?: string): RuntimeHandle {
    return {
      id: sandbox.id,
      state: sandbox.status,
      ...(sandbox.createdAt ? { createdAt: sandbox.createdAt } : {}),
      homeDir: this.options.defaultHomeDir,
      ...(workdir ? { workdir } : {}),
    };
  }

  private async client(): Promise<DepotClientLike> {
    this.clientPromise ??= Promise.resolve(this.clientFactory(this.options));
    return await this.clientPromise;
  }
}

function validateOptions(options: DepotRuntimeOptions): DepotRuntimeOptions {
  const namePrefix = required(options.namePrefix, "Depot name prefix").toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,30}$/u.test(namePrefix)) {
    throw new Error("Depot namePrefix must be a lowercase provider-safe label up to 31 characters");
  }
  assertValidResources(options.resources);
  if (options.timeoutMinutes !== undefined && !isPositiveInteger(options.timeoutMinutes)) {
    throw new Error("Depot timeoutMinutes must be a positive integer");
  }
  return {
    ...options,
    token: required(options.token, "Depot token"),
    defaultHomeDir: required(options.defaultHomeDir, "Depot default home directory"),
    ownerTag: required(options.ownerTag, "Depot owner tag"),
    namePrefix,
  };
}

function ownedName(prefix: string, requested?: string): string {
  const slug = (requested ?? "sandbox")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 28) || "sandbox";
  const salt = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 10);
  return `${prefix}-${slug}-${salt}`;
}

function assertValidEnvironment(env: Record<string, string> | undefined): void {
  for (const key of Object.keys(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
  }
}

function assertValidResources(resources: DepotRuntimeOptions["resources"]): void {
  for (const [name, value] of Object.entries(resources ?? {})) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`Depot resource ${name} must be positive`);
    }
  }
}

function isTerminal(status: string | undefined): boolean {
  return status === "finished" || status === "cancelled" || status === "failed";
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

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
