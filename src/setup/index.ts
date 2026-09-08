/**
 * Provider account setup for trusted backends. This entrypoint imports no
 * provider SDK, routing library, account API, credential store or HTTP client.
 */
export interface ProviderReadinessPort {
  /** A tenant/environment-scoped read. Never initiates account setup. */
  hasAvailableCredentials(providerId: string): Promise<boolean>;
}

export type ProviderSetupStatus =
  | { readonly status: "ready" }
  | { readonly status: "warming"; readonly retryAfterMs: number }
  | { readonly status: "approval-required" }
  | { readonly status: "action-required" }
  | { readonly status: "review-required" }
  | { readonly status: "unavailable" };

export interface ProviderSetupBackend {
  /**
   * Explicit setup intent. The backend owns authorization, durable idempotency,
   * approval collection/revalidation and account operations. Calling this
   * method is not itself user approval. Bind one backend to one tenant and
   * environment; do not accept caller-supplied tenant identity here.
   */
  prewarm(providerId: string, options: { readonly idempotencyKey: string }): Promise<ProviderSetupStatus>;
  /** Read materialized readiness; ready means a usable credential binding. */
  status(providerId: string): Promise<ProviderSetupStatus>;
}

export class ProviderSetupError extends Error {
  readonly code = "PROVIDER_SETUP_UNAVAILABLE";
  constructor() {
    super("Provider setup is unavailable");
    this.name = "ProviderSetupError";
  }
}

function validateIdentifier(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new TypeError("Expected a non-empty provider or idempotency identifier of at most 128 characters");
  }
}

function safeStatus(value: unknown): ProviderSetupStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProviderSetupError();
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  const status = record.status;
  if (status === "warming") {
    const retryAfterMs = record.retryAfterMs;
    if (keys.length !== 2 || !keys.includes("status") || !keys.includes("retryAfterMs")
      || typeof retryAfterMs !== "number" || !Number.isSafeInteger(retryAfterMs)
      || retryAfterMs < 1 || retryAfterMs > 60_000) throw new ProviderSetupError();
    return { status: "warming", retryAfterMs };
  }
  if (keys.length !== 1 || keys[0] !== "status") throw new ProviderSetupError();
  switch (status) {
    case "ready": return { status: "ready" };
    case "approval-required": return { status: "approval-required" };
    case "action-required": return { status: "action-required" };
    case "review-required": return { status: "review-required" };
    case "unavailable": return { status: "unavailable" };
    default: throw new ProviderSetupError();
  }
}

export interface ProviderSetup extends ProviderReadinessPort {
  prewarm(providerId: string, options: { readonly idempotencyKey: string }): Promise<ProviderSetupStatus>;
  status(providerId: string): Promise<ProviderSetupStatus>;
}

/**
 * Adapts an authenticated, scoped backend to the public setup contract and the
 * router's boolean readiness port. There are no automatic retries or polling;
 * callers schedule later status reads. Backend errors and extra response fields
 * are rejected without returning raw account/credential metadata.
 */
export function createProviderSetup(backend: ProviderSetupBackend): ProviderSetup {
  async function status(providerId: string): Promise<ProviderSetupStatus> {
    validateIdentifier(providerId);
    try {
      return safeStatus(await backend.status(providerId));
    } catch {
      throw new ProviderSetupError();
    }
  }
  return {
    async prewarm(providerId, options) {
      validateIdentifier(providerId);
      const idempotencyKey = options?.idempotencyKey;
      validateIdentifier(idempotencyKey);
      try {
        return safeStatus(await backend.prewarm(providerId, { idempotencyKey }));
      } catch {
        throw new ProviderSetupError();
      }
    },
    status,
    async hasAvailableCredentials(providerId) {
      return (await status(providerId)).status === "ready";
    },
  };
}
