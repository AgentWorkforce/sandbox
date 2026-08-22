import type { Buffer } from "node:buffer";

import type { RuntimeHandle } from "./types.js";

export type RunScriptResult = {
  output: string;
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
  cmdId?: string;
  /**
   * True when the provider capped captured output and `output` is therefore
   * incomplete. Optional and additive: a provider that either never truncates
   * or cannot tell simply omits it, and `undefined` means "not reported",
   * never "complete". Mirrors `ExecResult.truncated` deliberately: an adapter
   * that bounds a log read should report the bound on both planes or on
   * neither, because a caller that moves between them would otherwise see the
   * same shortened log described two different ways.
   */
  truncated?: boolean;
};

export type AsyncRunStartResult = {
  sessionId: string;
  commandId: string;
  /**
   * True when a submit whose outcome was unknown resolved to the run that was
   * already admitted for this exact session and command, rather than starting
   * a second one.
   */
  reconciled?: true;
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

/**
 * How a capability is provided, for the cases where a boolean cannot say it.
 *
 * A boolean forces every provider to answer a question it may not be able to
 * answer. `streamingLogs: false` conflates three genuinely different things —
 * the provider cannot stream, the provider can but this adapter does not expose
 * it, and nobody has checked — and a caller choosing a provider needs to tell
 * them apart.
 *
 * Shape adopted from the `CapabilityMode` union in opencoredev/sandbox-sdk
 * (see `chief/.briefs/sandbox-sdk-eval-2026-08-21.md`); the members below, and
 * the absence vocabulary, are this package's own.
 */

/**
 * Why a capability is unavailable, when it is.
 *
 * The distinction that matters is **which of these a live probe can change**.
 * Only `"unknown"` is pending evidence. `"not-exposed"` is a fact about this
 * package and moves only when someone adds an operation to the port;
 * `"unsupported"` is a fact about the provider and never moves at all.
 *
 * Collapsing them is how a capability gets promoted on nothing: a later canary
 * sees `false`, reads it as "unverified", proves the provider can do the thing,
 * and flips a cell that was never about the provider's ability in the first
 * place. Adapters currently avoid that with prose and hand-maintained
 * "structurally false" lists; this is that knowledge in the type.
 */
export type CapabilityAbsence =
  /** Not established. A live probe can change this, and only this. */
  | "unknown"
  /** The provider has it; this package's ports do not reach it. */
  | "not-exposed"
  /** The provider cannot do it. Settled — no probe will ever change it. */
  | "unsupported";

/** How command output is surfaced. */
export type OutputStreamMode =
  | CapabilityAbsence
  /** Buffered and returned once the command completes. */
  | "buffered"
  /** Streamed live, stdout and stderr interleaved into one channel. */
  | "combined-stream"
  /** Streamed live, stdout and stderr separable by the caller. */
  | "separate-streams";

/** How long anything written to the sandbox filesystem survives. */
export type FilesystemMode =
  | CapabilityAbsence
  /** Lost when the sandbox stops. */
  | "ephemeral"
  /** Held in memory only; lost on any restart. */
  | "memory"
  /** Restored across stop/start of the same sandbox. */
  | "persistent";

/**
 * How a sandbox reaches the end of its life.
 *
 * Note that `"deadline"` is itself a settled statement: a provider that always
 * terminates at a deadline cannot offer a never-idle tier, so declaring it says
 * so without needing `"unsupported"`.
 */
export type LifetimeMode =
  | CapabilityAbsence
  /** The provider terminates it at a deadline that always exists. */
  | "deadline"
  /** Terminated after a period of inactivity. */
  | "idle-timeout"
  /** Runs until explicitly stopped. */
  | "never-idle";

/** Whether an interactive terminal is reachable through this package. */
export type InteractiveMode = CapabilityAbsence | "pty";

/** Whether sandbox state can be captured and restored through this package. */
export type SnapshotMode =
  | CapabilityAbsence
  /** Capture and restore. */
  | "snapshot"
  /** Capture, restore, and fork a running sandbox. */
  | "snapshot-and-fork";

/**
 * Modes a provider may declare. Every field is optional, and an absent field
 * resolves to `"unknown"` — so an existing runtime that declares nothing keeps
 * exactly today's behavior and makes no new claim.
 */
export type SandboxCapabilityModes = {
  readonly outputStreams: OutputStreamMode;
  readonly filesystem: FilesystemMode;
  readonly lifetime: LifetimeMode;
  readonly interactive: InteractiveMode;
  readonly snapshots: SnapshotMode;
};

/**
 * True when a mode is still pending evidence, i.e. a live probe could change
 * it.
 *
 * This is the guard a promotion path should consult. `"not-exposed"` and
 * `"unsupported"` are not weaker forms of `"unknown"` — proving the provider
 * can do the thing is not grounds for promoting either of them.
 */
export function isPendingEvidence(
  mode: CapabilityAbsence | (string & {}),
): boolean {
  return mode === "unknown";
}

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
  /**
   * Structured modes for the capabilities a boolean cannot express. Additive
   * and entirely optional: omitted fields resolve to `"unknown"`.
   */
  readonly declaredCapabilityModes?: Partial<SandboxCapabilityModes>;
};

