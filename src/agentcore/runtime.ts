import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
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
  RuntimeHandle,
  WorkflowRuntime,
} from "../types.js";
import {
  agentCoreObservedCapabilities,
  agentCoreSandboxCapabilities,
  agentCoreWorkflowCapabilities,
} from "./capabilities.js";
import type {
  AgentCoreInterpreterSource,
  AgentCoreNetworkConfig,
  AgentCoreRuntimeOptions,
} from "./config.js";
import {
  createOfficialAgentCoreApi,
  isAgentCoreNotFoundError,
  type AgentCoreApi,
  type AgentCoreApiFactory,
  type AgentCoreNetworkConfigParams,
} from "./internal/sdk.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CREATE_INTERPRETER_TIMEOUT_MS = 60_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 15_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_FILE_TIMEOUT_MS = 120_000;
const DEFAULT_DESTROY_TIMEOUT_MS = 30_000;

/** AgentCore session default per `StartCodeInterpreterSession` docs. */
const DEFAULT_SESSION_TIMEOUT_SECONDS = 900;
/** AgentCore session hard ceiling. */
const MAX_SESSION_TIMEOUT_SECONDS = 28_800;

const SYSTEM_INTERPRETER_ID = "aws.codeinterpreter.v1";

export class AgentCoreOperationTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`AgentCore ${operation} did not complete within ${timeoutMs}ms`);
    this.name = "AgentCoreOperationTimeoutError";
  }
}

export class AgentCoreDestroyVerificationError extends Error {
  constructor(readonly sessionId: string, readonly timeoutMs: number) {
    super(
      `AgentCore session "${sessionId}" stop was accepted but termination was not `
        + `verified within ${timeoutMs}ms`,
    );
    this.name = "AgentCoreDestroyVerificationError";
  }
}

export class AgentCoreUnregisteredHandleError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `AgentCore session "${sessionId}" is not registered on this runtime instance; `
        + "call getById() to attach it first",
    );
    this.name = "AgentCoreUnregisteredHandleError";
  }
}

export class AgentCoreNetworkConfigError extends Error {
  constructor(message: string) {
    super(`AgentCore network configuration: ${message}`);
    this.name = "AgentCoreNetworkConfigError";
  }
}

export class AgentCoreInterpreterNotReadyError extends Error {
  constructor(
    readonly codeInterpreterId: string,
    readonly lastStatus: string,
    readonly timeoutMs: number,
  ) {
    super(
      `AgentCore code interpreter "${codeInterpreterId}" did not reach READY within `
        + `${timeoutMs}ms (last status: "${lastStatus}")`,
    );
    this.name = "AgentCoreInterpreterNotReadyError";
  }
}

export class AgentCoreCommandFailedError extends Error {
  constructor(readonly stderr: string) {
    super(`AgentCore command reported an error: ${stderr || "(no stderr)"}`);
    this.name = "AgentCoreCommandFailedError";
  }
}

/** One budget for one logical operation, shared across every round trip it makes. */
class Deadline {
  private readonly expiresAt: number;

  constructor(readonly totalMs: number, readonly operation: string) {
    this.expiresAt = Date.now() + totalMs;
  }

  remaining(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  require(): number {
    const left = this.remaining();
    if (left <= 0) {
      throw new AgentCoreOperationTimeoutError(this.operation, this.totalMs);
    }
    return left;
  }

  signal(): AbortSignal {
    return AbortSignal.timeout(this.require());
  }
}

export interface AgentCoreRunScriptOptions extends ExecOptions {
  command: string;
}

/** Test-only injection seam. Not exported from the package barrel. */
export interface AgentCoreRuntimeDependencies {
  apiFactory?: AgentCoreApiFactory;
}

type RegisteredSession = {
  owned: boolean;
  labels: Readonly<Record<string, string>>;
  codeInterpreterIdentifier: string;
  state?: string;
};

/**
 * AWS Bedrock AgentCore Code Interpreter provider adapter.
 *
 * Identity note: `RuntimeHandle.id` carries the AgentCore **session id**, not
 * the code interpreter id. A session is the ephemeral, billable unit
 * (bounded lifetime, terminal stop) that maps onto this package's notion of
 * a "sandbox"; the code interpreter resource underneath it is closer to a
 * Vercel `image` or a Modal `App` — a template every session in this runtime
 * shares, created once and reused, not torn down per handle.
 *
 * Ownership is tracked only in this process's `registrations` map, not by a
 * name prefix: AgentCore session ids are opaque tokens with no addressable
 * namespace to scope a prefix against (see `capabilities.ts` on `warmLease`).
 */
export class AgentCoreSandboxRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "agentcore";
  readonly capabilities = agentCoreWorkflowCapabilities;
  readonly declaredCapabilities = agentCoreSandboxCapabilities;
  readonly observedCapabilities = agentCoreObservedCapabilities;

