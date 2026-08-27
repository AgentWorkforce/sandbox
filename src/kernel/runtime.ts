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
import type { KernelRuntimeOptions } from "./config.js";
import {
  createOfficialKernelClient,
  type KernelBrowserView,
  type KernelClientFactory,
  type KernelClientLike,
} from "./internal/sdk.js";

const OWNER_TAG = "agent-relay-owner";
const ATTRIBUTION_TAG = "_sandbox.attributionTag";
const EPHEMERAL_UNTIL_TAG = "_sandbox.ephemeralUntil";
const MAX_TAGS = 50;
const DEFAULT_DESTROY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export const kernelWorkflowCapabilities: RuntimeCapabilities = Object.freeze({
  pty: false,
  snapshots: false,
  isolation: "unknown",
  persistentHandle: true,
  streamingLogs: false,
});

export class KernelForeignBrowserError extends Error {
  constructor(readonly browserId: string) {
    super(`Kernel browser "${browserId}" is not owned by this runtime`);
    this.name = "KernelForeignBrowserError";
  }
}

export class KernelNotFoundError extends Error {
  constructor(readonly browserId: string) {
    super(`Kernel browser "${browserId}" was not found`);
    this.name = "KernelNotFoundError";
  }
}

export class KernelUnknownExitCodeError extends Error {
  constructor(readonly browserId: string) {
    super(`Kernel command in browser "${browserId}" completed without an exit code`);
    this.name = "KernelUnknownExitCodeError";
  }
}

export class KernelCreateTimeoutUnsupportedError extends Error {
  constructor() {
    super("Kernel launch cannot enforce createTimeoutSeconds without abandoning a live browser");
    this.name = "KernelCreateTimeoutUnsupportedError";
  }
}

export class KernelTagLimitError extends Error {
  constructor(readonly count: number) {
    super(`Kernel browser tags exceed the provider limit of ${MAX_TAGS} (received ${count})`);
    this.name = "KernelTagLimitError";
  }
}

export class KernelDestroyVerificationError extends Error {
  constructor(readonly browserId: string, readonly timeoutMs: number) {
    super(`Kernel browser "${browserId}" deletion was not verified within ${timeoutMs}ms`);
    this.name = "KernelDestroyVerificationError";
  }
}

export interface KernelRuntimeDependencies {
  clientFactory?: KernelClientFactory;
  sleep?: (ms: number) => Promise<void>;
}

