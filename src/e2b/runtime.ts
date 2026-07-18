import { Buffer } from "node:buffer";
import type { RuntimeHandle } from "../types.js";
import type {
  AsyncRunStartResult,
  AsyncRunStatus,
  RunScriptResult,
  SandboxRuntime,
} from "../port.js";

// ---------------------------------------------------------------------------
// E2B provider for the SandboxRuntime contract.
//
// The `e2b` npm package is imported LAZILY (`await import("e2b")`), never at
// module top level, so consumers using a different provider never bundle it.
// The SDK surface is modeled structurally below (from e2b@2.19.0) so typecheck
// and unit tests do not hard-couple to the SDK type graph, and a fake factory
// can drive every path without a real E2B API key.
// ---------------------------------------------------------------------------

// Command-LIFETIME budget for a background run (NOT a request timeout).
//
// Callers commonly pass a short `options.timeoutMs` meaning "how long to wait
// for the START call to return". For E2B that value is the SDK *request* cap,
// not the command lifetime — mapping it onto the background command's
// `timeoutMs` would kill every long-running command when the start request
// deadline elapses. We instead set the command lifetime and the microVM
// timeout to this budget, and route the caller's short timeout to
// `requestTimeoutMs`.
const DEFAULT_RUN_BUDGET_MS = 30 * 60_000;
const DEFAULT_CREATE_TIMEOUT_MS = 120_000;
const SCRIPT_LOG_READ_MAX_BYTES = 200_000;

// --- structural E2B SDK surface (e2b@2.19.0) ------------------------------

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
  /** Command LIFETIME cap (ms). 0/undefined → sandbox lifetime. */
  timeoutMs?: number;
  /** HTTP request / AbortSignal cap (ms) — bounds the submit call only. */
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
    read(path: string, opts?: { format?: "text" | "bytes" }): Promise<string | Uint8Array>;
  };
  setTimeout(timeoutMs: number): Promise<void>;
  kill(): Promise<boolean>;
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

type E2BConnectionOpts = { apiKey?: string };

export interface E2BSandboxStatics {
  create(
    template: string,
    opts?: E2BConnectionOpts & {
      metadata?: Record<string, string>;
      envs?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<E2BSandbox>;
  connect(sandboxId: string, opts?: E2BConnectionOpts): Promise<E2BSandbox>;
  list(opts?: E2BConnectionOpts & { query?: { metadata?: string } }): E2BSandboxPaginator;
  setTimeout(sandboxId: string, timeoutMs: number, opts?: E2BConnectionOpts): Promise<void>;
}

// Structurally compatible with the (module-local, unexported) option types on
// SandboxRuntime in port.ts.
type E2BLookupOptions = {
  states?: readonly string[] | null;
  limit?: number;
  pageSize?: number;
  owned?: boolean;
  excludeIds?: readonly string[];
  timeoutMs?: number;
};

type E2BCountOptions = {
  states?: readonly string[] | null;
  limit?: number;
  pageSize?: number;
  maxCount?: number;
  timeoutMs?: number;
};

export type E2BSandboxRuntimeOptions = {
  apiKey: string;
  /**
   * E2B template to launch. Required: templates are account-specific, so there
   * is no default that is correct for any other consumer.
   */
  template: string;
  runBudgetMs?: number;
  createTimeoutMs?: number;
  /** Injection seam for tests / a future adapter — defaults to lazy `import("e2b")`. */
  sandbox?: E2BSandboxStatics;
};

export class E2BSandboxRuntime implements SandboxRuntime {
  readonly id = "e2b";

  // `start`/`stop` below are unconditional no-ops (pause/resume is a warm-reuse
  // follow-up), so lifecycle must be declared false rather than inferred from
  // their presence. Label search IS real server-side (`Sandbox.list` with a
  // metadata query), so warm leases are meaningful; `collectByLabels` keeps its
  // own `[]`-degrade for an SDK build that lacks `list`.
  readonly declaredCapabilities = { warmLease: true, lifecycle: false } as const;

  private readonly apiKey: string;
  private readonly template: string;
  private readonly runBudgetMs: number;
  private readonly createTimeoutMs: number;
  private readonly injectedStatics?: E2BSandboxStatics;
  private staticsPromise?: Promise<E2BSandboxStatics>;
  // Cache live Sandbox instances launched this process; cross-request access
  // (the poll ticks) resolves via Sandbox.connect(id) — the reattach that lets
  // a run outlive the request that started it.
  private readonly sandboxes = new Map<string, E2BSandbox>();

  constructor(options: E2BSandboxRuntimeOptions) {
    this.apiKey = options.apiKey;
    this.template = options.template.trim();
    this.runBudgetMs = options.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS;
    this.createTimeoutMs = options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
    this.injectedStatics = options.sandbox;
  }

  async findByLabels(
    labels: Record<string, string>,
    options: E2BLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    const handles = await this.findAllByLabels(labels, options);
    const excluded = new Set(options.excludeIds ?? []);
    return handles.find((handle) => !excluded.has(handle.id)) ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: E2BLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const limit = options.limit ?? options.pageSize;
    return this.collectByLabels(labels, states, limit);
  }

  async countByLabels(
    labels: Record<string, string>,
    options: E2BCountOptions = {},
  ): Promise<number> {
    const maxCount = options.maxCount === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxCount));
    if (maxCount === 0) {
      return 0;
    }
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const cap = Number.isFinite(maxCount) ? maxCount : undefined;
    const handles = await this.collectByLabels(labels, states, cap);
    return handles.length;
  }

