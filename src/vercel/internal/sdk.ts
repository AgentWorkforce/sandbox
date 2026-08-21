import { AsyncLocalStorage } from "node:async_hooks";
import type { Buffer } from "node:buffer";

import type { VercelCredentials } from "../config.js";

/**
 * The vendor SDK boundary.
 *
 * This is the only module in the package that imports `@vercel/sandbox`, and
 * the import is dynamic so the dependency stays genuinely optional. Everything
 * above this file talks to the structural `*Like` interfaces below, which is
 * what makes the adapter testable without the SDK and pinnable to one version.
 */

/** Session status as reported by the provider. */
export type VercelSandboxStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "aborted"
  | "snapshotting"
  | (string & {});

/** A row from `Sandbox.list`. */
export interface VercelSandboxListItem {
  name: string;
  status: VercelSandboxStatus;
  createdAt: number;
  updatedAt?: number;
  persistent?: boolean;
  region?: string;
  vcpus?: number;
  memory?: number;
  image?: string;
  runtime?: string;
  timeout?: number;
  tags?: Record<string, string>;
  expiresAt?: number;
  totalActiveCpuDurationMs?: number;
  totalDurationMs?: number;
  totalEgressBytes?: number;
  totalIngressBytes?: number;
}

export interface VercelSandboxListPage {
  sandboxes: VercelSandboxListItem[];
  pagination: { count: number; next: string | null };
}

export interface VercelListParams {
  namePrefix?: string;
  tags?: Record<string, string>;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface VercelCreateParams {
  name: string;
  tags?: Record<string, string>;
  env?: Record<string, string>;
  ports?: number[];
  timeout?: number;
  persistent?: boolean;
  resources?: { vcpus: number };
  image?: string;
  runtime?: string;
  signal?: AbortSignal;
}

export interface VercelRunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  detached?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A command in a sandbox.
 *
 * `exitCode` is `null` while a detached command is still running and after a
 * re-resolution that has not observed an exit yet. It is never a stand-in for
 * success.
 */
export interface VercelCommandLike {
  readonly cmdId: string;
  readonly exitCode: number | null;
  output(
    stream?: "stdout" | "stderr" | "both",
    opts?: { signal?: AbortSignal },
  ): Promise<string>;
}

export interface VercelSessionLike {
  readonly sessionId: string;
}

export interface VercelSandboxLike {
  readonly name: string;
  readonly status: VercelSandboxStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly vcpus?: number;
  readonly memory?: number;
  readonly timeout?: number;
  readonly tags?: Record<string, string>;
  readonly expiresAt?: Date;
  readonly totalActiveCpuDurationMs?: number;
  readonly totalDurationMs?: number;
  currentSession(): VercelSessionLike;
  runCommand(params: VercelRunCommandParams): Promise<VercelCommandLike>;
  getCommand(
    cmdId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<VercelCommandLike>;
  writeFiles(
    files: Array<{ path: string; content: string | Uint8Array; mode?: number }>,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  readFileToBuffer(
    file: { path: string; cwd?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<Buffer | null>;
  mkDir(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
  delete(opts?: { signal?: AbortSignal }): Promise<void>;
}

/** The provider surface this adapter depends on, and nothing more. */
export interface VercelSandboxApiLike {
  create(params: VercelCreateParams): Promise<VercelSandboxLike>;
  get(params: {
    name: string;
    resume?: boolean;
    signal?: AbortSignal;
  }): Promise<VercelSandboxLike>;
  list(params: VercelListParams): Promise<VercelSandboxListPage>;
}

export type VercelSandboxApiFactory = () =>
  | Promise<VercelSandboxApiLike>
  | VercelSandboxApiLike;

/**
 * True when the provider reports the named sandbox as absent.
 *
 * Delete verification and reattach both need to tell "gone" apart from "the
 * lookup failed", and treating a transport error as absence is how a leaked
 * sandbox gets reported as cleaned up.
 */
export function isVercelNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const status = (error as { response?: { status?: unknown } }).response?.status;
  if (status === 404) {
    return true;
  }
  const code = (error as { json?: { error?: { code?: unknown } } }).json?.error
    ?.code;
  return code === "not_found" || code === "sandbox_not_found";
}

/**
 * Absolute deadline for one logical operation, including SDK-internal retries.
 *
 * The vendor SDK retries some failures itself. A per-attempt timeout therefore
 * bounds nothing: N retries multiply it. This store carries a single signal for
 * the whole operation, and the fetch wrapper below joins it onto every request
 * the SDK makes inside that operation — retries included.
 *
 * `AsyncLocalStorage` rather than a mutable field because operations on one
 * runtime run concurrently, and a shared cell would let a short lookup abort a
 * long exec that happened to overlap it.
 */
const operationDeadline = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` with an absolute deadline applied to every request it triggers. */
export function withRequestDeadline<T>(
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  return operationDeadline.run(AbortSignal.timeout(timeoutMs), fn);
}

/** The deadline signal in force, if any. Exported for the adapter's callers. */
export function currentRequestDeadlineSignal(): AbortSignal | undefined {
  return operationDeadline.getStore();
}

/**
 * Wrap `fetch` so every request also observes the ambient operation deadline.
 *
 * `AbortSignal.any` keeps the caller's own per-request signal intact instead of
 * replacing it, so an explicit cancellation and a deadline expiry both work.
 */
export function deadlineBoundFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const deadline = operationDeadline.getStore();
    if (!deadline) {
      return baseFetch(input, init);
    }
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline])
      : deadline;
    return baseFetch(input, { ...init, signal });
  };
}

/**
 * The official client, bound to injected credentials and the deadline-aware
 * fetch.
 *
 * Credentials are passed explicitly on every static call rather than left to
 * the SDK's ambient resolution, which would otherwise fall back to the
 * operator's environment or an on-disk OAuth token.
 *
 * Note what this function does *not* do: cast. Each vendor result is assigned
 * **through** the structural type above, so if the SDK changes a signature the
 * build breaks here, in the one file that owns the boundary. An
 * `as unknown as` would accept the drift silently and surface it later as a
 * runtime failure against a live sandbox.
 */
export async function createOfficialVercelSandboxApi(
  credentials: VercelCredentials,
): Promise<VercelSandboxApiLike> {
  const { Sandbox } = await import("@vercel/sandbox");
  const fetch = deadlineBoundFetch();
  const auth = {
    token: credentials.token,
    teamId: credentials.teamId,
    projectId: credentials.projectId,
  };
  return {
    create: async (params) => {
      const { image, runtime, ...rest } = params;
      // `image` and `runtime` are mutually exclusive upstream, so the call is
      // narrowed to one branch instead of handing over an object that claims
      // both are possible.
      const created = runtime
        ? await Sandbox.create({ ...rest, runtime, ...auth, fetch })
        : await Sandbox.create({
            ...rest,
            ...(image ? { image } : {}),
            ...auth,
            fetch,
          });
      const checked: VercelSandboxLike = created;
      return checked;
    },
    get: async (params) => {
      const checked: VercelSandboxLike = await Sandbox.get({
        ...params,
        ...auth,
        fetch,
      });
      return checked;
    },
    list: async (params) => {
      const checked: VercelSandboxListPage = await Sandbox.list({
        ...params,
        ...auth,
        fetch,
      });
      return checked;
    },
  };
}
