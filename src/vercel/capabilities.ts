import type { DeclaredSandboxRuntimeCapabilities } from "../port.js";
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