export class KernelRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "kernel";
  readonly capabilities = kernelWorkflowCapabilities;
  readonly declaredCapabilities = Object.freeze({
    asyncExec: false,
    detachedLaunch: false,
    warmLease: false,
    lifecycle: false,
  });
  readonly declaredCapabilityModes = Object.freeze({
    outputStreams: "buffered" as const,
    filesystem: "ephemeral" as const,
    lifetime: "idle-timeout" as const,
    interactive: "not-exposed" as const,
    snapshots: "not-exposed" as const,
  });

  private readonly options: KernelRuntimeOptions;
  private readonly clientFactory: KernelClientFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly destroyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private clientPromise?: Promise<KernelClientLike>;

  constructor(
    options: KernelRuntimeOptions,
    dependencies: KernelRuntimeDependencies = {},
  ) {
    this.options = validateOptions(options);
    this.clientFactory = dependencies.clientFactory ?? createOfficialKernelClient;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.destroyTimeoutMs = positiveDuration(options.destroyTimeoutMs, DEFAULT_DESTROY_TIMEOUT_MS);
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  }

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    if (options.createTimeoutSeconds !== undefined) {
      throw new KernelCreateTimeoutUnsupportedError();
    }
    assertValidEnvironment(options.env);
    const tags = {
      ...(options.labels ?? {}),
      ...(options.attributionTag !== undefined
        ? { [ATTRIBUTION_TAG]: options.attributionTag }
        : {}),
      ...(options.ephemeralUntil !== undefined
        ? { [EPHEMERAL_UNTIL_TAG]: normalizedDeadline(options.ephemeralUntil) }
        : {}),
      [OWNER_TAG]: this.options.ownerTag,
    };
    assertTagLimit(tags);
    const created = await (await this.client()).create({
      name: ownedName(this.options.namePrefix, options.name ?? options.label),
      tags,
      timeoutSeconds: this.options.timeoutSeconds,
    });
    const handle = this.handle(created, options.workdir);
    if (options.env && Object.keys(options.env).length > 0) {
      try {
        await this.persistLaunchEnvironment(handle, options.env);
      } catch (error) {
        try {
          await this.destroy(handle);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Kernel browser "${handle.id}" launch environment failed and cleanup also failed`,
          );
        }
        throw error;
      }
    }
    return handle;
  }

  async getById(
    id: string,
    options: { owned?: boolean; homeDir?: string; workdir?: string; states?: readonly string[] | null } = {},
  ): Promise<RuntimeHandle | null> {
    const found = await (await this.client()).get(required(id, "Kernel browser ID"));
    if (!found) return null;
    if (options.owned !== false && !this.isOwned(found)) return null;
    if (options.states && !options.states.includes(found.state)) return null;
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
    const pageSize = positiveIntegerOrUndefined(options.pageSize);
    if (options.states && !options.states.includes("active")) return [];
    const tags = { ...labels, [OWNER_TAG]: this.options.ownerTag };
    assertTagLimit(tags);
    const excluded = new Set(options.excludeIds ?? []);
    const matches: RuntimeHandle[] = [];
    for (const browser of await (await this.client()).list(tags, pageSize)) {
      if (!this.isOwned(browser) || excluded.has(browser.id)) continue;
      matches.push(this.handle(browser));
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
      pageSize: options.pageSize,
      limit: cap,
    })).length;
  }

  async exec(handle: RuntimeHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.runScript(handle, { command, ...options });
    if (result.exitCode === null) throw new KernelUnknownExitCodeError(handle.id);
    return { output: result.output, exitCode: result.exitCode };
  }

  async runScript(
    handle: RuntimeHandle,
    options: { command: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string },
  ): Promise<RunScriptResult> {
    await this.requireOwned(handle.id);
    assertValidEnvironment(options.env);
    const result = await (await this.client()).execute(handle.id, {
      command: "sh",
      args: ["-lc", commandWithEnvironment(
        required(options.command, "command"),
        `${this.options.defaultHomeDir}/.agent-relay-env`,
        options.env,
      )],
      ...((options.cwd ?? handle.workdir) ? { cwd: options.cwd ?? handle.workdir } : {}),
      ...(options.timeoutMs ? { timeoutSeconds: millisecondsToSeconds(options.timeoutMs) } : {}),
    });
    if (typeof result.exitCode !== "number") throw new KernelUnknownExitCodeError(handle.id);
    return {
      output: combinedOutput(result.stdout, result.stderr),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
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
      if (!await client.get(handle.id)) return;
      if (Date.now() >= deadline) {
        throw new KernelDestroyVerificationError(handle.id, this.destroyTimeoutMs);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async persistLaunchEnvironment(
    handle: RuntimeHandle,
    env: Record<string, string>,
  ): Promise<void> {
    const lines = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
    const client = await this.client();
    const result = await client.execute(handle.id, {
      command: "sh",
      args: ["-lc", `umask 077 && mkdir -p ${shellQuote(this.options.defaultHomeDir)}`],
    });
    if (result.exitCode !== 0) {
      throw new Error(`Kernel browser launch environment persistence failed with exit code ${String(result.exitCode)}`);
    }
    await client.upload(
      handle.id,
      `${this.options.defaultHomeDir}/.agent-relay-env`,
      Buffer.from(`${lines.join("\n")}\n`, "utf8"),
    );
  }

  private async requireOwned(id: string): Promise<KernelBrowserView> {
    const found = await (await this.client()).get(required(id, "Kernel browser ID"));
    if (!found) throw new KernelNotFoundError(id);
    if (!this.isOwned(found)) throw new KernelForeignBrowserError(id);
    return found;
  }

  private isOwned(browser: KernelBrowserView): boolean {
    return browser.tags[OWNER_TAG] === this.options.ownerTag
      && browser.name?.startsWith(`${this.options.namePrefix}-`) === true;
  }

  private handle(browser: KernelBrowserView, workdir?: string): RuntimeHandle {
    return {
      id: browser.id,
      state: browser.state,
      createdAt: browser.createdAt,
      homeDir: this.options.defaultHomeDir,
      ...(workdir ? { workdir } : {}),
    };
  }

  private async client(): Promise<KernelClientLike> {
    this.clientPromise ??= Promise.resolve(this.clientFactory(this.options));
    return await this.clientPromise;
  }
}

function validateOptions(options: KernelRuntimeOptions): KernelRuntimeOptions {
  const namePrefix = required(options.namePrefix, "Kernel name prefix").toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,19}$/u.test(namePrefix)) {
    throw new Error("Kernel namePrefix must be a lowercase provider-safe label up to 20 characters");
  }
  if (!Number.isInteger(options.timeoutSeconds)
    || options.timeoutSeconds < 10
    || options.timeoutSeconds > 259_200) {
    throw new Error("Kernel timeoutSeconds must be an integer from 10 through 259200");
  }
  return {
    ...options,
    apiKey: required(options.apiKey, "Kernel API key"),
    defaultHomeDir: required(options.defaultHomeDir, "Kernel default home directory"),
    ownerTag: required(options.ownerTag, "Kernel owner tag"),
    namePrefix,
  };
}

function ownedName(prefix: string, requested?: string): string {
  const slug = (requested ?? "sandbox")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24) || "sandbox";
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

function assertTagLimit(tags: Record<string, string>): void {
  const count = Object.keys(tags).length;
  if (count > MAX_TAGS) throw new KernelTagLimitError(count);
}

function combinedOutput(stdout: string, stderr: string): string {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

function millisecondsToSeconds(value: number): number {
  return Math.max(1, Math.ceil(positiveDuration(value, value) / 1_000));
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function commandWithEnvironment(
  command: string,
  environmentFile: string,
  env: Record<string, string> | undefined,
): string {
  const launchEnvironment = `if [ -f ${shellQuote(environmentFile)} ]; then . ${shellQuote(environmentFile)}; fi`;
  const commandEnvironment = Object.entries(env ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return [launchEnvironment, ...commandEnvironment, command].join("\n");
}
