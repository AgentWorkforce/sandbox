import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

import type {
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from "../types.js";
import type {
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
//    directory and environment are composed into the script.
//  - Commands are capped at 280 seconds by the provider; exceeding the cap
//    fails the call with `provisioning_failed` (502). That cap is the ONLY
//    command lifetime this adapter can enforce: `exec` takes no timeout, and
//    aborting the HTTP request abandons the response while the command runs on.
//    So `timeoutMs` — which the port defines as command lifetime — is honoured
//    only when the cap already satisfies it, and refused otherwise rather than
//    downgraded into an `AbortSignal` that cancels nothing. `requestTimeoutMs`
//    is the separate, honestly named budget for how long this client waits.
//  - Command output is capped at 512 KB per stream. When output is truncated,
//    the response carries `truncated: true`; this field is passed through in
//    RunScriptResult so callers can detect incomplete output.
//  - File transfer lives on the instance plane (`PUT`/`GET /v1/files/content`)
//    and is uncapped, which is why it is preferred over base64-over-exec.
//    The instance plane is authenticated with `X-Agent37-Key` and does NOT
//    require a public port; public ports are for user-space services only.
//
// Async exec (nohup+/tmp emulation) was removed because it cannot provide
// durable, idempotent guarantees:
//  - /tmp state is lost when an instance stops, restarts, or updates.
//  - Instance crashes leave the exit sentinel unwritten — permanent null state.
//  - No deduplication guard for concurrent startScript calls with the same sessionId.
// asyncExec is therefore false. Callers requiring async execution should use an
// external queue or a provider that natively supports it.
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

/**
 * A port exposed at a permanent unauthenticated URL, for user-space services.
 *
 * The instance plane (file API) is authenticated with `X-Agent37-Key` and does
 * NOT require a public port. Register public ports only for services that need
 * anonymous ingress from outside the instance.
 */
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
  /**
   * Ports to expose at permanent unauthenticated URLs, for user-space services.
   * The instance plane (file API) uses `X-Agent37-Key` auth and does not need
   * a public port.
   */
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
  /**
   * Command lifetime, per the port's contract: once it elapses the command is
   * no longer running. Agent37 can only satisfy this via its own
   * {@link AGENT37_COMMAND_CAP_MS} cap, so a shorter value is rejected with
   * {@link Agent37CommandTimeoutUnsupportedError} rather than silently
   * downgraded to an HTTP abort that would not stop anything.
   */
  timeoutMs?: number;
  /**
   * How long this client waits for the HTTP response, and nothing more. On
   * expiry the request is abandoned and **the command keeps running inside the
   * instance** — this is a budget for the caller, not a cancellation.
   */
  requestTimeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
};

/** `ExecOptions` plus the request budget that has no bootstrap-plane equivalent. */
export type Agent37ExecOptions = ExecOptions & { requestTimeoutMs?: number };

export type Agent37BundleFile = {
  source: string | Buffer;
  destination: string;
};

export type Agent37UploadBundleOptions = {
  files: Array<Agent37BundleFile>;
};

/**
 * The provider's hard ceiling on a single command, in milliseconds. Every
 * command is bounded by this whether the caller asks for it or not, which is
 * what makes a `timeoutMs` of at least this value honestly satisfiable.
 */
export const AGENT37_COMMAND_CAP_MS = 280_000;

/** Raised when `env` would be rejected by the provider's own create validation. */
export class Agent37EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Agent37EnvValidationError";
  }
}

/**
 * Raised when start / stop / destroy is handed an instance this runtime knows
 * nothing about.
 *
 * Ownership here is *caller-declared attachment*, not in-process provenance:
 * `launch` owns what it creates, and `getById` / `findAllByLabels` attach as
 * unowned unless the caller passes `owned: true`. An instance that was never
 * resolved through any of those is refused outright rather than mutated on a
 * guess.
 *
 * This is deliberately louder than the Daytona adapter, which silently returns
 * for an unregistered handle. A destroy that quietly does nothing reads to the
 * caller as a completed teardown that never happened, which is the more
 * expensive of the two failure modes.
 */
export class Agent37ForeignHandleError extends Error {
  constructor(id: string, operation: string) {
    super(
      `Agent37 refused to ${operation} instance "${id}": this runtime has no ` +
        "registration for it. Resolve it with getById(id, { owned: true }) to " +
        "declare ownership before mutating or destroying it.",
    );
    this.name = "Agent37ForeignHandleError";
  }
}