  /**
   * Drain the E2B sandbox list (server-side metadata-filtered), keep the ones
   * matching `states`, and stop once `cap` handles are collected. Returns `[]`
   * when the provider build lacks server-side label search — an EXPLICIT
   * warm-lease-degrades-to-cold gate, not a silent behavior change.
   */
  private async collectByLabels(
    labels: Record<string, string>,
    states: readonly string[] | null,
    cap: number | undefined,
  ): Promise<RuntimeHandle[]> {
    const statics = await this.statics();
    if (typeof statics.list !== "function") {
      return [];
    }
    const query = serializeMetadataQuery(labels);
    const paginator = statics.list({
      apiKey: this.apiKey,
      ...(query ? { query: { metadata: query } } : {}),
    });
    const handles: RuntimeHandle[] = [];
    while (paginator.hasNext) {
      const page = await paginator.nextItems();
      for (const info of page) {
        if (!matchesState(info.state, states)) {
          continue;
        }
        handles.push(handleFromE2BInfo(info));
        if (cap !== undefined && handles.length >= cap) {
          return handles;
        }
      }
    }
    return handles;
  }

  async launch(options: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  } = {}): Promise<RuntimeHandle> {
    const statics = await this.statics();
    const metadata: Record<string, string> = {
      ...(options.labels ?? {}),
      ...(options.name ? { name: options.name } : {}),
    };
    const timeoutMs = options.createTimeoutSeconds
      ? options.createTimeoutSeconds * 1000
      : this.createTimeoutMs;
    const sandbox = await statics.create(this.template, {
      apiKey: this.apiKey,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(hasEntries(options.env) ? { envs: options.env } : {}),
      timeoutMs,
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return { id: sandbox.sandboxId, state: "STARTED" };
  }

  async launchDetached(options: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  } = {}): Promise<RuntimeHandle> {
    // E2B sandboxes persist server-side the instant create() returns and are
    // re-attachable by id via Sandbox.connect — so a "detached" launch is just
    // launch. This is what lets a short-lived request context return before
    // the run finishes and a later tick reconnect, instead of holding a
    // request open until it hits a gateway timeout.
    return this.launch(options);
  }

  async getById(
    id: string,
    options: { states?: readonly string[] | null; owned?: boolean } = {},
  ): Promise<RuntimeHandle | null> {
    const sandbox = await this.connectSandbox(id);
    if (!sandbox) {
      return null;
    }
    // Sandbox.connect only succeeds against a running microVM; a paused/killed
    // one throws NotFound (→ null above). So a resolved handle is "STARTED".
    const handle: RuntimeHandle = { id: sandbox.sandboxId, state: "STARTED" };
    const states = options.states === undefined ? null : options.states;
    return matchesState("running", states) ? handle : null;
  }

  async uploadBundle(handle: RuntimeHandle, options: {
    files: Array<{ source: string | Buffer; destination: string }>;
  }): Promise<void> {
    const sandbox = await this.requireSandbox(handle);
    for (const file of options.files) {
      const data = typeof file.source === "string" ? file.source : toArrayBuffer(file.source);
      await sandbox.files.write(file.destination, data);
    }
  }

  async runScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    // Synchronous foreground run: here options.timeoutMs IS the intended command
    // lifetime (a bounded sync exec), so mapping it to `timeoutMs` is correct.
    try {
      const result = await sandbox.commands.run(options.command, {
        ...(options.timeoutMs && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
        ...(hasEntries(options.env) ? { envs: options.env } : {}),
      });
      return {
        output: combineOutput(result.stdout, result.stderr),
        ...(result.stdout ? { stdout: result.stdout } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      };
    } catch (error) {
      const normalized = normalizeCommandError(error);
      if (normalized) {
        return normalized;
      }
      throw error;
    }
  }

  async startScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    suppressInputEcho?: boolean;
  }): Promise<AsyncRunStartResult> {
    const sandbox = await this.requireSandbox(handle);
    const sessionId = options.sessionId ?? `run-${handle.id}-${Date.now()}`;
    const dir = scriptRunDir(sessionId);
    const outPath = `${dir}/out`;
    const exitPath = `${dir}/exit`;
    // Durable-file wrapper: capture combined stdout/stderr + the final exit code
    // to files under /tmp so getScriptStatus/getScriptLogs survive disconnect
    // and reconnect across poll ticks (mirrors Daytona's per-session redirect).
    const wrapped =
      `mkdir -p ${shellSingleQuote(dir)}; ` +
      `{ ${options.command}\n} > ${shellSingleQuote(outPath)} 2>&1; ` +
      `echo $? > ${shellSingleQuote(exitPath)}`;
    // Keep the microVM alive for the whole run, independent of the submit call.
    await sandbox.setTimeout(this.runBudgetMs);
    // The critical distinction: command LIFETIME is the run budget
    // (`timeoutMs`), while the caller's short `options.timeoutMs` bounds only
    // the submit HTTP request (`requestTimeoutMs`). A naive
    // `timeoutMs: options.timeoutMs` would kill every run the moment the
    // submit deadline elapsed.
    const started = await sandbox.commands.run(wrapped, {
      background: true,
      timeoutMs: this.runBudgetMs,
      ...(options.timeoutMs && options.timeoutMs > 0 ? { requestTimeoutMs: options.timeoutMs } : {}),
      ...(hasEntries(options.env) ? { envs: options.env } : {}),
    });
    return { sessionId, commandId: String(started.pid) };
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    sessionId: string,
    _commandId: string,
  ): Promise<AsyncRunStatus> {
    const sandbox = await this.requireSandbox(handle);
    const exitPath = `${scriptRunDir(sessionId)}/exit`;
    // Durable exit file is the source of truth: empty/missing → still running.
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
    const outPath = `${scriptRunDir(sessionId)}/out`;
    const output = await this.readFileBestEffort(sandbox, outPath, SCRIPT_LOG_READ_MAX_BYTES);
    // exitCode:null — status is the source of truth for the exit code (matches
    // Daytona/Local getScriptLogs).
    return { output, exitCode: null, cmdId: commandId };
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    // E2B pause/resume is a warm-reuse follow-up (see PR needs-key list); until
    // then start is a no-op that returns the handle, matching Local's 501 no-op.
    return handle;
  }

  async stop(_handle: RuntimeHandle): Promise<void> {
    // No-op (see start): pause/resume lifecycle deferred to warm-reuse follow-up.
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const sandbox = await this.connectSandbox(handle.id);
    this.sandboxes.delete(handle.id);
    if (!sandbox) {
      return;
    }
    await sandbox.kill();
  }

  // --- internals ----------------------------------------------------------

  private async statics(): Promise<E2BSandboxStatics> {
    if (this.injectedStatics) {
      return this.injectedStatics;
    }
    if (!this.staticsPromise) {
      // Lazy — keeps `e2b` out of every non-E2B bundle and off the eager-import
      // ban list.
      this.staticsPromise = import("e2b").then(
        (mod) => (mod as unknown as { Sandbox: E2BSandboxStatics }).Sandbox,
      );
    }
    return this.staticsPromise;
  }

  private async requireSandbox(handle: RuntimeHandle): Promise<E2BSandbox> {
    const sandbox = await this.connectSandbox(handle.id);
    if (!sandbox) {
      throw new Error(`E2B sandbox "${handle.id}" is no longer available`);
    }
    return sandbox;
  }

  private async connectSandbox(id: string): Promise<E2BSandbox | null> {
    const cached = this.sandboxes.get(id);
    if (cached) {
      return cached;
    }
    const statics = await this.statics();
    try {
      const sandbox = await statics.connect(id, { apiKey: this.apiKey });
      this.sandboxes.set(id, sandbox);
      return sandbox;
    } catch (error) {
      if (isSandboxNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async readFileBestEffort(sandbox: E2BSandbox, path: string, maxBytes: number): Promise<string> {
    // Read via a bounded foreground `tail -c` rather than files.read: it returns
    // "" (never throws) when the file is still absent, and caps the bytes pulled
    // back into the Worker.
    try {
      const result = await sandbox.commands.run(
        `tail -c ${maxBytes} ${shellSingleQuote(path)} 2>/dev/null || true`,
      );
      return result.stdout ?? "";
    } catch {
      return "";
    }
  }
}

// --- helpers --------------------------------------------------------------

function serializeMetadataQuery(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([key]) => key.length > 0);
  if (entries.length === 0) {
    return "";
  }
  // e2b's metadata filter is a URL-encoded "k=v&k2=v2" string, not an object.
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    params.append(key, value);
  }
  return params.toString();
}