  private readonly region: string;
  private readonly credentials: AgentCoreRuntimeOptions["credentials"];
  private readonly interpreter: AgentCoreInterpreterSource;
  private readonly defaultHomeDir: string;
  private readonly sessionTimeoutSeconds: number;
  private readonly env: Readonly<Record<string, string>>;
  private readonly requestTimeoutMs: number;
  private readonly createInterpreterTimeoutMs: number;
  private readonly launchTimeoutMs: number;
  private readonly lookupTimeoutMs: number;
  private readonly execTimeoutMs: number;
  private readonly fileTimeoutMs: number;
  private readonly destroyTimeoutMs: number;
  private readonly injectedApiFactory?: AgentCoreApiFactory;
  private readonly registrations = new Map<string, RegisteredSession>();

  private apiPromise?: Promise<AgentCoreApi>;
  /** Resolved once, lazily, and cached for the life of this instance. */
  private resolvedInterpreterId?: string;
  private resolvingInterpreter?: Promise<string>;

  constructor(
    options: AgentCoreRuntimeOptions,
    dependencies: AgentCoreRuntimeDependencies = {},
  ) {
    this.region = required(options.region, "AgentCore region");
    this.credentials = options.credentials;
    this.interpreter = validateInterpreterSource(options.interpreter);
    this.defaultHomeDir = required(
      options.defaultHomeDir,
      "AgentCore default home directory",
    );
    this.sessionTimeoutSeconds = validateSessionTimeoutSeconds(
      options.sessionTimeoutSeconds,
    );
    this.env = { ...(options.env ?? {}) };
    this.requestTimeoutMs = positiveDuration(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.createInterpreterTimeoutMs = positiveDuration(
      options.createInterpreterTimeoutMs,
      DEFAULT_CREATE_INTERPRETER_TIMEOUT_MS,
    );
    this.launchTimeoutMs = positiveDuration(
      options.launchTimeoutMs,
      DEFAULT_LAUNCH_TIMEOUT_MS,
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
    this.destroyTimeoutMs = positiveDuration(
      options.destroyTimeoutMs,
      DEFAULT_DESTROY_TIMEOUT_MS,
    );
    this.injectedApiFactory = dependencies.apiFactory;
  }

  // --- launch -----------------------------------------------------------

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    const deadline = new Deadline(
      options.createTimeoutSeconds && options.createTimeoutSeconds > 0
        ? Math.ceil(options.createTimeoutSeconds * 1_000)
        : this.launchTimeoutMs,
      "launch",
    );
    const codeInterpreterId = await this.ensureInterpreter(deadline);
    const api = await this.api();
    const started = await api.data.startSession({
      codeInterpreterIdentifier: codeInterpreterId,
      ...(options.name?.trim() ? { name: options.name.trim() } : {}),
      sessionTimeoutSeconds: this.sessionTimeoutSeconds,
      clientToken: randomUUID(),
      abortSignal: deadline.signal(),
    });
    this.registrations.set(started.sessionId, {
      owned: true,
      labels: { ...(options.labels ?? {}) },
      codeInterpreterIdentifier: codeInterpreterId,
      state: "READY",
    });
    return {
      id: started.sessionId,
      state: "READY",
      homeDir: this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
      ...(started.createdAt ? { createdAt: started.createdAt.toISOString() } : {}),
    };
  }

  // Session start resolves only once the session is `READY` for use; there
  // is no mid-boot handle AgentCore hands back, so detached launch (like the
  // Vercel adapter) is not offered rather than faked.
  declare readonly launchDetached?: undefined;

  // --- lookup -------------------------------------------------------------

  async findByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    const matches = await this.findAllByLabels(labels, { ...options, limit: 1 });
    return matches[0] ?? null;
  }

