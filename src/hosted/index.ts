import { randomUUID } from "node:crypto";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOWER_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type HostedSandboxProvider = "e2b" | "daytona";

export type HostedSandboxErrorCode =
  | "SANDBOX_INVALID_INPUT"
  | "SANDBOX_PROVIDER_NOT_READY"
  | "SANDBOX_SETUP_UNAVAILABLE"
  | "SANDBOX_ACCESS_DENIED"
  | "SANDBOX_CREATE_UNKNOWN"
  | "SANDBOX_RUN_UNKNOWN"
  | "SANDBOX_DESTROY_UNKNOWN";

export class HostedSandboxError extends Error {
  readonly code: HostedSandboxErrorCode;
  readonly setupUrl?: string;

  constructor(code: HostedSandboxErrorCode, message: string, setupUrl?: string) {
    super(message);
    this.name = "HostedSandboxError";
    this.code = code;
    if (setupUrl !== undefined) this.setupUrl = setupUrl;
  }
}

export interface HostedSandboxOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly providerId: HostedSandboxProvider;
  readonly appKey?: string;
  readonly environment?: string;
  readonly intentKey?: string;
  readonly requestTimeoutMs?: number;
}

export interface HostedSandboxRunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

export interface HostedSandboxRunResult {
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number | null;
}

export interface HostedSandboxSession {
  readonly id: string;
  run(command: string, options?: HostedSandboxRunOptions): Promise<HostedSandboxRunResult>;
  destroy(): Promise<void>;
}

type HostedConfig = {
  readonly baseUrl: URL;
  readonly token: string;
  readonly workspaceId: string;
  readonly providerId: HostedSandboxProvider;
  readonly appKey: string;
  readonly environment: string;
  readonly intentKey: string;
  readonly requestTimeoutMs: number;
  readonly setupUrl: string;
};

function invalid(message: string): never {
  throw new HostedSandboxError("SANDBOX_INVALID_INPUT", message);
}

function validateString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) invalid(message);
}

function validateBaseUrl(value: unknown): URL {
  validateString(value, "Hosted sandbox baseUrl is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("Hosted sandbox baseUrl is invalid");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) {
    invalid("Hosted sandbox baseUrl must be an HTTPS deployment URL without credentials or query parameters");
  }
  return url;
}

function validateBoundedInteger(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(message);
  return value;
}

function validateConfig(options: HostedSandboxOptions): HostedConfig {
  if (options === null || typeof options !== "object") invalid("Hosted sandbox options are invalid");
  const baseUrl = validateBaseUrl(options.baseUrl);
  validateString(options.token, "Hosted sandbox token is invalid");
  validateString(options.workspaceId, "Hosted sandbox workspaceId is invalid");
  if (!UUID.test(options.workspaceId)) invalid("Hosted sandbox workspaceId must be a UUID");
  if (options.providerId !== "e2b" && options.providerId !== "daytona") invalid("Hosted sandbox providerId is invalid");
  const appKey = options.appKey ?? "sandbox";
  const environment = options.environment ?? "development";
  const intentKey = options.intentKey ?? randomUUID();
  if (typeof appKey !== "string" || !LOWER_IDENTIFIER.test(appKey) || appKey.length > 128) invalid("Hosted sandbox appKey is invalid");
  if (typeof environment !== "string" || !LOWER_IDENTIFIER.test(environment) || environment.length > 64) invalid("Hosted sandbox environment is invalid");
  if (typeof intentKey !== "string" || !IDENTIFIER.test(intentKey) || intentKey.length > 128) invalid("Hosted sandbox intentKey is invalid");
  const requestTimeoutMs = options.requestTimeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : validateBoundedInteger(options.requestTimeoutMs, 1, MAX_REQUEST_TIMEOUT_MS, "Hosted sandbox requestTimeoutMs is invalid");
  return {
    baseUrl,
    token: options.token,
    workspaceId: options.workspaceId,
    providerId: options.providerId,
    appKey,
    environment,
    intentKey,
    requestTimeoutMs,
    setupUrl: getHostedSandboxSetupUrl({ baseUrl: baseUrl.toString(), workspaceId: options.workspaceId, appKey, environment }),
  };
}