/**
 * Raised when a command completes but the provider's reply carries no
 * `exit_code`, so its outcome is unknown.
 *
 * `runScript` reports this as `exitCode: null`, which the port models. `exec`
 * cannot: `ExecResult.exitCode` is a number, and the only numbers available are
 * lies — `0` would report a command that may have failed as a success.
 */
export class Agent37UnknownExitCodeError extends Error {
  readonly output: string;

  constructor(id: string, output: string) {
    super(
      `Agent37 exec on instance "${id}" returned no exit_code, so the command's ` +
        "outcome is unknown; refusing to report it as success",
    );
    this.name = "Agent37UnknownExitCodeError";
    this.output = output;
  }
}

/**
 * Raised when a caller asks for a command lifetime Agent37 cannot enforce.
 *
 * `timeoutMs` on the port means the command is no longer running once it
 * elapses. Agent37's `exec` accepts no timeout, and aborting the HTTP request
 * only abandons the response — the command keeps running inside the instance.
 * The single lifetime bound Agent37 genuinely enforces is its own
 * {@link AGENT37_COMMAND_CAP_MS} cap, so anything shorter is refused instead of
 * being faked with an `AbortSignal`.
 *
 * Callers that want to stop *waiting* (as opposed to stopping the command) want
 * `requestTimeoutMs`, which is named for what it actually does.
 */
export class Agent37CommandTimeoutUnsupportedError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Agent37 cannot enforce a ${timeoutMs}ms command timeout: exec takes no ` +
        `timeout, and aborting the request leaves the command running. The only ` +
        `lifetime bound is the provider's own ${AGENT37_COMMAND_CAP_MS}ms cap, so ` +
        `timeoutMs must be at least that. To bound how long this client waits ` +
        `— which does not stop the command — use requestTimeoutMs instead.`,
    );
    this.name = "Agent37CommandTimeoutUnsupportedError";
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

