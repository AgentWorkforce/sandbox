/** Provider-neutral entrypoint for `@agent-relay/sandbox`. */

/** Package name, exported so consumers can identify the module at runtime. */
export const PACKAGE_NAME = "@agent-relay/sandbox";

// --- runtime port (outer orchestration plane) ------------------------------
export type {
  AsyncRunStartResult,
  AsyncRunStatus,
  CapabilityAbsence,
  DeclaredSandboxRuntimeCapabilities,
  FilesystemMode,
  InteractiveMode,
  LifetimeMode,
  OutputStreamMode,
  SnapshotMode,
  ResolvedSandboxRuntimeCapabilities,
  RunScriptResult,
  SandboxCapabilityModes,
  SandboxCountOptions,
  SandboxLookupOptions,
  SandboxRuntime,
  SandboxRuntimeCapabilities,
} from "../port.js";
export { isPendingEvidence, resolveSandboxRuntimeCapabilities } from "../port.js";

// --- bootstrap plane (live in-sandbox session) -----------------------------
export type {
  AsyncExecStartResult,
  AsyncExecStatus,
  ExecOptions,
  ExecResult,
  IsolationLevel,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from "../types.js";

export { LocalSandboxRuntime } from "../local/runtime.js";
export type { LocalSandboxRuntimeOptions } from "../local/runtime.js";

// --- orchestration ---------------------------------------------------------
export { SandboxOrchestrator } from "../orchestrator.js";
export {
  buildRelayfileMountCleanupInvocationShell,
  buildRelayfileMountLifecycleShell,
} from "../orchestrator.js";
export type {
  FlushMountOptions,
  RelayfileMountHandle,
  RelayfileMountLifecycleShellOptions,
  SandboxBundleFile,
  SandboxCapturedOutput,
  SandboxCommandResult,
  SandboxOrchestratorRuntime,
  SandboxOutputChunk,
  SandboxProvisionOptions,
  SandboxRunScriptOptions,
  StartMountOptions,
  StopMountOptions,
} from "../orchestrator.js";

// --- relayfile-mount shell builders ----------------------------------------
export * from "../mount-script.js";