/**
 * What a caller is allowed to do with a given provider, computed once from the
 * runtime instead of re-probed at each call site.
 *
 * NOTE: this is the *outer orchestration* plane. It is deliberately NOT the
 * narrow `RuntimeCapabilities` in `./types.ts`, which belongs to the live
 * in-sandbox bootstrap plane and must not be conflated with it. The two are
 * kept under distinct names on purpose.
 *
 * `modes` is optional on this shape so a TypeScript consumer can still
 * literal-construct a fixture with the five booleans. The resolver returns the
 * stricter `ResolvedSandboxRuntimeCapabilities` where `modes` is required and
 * always populated (defaulting to `"unknown"` rather than to a claim).
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
  /**
   * Structured detail for the capabilities a boolean flattens. Optional on the
   * base shape for source-compat with pre-modes fixtures; always populated on
   * the resolver's return type (`ResolvedSandboxRuntimeCapabilities`).
   */
  readonly modes?: SandboxCapabilityModes;
};

/**
 * The descriptor `resolveSandboxRuntimeCapabilities` returns. `modes` is
 * required here — the resolver always populates it, defaulting to `"unknown"`
 * so a runtime that declares nothing makes no new claim while still producing
 * a fully-shaped resolved descriptor.
 *
 * Kept distinct from `SandboxRuntimeCapabilities` so external consumers that
 * literal-construct fixtures with only the pre-modes fields continue to
 * compile; those fixtures satisfy `SandboxRuntimeCapabilities`, and only code
 * reading a resolver output relies on `modes` being present.
 */
export type ResolvedSandboxRuntimeCapabilities = SandboxRuntimeCapabilities & {
  readonly modes: SandboxCapabilityModes;
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
  ResolvedSandboxRuntimeCapabilities
>();

/**
 * Resolve (and memoize) a runtime's capability descriptor.
 *
 * Hybrid by necessity: `asyncExec` / `reattach` / `detachedLaunch` are honestly
 * derivable from method presence, but `warmLease` and `lifecycle` are not —
 * a provider can expose `findAllByLabels` while degrading unsupported search
 * to `[]`, and can expose `start`/`stop` as compatibility no-ops. Method
 * presence cannot distinguish either case. Those two are provider-declared,
 * defaulting to `true` so an undeclared runtime keeps today's behavior exactly.
 */
export function resolveSandboxRuntimeCapabilities(
  runtime: SandboxRuntime,
): ResolvedSandboxRuntimeCapabilities {
  const cached = capabilitiesByRuntime.get(runtime);
  if (cached) {
    return cached;
  }
  const declared = runtime.declaredCapabilities ?? {};
  const declaredModes = runtime.declaredCapabilityModes ?? {};
  // All-or-nothing: a runtime that can submit but cannot poll would strand a
  // live command inside the sandbox with no way to ever observe or reap it.
  const asyncExec = typeof runtime.startScript === "function"
    && typeof runtime.getById === "function"
    && typeof runtime.getScriptStatus === "function"
    && typeof runtime.getScriptLogs === "function";
  const resolved: ResolvedSandboxRuntimeCapabilities = {
    asyncExec,
    reattach: typeof runtime.getById === "function",
    detachedLaunch: typeof runtime.launchDetached === "function",
    warmLease: declared.warmLease ?? true,
    lifecycle: declared.lifecycle ?? true,
    // Modes default to "unknown", not to a plausible-looking value. An
    // undeclared mode means nobody has established it, and inventing one here
    // would manufacture exactly the false confidence the booleans already cost
    // us.
    modes: {
      outputStreams: declaredModes.outputStreams ?? "unknown",
      filesystem: declaredModes.filesystem ?? "unknown",
      lifetime: declaredModes.lifetime ?? "unknown",
      interactive: declaredModes.interactive ?? "unknown",
      snapshots: declaredModes.snapshots ?? "unknown",
    },
  };
  capabilitiesByRuntime.set(runtime, resolved);
  return resolved;
}
