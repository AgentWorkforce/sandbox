import type {
  DeclaredSandboxRuntimeCapabilities,
} from "../port.js";
import type { RuntimeCapabilities } from "../types.js";

/**
 * SDK-free capability metadata. Behavioral claims stay conservative until a
 * live negative/positive probe establishes them against the pinned SDK/API.
 */
export const freestyleSandboxCapabilities = {
  // Freestyle create has no label field. Name-scoped ownership is useful for
  // cleanup, but it is not a server-side label lease implementation.
  warmLease: false,
  // The adapter implements stop/start as a probe surface. This flag is promoted
  // only after stop -> settled state -> start -> exec succeeds live.
  lifecycle: false,
} as const satisfies DeclaredSandboxRuntimeCapabilities;

export const freestyleWorkflowCapabilities = {
  // The SDK has PTY and snapshot APIs, but this package's WorkflowRuntime port
  // exposes neither operation. Capability means reachable through this port.
  pty: false,
  snapshots: false,
  isolation: "strong",
  persistentHandle: true,
  // vm.exec waits and buffers stdout/stderr; no streaming surface is exposed.
  streamingLogs: false,
} as const satisfies RuntimeCapabilities;

export type FreestyleObservedCapabilities = {
  cleanupVerified: boolean;
  fork: boolean;
  lifecycle: boolean;
  neverIdle: boolean;
  ptySurvival: boolean;
  snapshotCapture: boolean;
  streamingExec: boolean;
  warmLease: boolean;
};

/** Cells not yet proven live remain false rather than inferred from SDK shape. */
export const freestyleObservedCapabilities: FreestyleObservedCapabilities = {
  // Promoted after the 2026-08-20 live canary plus n=7/concurrency run: every
  // ledgered VM was absent or deleted:true in a fresh post-run prefix audit.
  cleanupVerified: true,
  fork: false,
  lifecycle: false,
  neverIdle: false,
  ptySurvival: false,
  snapshotCapture: false,
  streamingExec: false,
  warmLease: false,
};
