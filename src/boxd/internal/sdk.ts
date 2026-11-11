import type { BoxdRuntimeOptions } from "../config.js";

export type BoxdMachineStatus =
  | "pending"
  | "starting"
  | "running"
  | "suspended"
  | "hibernated"
  | "stopped"
  | "failed"
  | "destroyed"
  | "migrating"
  | string;

/** The machine fields this adapter reads. */
export interface BoxdMachineLike {
  id: string;
  name: string;
  status: BoxdMachineStatus;
  createdAt?: Date | null;
  labels?: Record<string, string> | null;
}

export interface BoxdExecResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BoxdCreateParams {
  name: string;
  org?: string;
  region?: string;
  isolated: boolean;
  labels: Record<string, string>;
  env?: Record<string, string>;
  fromSnapshot?: string;
  deleteAfter?: number;
  config: {
    vcpu?: number;
    memory?: string;
    autoSuspendTimeout?: number;
  };
}

/** The subset of `@boxd-sh/sdk`'s `Boxd` client this adapter calls. */
export interface BoxdClientLike {
  readonly machines: {
    create(params: BoxdCreateParams): Promise<BoxdMachineLike>;
    get(id: string): Promise<BoxdMachineLike>;
    list(params: {
      org?: string;
      labels?: Record<string, string>;
    }): Promise<BoxdMachineLike[]>;
    delete(id: string): Promise<void>;
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    setAutoHibernateTimeout(id: string, seconds: number): Promise<void>;
    waitUntilReady(
      id: string,
      params?: { timeout?: number; pollInterval?: number },
    ): Promise<BoxdMachineLike>;
    exec(id: string, params: {
      command: string[];
      env?: Record<string, string>;
      cwd?: string;
      timeout?: number;
    }): Promise<BoxdExecResultLike>;
    readonly fs: {
      read(id: string, path: string): Promise<Uint8Array>;
      write(id: string, path: string, data: Uint8Array): Promise<unknown>;
    };
  };
  close?(): Promise<void>;
}

export type BoxdClientFactory = () => Promise<BoxdClientLike> | BoxdClientLike;

/**
 * The only module that imports the vendor SDK. `requestTimeoutMs` is the
 * SDK's per-request deadline, so it must cover the slowest unary call the
 * adapter makes (create).
 */
export async function createOfficialBoxdClient(
  options: Pick<BoxdRuntimeOptions, "apiKey" | "baseUrl" | "region">,
  requestTimeoutMs: number,
): Promise<BoxdClientLike> {
  const { Boxd } = await import("@boxd-sh/sdk");
  return new Boxd({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.region ? { region: options.region } : {}),
    timeout: requestTimeoutMs,
  }) as unknown as BoxdClientLike;
}

/**
 * Error classification by the SDK's stable error names, so callers of this
 * module never need the vendor classes in scope.
 */
export function isBoxdNotFoundError(error: unknown): boolean {
  return errorName(error) === "NotFoundError";
}

export function isBoxdConflictError(error: unknown): boolean {
  return errorName(error) === "ConflictError";
}

/**
 * Errors after which a create may still have made the machine: no answer,
 * a cut connection or a server error. Validation, auth and conflict errors
 * mean nothing was made.
 */
export function isBoxdCreateOutcomeUnknown(error: unknown): boolean {
  const name = errorName(error);
  return name === "APIConnectionError" || name === "APIStatusError" || name === "BoxdError";
}

export function isBoxdFileNotFoundError(error: unknown): boolean {
  return errorName(error) === "MachineFileNotFoundError";
}

function errorName(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : undefined;
}
