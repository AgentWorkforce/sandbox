/**
 * Minimal HTTP client for the Agent37 Cloud API.
 *
 * There is no official Agent37 JavaScript SDK to depend on: the only published
 * npm package (`agent37`) is a command-line interface that exposes a `bin`, no
 * library entry point, and no runtime dependencies. So this adapter speaks the
 * documented HTTP contract directly over `fetch`, and takes an injectable
 * `fetch` seam instead of a peer dependency. That is deliberate — an optional
 * peer dependency pointing at a CLI would be a dependency on something that
 * cannot be imported.
 *
 * Agent37 exposes two planes that share one credential but not one header:
 *
 *  - the **hosting plane** (`{baseUrl}/v1/instances/...`), authenticated with
 *    `Authorization: Bearer <key>`, which creates, lists, execs, and tears down
 *    instances; and
 *  - the **instance plane** (the `url` an instance object reports),
 *    authenticated with `X-Agent37-Key: <key>`, which serves that one
 *    instance's filesystem.
 *
 * The instance plane's origin is never constructed here. It is read off the
 * instance object, so no provider hostname is baked into this package.
 */

/** Response shape this client needs. Structurally satisfied by global `Response`. */
export type Agent37FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** Request shape this client sends. Structurally satisfied by global `RequestInit`. */
export type Agent37FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
};

/** Injection seam for the transport. Global `fetch` is assignable to this. */
export type Agent37Fetch = (
  url: string,
  init?: Agent37FetchInit,
) => Promise<Agent37FetchResponse>;

/**
 * A non-2xx response from either Agent37 plane.
 *
 * `code` is the machine-readable identifier the API documents callers should
 * branch on — never the message text, and never the HTTP status alone, because
 * one status carries several codes (409 is both `try_again` and
 * `instance_limit_reached`).
 */
export class Agent37ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Method and path only. Never the query string, body, or any header. */
  readonly request: string;
  readonly retryable: boolean;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    request: string;
    retryable: boolean;
  }) {
    super(`Agent37 ${options.request} failed: ${options.status} ${options.code}: ${options.message}`);
    this.name = "Agent37ApiError";
    this.status = options.status;
    this.code = options.code;
    this.request = options.request;
    this.retryable = options.retryable;
  }
}

/**
 * Codes the API documents as safe to retry with backoff.
 *
 * Everything absent from this set is retried never, not "retried cautiously".
 * Two exclusions are load-bearing rather than conservative:
 *
 *  - `provisioning_failed` (502) is also what a synchronous `exec` returns when
 *    it passes the provider's 280-second command cap. Retrying it would run the
 *    caller's command a second time, on an instance where the first copy is
 *    still running.
 *  - `container_unavailable` (502) means the instance is stopped. Retrying
 *    cannot change that; `start` can.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  // hosting plane
  "no_capacity",
  "try_again",
  // transport plane
  "container_unreachable",
  "upstream_unreachable",
  "host_mesh_not_ready",
  "instance_saturated",
  "wake_timeout",
  "upstream_timeout",
  // agent plane
  "rate_limited",
]);

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

export type Agent37ClientOptions = {
  /**
   * An `sk_live_` workspace key. Required, and never read from the environment
   * by this package: credential sourcing belongs to the caller.
   */
  apiKey: string;
  /**
   * Origin of the Agent37 hosting API, without a trailing slash — for example
   * the provider's public control plane, or a proxy in front of it. Required:
   * this package ships no endpoint defaults.
   */
  baseUrl: string;
  /** Transport seam. Defaults to the global `fetch`. */
  fetch?: Agent37Fetch;
  /** Total attempts for a retryable failure, including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff step; doubles per attempt. Default 250ms. */
  retryBaseDelayMs?: number;
  /** Sleep seam, so retry backoff is deterministic under test. */
  sleep?: (ms: number) => Promise<void>;
};

type SendOptions = {
  method: string;
  /** Absolute origin to send to: the hosting base, or an instance's own URL. */
  origin: string;
  path: string;
  query?: Record<string, string | undefined>;
  headerStyle: "bearer" | "instance-key";
  body?: string | Uint8Array;
  contentType?: string;
  timeoutMs?: number;
  /** Extra non-credential headers, e.g. `X-Expected-Mtime`. */
  headers?: Record<string, string>;
};

