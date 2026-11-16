import type {
  DeclaredSandboxRuntimeCapabilities,
  SandboxCapabilityModes,
} from "../port.js";
import type { RuntimeCapabilities } from "../types.js";

/**
 * SDK-free capability metadata for the boxd adapter.
 *
 * A capability means reachable through this package's ports, and a behavioral
 * claim is made only where a live run against the pinned SDK established it.
 * The dated evidence for each `true` cell is in docs/boxd.md ("Live evidence").
 */
export const boxdSandboxCapabilities = {
  // Machines carry server-side key=value labels, and `machines.list` filters
  // on them, so a label lookup finds machines another process launched.
  warmLease: true,
  // `stop` stops the machine and keeps its disk; `start` boots it again.
  lifecycle: true,
} as const satisfies DeclaredSandboxRuntimeCapabilities;

export const boxdWorkflowCapabilities = {
  // boxd has PTY exec, snapshots and forks, but this package's WorkflowRuntime
  // port exposes none of them. Capability means reachable through this port.
  pty: false,
  snapshots: false,
  // Each sandbox is its own virtual machine with its own kernel.
  isolation: "strong",
  persistentHandle: true,
  // runScript/exec wait for the command and return buffered output.
  streamingLogs: false,
} as const satisfies RuntimeCapabilities;

export const boxdCapabilityModes = {
  // The SDK can stream exec output; this adapter returns finished results and
  // the port has no streaming operation.
  outputStreams: "buffered",
  // Files written before `stop` are there after `start`.
  filesystem: "persistent",
  // A machine runs until it is stopped or deleted. Idle machines may go to
  // standby or hibernate, which keeps memory and disk, and wake on the next
  // exec. `deleteAfterSeconds` turns this into a deadline; the runtime
  // reports that per instance.
  lifetime: "never-idle",
  // boxd has PTY exec; the port has no interactive operation.
  interactive: "not-exposed",
  // boxd has snapshots and live forks; the port has no operation for them.
  snapshots: "not-exposed",
} as const satisfies SandboxCapabilityModes;

export type BoxdObservedCapabilities = {
  cleanupVerified: boolean;
  fork: boolean;
  lifecycle: boolean;
  neverIdle: boolean;
  ptySurvival: boolean;
  snapshotCapture: boolean;
  streamingExec: boolean;
  warmLease: boolean;
};

/** Cells not proven live through this adapter stay false. */
export const boxdObservedCapabilities: BoxdObservedCapabilities = {
  cleanupVerified: true,
  fork: false,
  lifecycle: true,
  neverIdle: true,
  ptySurvival: false,
  snapshotCapture: false,
  streamingExec: false,
  warmLease: true,
};