  /**
   * In-process only. See `capabilities.ts`: AgentCore sessions carry no
   * server-side tag/label field, so there is no way to discover a labeled
   * session started by another process. This still returns real matches
   * among sessions this runtime instance itself registered.
   */
  async findAllByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const wanted = { ...labels };
    const excluded = new Set(options.excludeIds ?? []);
    const handles: RuntimeHandle[] = [];
    for (const [sessionId, entry] of this.registrations) {
      if (!entry.owned || excluded.has(sessionId)) {
        continue;
      }
      if (!matchesAllLabels(entry.labels, wanted)) {
        continue;
      }
      handles.push({ id: sessionId, state: entry.state, homeDir: this.defaultHomeDir });
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
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.maxCount !== undefined ? { limit: options.maxCount } : {}),
    });
    return matches.length;
  }

  /**
   * Re-resolve a session by id via `GetCodeInterpreterSession`. Works across
   * a process restart as long as the caller's runtime config resolves to the
   * same code interpreter (fixed by `AgentCoreInterpreterSource`) and the
   * session has not reached its `sessionTimeoutSeconds` deadline.
   */
  async getById(
    id: string,
    options: { states?: readonly string[] | null; owned?: boolean } = {},
  ): Promise<RuntimeHandle | null> {
    const deadline = new Deadline(this.lookupTimeoutMs, "get session");
    const codeInterpreterId = await this.ensureInterpreter(deadline);
    const api = await this.api();
    let session;
    try {
      session = await api.data.getSession({
        codeInterpreterIdentifier: codeInterpreterId,
        sessionId: id,
        abortSignal: deadline.signal(),
      });
    } catch (error) {
      if (isAgentCoreNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    const states = options.states === undefined ? null : options.states;
    if (states && !states.includes(session.status)) {
      return null;
    }
    const existing = this.registrations.get(id);
    this.registrations.set(id, {
      owned: options.owned ?? existing?.owned ?? false,
      labels: existing?.labels ?? {},
      codeInterpreterIdentifier: codeInterpreterId,
      state: session.status,
    });
    return { id, state: session.status, homeDir: this.defaultHomeDir };
  }

  // --- exec -----------------------------------------------------------------

  async runScript(
    handle: RuntimeHandle,
    options: AgentCoreRunScriptOptions,
  ): Promise<RunScriptResult> {
    const entry = this.requireRegistered(handle);
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0
      ? Math.ceil(options.timeoutMs)
      : this.execTimeoutMs;
    const deadline = new Deadline(timeoutMs, "invoke executeCommand");
    const api = await this.api();
    const result = await api.data.invoke({
      codeInterpreterIdentifier: entry.codeInterpreterIdentifier,
      sessionId: handle.id,
      name: "executeCommand",
      arguments: { command: this.shellCommand(options) },
      abortSignal: deadline.signal(),
    });
    const stdout = result.structuredContent?.stdout
      ?? textContent(result.content);
    const stderr = result.structuredContent?.stderr ?? "";
    const exitCode = result.structuredContent?.exitCode
      ?? (result.isError ? 1 : 0);
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
    return { output: result.output, exitCode: result.exitCode ?? 1 };
  }

  // AgentCore's `InvokeCodeInterpreter` is a single synchronous call per
  // action — there is no submit-then-poll pair to build `startScript`/
  // `getScriptStatus`/`getScriptLogs` on, so async exec is omitted rather
  // than faked with a buffered result masquerading as a pending one.

  // --- files ------------------------------------------------------------

  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    await this.uploadBundle(handle, { files: [{ source, destination }] });
  }

  async uploadBundle(
    handle: RuntimeHandle,
    options: { files: Array<{ source: string | Buffer; destination: string }> },
  ): Promise<void> {
    const entry = this.requireRegistered(handle);
    const deadline = new Deadline(this.fileTimeoutMs, "upload bundle");
    const api = await this.api();
    const textFiles: Array<{ path: string; text: string }> = [];
    // `writeFiles` only documents a `text` field for content, not a binary
    // one; buffers are shipped as a base64 sidecar file and decoded in-
    // sandbox with Python (a guaranteed-present runtime), rather than
    // assuming an unconfirmed binary content type on the vendor API.
    const decodeCommands: string[] = [];
    for (const file of options.files) {
      const isBuffer = typeof file.source !== "string";
      const content = isBuffer
        ? (file.source as Buffer)
        : await readFile(file.source as string);
      const binary = isBuffer || content.subarray(0, 8_192).includes(0);
      if (binary) {
        const b64Path = `${file.destination}.__b64__`;
        textFiles.push({ path: b64Path, text: content.toString("base64") });
        decodeCommands.push(
          `python3 -c "import base64; open(${shellSingleQuote(file.destination)}, 'wb').write(base64.b64decode(open(${shellSingleQuote(b64Path)}).read()))" && rm -f ${shellSingleQuote(b64Path)}`,
        );
      } else {
        textFiles.push({ path: file.destination, text: content.toString("utf8") });
      }
    }
    if (textFiles.length === 0) {
      return;
    }
    await api.data.invoke({
      codeInterpreterIdentifier: entry.codeInterpreterIdentifier,
      sessionId: handle.id,
      name: "writeFiles",
      arguments: { content: textFiles },
      abortSignal: deadline.signal(),
    });
    if (decodeCommands.length > 0) {
      const verified = await this.runScript(handle, {
        command: decodeCommands.join(" && "),
        timeoutMs: deadline.require(),
      });
      if (verified.exitCode !== 0) {
        throw new Error("Failed to decode uploaded AgentCore bundle files");
      }
    }
  }

  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    this.requireRegistered(handle);
    // Downloaded through `executeCommand` + base64, not the `readFiles`
    // action: the AWS docs do not confirm whether `readFiles` returns binary
    // content safely, and shelling through base64 is correct for both text
    // and binary files regardless of that answer.
    const result = await this.runScript(handle, {
      command: `base64 ${shellSingleQuote(source)}`,
      timeoutMs: this.fileTimeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `AgentCore session "${handle.id}" has no file at "${source}"`,
      );
    }
    const buffer = Buffer.from(result.output.trim(), "base64");
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

  // --- lifecycle ----------------------------------------------------------

  // No `start`/`stop`: `StopCodeInterpreterSession` is a terminal transition
  // with no resume path (`GetCodeInterpreterSession.status` is only
  // `READY | TERMINATED`), the same shape the Modal adapter's `lifecycle:
  // false` documents for `Sandbox.terminate()`. Shipping a `stop` that
  // cannot be undone under a name implying it can would be worse than
  // omitting it.

  /**
   * Stop a session and verify it reached `TERMINATED`.
   *
   * The registration is retained when verification fails, so a caller can
   * retry cleanup — dropping it would make a leaked session unreachable
   * through this runtime and therefore invisible to any subsequent audit.
   */
  async destroy(handle: RuntimeHandle): Promise<void> {
    const entry = this.registrations.get(handle.id);
    if (!entry) {
      return;
    }
    if (!entry.owned) {
      this.registrations.delete(handle.id);
      return;
    }
    const deadline = new Deadline(this.destroyTimeoutMs, "stop session");
    const api = await this.api();
    try {
      await api.data.stopSession({
        codeInterpreterIdentifier: entry.codeInterpreterIdentifier,
        sessionId: handle.id,
        abortSignal: deadline.signal(),
      });
    } catch (error) {
      if (!isAgentCoreNotFoundError(error)) {
        throw error;
      }
      // Already gone. Fall through to verification, which will agree.
    }
    const verified = await this.waitUntilTerminated(
      entry.codeInterpreterIdentifier,
      handle.id,
      deadline,
    );
    if (!verified) {
      throw new AgentCoreDestroyVerificationError(handle.id, deadline.totalMs);
    }
    this.registrations.delete(handle.id);
  }

  /**
   * Delete the owned code interpreter resource itself.
   *
   * Not part of `SandboxRuntime`/`WorkflowRuntime`: the code interpreter is
   * a shared template across every session this runtime starts (see the
   * class doc), analogous to a Vercel `image` or a Modal `App`, and neither
   * of those is destroyed by a per-handle `destroy()` either. Callers that
   * own the whole runtime's lifecycle (tests, a process shutdown hook) call
   * this explicitly once they are done with every session.
   */
  async deleteOwnedCodeInterpreter(): Promise<void> {
    if (this.interpreter.type !== "owned" || !this.resolvedInterpreterId) {
      return;
    }
    const deadline = new Deadline(this.destroyTimeoutMs, "delete code interpreter");
    const api = await this.api();
    await api.control.deleteCodeInterpreter({
      codeInterpreterId: this.resolvedInterpreterId,
      clientToken: randomUUID(),
      abortSignal: deadline.signal(),
    });
    this.resolvedInterpreterId = undefined;
  }

  // --- internals ------------------------------------------------------------

  private async api(): Promise<AgentCoreApi> {
    if (this.injectedApiFactory) {
      return this.injectedApiFactory();
    }
    this.apiPromise ??= createOfficialAgentCoreApi(this.credentials, this.region);
    return this.apiPromise;
  }

  /**
   * Resolve the code interpreter this runtime's sessions run against,
   * creating it on first use and caching the id for the life of the
   * instance. Idempotent under concurrent callers via `resolvingInterpreter`.
   */
  private async ensureInterpreter(callerDeadline: Deadline): Promise<string> {
    if (this.interpreter.type === "system") {
      return SYSTEM_INTERPRETER_ID;
    }
    if (this.resolvedInterpreterId) {
      return this.resolvedInterpreterId;
    }
    if (!this.resolvingInterpreter) {
      this.resolvingInterpreter = this.createOrAdoptInterpreter().finally(() => {
        this.resolvingInterpreter = undefined;
      });
    }
    // The caller's own deadline still governs how long *it* is willing to
    // wait, independent of how long interpreter resolution takes.
    callerDeadline.require();
    return this.resolvingInterpreter;
  }

  private async createOrAdoptInterpreter(): Promise<string> {
    if (this.interpreter.type !== "owned") {
      throw new Error("createOrAdoptInterpreter called without an owned interpreter source");
    }
    const source = this.interpreter;
    const deadline = new Deadline(
      this.createInterpreterTimeoutMs,
      "create code interpreter",
    );
    const api = await this.api();
    const network = toNetworkConfigParams(source.network);
    const created = await api.control.createCodeInterpreter({
      name: source.name,
      ...(source.description ? { description: source.description } : {}),
      ...(source.executionRoleArn ? { executionRoleArn: source.executionRoleArn } : {}),
      networkConfiguration: network,
      ...(source.tags ? { tags: { ...source.tags } } : {}),
      clientToken: randomUUID(),
      abortSignal: deadline.signal(),
    });
    const ready = await this.waitUntilInterpreterReady(
      created.codeInterpreterId,
      created.status,
      deadline,
    );
    this.resolvedInterpreterId = ready;
    return ready;
  }

  private async waitUntilInterpreterReady(
    codeInterpreterId: string,
    initialStatus: string,
    deadline: Deadline,
  ): Promise<string> {
    let status = initialStatus;
    const api = await this.api();
    while (status !== "READY") {
      if (status === "CREATE_FAILED") {
        throw new AgentCoreInterpreterNotReadyError(
          codeInterpreterId,
          status,
          deadline.totalMs,
        );
      }
      deadline.require();
      await sleep(Math.min(1_000, deadline.remaining()));
      const current = await api.control.getCodeInterpreter({
        codeInterpreterId,
        abortSignal: deadline.signal(),
      });
      status = current.status;
    }
    return codeInterpreterId;
  }

  private async waitUntilTerminated(
    codeInterpreterId: string,
    sessionId: string,
    deadline: Deadline,
  ): Promise<boolean> {
    const api = await this.api();
    while (deadline.remaining() > 0) {
      try {
        const current = await api.data.getSession({
          codeInterpreterIdentifier: codeInterpreterId,
          sessionId,
          abortSignal: deadline.signal(),
        });
        if (current.status === "TERMINATED") {
          return true;
        }
      } catch (error) {
        if (isAgentCoreNotFoundError(error)) {
          return true;
        }
        throw error;
      }
      if (deadline.remaining() <= 0) {
        return false;
      }
      await sleep(Math.min(750, deadline.remaining()));
    }
    return false;
  }

  private requireRegistered(handle: RuntimeHandle): RegisteredSession {
    const entry = this.registrations.get(handle.id);
    if (!entry) {
      throw new AgentCoreUnregisteredHandleError(handle.id);
    }
    return entry;
  }

  /**
   * AgentCore's `executeCommand` action takes a bare `command` string with
   * no `cwd`/`env` fields of its own, so both are folded into the command
   * text: `cd` for the working directory, `export` for each variable, each
   * value single-quoted so nothing a caller passes is ever interpreted as
   * shell syntax.
   */
  private shellCommand(options: AgentCoreRunScriptOptions): string {
    const env = { ...this.env, ...(options.env ?? {}) };
    const prefix: string[] = [];
    if (options.cwd) {
      prefix.push(`cd ${shellSingleQuote(options.cwd)}`);
    }
    for (const [key, value] of Object.entries(env)) {
      prefix.push(`export ${key}=${shellSingleQuote(value)}`);
    }
    return prefix.length > 0
      ? `${prefix.join(" && ")} && ${options.command}`
      : options.command;
  }
}

