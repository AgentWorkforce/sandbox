import type { Buffer } from "node:buffer";

import type { RuntimeHandle } from "./types.js";

export type RunScriptResult = {
  output: string;
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
  cmdId?: string;
};

export type AsyncRunStartResult = {
  sessionId: string;
  commandId: string;
};

export type AsyncRunStatus = {
  exitCode: number | null;
};

export type SandboxLookupOptions = {
  states?: readonly string[] | null;
  limit?: number;
  pageSize?: number;
  owned?: boolean;
  excludeIds?: readonly string[];
  timeoutMs?: number;
};

export type SandboxCountOptions = {
  states?: readonly string[] | null;
  limit?: number;
  pageSize?: number;
  maxCount?: number;
  timeoutMs?: number;
};

export type SandboxRuntime = {
  readonly id: string;
  findByLabels(
    labels: Record<string, string>,
    options?: SandboxLookupOptions,
  ): Promise<RuntimeHandle | null>;
  findAllByLabels(
    labels: Record<string, string>,
    options?: SandboxLookupOptions,
  ): Promise<RuntimeHandle[]>;
  countByLabels(
    labels: Record<string, string>,
    options?: SandboxCountOptions,
  ): Promise<number>;
  launch(options?: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  }): Promise<RuntimeHandle>;
  launchDetached?(options?: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  }): Promise<RuntimeHandle>;
  getById?(
    id: string,
    options?: { states?: readonly string[] | null; owned?: boolean },
  ): Promise<RuntimeHandle | null>;
  uploadBundle(handle: RuntimeHandle, options: {
    files: Array<{ source: string | Buffer; destination: string }>;
  }): Promise<void>;
  runScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<RunScriptResult>;
  startScript?(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    suppressInputEcho?: boolean;
  }): Promise<AsyncRunStartResult>;
  getScriptStatus?(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<AsyncRunStatus>;
  getScriptLogs?(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult>;
  start?(handle: RuntimeHandle): Promise<RuntimeHandle>;
  stop?(handle: RuntimeHandle): Promise<void>;
  destroy(handle: RuntimeHandle): Promise<void>;
  /**
   * Capabilities a provider must declare because method presence cannot
   * express them. Omitted fields default to `true`, so a runtime that declares
   * nothing behaves exactly as it did before the descriptor existed.
   */
  readonly declaredCapabilities?: Partial<DeclaredSandboxRuntimeCapabilities>;
};

/**
 * What a caller is allowed to do with a given provider, computed once from the
 * runtime instead of re-probed at each call site.
 *
 * NOTE: this is the *outer orchestration* plane. It is deliberately NOT the
 * narrow `RuntimeCapabilities` in `./types.ts`, which belongs to the live
 * in-sandbox bootstrap plane and must not be conflated with it. The two are
 * kept under distinct names on purpose.
 */
export type SandboxRuntimeCapabilities = {
  /**
   * Async submit + poll, as one all-or-nothing capability. Splitting it is what
   * let a provider submit a run it could never poll — see the resolver.
   */
  readonly asyncExec: boolean;
  /** Can re-resolve a sandbox by id (lease reattach, crash recovery). */
  readonly reattach: boolean;
  /** Can hand a mid-boot sandbox back so a 30s Worker can yield. */
  readonly detachedLaunch: boolean;
  /** Server-side label search is real, so warm-lease lookup is meaningful. */
  readonly warmLease: boolean;
  /** `start`/`stop` actually change sandbox state rather than no-opping. */
  readonly lifecycle: boolean;
};

/**
 * The subset providers declare. Both are invisible to method presence:
 * `findAllByLabels` and `start`/`stop` are always *present*; whether they do
 * anything is provider knowledge.
 */
export type DeclaredSandboxRuntimeCapabilities = Pick<
  SandboxRuntimeCapabilities,
  "warmLease" | "lifecycle"
>;

const capabilitiesByRuntime = new WeakMap<
  SandboxRuntime,
  SandboxRuntimeCapabilities
>();

/**
 * Resolve (and memoize) a runtime's capability descriptor.
 *
 * Hybrid by necessity: `asyncExec` / `reattach` / `detachedLaunch` are honestly
 * derivable from method presence, but `warmLease` and `lifecycle` are not —
 * every provider ships `findAllByLabels` (E2B and local return `[]` both for
 * "no server-side label search" and for "no matches", an ambiguity presence
 * cannot resolve) and every provider ships `start`/`stop` (present-but-no-op on
 * local and E2B). Those two are provider-declared, defaulting to `true` so an
 * undeclared runtime keeps today's behavior exactly.
 */
export function resolveSandboxRuntimeCapabilities(
  runtime: SandboxRuntime,
): SandboxRuntimeCapabilities {
  const cached = capabilitiesByRuntime.get(runtime);
  if (cached) {
    return cached;
  }
  const declared = runtime.declaredCapabilities ?? {};
  // All-or-nothing: a runtime that can submit but cannot poll would strand a
  // live command inside the sandbox with no way to ever observe or reap it.
  const asyncExec = typeof runtime.startScript === "function"
    && typeof runtime.getById === "function"
    && typeof runtime.getScriptStatus === "function"
    && typeof runtime.getScriptLogs === "function";
  const resolved: SandboxRuntimeCapabilities = {
    asyncExec,
    reattach: typeof runtime.getById === "function",
    detachedLaunch: typeof runtime.launchDetached === "function",
    warmLease: declared.warmLease ?? true,
    lifecycle: declared.lifecycle ?? true,
  };
  capabilitiesByRuntime.set(runtime, resolved);
  return resolved;
}
