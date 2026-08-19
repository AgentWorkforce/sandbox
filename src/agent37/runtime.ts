import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

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
  AsyncRunStartResult,
  AsyncRunStatus,
  RunScriptResult,
  SandboxRuntime,
} from "../port.js";
import { Agent37ApiError, Agent37Client } from "./client.js";
import type { Agent37ClientOptions, Agent37Fetch } from "./client.js";

// ---------------------------------------------------------------------------
// Agent37 Cloud provider for the SandboxRuntime + WorkflowRuntime contracts.
//
// Facts this adapter is built on, taken from the provider's published API
// reference and its CLI source, not inferred:
//
//  - Two planes, one key. The hosting plane takes `Authorization: Bearer`; an
//    instance's own URL takes `X-Agent37-Key`. Instance URLs are read off the
//    instance object, never constructed.
//  - `POST /v1/instances` returns 201 only once the instance reports `running`.
//    There is no documented "return me a booting instance" variant, so this
//    adapter deliberately does NOT implement `launchDetached`.
//  - `GET /v1/instances` returns `{ "data": [...] }`, newest first, with no
//    documented filter or pagination parameters. Label lookup is therefore a
//    client-side filter over a complete list.
//  - `POST /v1/instances/{id}/exec` takes exactly one field, `command`, run
//    through `sh -c`. No cwd, no env, no timeout, no async mode. Working
//    directory and environment are composed into the script; asynchronous
//    execution is built on the provider's own documented recipe (`nohup ... &`
//    plus a second exec to poll).
//  - Command output is capped at 512 KB per stream and a command may run for
//    280 seconds before the call fails.
//  - File transfer lives on the instance plane (`PUT`/`GET /v1/files/content`)
//    and is uncapped, which is why it is preferred over base64-over-exec.
// ---------------------------------------------------------------------------

/** Instance lifecycle states the hosting API reports. */
export type Agent37InstanceStatus =
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "starting"
  | "restarting"
  | "updating"
  | "sleeping"
  | "waking"
  | "failed"
  | "deleting"
  | "deleted";

/** Instance shape. Valid combinations are provider- and plan-specific. */
export type Agent37Resources = {
  cpu: number;
  memory: number;
  disk?: number;
};

/** A port exposed at a permanent unauthenticated URL. */
export type Agent37PublicPort = {
  port: number;
  prefix?: string;
};

/** Ceilings on an instance's managed-service usage, in micros. */
export type Agent37Budget = {
  monthly_cap_micros?: number;
  credit_micros?: number;
};

/** The instance object, as returned by the hosting plane. */
export type Agent37Instance = {
  id: string;
  status: Agent37InstanceStatus;
  status_reason?: string | null;
  template?: string | null;
  url?: string | null;
  user?: string | null;
  name?: string | null;
  metadata?: Record<string, string> | null;
  resources?: Agent37Resources | null;
  auto_sleep?: boolean;
  idle_timeout_seconds?: number;
  past_due?: boolean;
  created?: number;
};

/** Snapshot of a container's own output plus a compact health readout. */
export type Agent37ContainerLogs = {
  logs: string;
  truncated: boolean;
  health: Record<string, unknown> | null;
  fetched_at?: number;
};