function endpoint(config: HostedConfig, suffix = ""): string {
  const root = config.baseUrl.pathname.replace(/\/+$/u, "");
  const url = new URL(config.baseUrl.toString());
  url.pathname = `${root}/api/v1/workspaces/${encodeURIComponent(config.workspaceId)}/sandbox-sessions${suffix}`;
  return url.toString();
}

function sessionEndpoint(config: HostedConfig, id: string, suffix = ""): string {
  return endpoint(config, `/${encodeURIComponent(id)}${suffix}`);
}

function safeObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function readBody(response: Response, controller: AbortController): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new Error("response too large");
      }
      chunks.push(part.value);
      if (controller.signal.aborted) throw new Error("request aborted");
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function request(config: HostedConfig, method: "POST" | "DELETE", url: string, body: unknown, operation: "create" | "run" | "destroy"): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new HostedSandboxError(`SANDBOX_${operation.toUpperCase()}_UNKNOWN` as HostedSandboxErrorCode, `Hosted sandbox ${operation} request outcome is unknown`);
    }
    let responseBody: unknown;
    try {
      responseBody = await readBody(response, controller);
    } catch {
      throw new HostedSandboxError(`SANDBOX_${operation.toUpperCase()}_UNKNOWN` as HostedSandboxErrorCode, `Hosted sandbox ${operation} request outcome is unknown`);
    }
    return { status: response.status, body: responseBody };
  } finally {
    clearTimeout(timer);
  }
}

function accessError(): HostedSandboxError {
  return new HostedSandboxError("SANDBOX_ACCESS_DENIED", "Hosted sandbox access was denied");
}

function setupError(code: "SANDBOX_PROVIDER_NOT_READY" | "SANDBOX_SETUP_UNAVAILABLE", setupUrl: string): HostedSandboxError {
  return new HostedSandboxError(code, code === "SANDBOX_PROVIDER_NOT_READY" ? "Sandbox provider is not ready" : "Sandbox setup is unavailable", setupUrl);
}

function validateRun(command: string, options: HostedSandboxRunOptions | undefined): { command: string; cwd?: string; env?: Record<string, string>; timeoutMs: number } {
  if (typeof command !== "string" || command.length > 64 * 1024 || command.includes("\0")) invalid("Hosted sandbox command is invalid");
  if (options !== undefined && (options === null || typeof options !== "object")) invalid("Hosted sandbox run options are invalid");
  const result: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs: number } = {
    command,
    timeoutMs: options?.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : validateBoundedInteger(options.timeoutMs, 1, 60_000, "Hosted sandbox timeoutMs is invalid"),
  };
  if (options?.cwd !== undefined) {
    if (typeof options.cwd !== "string" || options.cwd.length > 1024 || !options.cwd.startsWith("/") || options.cwd.includes("\0")) invalid("Hosted sandbox cwd is invalid");
    result.cwd = options.cwd;
  }
  if (options?.env !== undefined) {
    if (options.env === null || typeof options.env !== "object" || Array.isArray(options.env)) invalid("Hosted sandbox env is invalid");
    const entries = Object.entries(options.env);
    if (entries.length > 64) invalid("Hosted sandbox env is invalid");
    const env: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (!ENV_NAME.test(name) || typeof value !== "string" || value.length > 8192 || value.includes("\0")) invalid("Hosted sandbox env is invalid");
      env[name] = value;
    }
    result.env = env;
  }
  return result;
}

function parseRunResult(value: unknown): HostedSandboxRunResult {
  const record = safeObject(value);
  if (!record || typeof record.output !== "string" || (record.exitCode !== null && (typeof record.exitCode !== "number" || !Number.isSafeInteger(record.exitCode)))) {
    throw new HostedSandboxError("SANDBOX_RUN_UNKNOWN", "Hosted sandbox returned an invalid run result");
  }
  if (record.stdout !== undefined && typeof record.stdout !== "string") throw new HostedSandboxError("SANDBOX_RUN_UNKNOWN", "Hosted sandbox returned an invalid run result");
  if (record.stderr !== undefined && typeof record.stderr !== "string") throw new HostedSandboxError("SANDBOX_RUN_UNKNOWN", "Hosted sandbox returned an invalid run result");
  return {
    output: record.output,
    exitCode: record.exitCode as number | null,
    ...(record.stdout === undefined ? {} : { stdout: record.stdout }),
    ...(record.stderr === undefined ? {} : { stderr: record.stderr }),
  };
}