const DEFAULT_EXEC_UPLOAD_MAX_BYTES = 262_144; // 256 KiB

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
   *
   * `asyncExec` is not declared here; it is derived from method presence by
   * `resolveSandboxRuntimeCapabilities`. Async exec is absent from this adapter
   * because nohup+/tmp emulation cannot provide durable, idempotent guarantees.
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
  private readonly execUploadMaxBytes: number;
  // An instance's own origin is only knowable from its instance object. Cache
  // what has been seen so the file plane does not re-GET on every transfer.
  private readonly instanceUrls = new Map<string, string>();
  // What this runtime has been told about each instance it has resolved:
  // `true` for one it launched or that the caller explicitly claimed, `false`
  // for a plain attachment. Absent means "never seen", which is refused rather
  // than mutated. Deliberately not a provenance set — a process that crashed
  // and restarted launched nothing, yet must still be able to delete its own
  // instances, which it does by resolving them with `owned: true`.
  private readonly ownership = new Map<string, boolean>();

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
      this.declareOwnership(instance.id, options.owned === true);
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
    // `owned: true` is the caller asserting this instance is theirs — the one
    // way a restarted process reacquires the right to tear down what a previous
    // run created.
    this.declareOwnership(id, options.owned === true);
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
    // The singular `label` from LaunchOptions populates a "label" metadata key.
    // Explicit `labels` entries merge on top and take precedence if both are provided.
    const rawMetadata: Record<string, string> = {};
    if (options.label !== undefined) {
      rawMetadata["label"] = options.label;
    }
    if (options.labels) {
      Object.assign(rawMetadata, options.labels);
    }
    const metadata = Object.keys(rawMetadata).length > 0 ? rawMetadata : undefined;
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
      ...(metadata ? { metadata } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    };
    const instance = await this.client.hosting<Agent37Instance>("POST", "/v1/instances", {
      body,
      ...(options.createTimeoutSeconds === undefined
        ? {}
        : { timeoutMs: options.createTimeoutSeconds * 1000 }),
    });
    this.declareOwnership(instance.id, true);
    const handle = this.registerInstance(instance);
    return {
      ...handle,
      homeDir: this.defaultHomeDir,
      ...(options.workdir ? { workdir: options.workdir } : {}),
    };
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    if (!this.requireOwnership(handle.id, "start")) {
      // Attached, not owned: the instance's lifecycle belongs to whoever does
      // own it. Returning the handle unchanged is honest; claiming STARTED
      // would not be.
      return handle;
    }
    const ack = await this.client.hosting<{ id: string; status: Agent37InstanceStatus }>(
      "POST",
      `/v1/instances/${encodeURIComponent(handle.id)}/start`,
    );
    return { ...handle, state: normalizeStatus(ack.status) };
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    if (!this.requireOwnership(handle.id, "stop")) {
      return;
    }
    await this.client.hosting("POST", `/v1/instances/${encodeURIComponent(handle.id)}/stop`);
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    if (!this.requireOwnership(handle.id, "destroy")) {
      // Destroying an attachment releases this runtime's reference to it and
      // nothing else. The instance is caller-managed, so deleting it here would
      // be destroying someone else's sandbox.
      this.forget(handle.id);
      return;
    }
    try {
      await this.client.hosting("DELETE", `/v1/instances/${encodeURIComponent(handle.id)}`);
    } catch (error) {
      // Delete acts once: a repeat returns 404. An already-gone instance is
      // the caller's desired end state, so absorb it rather than making every
      // teardown path handle a race it cannot prevent.
      if (isNotFound(error)) {
        this.forget(handle.id);
        return;
      }
      // Order matters: the registration is dropped only on a terminal outcome.
      // Forgetting first would strip ownership from a handle whose delete has
      // not happened yet, leaving the caller unable to retry its own teardown.
      throw error;
    }
    this.forget(handle.id);
  }

  // --- execution ----------------------------------------------------------

  async exec(
    handle: RuntimeHandle,
    command: string,
    options: Agent37ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, {
      command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    if (result.exitCode === null) {
      throw new Agent37UnknownExitCodeError(handle.id, result.output);
    }
    return {
      output: result.output,
      exitCode: result.exitCode,
      ...(result.truncated === true ? { truncated: true } : {}),
    };
  }

  async runScript(
    handle: RuntimeHandle,
    options: Agent37RunScriptOptions,
  ): Promise<RunScriptResult> {
    assertHonourableCommandTimeout(options.timeoutMs);
    if (options.env) {
      assertValidEnv(options.env);
    }
    const cwd = options.cwd ?? handle.workdir;
    const script = composeScript(options.command, {
      ...(cwd ? { cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    // Only `requestTimeoutMs` becomes an abort signal. `timeoutMs` is a command
    // lifetime, and it got here only because the provider's own cap already
    // satisfies it — turning it into an HTTP abort would abandon the response
    // while the command ran on.
    const result = await this.execRaw(handle.id, script, options.requestTimeoutMs);
    return {
      output: combineOutput(result.stdout, result.stderr),
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
      exitCode: result.exit_code,
      ...(result.truncated === true ? { truncated: true } : {}),
    };
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

  /**
   * Record what the caller declared about an instance.
   *
   * Monotonic on purpose: once ownership is claimed it survives later read-only
   * resolutions of the same id. A plain `findAllByLabels` sweep listing an
   * instance must not quietly revoke the delete rights a caller already
   * declared through `getById(id, { owned: true })`.
   */
  private declareOwnership(id: string, owned: boolean): void {
    if (owned) {
      this.ownership.set(id, true);
      return;
    }
    if (!this.ownership.has(id)) {
      this.ownership.set(id, false);
    }
  }

  /**
   * Resolve what may be done to `id`: `true` to mutate it, `false` for an
   * attachment this runtime must leave alone. Throws when the id was never
   * registered, because that is a caller mistake rather than a policy decision.
   */
  private requireOwnership(id: string, operation: string): boolean {
    const owned = this.ownership.get(id);
    if (owned === undefined) {
      throw new Agent37ForeignHandleError(id, operation);
    }
    return owned;
  }

  /** Drop every trace of an instance this runtime is done with. */
  private forget(id: string): void {
    this.ownership.delete(id);
    this.instanceUrls.delete(id);
  }

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

/**
 * Reject a command lifetime Agent37 cannot deliver.
 *
 * Anything at or above the provider's cap is genuinely satisfied — the command
 * cannot outlive the cap, so it certainly cannot outlive a longer deadline.
 * Anything below it would need real cancellation, which `exec` does not offer.
 */
export function assertHonourableCommandTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && timeoutMs < AGENT37_COMMAND_CAP_MS) {
    throw new Agent37CommandTimeoutUnsupportedError(timeoutMs);
  }
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
