import type { DeclaredSandboxRuntimeCapabilities } from "../port.js";
import type { RuntimeCapabilities } from "../types.js";

/**
 * SDK-free capability metadata for the AgentCore Code Interpreter adapter.
 *
 * Two rules govern this file, carried over from the Vercel and Modal
 * adapters:
 *
 *  1. A capability means *reachable through this package's ports*. The
 *     vendor API having an operation is not the same as this adapter
 *     exposing it.
 *  2. A behavioral claim stays `false` until a live probe against the pinned
 *     SDK establishes it. Shape is not evidence.
 *
 * A third distinction is specific to this adapter: some cells below are not
 * *pending* proof, they are *structurally* false — the AgentCore session API
 * has no server surface that could ever make them true, the way Modal's
 * `lifecycle` is permanently false because `Sandbox.terminate()` is the only
 * transition the vendor SDK exposes. Each such cell says so.
 */
export const agentCoreSandboxCapabilities = {
  /**
   * Structurally false, not pending.
   *
   * `StartCodeInterpreterSession` accepts only a non-unique `name` string —
   * there is no tags/labels field on a session, unlike the code interpreter
   * *resource* itself (which does accept `tags` at `CreateCodeInterpreter`
   * time, but that resource is this adapter's shared environment, not a
   * per-session lease target). `ListCodeInterpreterSessions` therefore has
   * nothing to filter server-side, and `findAllByLabels` degrades to
   * searching this runtime instance's own in-process registrations — real
   * within one process, empty in every other one. Promoting this would
   * require the vendor API to grow a session-level tag field; it does not
   * exist today.
   */
  warmLease: false,
  /**
   * Structurally false, not pending.
   *
   * `GetCodeInterpreterSession.status` is `READY | TERMINATED` — there is no
   * `STOPPED`-but-resumable state, and `StopCodeInterpreterSession` is a
   * terminal transition with no corresponding start/resume call, exactly
   * the shape the Modal adapter's `lifecycle: false` already documents for
   * `Sandbox.terminate()`. This adapter follows the same choice: `stop`/
   * `start` are omitted from the class entirely rather than shipping a
   * `stop` that cannot be undone under a name implying it can.
   */
  lifecycle: false,
} as const satisfies DeclaredSandboxRuntimeCapabilities;

/**
 * Bootstrap-plane capabilities — `RuntimeCapabilities` from `../types.js`,
 * the live in-sandbox plane, not the orchestration-plane
 * `SandboxRuntimeCapabilities` above. Kept distinct on purpose.
 */
export const agentCoreWorkflowCapabilities = {
  /** No PTY operation in the AgentCore API or this port. */
  pty: false,
  /** No filesystem snapshot or fork operation in the AgentCore API. */
  snapshots: false,
  /**
   * Each session runs in a dedicated, AWS-managed microVM-class sandbox
   * (AgentCore's own "containerized environment... isolated and secure"
   * framing; see
   * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html).
   */
  isolation: "strong",
  /**
   * `GetCodeInterpreterSession(codeInterpreterIdentifier, sessionId)`
   * re-resolves a still-live session from a bare id, including across a
   * process restart, as long as the caller supplies the same
   * `codeInterpreterIdentifier` — which this adapter fixes deterministically
   * via `AgentCoreInterpreterSource.name`.
   */
  persistentHandle: true,
  /**
   * `InvokeCodeInterpreter` genuinely returns an event stream server-side
   * (`response["stream"]` in the AWS examples), but this port's
   * `WorkflowRuntime.exec`/`runScript` return a single buffered
   * `RunScriptResult`, so nothing upstream of this adapter observes
   * incremental output. False *for this port*, true of the provider — the
   * same distinction the Modal adapter draws for `Command.logs()`.
   */
  streamingLogs: false,
} as const satisfies RuntimeCapabilities;

export type AgentCoreObservedCapabilities = {
  /** A terminated session verifiably left `READY` state, checked by re-`Get`. */
  cleanupVerified: boolean;
  /**
   * Whether a live idle-hold canary confirmed AWS's "I/O wait and idle time
   * are free" billing claim extends to session *memory*, not only CPU. This
   * is the load-bearing economics question for this adapter (see
   * `docs/agentcore.md`) and is deliberately tracked separately from the
   * generic capability cells below: it is a pricing fact, not a port
   * capability, but it belongs in the same "no promotion without dated live
   * evidence" ledger.
   */
  idleMemoryBillingConfirmedFree: boolean;
  fork: boolean;
  lifecycle: boolean;
  /**
   * Settled `false`, not pending, same reasoning as Vercel's `neverIdle`:
   * every session carries a `sessionTimeoutSeconds` ceiling (max 8 hours),
   * so there is no never-idle tier for this cell to ever promote to.
   */
  neverIdle: boolean;
  ptySurvival: boolean;
  snapshotCapture: boolean;
  streamingExec: boolean;
  warmLease: boolean;
};

/**
 * Cells not yet proven live remain `false` rather than inferred from SDK or
 * API-doc shape. Promotion protocol: a cell flips to `true` only in a commit
 * that also records the dated live evidence that justified it.
 */
export const agentCoreObservedCapabilities: AgentCoreObservedCapabilities = {
  cleanupVerified: false,
  idleMemoryBillingConfirmedFree: false,
  fork: false,
  lifecycle: false,
  neverIdle: false,
  ptySurvival: false,
  snapshotCapture: false,
  streamingExec: false,
  warmLease: false,
};
