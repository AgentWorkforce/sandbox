import type { FreestyleRuntimeOptions } from "../config.js";

export type FreestyleVmState =
  | "building"
  | "starting"
  | "running"
  | "stopping"
  | "suspending"
  | "suspended"
  | "stopped"
  | "lost"
  | string;

export interface FreestyleVmListItem {
  id: string;
  name?: string | null;
  state: FreestyleVmState;
  deleted?: boolean | null;
  createdAt?: string | null;
  lastNetworkActivity?: string | null;
  sizing?: {
    vcpuCount?: number;
    memSizeMib?: number;
    rootfsSizeMb?: number;
  } | null;
}

export interface FreestyleVmLike {
  readonly vmId?: string;
  start(options?: { idleTimeoutSeconds?: number | null }): Promise<unknown>;
  stop(): Promise<unknown>;
  exec(options: string | {
    command: string;
    terminal?: string;
    timeoutMs?: number;
  }): Promise<{
    stdout?: string | null;
    stderr?: string | null;
    statusCode?: number | null;
  }>;
  fs: {
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, content: Buffer): Promise<void>;
    readTextFile(path: string): Promise<string>;
    writeTextFile(path: string, content: string): Promise<void>;
  };
}

export interface FreestyleClientLike {
  readonly vms: {
    create(options?: {
      snapshotId?: string | null;
      name?: string | null;
      idleTimeoutSeconds?: number | null;
      persistence?: FreestyleRuntimeOptions["persistence"];
    }): Promise<{ vm: FreestyleVmLike; vmId: string; domains?: string[] }>;
    list(): Promise<{ vms: FreestyleVmListItem[] }>;
    ref(options: { vmId: string }): FreestyleVmLike;
    get?(options: { vmId: string }): Promise<{ vm: FreestyleVmLike }>;
    delete(options: { vmId: string }): Promise<unknown>;
  };
}

export type FreestyleClientFactory = (
  requestTimeoutMs: number,
) => Promise<FreestyleClientLike> | FreestyleClientLike;

/** The only module that imports the vendor SDK. */
export async function createOfficialFreestyleClient(
  options: Pick<FreestyleRuntimeOptions, "apiKey" | "baseUrl">,
  requestTimeoutMs: number,
): Promise<FreestyleClientLike> {
  const { Freestyle } = await import("freestyle");
  // Keep one absolute signal for the lifetime of this short-lived client. The
  // official SDK retries some failures internally; creating a fresh timeout in
  // every retry would silently reset the caller's deadline.
  const deadlineSignal = AbortSignal.timeout(requestTimeoutMs);
  return new Freestyle({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    fetch: (url, init) => globalThis.fetch(url, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, deadlineSignal])
        : deadlineSignal,
    }),
  }) as unknown as FreestyleClientLike;
}
