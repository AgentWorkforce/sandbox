import type {
  DeclaredSandboxRuntimeCapabilities,
  SandboxCapabilityModes,
} from "../port.js";
import type { RuntimeCapabilities } from "../types.js";

/**
 * SDK-free capability metadata for the Vercel Sandbox adapter.
 *
 * Two rules govern this file:
 *
 *  1. A capability means *reachable through this package's ports*. The vendor
 *     SDK having a method is not the same as this adapter exposing it, and the
 *     gap is where false capability claims come from.
 *  2. A behavioral claim stays `false` until a live probe against the pinned
 *     SDK establishes it. Shape is not evidence.
 */

export const vercelSandboxCapabilities = {
  // `Sandbox.list` accepts a server-side `tags` filter, so unlike Freestyle the
  // implementation here is a real label search rather than a degraded `[]`.
  // It still declares false: server-side filtering that is silently ignored by
  // the API would return foreign sandboxes as lease candidates, which is worse
  // than no lease at all. Promote only once a live probe shows that a tag query
  // excludes a known non-matching sandbox.
  warmLease: false,
  // `stop()` is real, and `Sandbox.get({ resume: true })` is the resume path.
  // Promotion waits on a live stop -> settled -> resume -> exec round trip.
  lifecycle: false,
} as const satisfies DeclaredSandboxRuntimeCapabilities;

export const vercelWorkflowCapabilities = {
  // `sandbox.openInteractive()` exists in the SDK, but WorkflowRuntime exposes
  // no PTY operation, so it is not reachable through this port.
  pty: false,
  // `sandbox.snapshot()` and `Sandbox.fork()` exist in the SDK; likewise not
  // reachable through this port.
  snapshots: false,
  // Each sandbox is a dedicated Firecracker-class microVM.
  isolation: "strong",
  // `getById` re-resolves a sandbox by name across processes.
  persistentHandle: true,
  // `Command.logs()` is an async iterator in the SDK, but this adapter buffers
  // and returns a completed result; no streaming surface is exposed.
  streamingLogs: false,
} as const satisfies RuntimeCapabilities;

export type VercelObservedCapabilities = {
  cleanupVerified: boolean;
  fork: boolean;
  lifecycle: boolean;
  neverIdle: boolean;
  ptySurvival: boolean;
  snapshotCapture: boolean;
  streamingExec: boolean;
  warmLease: boolean;
};

/**
 * Cells not yet proven live remain `false` rather than inferred from SDK shape.
 *
 * Promotion protocol: a cell flips to `true` only in a commit that also records
 * the dated live evidence that justified it, exactly as the Freestyle adapter
 * did for `cleanupVerified`.
 */
export const vercelObservedCapabilities: VercelObservedCapabilities = {
  // Implemented: `destroy` submits the delete and then verifies absence in a
  // fresh prefix listing, treating a same-name row with a different createdAt
  // as a *different* sandbox rather than a survivor. Promotion is gated on the
  // live canary showing destroyed === verifiedGone across the n=7 run.
  cleanupVerified: false,
  fork: false,
  lifecycle: false,
  // Not merely unproven: Vercel sandboxes always carry a termination deadline,
  // so there is no never-idle tier to promote this to. This one is settled.
  neverIdle: false,
  ptySurvival: false,
  snapshotCapture: false,
  streamingExec: false,
  warmLease: false,
};

/**
 * Structured capability modes for the Vercel Sandbox adapter.
 *
 * These restate, in the type system, distinctions this file already draws in
 * prose. The booleans above cannot separate "the provider cannot do this" from
 * "the provider can, but this package's port exposes no operation reaching it"
 * from "nobody has checked yet" — and rule 1 of this file is precisely that
 * distinction. `not-exposed` is that rule as a type.
 *
 * Note which cell is **missing**: `filesystem`. See below.
 */
export const vercelCapabilityModes = {
  /**
   * `Command.logs()` is an async iterator, so the SDK can genuinely stream. This
   * adapter awaits `output("stdout")` and `output("stderr")` to completion and
   * returns a finished `RunScriptResult`, and the port exposes no streaming
   * operation. Both streaming members of the union mean *streamed live*, so
   * `buffered` is the honest shape for this port.
   */
  outputStreams: "buffered",
  /**
   * Settled, not pending. A Vercel sandbox always carries a wall-clock
   * termination deadline (`sandboxTimeoutMs`) — there is no never-idle tier to
   * promote to, which is the same fact recorded against
   * {@link vercelObservedCapabilities.neverIdle}. Per the union's own note,
   * `deadline` says this without needing `unsupported`.
   */
  lifetime: "deadline",
  /**
   * `sandbox.openInteractive()` exists in the SDK; `WorkflowRuntime` exposes no
   * PTY operation, so it is unreachable *here*. `not-exposed` rather than
   * `unsupported`: this is a fact about our port, and it moves only if someone
   * adds an operation — never on the strength of a live probe against Vercel.
   */
  interactive: "not-exposed",
  /**
   * `sandbox.snapshot()` and `Sandbox.fork()` exist in the SDK and are likewise
   * unreachable through this port. Note this is a *different* claim from
   * {@link vercelObservedCapabilities.snapshotCapture}, which is a pending
   * observation about Vercel: a canary may promote that one and must never
   * promote this one.
   */
  snapshots: "not-exposed",
} as const satisfies Partial<SandboxCapabilityModes>;

/**
 * Why `filesystem` is deliberately left undeclared, and so resolves to
 * `"unknown"`.
 *
 * Unlike the cells above, this one is not a fact this adapter is in a position
 * to state. Two reasons compound:
 *
 *  1. It is **configurable per instance**, not a property of the provider.
 *     `VercelSandboxRuntimeOptions.persistent` selects the durability contract,
 *     so no single static value is correct for every `VercelSandboxRuntime`.
 *  2. Even for a `persistent: true` instance, the union's `"persistent"` means
 *     *restored across stop/start of the same sandbox* — which is exactly the
 *     round trip that `vercelSandboxCapabilities.lifecycle` is still waiting on
 *     a live probe to establish. Declaring it would promote, through a mode,
 *     the very behavior the boolean is holding back for lack of evidence.
 *
 * `"unknown"` is the accurate answer and the only one that keeps
 * `isPendingEvidence()` truthful: a live stop -> resume -> read-back probe
 * genuinely can settle this, and should be what does.
 */
export const VERCEL_FILESYSTEM_MODE_UNDECLARED =
  "filesystem durability is per-instance (options.persistent) and its across-restart "
  + "behavior is gated on the same unproven live probe as lifecycle";
