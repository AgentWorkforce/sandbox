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
} from "./port.js";
export { isPendingEvidence, resolveSandboxRuntimeCapabilities } from "./port.js";

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
export { fetchDaytonaWireSupplement } from "./daytona/wire-supplement.js";
export type { DaytonaWireSupplement } from "./daytona/wire-supplement.js";

export {
  E2B_ASYNC_PROCESS_LOST_EXIT_CODE,
  E2BSandboxRuntime,
} from "./e2b/runtime.js";
export type {
  E2BAttachedSandboxOptions,
  E2BBundleFile,
  E2BCountByLabelsOptions,
  E2BFindByLabelsOptions,
  E2BRunScriptOptions,
  E2BSandboxRuntimeOptions,
  E2BSandboxStatics,
  E2BUploadBundleOptions,
} from "./e2b/runtime.js";

export {
  MicrosandboxBackendBusyError,
  MicrosandboxBackendPoisonedError,
  MicrosandboxCreateTimeoutError,
  MicrosandboxLogReadError,
  MicrosandboxLookupTimeoutError,
  MicrosandboxNameTooLongError,
  MicrosandboxPaginationError,
  MicrosandboxRunLostError,
  MicrosandboxRunNotFinishedError,
  MicrosandboxRunTimeoutUnsupportedError,
  MicrosandboxRuntime,
  MicrosandboxSessionConflictError,
  MicrosandboxStatusProbeError,
  MicrosandboxUnknownOutcomeError,
} from "./microsandbox/runtime.js";
export type {
  MicrosandboxBackend,
  MicrosandboxRuntimeOptions,
  MicrosandboxSdk,
  MicrosandboxStatus,
} from "./microsandbox/runtime.js";

export {
  AGENT37_COMMAND_CAP_MS,
  Agent37CommandTimeoutUnsupportedError,
  Agent37CreateTimeoutUnsupportedError,
  Agent37EnvValidationError,
  Agent37ForeignHandleError,
  Agent37MalformedResponseError,
  Agent37Runtime,
  Agent37UnknownExitCodeError,
} from "./agent37/runtime.js";
export type {
  Agent37BundleFile,
  Agent37Budget,
  Agent37ContainerLogs,
  Agent37CountOptions,
  Agent37ExecOptions,
  Agent37Instance,
  Agent37InstanceStatus,
  Agent37LaunchOptions,
  Agent37LookupOptions,
  Agent37PublicPort,
  Agent37Resources,
  Agent37RunScriptOptions,
  Agent37RuntimeOptions,
  Agent37UploadBundleOptions,
} from "./agent37/runtime.js";
export { Agent37ApiError, Agent37Client, isRetryableAgent37Code } from "./agent37/client.js";
export type {
  Agent37ClientOptions,
  Agent37Fetch,
  Agent37FetchInit,
  Agent37FetchResponse,
} from "./agent37/client.js";

export {
  VercelCapabilityMismatchError,
  VercelDestroyVerificationError,
  VercelDetachedLaunchUnsupportedError,
  VercelForeignSandboxError,
  VercelLifecycleTimeoutError,
  VercelListPageLimitError,
  VercelOperationTimeoutError,
  VercelSandboxRuntime,
  VercelTagLimitError,
  VercelUnknownExitCodeError,
  reconcileVercelCapabilities,
} from "./vercel/runtime.js";
export type {
  VercelAttachedSandboxOptions,
  VercelCapabilitySurface,
  VercelBundleFile,
  VercelListOwnedOptions,
  VercelOwnedSandbox,
  VercelRunScriptOptions,
  VercelUploadBundleOptions,
} from "./vercel/runtime.js";
export {
  vercelCapabilityModes,
  vercelObservedCapabilities,
  vercelSandboxCapabilities,
  vercelWorkflowCapabilities,
} from "./vercel/capabilities.js";
export type { VercelObservedCapabilities } from "./vercel/capabilities.js";
export type {
  VercelCredentials,
  VercelRuntimeOptions,
  VercelSandboxSource,
} from "./vercel/config.js";

export {
  ModalCapabilityMismatchError,
  ModalDeadlineExceededError,
  ModalForeignSandboxError,
  ModalRuntime,
  ModalTagCollisionError,
  reconcileModalCapabilities,
} from "./modal/runtime.js";
export {
  MODAL_DEFAULTS,
  MODAL_MAX_LIFETIME_MS,
  MODAL_MIN_CPU_CORES,
  resolveModalRuntimeOptions,
} from "./modal/config.js";
export type {
  ModalCredentials,
  ModalResourceShape,
  ModalRuntimeOptions,
  ResolvedModalRuntimeOptions,
} from "./modal/config.js";
export {
  MODAL_RATES,
  ModalBenchLedger,
  ModalBudgetExceededError,
  ModalLeakedSandboxError,
  estimateModalFunctionCostUsd,
  estimateModalSandboxCostUsd,
  percentile,
  runModalBenchmark,
} from "./modal/bench.js";
export type {
  ModalBenchOptions,
  ModalBenchReport,
  ModalBenchSample,
  ModalCostInput,
  ModalLedgerEntry,
  ModalLedgerEntryState,
} from "./modal/bench.js";
export {
  MODAL_STRUCTURALLY_FALSE,
  modalCapabilityModes,
  modalObservedCapabilities,
  modalSandboxCapabilities,
  modalWorkflowCapabilities,
} from "./modal/capabilities.js";
export type { ModalObservedCapabilities } from "./modal/capabilities.js";
export type {
  ModalClientFactory,
  ModalClientLike,
  ModalContainerProcessLike,
  ModalExecParams,
  ModalFilesystemLike,
  ModalSandboxCreateParams,
  ModalSandboxLike,
  ModalSandboxListParams,
  ModalSandboxServiceLike,
} from "./modal/internal/sdk.js";

export { LocalSandboxRuntime } from "./local/runtime.js";
export type { LocalSandboxRuntimeOptions } from "./local/runtime.js";

// --- orchestration ---------------------------------------------------------
export { SandboxOrchestrator } from "./orchestrator.js";
export {
  buildRelayfileMountCleanupInvocationShell,
  buildRelayfileMountLifecycleShell,
} from "./orchestrator.js";
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
} from "./orchestrator.js";

// --- relayfile-mount shell builders ----------------------------------------
export * from "./mount-script.js";
