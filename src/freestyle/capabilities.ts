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
  // Measured live 2026-08-22: stop/start/exec round-trips cleanly under
  // `sticky` persistence, but under `ephemeral` — what this adapter is
  // validated with — `stop` destroys the VM rather than stopping it. The
  // capability is therefore a function of `options.persistence`, which one
  // shared constant cannot express, so it stays false rather than claiming
  // something untrue for the default configuration. See docs/freestyle.md.
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
  // False as a *declaration*, not as an observation: see the note above. Under
  // `sticky` persistence stop -> start -> exec was observed working live.
  lifecycle: false,
  neverIdle: false,
  ptySurvival: false,
  snapshotCapture: false,
  streamingExec: false,
  warmLease: false,
};