export type Agent37RuntimeOptions = {
  /** `sk_live_` workspace key. Never sourced from the environment here. */
  apiKey: string;
  /**
   * Origin of the hosting API. Required: this package ships no endpoint
   * defaults, so the caller names the control plane (or a proxy in front of
   * it) explicitly.
   */
  baseUrl: string;
  /**
   * Home directory inside the instance image. Required: it is template-
   * specific, so there is no default correct for every consumer.
   */
  defaultHomeDir: string;
  /**
   * Template to launch. Omitted, the field is left off the create body and the
   * provider applies its own default — this package does not substitute one.
   */
  template?: string;
  /** Instance shape. Omitted, the provider applies its own smallest shape. */
  resources?: Agent37Resources;
  /** `dedicated` or `shared`. Omitted, the provider applies its own default. */
  type?: string;
  /** Managed-service ceilings. Omitted, the provider applies its own default. */
  budget?: Agent37Budget;
  /** Opt instances into idle checkpointing. */
  autoSleep?: boolean;
  /** Idle seconds before sleeping. Only meaningful with `autoSleep`. */
  idleTimeoutSeconds?: number;
  /** Ports to expose at permanent unauthenticated URLs. */
  publicPorts?: readonly Agent37PublicPort[];
  /** Opaque attribution tag stamped on every instance this runtime launches. */
  user?: string;
  /** Transport seam. Defaults to the global `fetch`. */
  fetch?: Agent37Fetch;
  /** Retry policy passthrough. */
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Pre-built client, for tests or for sharing one transport across runtimes. */
  client?: Agent37Client;
  /** Trailing bytes of a background run's log file that `getScriptLogs` pulls. */
  scriptLogReadMaxBytes?: number;
  /**
   * Largest file `uploadBundle` will push through the base64-over-exec
   * fallback, used only when an instance exposes no URL of its own.
   */
  execUploadMaxBytes?: number;
};

export type Agent37LookupOptions = {
  states?: readonly string[] | null;
  limit?: number;
  pageSize?: number;
  owned?: boolean;
  excludeIds?: readonly string[];
  timeoutMs?: number;
};

export type Agent37CountOptions = {
  states?: readonly string[] | null;
  limit?: number;
  pageSize?: number;
  maxCount?: number;
  timeoutMs?: number;
};

export type Agent37LaunchOptions = {
  name?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  workdir?: string;
  createTimeoutSeconds?: number;
};

export type Agent37RunScriptOptions = {
  command: string;
  sessionId?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  suppressInputEcho?: boolean;
};

export type Agent37BundleFile = {
  source: string | Buffer;
  destination: string;
};

export type Agent37UploadBundleOptions = {
  files: Array<Agent37BundleFile>;
};

/** Raised when `env` would be rejected by the provider's own create validation. */
export class Agent37EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Agent37EnvValidationError";
  }
}

// The provider documents `env` as at most 32 entries, keys of uppercase
// letters, digits, and underscores starting with a letter, values up to 4096
// characters. Checking locally turns a 400 after a round trip into an
// immediate, specific error — and, more importantly, keeps a malformed key
// from ever being interpolated into a shell.
const ENV_MAX_ENTRIES = 32;
const ENV_MAX_VALUE_LENGTH = 4096;
const ENV_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

const DEFAULT_SCRIPT_LOG_READ_MAX_BYTES = 262_144; // 256 KiB
const DEFAULT_EXEC_UPLOAD_MAX_BYTES = 262_144; // 256 KiB
const RUN_STATE_ROOT = "/tmp/agent37-run";