function handleFromE2BInfo(info: E2BSandboxInfo): RuntimeHandle {
  return {
    id: info.sandboxId,
    ...(info.state ? { state: normalizeE2BState(info.state) } : {}),
    ...(info.startedAt ? { createdAt: info.startedAt.toISOString() } : {}),
  };
}

function normalizeE2BState(state: E2BSandboxState): string {
  // Map to the normalized vocabulary the delivery path reasons about (Daytona
  // STARTED/STOPPED). A paused E2B sandbox is not cold-reusable in this PR
  // (warm resume is the follow-up) so it reads as STOPPED and is excluded by the
  // default ["STARTED"] filter → cold provisioning.
  return state === "running" ? "STARTED" : "STOPPED";
}

function matchesState(state: E2BSandboxState | undefined, states: readonly string[] | null): boolean {
  if (states === null) {
    return true;
  }
  const normalized = normalizeE2BState(state ?? "running");
  return states.includes(normalized);
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return stdout.endsWith("\n") || stderr.startsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
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

function isSandboxNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  return (
    name === "NotFoundError" ||
    name === "SandboxNotFoundError" ||
    (typeof message === "string" && /not\s*found/i.test(message))
  );
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function hasEntries(record?: Record<string, string>): record is Record<string, string> {
  return !!record && Object.keys(record).length > 0;
}

function scriptRunDir(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `/tmp/e2b-run/${safe}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
