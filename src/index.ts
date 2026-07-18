/**
 * `@agent-relay/sandbox` — provider-agnostic sandbox runtimes and orchestration.
 *
 * Two planes live here, and they are deliberately NOT merged:
 *
 *  - The **runtime port** (`SandboxRuntime` and friends) is the outer
 *    orchestration plane: launch, look up, run, tear down. Capabilities on this
 *    plane are `SandboxRuntimeCapabilities`.
 *  - The **bootstrap plane** (`WorkflowRuntime`, `RuntimeCapabilities`,
 *    `RuntimeHandle`) describes a live in-sandbox session. Its
 *    `RuntimeCapabilities` is a different concept from
 *    `SandboxRuntimeCapabilities` and must not be conflated with it.
 *
 * Configuration is injected, never baked in: templates, home directories, and
 * state directories are required arguments, because no default is correct for
 * every consumer.
 */

/** Package name, exported so consumers can identify the module at runtime. */
export const PACKAGE_NAME = "@agent-relay/sandbox";

// --- runtime port (outer orchestration plane) ------------------------------
export type {
  AsyncRunStartResult,
  AsyncRunStatus,
  DeclaredSandboxRuntimeCapabilities,
  RunScriptResult,
  SandboxRuntime,
  SandboxRuntimeCapabilities,
} from "./port.js";
export { resolveSandboxRuntimeCapabilities } from "./port.js";

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
} from "./types.js";

// --- providers -------------------------------------------------------------
export { DaytonaRuntime, SnapshotNotFoundError } from "./daytona/runtime.js";
export type {
  DaytonaAttachedSandboxOptions,
  DaytonaBundleFile,
  DaytonaCountByLabelsOptions,
  DaytonaFindByLabelsOptions,
  DaytonaRunScriptOptions,
  DaytonaRunScriptResult,
  DaytonaRuntimeOptions,
  DaytonaUploadBundleOptions,
} from "./daytona/runtime.js";

export { E2BSandboxRuntime } from "./e2b/runtime.js";
export type { E2BSandboxRuntimeOptions, E2BSandboxStatics } from "./e2b/runtime.js";

export { LocalSandboxRuntime } from "./local/runtime.js";

// --- orchestration ---------------------------------------------------------
export { SandboxOrchestrator } from "./orchestrator.js";
export type {
  RelayfileMountHandle,
  SandboxBundleFile,
  SandboxCapturedOutput,
  SandboxCommandResult,
  SandboxOrchestratorRuntime,
  SandboxOutputChunk,
  SandboxProvisionOptions,
  SandboxRunScriptOptions,
} from "./orchestrator.js";

// --- relayfile-mount shell builders ----------------------------------------
export * from "./mount-script.js";