// --- validation helpers -----------------------------------------------------

function required(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive duration, got ${value}`);
  }
  return value;
}

function validateSessionTimeoutSeconds(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SESSION_TIMEOUT_SECONDS;
  }
  if (!Number.isFinite(value) || value < 1 || value > MAX_SESSION_TIMEOUT_SECONDS) {
    throw new Error(
      `AgentCore sessionTimeoutSeconds must be between 1 and ${MAX_SESSION_TIMEOUT_SECONDS}, `
        + `got ${value}`,
    );
  }
  return Math.floor(value);
}

function validateInterpreterSource(
  source: AgentCoreInterpreterSource,
): AgentCoreInterpreterSource {
  if (source.type === "system") {
    return source;
  }
  if (source.type !== "owned") {
    throw new Error(`Unknown AgentCore interpreter source type: ${(source as { type: string }).type}`);
  }
  required(source.name, "AgentCore owned interpreter name");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(source.name)) {
    throw new Error(
      `AgentCore code interpreter name "${source.name}" must match [a-zA-Z][a-zA-Z0-9_]{0,47}`,
    );
  }
  toNetworkConfigParams(source.network);
  return source;
}

/**
 * Translate the SDK-free `AgentCoreNetworkConfig` into the vendor API's
 * `networkConfiguration` shape, enforcing the VPC-default / explicit-opt-in
 * rule documented on `AgentCoreNetworkConfig` itself.
 */
function toNetworkConfigParams(
  network: AgentCoreNetworkConfig,
): AgentCoreNetworkConfigParams {
  const mode = network.mode ?? "VPC";
  if (mode === "SANDBOX") {
    // eslint-disable-next-line no-console
    console.warn(
      "[agentcore] network mode SANDBOX was explicitly requested. Public research "
        + "disclosed in March 2026 (BeyondTrust Phantom Labs, corroborated by Unit 42 "
        + "and the Cloud Security Alliance) showed SANDBOX mode still permits outbound "
        + "DNS A/AAAA queries, which is sufficient to build a covert command-and-"
        + "control and data-exfiltration channel out of the sandbox. AWS's mitigation "
        + "is VPC mode plus a Route 53 Resolver DNS Firewall, not a SANDBOX-mode fix. "
        + "Prefer network: { vpc: {...} } unless this session has no secrets to leak.",
    );
    return { networkMode: "SANDBOX" };
  }
  if (mode === "PUBLIC") {
    return { networkMode: "PUBLIC" };
  }
  if (!("vpc" in network) || !network.vpc) {
    throw new AgentCoreNetworkConfigError(
      "mode is VPC (the default) but no `vpc` config was supplied; provide "
        + "{ vpc: { subnetIds, securityGroupIds } } or explicitly opt into "
        + '{ mode: "SANDBOX" } / { mode: "PUBLIC" }',
    );
  }
  const { subnetIds, securityGroupIds, requireServiceS3Endpoint } = network.vpc;
  if (subnetIds.length === 0) {
    throw new AgentCoreNetworkConfigError("vpc.subnetIds must contain at least one subnet");
  }
  if (securityGroupIds.length === 0) {
    throw new AgentCoreNetworkConfigError(
      "vpc.securityGroupIds must contain at least one security group",
    );
  }
  return {
    networkMode: "VPC",
    vpcConfig: {
      subnets: [...subnetIds],
      securityGroups: [...securityGroupIds],
      ...(requireServiceS3Endpoint !== undefined ? { requireServiceS3Endpoint } : {}),
    },
  };
}

function matchesAllLabels(
  actual: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>>,
): boolean {
  for (const [key, value] of Object.entries(wanted)) {
    if (actual[key] !== value) {
      return false;
    }
  }
  return true;
}

function textContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return `${stdout}\n${stderr}`;
  }
  return stdout || stderr;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
