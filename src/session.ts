import type { SandboxRuntime } from "./port.js";
import type { ProviderReadinessPort } from "./setup/index.js";

export type SandboxSessionOptions = {
  readonly runtime: SandboxRuntime;
  readonly launch?: Parameters<SandboxRuntime["launch"]>[0];
  /** Optional trusted-backend readiness check for new allocation only. */
  readonly readiness?: { readonly providerId: string; readonly port: ProviderReadinessPort };
};

export interface SandboxSession {
  /** Provider-native identity. Durable mapping/recovery is caller-owned. */
  readonly id: string;
  run(command: string, options?: Omit<Parameters<SandboxRuntime["runScript"]>[1], "command">): ReturnType<SandboxRuntime["runScript"]>;
  /** Concurrent calls share cleanup; a failed cleanup may be retried. */
  destroy(): Promise<void>;
}

export class SandboxNotReadyError extends Error {
  readonly code = "SANDBOX_PROVIDER_NOT_READY";
  constructor() {
    super("Sandbox provider credentials are not ready; complete provider setup before creating a sandbox");
    this.name = "SandboxNotReadyError";
  }
}

/** A small create/run/destroy facade over one explicitly configured runtime. */
export async function createSandbox(options: SandboxSessionOptions): Promise<SandboxSession> {
  const { runtime, readiness } = options;
  if (readiness) {
    let available: unknown;
    try {
      available = await readiness.port.hasAvailableCredentials(readiness.providerId);
    } catch {
      throw new SandboxNotReadyError();
    }
    if (available !== true) throw new SandboxNotReadyError();
  }
  const handle = await runtime.launch(options.launch);
  let closing = false;
  let cleanup: Promise<void> | undefined;
  return {
    get id() { return handle.id; },
    async run(command, runOptions) {
      if (closing) throw new Error("Sandbox session is closing or destroyed");
      return runtime.runScript(handle, { ...runOptions, command });
    },
    destroy() {
      if (!cleanup) {
        closing = true;
        cleanup = Promise.resolve().then(() => runtime.destroy(handle)).catch((error: unknown) => {
          cleanup = undefined;
          // Keep command execution disabled after a failed destroy: the
          // provider may already have removed the sandbox. Only retry cleanup.
          throw error;
        });
      }
      return cleanup;
    },
  };
}

/**
 * Run a bounded workload and always attempt cleanup. Caller/provider deadlines
 * still apply; this does not recover a process killed before cleanup executes.
 */
export async function withSandbox<T>(
  options: SandboxSessionOptions,
  work: (sandbox: SandboxSession) => Promise<T>,
): Promise<T> {
  const sandbox = await createSandbox(options);
  let result: T;
  try {
    result = await work(sandbox);
  } catch (workError) {
    try {
      await sandbox.destroy();
    } catch (cleanupError) {
      throw new AggregateError([workError, cleanupError], "Sandbox workload and cleanup both failed");
    }
    throw workError;
  }
  await sandbox.destroy();
  return result;
}