export async function createHostedSandbox(options: HostedSandboxOptions): Promise<HostedSandboxSession> {
  const config = validateConfig(options);
  const response = await request(config, "POST", endpoint(config), {
    appKey: config.appKey,
    environment: config.environment,
    providerId: config.providerId,
    intentKey: config.intentKey,
  }, "create");
  if (response.status === 401 || response.status === 403) throw accessError();
  const body = safeObject(response.body);
  if (response.status === 409 && body?.code === "SANDBOX_PROVIDER_NOT_READY") throw setupError("SANDBOX_PROVIDER_NOT_READY", config.setupUrl);
  if (response.status === 503 && body?.code === "SANDBOX_SETUP_UNAVAILABLE") throw setupError("SANDBOX_SETUP_UNAVAILABLE", config.setupUrl);
  if ((response.status !== 200 && response.status !== 201) || typeof body?.id !== "string" || !UUID.test(body.id)) {
    throw new HostedSandboxError("SANDBOX_CREATE_UNKNOWN", "Hosted sandbox creation outcome is unknown");
  }
  const id = body.id;
  let closing = false;
  let cleanup: Promise<void> | undefined;
  return {
    id,
    async run(command, runOptions) {
      if (closing) throw new Error("Hosted sandbox session is closing or destroyed");
      const run = validateRun(command, runOptions);
      const result = await request(config, "POST", sessionEndpoint(config, id, "/run"), run, "run");
      if (result.status === 401 || result.status === 403) throw accessError();
      if (result.status !== 200) throw new HostedSandboxError("SANDBOX_RUN_UNKNOWN", "Hosted sandbox run outcome is unknown");
      return parseRunResult(result.body);
    },
    destroy() {
      if (!cleanup) {
        closing = true;
        cleanup = Promise.resolve().then(async () => {
          const response = await request(config, "DELETE", sessionEndpoint(config, id), undefined, "destroy");
          if (response.status === 204) return;
          const body = safeObject(response.body);
          if (response.status !== 200 || body?.status !== "closed") throw new HostedSandboxError("SANDBOX_DESTROY_UNKNOWN", "Hosted sandbox cleanup outcome is unknown");
        }).catch((error: unknown) => {
          cleanup = undefined;
          if (error instanceof HostedSandboxError) throw error;
          throw new HostedSandboxError("SANDBOX_DESTROY_UNKNOWN", "Hosted sandbox cleanup outcome is unknown");
        });
      }
      return cleanup;
    },
  };
}

export async function withHostedSandbox<T>(options: HostedSandboxOptions, work: (session: HostedSandboxSession) => Promise<T>): Promise<T> {
  if (typeof work !== "function") invalid("Hosted sandbox work callback is invalid");
  const session = await createHostedSandbox(options);
  let result: T;
  try {
    result = await work(session);
  } catch (workError) {
    try {
      await session.destroy();
    } catch (cleanupError) {
      throw new AggregateError([workError, cleanupError], "Sandbox workload and cleanup both failed");
    }
    throw workError;
  }
  await session.destroy();
  return result;
}

export function getHostedSandboxSetupUrl(options: { readonly baseUrl: string; readonly workspaceId: string; readonly appKey?: string; readonly environment?: string }): string {
  if (options === null || typeof options !== "object") invalid("Hosted sandbox setup options are invalid");
  const baseUrl = validateBaseUrl(options.baseUrl);
  validateString(options.workspaceId, "Hosted sandbox workspaceId is invalid");
  if (!UUID.test(options.workspaceId)) invalid("Hosted sandbox workspaceId must be a UUID");
  const appKey = options.appKey ?? "sandbox";
  const environment = options.environment ?? "development";
  if (typeof appKey !== "string" || !LOWER_IDENTIFIER.test(appKey) || appKey.length > 128) invalid("Hosted sandbox appKey is invalid");
  if (typeof environment !== "string" || !LOWER_IDENTIFIER.test(environment) || environment.length > 64) invalid("Hosted sandbox environment is invalid");
  const root = baseUrl.pathname.replace(/\/+$/u, "");
  const url = new URL(baseUrl.toString());
  url.pathname = `${root}/dashboard/integrations`;
  url.search = new URLSearchParams({ workspaceId: options.workspaceId, appKey, environment }).toString();
  url.hash = "sandbox-providers";
  return url.toString();
}