export class Agent37Runtime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "agent37";

  /**
   * Bootstrap-plane capabilities (the live in-sandbox session), distinct from
   * `SandboxRuntimeCapabilities`.
   *
   * `pty: false` and `streamingLogs: false` are facts, not caution: `exec` is a
   * single buffered request/response with no TTY, and the one log endpoint
   * (`GET /v1/instances/{id}/logs`) returns a snapshot with a `tail` count, not
   * a stream. `snapshots: false` likewise — templates are built from a
   * Dockerfile ahead of time; there is no documented call that captures a
   * running instance as a reusable image.
   */
  readonly capabilities: RuntimeCapabilities = {
    pty: false,
    snapshots: false,
    isolation: "strong",
    persistentHandle: true,
    streamingLogs: false,
  };

  /**
   * `lifecycle: true` because `start` and `stop` are real hosting-plane calls
   * that change `status`, not the no-ops some providers ship.
   *
   * `warmLease: true` because label lookup returns real matches. `GET
   * /v1/instances` documents no server-side filter, so the filtering happens
   * here — but it happens over a complete, unpaginated list, which makes an
   * empty result mean "no match" and nothing else. That is the ambiguity the
   * capability exists to rule out, and it is ruled out.
   */
  readonly declaredCapabilities = { warmLease: true, lifecycle: true } as const;

  private readonly client: Agent37Client;
  private readonly defaultHomeDir: string;
  private readonly template?: string;
  private readonly resources?: Agent37Resources;
  private readonly instanceType?: string;
  private readonly budget?: Agent37Budget;
  private readonly autoSleep?: boolean;
  private readonly idleTimeoutSeconds?: number;
  private readonly publicPorts?: readonly Agent37PublicPort[];
  private readonly user?: string;
  private readonly scriptLogReadMaxBytes: number;
  private readonly execUploadMaxBytes: number;
  // An instance's own origin is only knowable from its instance object. Cache
  // what has been seen so the file plane does not re-GET on every transfer.
  private readonly instanceUrls = new Map<string, string>();

  constructor(options: Agent37RuntimeOptions) {
    if (!options.defaultHomeDir?.trim()) {
      throw new Error(
        "Agent37Runtime requires an explicit defaultHomeDir: it is template-specific",
      );
    }
    this.client = options.client ?? new Agent37Client(toClientOptions(options));
    this.defaultHomeDir = options.defaultHomeDir.trim();
    if (options.template !== undefined) {
      this.template = options.template;
    }
    if (options.resources !== undefined) {
      this.resources = options.resources;
    }
    if (options.type !== undefined) {
      this.instanceType = options.type;
    }
    if (options.budget !== undefined) {
      this.budget = options.budget;
    }
    if (options.autoSleep !== undefined) {
      this.autoSleep = options.autoSleep;
    }
    if (options.idleTimeoutSeconds !== undefined) {
      this.idleTimeoutSeconds = options.idleTimeoutSeconds;
    }
    if (options.publicPorts !== undefined) {
      this.publicPorts = options.publicPorts;
    }
    if (options.user !== undefined) {
      this.user = options.user;
    }
    this.scriptLogReadMaxBytes =
      options.scriptLogReadMaxBytes ?? DEFAULT_SCRIPT_LOG_READ_MAX_BYTES;
    this.execUploadMaxBytes = options.execUploadMaxBytes ?? DEFAULT_EXEC_UPLOAD_MAX_BYTES;
  }

  // --- discovery ----------------------------------------------------------

  async findByLabels(
    labels: Record<string, string>,
    options: Agent37LookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    const excluded = new Set(options.excludeIds ?? []);
    const handles = await this.findAllByLabels(labels, options);
    return handles.find((handle) => !excluded.has(handle.id)) ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: Agent37LookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const limit = options.limit ?? options.pageSize;
    const excluded = new Set(options.excludeIds ?? []);
    const instances = await this.listInstances(options.timeoutMs);
    const handles: RuntimeHandle[] = [];
    for (const instance of instances) {
      if (excluded.has(instance.id)) {
        continue;
      }
      if (!matchesLabels(instance, labels)) {
        continue;
      }
      if (!matchesState(instance.status, states)) {
        continue;
      }
      handles.push(this.registerInstance(instance));
      if (limit !== undefined && handles.length >= limit) {
        break;
      }
    }
    return handles;
  }

  async countByLabels(
    labels: Record<string, string>,
    options: Agent37CountOptions = {},
  ): Promise<number> {
    const maxCount =
      options.maxCount === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(options.maxCount));
    if (maxCount === 0) {
      return 0;
    }
    const lookup: Agent37LookupOptions = {
      ...(options.states === undefined ? {} : { states: options.states }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(Number.isFinite(maxCount) ? { limit: maxCount } : {}),
    };
    const handles = await this.findAllByLabels(labels, lookup);
    return handles.length;
  }

  async getById(
    id: string,
    options: {
      states?: readonly string[] | null;
      owned?: boolean;
      homeDir?: string;
      workdir?: string;
    } = {},
  ): Promise<RuntimeHandle | null> {
    const instance = await this.fetchInstance(id);
    if (!instance) {
      return null;
    }
    // `states: undefined` means "no filter" on reattach: a caller resolving a
    // known id wants the instance whatever state it is in, so it can decide
    // whether to start it. That is the opposite of the label search default,
    // which is looking for something ready to use right now.
    const states = options.states === undefined ? null : options.states;
    if (!matchesState(instance.status, states)) {
      return null;
    }
    const handle = this.registerInstance(instance);
    return {
      ...handle,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.workdir ? { workdir: options.workdir } : {}),
    };
  }

  // --- lifecycle ----------------------------------------------------------

  async launch(options: Agent37LaunchOptions & LaunchOptions = {}): Promise<RuntimeHandle> {
    const env = options.env;
    if (env) {
      assertValidEnv(env);
    }
    const metadata = options.labels;
    const body: Record<string, unknown> = {
      ...(this.template === undefined ? {} : { template: this.template }),
      ...(this.resources === undefined ? {} : { resources: this.resources }),
      ...(this.instanceType === undefined ? {} : { type: this.instanceType }),
      ...(this.budget === undefined ? {} : { budget: this.budget }),
      ...(this.autoSleep === undefined ? {} : { auto_sleep: this.autoSleep }),
      ...(this.idleTimeoutSeconds === undefined
        ? {}
        : { idle_timeout_seconds: this.idleTimeoutSeconds }),
      ...(this.publicPorts === undefined ? {} : { public_ports: this.publicPorts }),
      ...(this.user === undefined ? {} : { user: this.user }),
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    };
    const instance = await this.client.hosting<Agent37Instance>("POST", "/v1/instances", {
      body,
      ...(options.createTimeoutSeconds === undefined
        ? {}
        : { timeoutMs: options.createTimeoutSeconds * 1000 }),
    });
    const handle = this.registerInstance(instance);
    return {
      ...handle,
      homeDir: this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
    };
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const ack = await this.client.hosting<{ id: string; status: Agent37InstanceStatus }>(
      "POST",
      `/v1/instances/${encodeURIComponent(handle.id)}/start`,
    );
    return { ...handle, state: normalizeStatus(ack.status) };
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    await this.client.hosting("POST", `/v1/instances/${encodeURIComponent(handle.id)}/stop`);
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    this.instanceUrls.delete(handle.id);
    try {
      await this.client.hosting("DELETE", `/v1/instances/${encodeURIComponent(handle.id)}`);
    } catch (error) {
      // Delete acts once: a repeat returns 404. An already-gone instance is
      // the caller's desired end state, so absorb it rather than making every
      // teardown path handle a race it cannot prevent.
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }

  // --- execution ----------------------------------------------------------

  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, {
      command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return { output: result.output, exitCode: result.exitCode ?? 0 };
  }

  async runScript(
    handle: RuntimeHandle,
    options: Agent37RunScriptOptions,
  ): Promise<RunScriptResult> {
    if (options.env) {
      assertValidEnv(options.env);
    }
    const cwd = options.cwd ?? handle.workdir;
    const script = composeScript(options.command, {
      ...(cwd ? { cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const result = await this.execRaw(handle.id, script, options.timeoutMs);
    return {
      output: combineOutput(result.stdout, result.stderr),
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
      exitCode: result.exit_code,
    };
  }

  /**
   * Submit a command that outlives this request.
   *
   * `exec` is synchronous and capped at 280 seconds, so a long run cannot be
   * held open across the call. The provider's own guidance is to background it
   * and poll with a second exec; this builds that into a durable form. The
   * command and its runner are written to files (base64-decoded in place, so no
   * caller text is ever interpolated into a shell word), the runner redirects
   * combined output to `out` and writes the final status to `exit`, and
   * `nohup ... &` detaches it. `getScriptStatus` and `getScriptLogs` then read
   * those files, which survive across poll ticks and separate requests.
   */
  async startScript(
    handle: RuntimeHandle,
    options: Agent37RunScriptOptions,
  ): Promise<AsyncRunStartResult> {
    if (options.env) {
      assertValidEnv(options.env);
    }
    const sessionId = options.sessionId ?? `run-${handle.id}-${Date.now()}`;
    const dir = scriptRunDir(sessionId);
    const cwd = options.cwd ?? handle.workdir;
    const script = composeScript(options.command, {
      ...(cwd ? { cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const runner =
      `sh ${shellQuote(`${dir}/cmd.sh`)} > ${shellQuote(`${dir}/out`)} 2>&1\n` +
      `echo $? > ${shellQuote(`${dir}/exit`)}\n`;
    const bootstrap = [
      `mkdir -p ${shellQuote(dir)}`,
      writeFileViaBase64(`${dir}/cmd.sh`, script),
      writeFileViaBase64(`${dir}/run.sh`, runner),
      `nohup sh ${shellQuote(`${dir}/run.sh`)} >/dev/null 2>&1 &`,
      "echo $!",
    ].join("\n");
    const started = await this.execRaw(handle.id, bootstrap, options.timeoutMs);
    if (started.exit_code !== 0) {
      throw new Error(
        `Agent37 failed to start background run in "${handle.id}" (exit ${started.exit_code}): ${
          combineOutput(started.stdout, started.stderr).slice(0, 2000)
        }`,
      );
    }
    return { sessionId, commandId: started.stdout.trim() };
  }

  startExec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions & { sessionId?: string } = {},
  ): Promise<AsyncExecStartResult> {
    return this.startScript(handle, {
      command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    sessionId: string,
    _commandId: string,
  ): Promise<AsyncRunStatus> {
    const exitPath = `${scriptRunDir(sessionId)}/exit`;
    // The durable exit file is the only source of truth. Missing or empty
    // means the run has not finished — never "succeeded".
    const raw = await this.readRemoteText(handle.id, exitPath, 64);
    const trimmed = raw.trim();
    if (!trimmed) {
      return { exitCode: null };
    }
    const parsed = Number.parseInt(trimmed, 10);
    return { exitCode: Number.isFinite(parsed) ? parsed : null };
  }

  getExecStatus(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<AsyncExecStatus> {
    return this.getScriptStatus(handle, sessionId, commandId);
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    const outPath = `${scriptRunDir(sessionId)}/out`;
    const output = await this.readRemoteText(handle.id, outPath, this.scriptLogReadMaxBytes);
    // `exitCode: null` on purpose: status owns the exit code, and a log read
    // that invented one would let a still-running command read as finished.
    return { output, exitCode: null, cmdId: commandId };
  }

  async getExecLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<ExecResult> {
    const result = await this.getScriptLogs(handle, sessionId, commandId);
    return { output: result.output, exitCode: result.exitCode ?? 0 };
  }

  // --- files --------------------------------------------------------------

  async uploadBundle(
    handle: RuntimeHandle,
    options: Agent37UploadBundleOptions,
  ): Promise<void> {
    for (const file of options.files) {
      await this.uploadFile(handle, file.source, file.destination);
    }
  }

  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : source;
    const instanceUrl = await this.resolveInstanceUrl(handle.id);
    if (instanceUrl) {
      await this.client.instance(instanceUrl, "PUT", "/v1/files/content", {
        query: { path: destination },
        body: new Uint8Array(bytes),
        contentType: "application/octet-stream",
      });
      return;
    }
    // A template registered with no ports has no URL of its own, so the file
    // plane is unreachable and the only way in is through the hosting plane's
    // exec. That path carries the payload inside a shell command, so it is
    // bounded rather than silently attempted at any size.
    if (bytes.byteLength > this.execUploadMaxBytes) {
      throw new Error(
        `Agent37 instance "${handle.id}" exposes no URL, so uploads fall back to exec, ` +
          `which is capped at ${this.execUploadMaxBytes} bytes; "${destination}" is ` +
          `${bytes.byteLength} bytes. Register the template with a port to use the file API.`,
      );
    }
    const dir = posixDirname(destination);
    const command = [
      ...(dir ? [`mkdir -p ${shellQuote(dir)}`] : []),
      writeFileViaBase64(destination, bytes),
    ].join("\n");
    const result = await this.execRaw(handle.id, command);
    if (result.exit_code !== 0) {
      throw new Error(
        `Agent37 exec upload of "${destination}" failed (exit ${result.exit_code}): ${
          combineOutput(result.stdout, result.stderr).slice(0, 2000)
        }`,
      );
    }
  }

  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    const instanceUrl = await this.resolveInstanceUrl(handle.id);
    if (!instanceUrl) {
      throw new Error(
        `Agent37 instance "${handle.id}" exposes no URL, so its file API is unreachable; ` +
          "register the template with a port, or read the file through exec.",
      );
    }
    const bytes = await this.client.instanceBytes(instanceUrl, "GET", "/v1/files/content", {
      query: { path: source, disposition: "attachment" },
    });
    const buffer = Buffer.from(bytes);
    if (destination === undefined) {
      return buffer;
    }
    await writeFile(destination, buffer);
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    return handle.homeDir ?? this.defaultHomeDir;
  }

  // --- diagnostics --------------------------------------------------------

  /**
   * Container boot and runtime logs. Unlike `exec`, this works in any state,
   * which is what makes it the tool for an instance that will not stay up.
   */
  async getContainerLogs(
    handle: RuntimeHandle,
    options: { tail?: number } = {},
  ): Promise<Agent37ContainerLogs> {
    return this.client.hosting<Agent37ContainerLogs>(
      "GET",
      `/v1/instances/${encodeURIComponent(handle.id)}/logs`,
      {
        ...(options.tail === undefined ? {} : { query: { tail: String(options.tail) } }),
      },
    );
  }

  // --- internals ----------------------------------------------------------

  private async execRaw(
    id: string,
    command: string,
    timeoutMs?: number,
  ): Promise<{ exit_code: number | null; stdout: string; stderr: string; truncated?: boolean }> {
    const response = await this.client.hosting<{
      exit_code?: number;
      stdout?: string;
      stderr?: string;
      truncated?: boolean;
    }>("POST", `/v1/instances/${encodeURIComponent(id)}/exec`, {
      body: { command },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return {
      // A response that omits `exit_code` is an unknown outcome, never a
      // success. Defaulting it to 0 would let a malformed reply read as a
      // command that passed.
      exit_code: typeof response.exit_code === "number" ? response.exit_code : null,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      ...(response.truncated === undefined ? {} : { truncated: response.truncated }),
    };
  }

  /**
   * Read at most `maxBytes` trailing bytes of a remote file, returning "" when
   * it does not exist yet. `|| true` keeps a missing file — the normal state
   * of `exit` while a run is in flight — from reading as a failed poll.
   */
  private async readRemoteText(id: string, path: string, maxBytes: number): Promise<string> {
    const result = await this.execRaw(
      id,
      `tail -c ${maxBytes} ${shellQuote(path)} 2>/dev/null || true`,
    );
    return result.stdout;
  }

  private async listInstances(timeoutMs?: number): Promise<Agent37Instance[]> {
    const response = await this.client.hosting<{ data?: Agent37Instance[] }>(
      "GET",
      "/v1/instances",
      { ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  private async fetchInstance(id: string): Promise<Agent37Instance | null> {
    try {
      return await this.client.hosting<Agent37Instance>(
        "GET",
        `/v1/instances/${encodeURIComponent(id)}`,
      );
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async resolveInstanceUrl(id: string): Promise<string | null> {
    const cached = this.instanceUrls.get(id);
    if (cached) {
      return cached;
    }
    const instance = await this.fetchInstance(id);
    if (!instance) {
      throw new Error(`Agent37 instance "${id}" is no longer available`);
    }
    this.registerInstance(instance);
    return this.instanceUrls.get(id) ?? null;
  }

  private registerInstance(instance: Agent37Instance): RuntimeHandle {
    if (instance.url) {
      this.instanceUrls.set(instance.id, instance.url.replace(/\/+$/, ""));
    }
    return {
      id: instance.id,
      state: normalizeStatus(instance.status),
      ...(typeof instance.created === "number"
        ? { createdAt: new Date(instance.created * 1000).toISOString() }
        : {}),
    };
  }
}

// --- helpers --------------------------------------------------------------

function toClientOptions(options: Agent37RuntimeOptions): Agent37ClientOptions {
  return {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryBaseDelayMs === undefined
      ? {}
      : { retryBaseDelayMs: options.retryBaseDelayMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
}

/**
 * Map a provider status onto the normalized vocabulary the delivery path
 * reasons about.
 *
 * Only `running` is `STARTED`. Every transitional status — `provisioning`,
 * `starting`, `waking`, `restarting`, `updating` — reads as `STOPPED`, so the
 * default `["STARTED"]` filter can never hand a caller an instance that is not
 * yet able to accept an exec.
 */
export function normalizeStatus(status: Agent37InstanceStatus | undefined): string {
  return status === "running" ? "STARTED" : "STOPPED";
}

function matchesState(
  status: Agent37InstanceStatus | undefined,
  states: readonly string[] | null,
): boolean {
  if (states === null) {
    return true;
  }
  return states.includes(normalizeStatus(status));
}

function matchesLabels(instance: Agent37Instance, labels: Record<string, string>): boolean {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return true;
  }
  const metadata = instance.metadata;
  if (!metadata) {
    return false;
  }
  return entries.every(([key, value]) => metadata[key] === value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Agent37ApiError && (error.status === 404 || error.code === "not_found");
}

export function assertValidEnv(env: Record<string, string>): void {
  const keys = Object.keys(env);
  if (keys.length > ENV_MAX_ENTRIES) {
    throw new Agent37EnvValidationError(
      `Agent37 accepts at most ${ENV_MAX_ENTRIES} env entries; received ${keys.length}`,
    );
  }
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      // The name is safe to quote (it failed a character-class test, so it is
      // reported as-is); the value never appears in the message.
      throw new Agent37EnvValidationError(
        `Agent37 env name ${JSON.stringify(key)} is not a valid shell identifier`,
      );
    }
    const value = env[key];
    if (typeof value !== "string") {
      throw new Agent37EnvValidationError(`Agent37 env value for ${JSON.stringify(key)} must be a string`);
    }
    if (value.length > ENV_MAX_VALUE_LENGTH) {
      throw new Agent37EnvValidationError(
        `Agent37 env value for ${JSON.stringify(key)} exceeds ${ENV_MAX_VALUE_LENGTH} characters`,
      );
    }
  }
}

/**
 * Build the shell program for one run.
 *
 * `exec` accepts a command and nothing else — no cwd, no env, no timeout — so
 * both are expressed in the program itself. Values are single-quoted, and a
 * failed `cd` aborts rather than silently running the command in the wrong
 * directory.
 */
export function composeScript(
  command: string,
  options: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const lines: string[] = [];
  if (options.cwd) {
    lines.push(`cd ${shellQuote(options.cwd)} || exit 1`);
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push(command);
  return `${lines.join("\n")}\n`;
}

/**
 * A shell line that materializes `contents` at `path`.
 *
 * The payload is base64, whose alphabet cannot escape a single-quoted word, so
 * no caller-supplied byte is ever parsed as shell syntax.
 */
function writeFileViaBase64(path: string, contents: string | Buffer): string {
  const encoded = (typeof contents === "string" ? Buffer.from(contents, "utf8") : contents)
    .toString("base64");
  return `printf %s '${encoded}' | base64 -d > ${shellQuote(path)}`;
}

function scriptRunDir(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${RUN_STATE_ROOT}/${safe}`;
}

function posixDirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return "";
  }
  return path.slice(0, index);
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return stdout.endsWith("\n") || stderr.startsWith("\n")
      ? `${stdout}${stderr}`
      : `${stdout}\n${stderr}`;
  }
  return stdout || stderr || "";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