export class Agent37Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: Agent37Fetch;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: Agent37ClientOptions) {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Agent37Client requires a non-empty apiKey");
    }
    const baseUrl = options.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error(
        "Agent37Client requires an explicit baseUrl: this package ships no endpoint defaults",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as Agent37Fetch);
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Agent37Client requires a fetch implementation (none found on globalThis)");
    }
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** JSON call against the hosting plane (`Authorization: Bearer`). */
  async hosting<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | undefined>;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const response = await this.send({
      method,
      origin: this.baseUrl,
      path,
      ...(options.query ? { query: options.query } : {}),
      headerStyle: "bearer",
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body), contentType: "application/json" }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return (await readJson(response)) as T;
  }

  /** JSON call against one instance's own plane (`X-Agent37-Key`). */
  async instance<T>(
    instanceUrl: string,
    method: string,
    path: string,
    options: {
      body?: string | Uint8Array;
      contentType?: string;
      query?: Record<string, string | undefined>;
      timeoutMs?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const response = await this.send({
      method,
      origin: stripTrailingSlash(instanceUrl),
      path,
      ...(options.query ? { query: options.query } : {}),
      headerStyle: "instance-key",
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    return (await readJson(response)) as T;
  }

  /** Byte-stream call against one instance's own plane, for file downloads. */
  async instanceBytes(
    instanceUrl: string,
    method: string,
    path: string,
    options: { query?: Record<string, string | undefined>; timeoutMs?: number } = {},
  ): Promise<Uint8Array> {
    const response = await this.send({
      method,
      origin: stripTrailingSlash(instanceUrl),
      path,
      ...(options.query ? { query: options.query } : {}),
      headerStyle: "instance-key",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  // --- internals ----------------------------------------------------------

  private async send(options: SendOptions): Promise<Agent37FetchResponse> {
    // `request` is what surfaces in errors: method and path, never the query
    // string (it carries filesystem paths) and never a header (it carries the
    // credential).
    const request = `${options.method} ${options.path}`;
    const url = buildUrl(options.origin, options.path, options.query);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      // A thrown transport failure is NOT retried. The outcome of a POST that
      // never returned is unknown, and re-sending it is how one submitted
      // command becomes two. Only a *classified* response is retried, because
      // only then is it known that the server rejected rather than accepted.
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers: this.buildHeaders(options),
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.timeoutMs === undefined || options.timeoutMs <= 0
          ? {}
          : { signal: AbortSignal.timeout(options.timeoutMs) }),
      });
      if (response.ok) {
        return response;
      }
      const error = await toApiError(response, request);
      if (!error.retryable || attempt >= this.maxAttempts) {
        throw error;
      }
      await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }

  private buildHeaders(options: SendOptions): Record<string, string> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.headerStyle === "bearer") {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else {
      headers["X-Agent37-Key"] = this.apiKey;
    }
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }
    return headers;
  }
}

// --- helpers --------------------------------------------------------------

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildUrl(
  origin: string,
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      params.append(key, value);
    }
  }
  const search = params.toString();
  return `${origin}${path}${search ? `?${search}` : ""}`;
}

async function readJson(response: Agent37FetchResponse): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Normalize the three documented error envelopes into one error.
 *
 *  - hosting/agent plane: `{ "error": { "code", "message", ... } }`
 *  - transport plane:     `{ "error": "flat_string_code" }`
 *  - neither (HTML from a proxy, empty body): synthesize `http_<status>`, which
 *    is never in the retryable set, so an unparseable failure fails fast.
 */
async function toApiError(
  response: Agent37FetchResponse,
  request: string,
): Promise<Agent37ApiError> {
  let code = `http_${response.status}`;
  let message = "";
  try {
    const parsed = JSON.parse(await response.text()) as { error?: unknown };
    const raw = parsed.error;
    if (typeof raw === "string" && raw) {
      code = raw;
    } else if (raw && typeof raw === "object") {
      const shaped = raw as { code?: unknown; message?: unknown };
      if (typeof shaped.code === "string" && shaped.code) {
        code = shaped.code;
      }
      if (typeof shaped.message === "string") {
        message = shaped.message;
      }
    }
  } catch {
    // Leave the synthesized code in place.
  }
  return new Agent37ApiError({
    status: response.status,
    code,
    message,
    request,
    retryable: RETRYABLE_CODES.has(code),
  });
}

/** Exported for tests and for callers that want to mirror the retry policy. */
export function isRetryableAgent37Code(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}
