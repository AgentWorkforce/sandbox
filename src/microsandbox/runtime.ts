import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import type {
  AsyncExecStartResult,
  AsyncExecStatus,
  ExecOptions,
  ExecResult,
  LaunchOptions,
  RuntimeCapabilities,
  RuntimeHandle,
  WorkflowRuntime,
} from "../types.js";
import type {
  AsyncRunStartResult,
  AsyncRunStatus,
  RunScriptResult,
  SandboxCountOptions,
  SandboxLookupOptions,
  SandboxRuntime,
} from "../port.js";

// ---------------------------------------------------------------------------
// Microsandbox provider for the SandboxRuntime + WorkflowRuntime contracts.
//
// The `microsandbox` npm package is imported LAZILY (`await import(...)`),
// never at module top level, so consumers on another provider neither bundle it
// nor need its platform-specific native addon installed. The SDK surface is
// modeled structurally below (read from microsandbox@0.6.11 `dist/*.d.ts`) so
// typecheck and unit tests do not hard-couple to the SDK type graph, and a fake
// SDK can drive every path without a live backend or an API key.
//
// Five provider facts shape this adapter and are worth stating up front,
// because each one breaks an assumption the other adapters in this package are
// allowed to make:
//
//  1. IDENTITY IS A NAME, NOT A SERVER-ASSIGNED ID. `Sandbox.builder(name)`,
//     `Sandbox.get(name)` and `SandboxHandle.remove()` all address a sandbox by
//     a caller-chosen name capped at 128 UTF-8 bytes. `RuntimeHandle.id`
//     therefore carries that name, and an over-long name is rejected rather
//     than truncated — truncating would silently alias two distinct sandboxes
//     onto one identity.
//
//  2. BACKEND SELECTION IS PROCESS-WIDE GLOBAL STATE. The SDK exposes
//     `setDefaultBackend(backend)` (permanent) and `withDefaultBackend(backend,
//     fn)` (scoped, restored in a `finally`). The SDK documents that the scoped
//     form is NOT task-local: concurrent work in the same process observes the
//     temporary backend while the callback runs, so two overlapping calls on
//     different backends would silently send one of them to the wrong place.
//     This adapter therefore never calls `setDefaultBackend`, and routes the
//     calls that DO read that slot — the SDK's default-dependent statics —
//     through one PROCESS-GLOBAL gate (see `withBackendScope`): calls that want
//     the same backend share a single open scope and still run concurrently; a
//     call that wants a different backend waits until the current scope has
//     closed. A resolved `Sandbox` or `SandboxHandle` is bound to the backend it
//     was resolved on, so its exec, filesystem and lifecycle calls read no
//     global state and are issued off the gate. That is a real mutual-exclusion
//     guarantee for this adapter's own default-dependent calls, and the honest
//     limit of it is stated on the gate: SDK calls made elsewhere in the
//     process, outside this adapter, are not covered by it and can still
//     observe the scoped backend.
//
//  3. THERE IS NO CREATE-TIMEOUT SETTER ON THE BUILDER. `maxDuration` and
//     `idleTimeout` are sandbox LIFETIME budgets. Mapping the caller's
//     `createTimeoutSeconds` onto either would kill every long-lived sandbox
//     the moment the boot deadline elapsed, so the create deadline is enforced
//     client-side instead — and a create that lands AFTER that deadline is
//     reclaimed rather than leaked (see `launch`).
//
//  4. THE SDK REQUIRES NODE 22+ AND A VIRTUALIZATION-CAPABLE HOST.
//     `microsandbox@0.6.x` declares `engines.node >= 22` and ships a
//     platform-specific native addon (macOS arm64, Linux x64/arm64, Windows
//     x64/arm64). Its published requirements are Linux with KVM, macOS on
//     Apple Silicon, or Windows 10+ with WHP — that hardware requirement is
//     what the LOCAL backend boots microVMs on; the cloud backend boots them
//     remotely but still loads the same native client addon. This package's own
//     floor stays Node 20, because every other adapter here runs there and the
//     SDK is an OPTIONAL peer dependency — so the constraint is surfaced where
//     it actually bites: the lazy import wraps a load failure with it.
//
//  5. AN ASYNC RUN HAS NO SERVER-SIDE COMMAND RECORD. The SDK's streaming
//     `ExecHandle` is process-local and carries no id a later process could
//     poll, so async runs are tracked by durable files in the guest. Everything
//     that makes that safe — one-shot admission, adoption of a run whose
//     submit response was lost, refusal to overwrite another run's state, and
//     detection of a run whose process died without recording an exit code —
//     lives in the two POSIX shell scripts below, not in the caller.
// ---------------------------------------------------------------------------

/** Max sandbox name length the SDK accepts, in UTF-8 bytes. */
const MAX_SANDBOX_NAME_BYTES = 128;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_PAGE_SIZE = 100;
/**
 * How long a call may wait for the process-global backend gate before it fails
 * instead of waiting forever. See {@link MicrosandboxBackendBusyError}.
 */
const DEFAULT_BACKEND_QUEUE_TIMEOUT_MS = 30_000;
const SCRIPT_LOG_READ_MAX_BYTES = 200_000;
/**
 * Longest encoded run-state path segment before it is replaced by a digest.
 * Well under the 255-byte filename limit every mainstream guest filesystem
 * imposes, with room for the `out`/`exit`/`pid` leaves underneath it.
 */
const MAX_RUN_SEGMENT_BYTES = 120;

/**
 * Where the async-run wrapper parks its `cmd`/`pid`/`boot`/`out`/`exit` files
 * inside the guest.
 *
 * `/tmp` is a POSIX guarantee of the guest filesystem, not a fact about any
 * particular deployment, so it is a safe default rather than baked-in
 * infrastructure. Consumers whose image mounts `/tmp` read-only override it
 * with `runStateDir`.
 */
const DEFAULT_RUN_STATE_DIR = "/tmp/microsandbox-run";

/** POSIX shell used to interpret a `runScript`/`startScript` command string. */
const DEFAULT_SHELL = "/bin/sh";

// --- guest-side async run protocol -----------------------------------------
//
// Both scripts below are pure POSIX `sh` and take every value — including the
// caller's command — as a positional ARGUMENT, never as interpolated text. So
// no quoting of caller data happens anywhere on the host, and the exact bytes
// of the command reach the guest unmodified.
//
// The run directory doubles as the admission record. `mkdir` of a single
// directory is atomic on every POSIX filesystem, so it either claims the
// session or proves someone else already did — which is what makes a resubmit
// of the same session id incapable of starting a second process or of
// overwriting the first one's state.

/**
 * Admit one async run.
 *
 * Arguments: `$1` command, `$2` run directory, `$3` its parent, `$4` shell.
 *
 * Prints exactly one of:
 *  - `ADMITTED <pid>` — this call created the run.
 *  - `CLAIMED <pid>`  — the session was already admitted for THIS EXACT
 *    command, so its existing run is adopted. This is the outcome-unknown
 *    case: a submit whose response was lost is retried by the caller and
 *    resolves here, without ever starting a second process.
 *  - `CONFLICT`       — the session is already admitted for a DIFFERENT
 *    command (or its record is unreadable). Nothing is started and nothing is
 *    overwritten; the caller gets a typed error.
 *
 * @internal Exported only so the protocol tests can execute it under a real
 * `/bin/sh`. Not part of the package's public API.
 */
export const MICROSANDBOX_RUN_ADMIT_SCRIPT = [
  "set -u",
  "cmd=$1",
  "dir=$2",
  "parent=$3",
  "shell_path=$4",
  'mkdir -p "$parent" 2>/dev/null || true',
  'if mkdir "$dir" 2>/dev/null; then',
  // Record the command BEFORE starting anything: a crash between the two
  // leaves a claimed-but-dead session, which the status probe reports as lost,
  // rather than an unattributable running process.
  '  printf %s "$cmd" > "$dir/cmd"',
  // Boot identity, used by the status probe to tell "still running" from "the
  // sandbox restarted and this pid now belongs to someone else". Absent on a
  // guest without procfs, in which case the probe falls back to pid liveness.
  '  cat /proc/sys/kernel/random/boot_id > "$dir/boot" 2>/dev/null || true',
  // The command runs in a CHILD shell, so an `exit 7` inside it cannot skip
  // the exit-code record: the child exits, the wrapper writes its status.
  '  nohup "$shell_path" -c \'"$3" -c "$1" > "$2/out" 2>&1; printf %s "$?" > "$2/exit"\' msb-run "$cmd" "$dir" "$shell_path" > /dev/null 2>&1 &',
  "  run_pid=$!",
  '  printf %s "$run_pid" > "$dir/pid"',
  '  printf "ADMITTED %s\\n" "$run_pid"',
  "  exit 0",
  "fi",
  // `$(cat f)` strips EVERY trailing newline, so the sentinel-and-strip form
  // is what makes the comparison byte-exact: a command that ends in a newline
  // must still be recognised as the same command on an outcome-unknown retry.
  'existing=$(cat "$dir/cmd" 2>/dev/null; printf X) || existing=X',
  'existing=${existing%X}',
  'run_pid=$(cat "$dir/pid" 2>/dev/null) || run_pid=""',
  'if [ "$existing" = "$cmd" ] && [ -n "$run_pid" ]; then',
  '  printf "CLAIMED %s\\n" "$run_pid"',
  "  exit 0",
  "fi",
  'printf "CONFLICT\\n"',
].join("\n");

/**
 * Report one async run's outcome.
 *
 * Argument: `$1` run directory. Prints exactly one of `EXIT <code>`,
 * `RUNNING`, `MISSING`, or `LOST <reason>`.
 *
 * The exit file is checked first and again last: the wrapper writes it as its
 * final act, so re-reading after the liveness probe closes the window where a
 * run finishes mid-probe and would otherwise read as lost.
 *
 * @internal Exported only for the protocol tests (see above).
 */
export const MICROSANDBOX_RUN_STATUS_SCRIPT = [
  "set -u",
  "dir=$1",
  'if [ -f "$dir/exit" ]; then',
  '  printf "EXIT %s\\n" "$(cat "$dir/exit" 2>/dev/null)"',
  "  exit 0",
  "fi",
  'if [ ! -d "$dir" ]; then',
  '  printf "MISSING\\n"',
  "  exit 0",
  "fi",
  'boot=$(cat "$dir/boot" 2>/dev/null) || boot=""',
  'now=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || now=""',
  'if [ -n "$boot" ] && [ -n "$now" ] && [ "$boot" != "$now" ]; then',
  '  printf "LOST sandbox-restarted\\n"',
  "  exit 0",
  "fi",
  'run_pid=$(cat "$dir/pid" 2>/dev/null) || run_pid=""',
  'if [ -z "$run_pid" ]; then',
  // Admitted, pid not recorded yet: the admission call is still in flight.
  '  printf "RUNNING\\n"',
  "  exit 0",
  "fi",
  'if kill -0 "$run_pid" 2>/dev/null; then',
  '  printf "RUNNING\\n"',
  "  exit 0",
  "fi",
  'if [ -f "$dir/exit" ]; then',
  '  printf "EXIT %s\\n" "$(cat "$dir/exit" 2>/dev/null)"',
  "  exit 0",
  "fi",
  'printf "LOST process-gone\\n"',
].join("\n");

// --- structural microsandbox SDK surface (microsandbox@0.6.11) --------------

/** `SandboxStatus` — the SDK's own status vocabulary. */
export type MicrosandboxStatus = "running" | "stopped" | "crashed" | "draining";

type MsbExecOutput = {
  readonly code: number;
  readonly success: boolean;
  stdout(): string;
  stderr(): string;
};

type MsbExecOptionsBuilder = {
  args(args: string[]): MsbExecOptionsBuilder;
  cwd(cwd: string): MsbExecOptionsBuilder;
  envs(vars: Record<string, string>): MsbExecOptionsBuilder;
  timeout(ms: number): MsbExecOptionsBuilder;
  tty(enabled: boolean): MsbExecOptionsBuilder;
};

type MsbFsOps = {
  write(path: string, data: Uint8Array | string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  readToString(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  copyFromHost(hostPath: string, guestPath: string): Promise<void>;
  copyToHost(guestPath: string, hostPath: string): Promise<void>;
};

type MsbSandbox = {
  readonly name: string;
  exec(cmd: string, args?: Iterable<string>): Promise<MsbExecOutput>;
  execWith(
    cmd: string,
    configure: (b: MsbExecOptionsBuilder) => MsbExecOptionsBuilder,
  ): Promise<MsbExecOutput>;
  fs(): MsbFsOps;
  detach?(): Promise<void>;
};

// `Sandbox.get` resolves a handle and REJECTS with a `sandboxNotFound`-coded
// error for an unknown name; `| null` is modeled here only so a double may
// express absence the simpler way. Both are handled (see `lookupHandle`).
type MsbSandboxHandle = {
  readonly name: string;
  readonly status: MicrosandboxStatus;
  readonly createdAt?: Date | null;
  readonly updatedAt?: Date | null;
  connect(): Promise<MsbSandbox>;
  connectWithTimeout(timeoutMs: number): Promise<MsbSandbox>;
  start(): Promise<MsbSandbox>;
  startDetached(): Promise<MsbSandbox>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  remove(): Promise<void>;
};

type MsbSandboxPage = {
  sandboxes: MsbSandboxHandle[];
  nextCursor?: string;
};

type MsbSandboxListBuilder = {
  limit(limit: number): MsbSandboxListBuilder;
  cursor(cursor: string): MsbSandboxListBuilder;
  labels(labels: Record<string, string>): MsbSandboxListBuilder;
};

type MsbSandboxBuilder = {
  image(image: string): MsbSandboxBuilder;
  fromSnapshot(pathOrName: string): MsbSandboxBuilder;
  cpus(n: number): MsbSandboxBuilder;
  memory(mib: number): MsbSandboxBuilder;
  workdir(path: string): MsbSandboxBuilder;
  envs(vars: Record<string, string>): MsbSandboxBuilder;
  labels(labels: Record<string, string>): MsbSandboxBuilder;
  detached(enabled: boolean): MsbSandboxBuilder;
  idleTimeout(secs: number): MsbSandboxBuilder;
  maxDuration(secs: number): MsbSandboxBuilder;
  replace(): MsbSandboxBuilder;
  create(): Promise<MsbSandbox>;
};

type MsbSandboxStatics = {
  builder(name: string): MsbSandboxBuilder;
  get(name: string): Promise<MsbSandboxHandle | null>;
  listWith(
    configure: (b: MsbSandboxListBuilder) => MsbSandboxListBuilder,
  ): Promise<MsbSandboxPage>;
};

/**
 * The slice of the `microsandbox` module this adapter binds to.
 *
 * Exported so a consumer can supply a double (tests, a proxy that adds
 * tracing) through {@link MicrosandboxRuntimeOptions.sdk} without depending on
 * the SDK's internal type graph.
 */
export type MicrosandboxSdk = {
  Sandbox: MsbSandboxStatics;
  withDefaultBackend<T>(
    backend: MicrosandboxBackend,
    fn: () => Promise<T> | T,
  ): Promise<T>;
};

/**
 * Backend routing for one runtime instance — mirrors the SDK's
 * `DefaultBackend`.
 *
 * There is deliberately no default: `"local"` would silently run workloads on
 * the caller's host, and a cloud URL is deployment-specific. The API key is
 * accepted here as a value the caller supplies at construction from its own
 * secret store; this package never reads an environment variable, never logs
 * the key, and never writes it to disk.
 */
export type MicrosandboxBackend =
  | "local"
  | {
      kind: "cloud";
      /** Hosted API endpoint. Omit to use the SDK's own default endpoint. */
      url?: string;
      apiKey: string;
    }
  | { kind: "cloud"; profile: string };

export type MicrosandboxRuntimeOptions = {
  /**
   * Backend this runtime routes every SDK call through. Required: see
   * {@link MicrosandboxBackend}.
   */
  backend: MicrosandboxBackend;
  /**
   * OCI image to boot. Required unless {@link snapshot} is given: images are
   * registry- and consumer-specific, so no default is correct for anyone else.
   */
  image?: string;
  /**
   * Snapshot to boot from instead of an image. Mutually exclusive with
   * {@link image}.
   */
  snapshot?: string;
  /**
   * Home directory inside the guest, reported by `getHomeDir`. Required: it is
   * a property of the image, which this package does not choose.
   */
  homeDir: string;
  /** Default working directory for launched sandboxes. */
  workdir?: string;
  /** vCPU count applied at create time. Omit to accept the image default. */
  cpus?: number;
  /** Guest memory in MiB applied at create time. */
  memoryMiB?: number;
  /** Idle-shutdown budget in seconds, applied at create time. */
  idleTimeoutSeconds?: number;
  /** Hard sandbox lifetime in seconds, applied at create time. */
  maxDurationSeconds?: number;
  /**
   * Replace a same-named sandbox at create time. Defaults to `false`: names are
   * the identity here, so replacing on collision would destroy a sandbox this
   * caller may not own.
   */
  replaceExisting?: boolean;
  /** Prefix for generated sandbox names when the caller supplies none. */
  namePrefix?: string;
  /** Guest directory holding async-run state files. Defaults to `/tmp/microsandbox-run`. */
  runStateDir?: string;
  /** Shell used to interpret command strings. Defaults to `/bin/sh`. */
  shell?: string;
  /** Timeout for `connect` to an already-running sandbox. Defaults to 10s. */
  connectTimeoutMs?: number;
  /**
   * Deadline for a whole label lookup, including every page it drains.
   * Defaults to 10s, and is overridden per call by `options.timeoutMs`.
   */
  lookupTimeoutMs?: number;
  /** Page size used when draining label listings. Defaults to 100. */
  listPageSize?: number;
  /**
   * How long a call may wait for the process-global backend gate before failing
   * with {@link MicrosandboxBackendBusyError}. Defaults to 30s.
   *
   * Only meaningful in a process that drives MORE THAN ONE backend: a process
   * on a single backend shares one open scope and never queues.
   */
  backendQueueTimeoutMs?: number;
  /** Injection seam for tests / a wrapping adapter — defaults to lazy `import("microsandbox")`. */
  sdk?: MicrosandboxSdk;
};

/**
 * A sandbox name exceeded the SDK's 128 UTF-8 byte cap.
 *
 * Raised instead of truncating: the name IS the identity, so a truncated name
 * would collide two distinct sandboxes onto one addressable handle.
 */
export class MicrosandboxNameTooLongError extends Error {
  override readonly name = "MicrosandboxNameTooLongError";
  readonly sandboxName: string;
  readonly byteLength: number;
  readonly maxByteLength = MAX_SANDBOX_NAME_BYTES;

  constructor(sandboxName: string, byteLength: number) {
    super(
      `Microsandbox sandbox name is ${byteLength} UTF-8 bytes, exceeding the ${MAX_SANDBOX_NAME_BYTES}-byte limit`,
    );
    this.sandboxName = sandboxName;
    this.byteLength = byteLength;
  }
}

/**
 * The create deadline supplied by the caller elapsed before the sandbox
 * finished booting.
 *
 * The create itself is NOT abandoned: the SDK exposes no cancellation for it,
 * so the adapter keeps watching that promise and, if the sandbox does finish
 * booting afterwards, reclaims it (kill + remove) rather than leaving a
 * running microVM nobody is waiting for and a name nobody can reuse.
 */
export class MicrosandboxCreateTimeoutError extends Error {
  override readonly name = "MicrosandboxCreateTimeoutError";
  readonly sandboxName: string;
  readonly timeoutMs: number;

  constructor(sandboxName: string, timeoutMs: number) {
    super(
      `Microsandbox sandbox "${sandboxName}" did not finish creating within ${timeoutMs}ms; a late create is reclaimed`,
    );
    this.sandboxName = sandboxName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A label lookup did not finish within its deadline.
 *
 * Raised rather than returning a partial page: a warm-lease decision made from
 * a truncated listing is a decision made from data the caller cannot tell apart
 * from "there is nothing else".
 */
export class MicrosandboxLookupTimeoutError extends Error {
  override readonly name = "MicrosandboxLookupTimeoutError";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, description: string) {
    super(`Microsandbox sandbox lookup exceeded ${timeoutMs}ms while ${description}`);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A label listing could not be drained to a trustworthy end.
 *
 * Raised rather than returning what was collected so far. A short list and a
 * complete one are indistinguishable to the caller, so a drain that gave up on
 * a cursor that never advances, or on a page body it cannot read, would answer
 * "there is nothing else" — and a warm-lease decision or a quota count made
 * from that answer is made from data the provider never actually supplied.
 */
export class MicrosandboxPaginationError extends Error {
  override readonly name = "MicrosandboxPaginationError";
  readonly pages: number;

  constructor(pages: number, detail: string) {
    super(`Microsandbox sandbox listing could not be drained after ${pages} page(s): ${detail}`);
    this.pages = pages;
  }
}

/**
 * A call gave up waiting for the process-global backend gate.
 *
 * The gate exists because `withDefaultBackend` mutates ONE process-wide slot,
 * so a call on backend A cannot run while backend B holds the scope. Normally
 * the wait is short. It is NOT short when the scope holder has been abandoned:
 * a create or a lookup that outlived its own client-side deadline returned a
 * typed error to ITS caller, but the SDK exposes no cancellation, so the
 * request is still in flight and the process-wide backend still has to be its
 * own until it settles.
 *
 * Waiting forever in that situation deadlocks every other backend in the
 * process. Running anyway would send this call to whatever backend the process
 * default happens to hold, which is the one outcome the gate exists to prevent.
 * So the queued call FAILS, loudly and with a typed error the caller can retry
 * on — the honest third option.
 */
export class MicrosandboxBackendBusyError extends Error {
  override readonly name = "MicrosandboxBackendBusyError";
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(
      `Microsandbox backend gate was held by another backend for ${waitedMs}ms; this call was not sent `
        + "rather than being sent to the wrong backend. A scope held this long usually means an SDK call "
        + "outlived its client-side deadline and is still in flight.",
    );
    this.waitedMs = waitedMs;
  }
}

/**
 * `startScript` was called for a session id that is already admitted for a
 * DIFFERENT command.
 *
 * Nothing was started and nothing was overwritten. A session id is the identity
 * of one run's durable state; reusing it for another command would either
 * strand the first run or report its exit code as the second one's.
 */
export class MicrosandboxSessionConflictError extends Error {
  override readonly name = "MicrosandboxSessionConflictError";
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Microsandbox run session "${sessionId}" is already admitted for a different command; nothing was submitted`,
    );
    this.sessionId = sessionId;
  }
}

/**
 * An admitted run can no longer produce an exit code.
 *
 * The wrapper writes the exit file as its final act, so a run whose process is
 * gone without one — killed, out of memory, or interrupted by a sandbox
 * restart — will never complete. Raised so a poll loop ends with a terminal
 * outcome instead of asking forever.
 */
export class MicrosandboxRunLostError extends Error {
  override readonly name = "MicrosandboxRunLostError";
  readonly sessionId: string;
  readonly commandId: string;
  readonly reason: string;

  constructor(sessionId: string, commandId: string, reason: string) {
    super(`Microsandbox run "${sessionId}" is no longer completable: ${reason}`);
    this.sessionId = sessionId;
    this.commandId = commandId;
    this.reason = reason;
  }
}

/**
 * `getExecLogs` was asked for a terminal result while the run is still going.
 *
 * The bootstrap-plane `ExecResult` has no "unfinished" value — its `exitCode`
 * is a number — so returning one here would have to invent a code. Callers poll
 * `getExecStatus` and read logs once it reports terminal.
 */
export class MicrosandboxRunNotFinishedError extends Error {
  override readonly name = "MicrosandboxRunNotFinishedError";
  readonly sessionId: string;
  readonly commandId: string;

  constructor(sessionId: string, commandId: string) {
    super(
      `Microsandbox run "${sessionId}" has not finished; its exit code is not known yet`,
    );
    this.sessionId = sessionId;
    this.commandId = commandId;
  }
}

// --- process-global backend gate -------------------------------------------
//
// WHAT ACTUALLY NEEDS GATING, and why it is only some of the SDK.
//
// `withDefaultBackend` swaps ONE process-wide slot and restores it in a
// `finally`; the SDK documents that it is not task-local. But only the SDK's
// STATIC entry points read that slot. `Sandbox` and `SandboxHandle` each
// capture their backend when they are resolved (`backendKind` on the instance)
// and every instance method delegates to that bound native object — so an
// exec, a filesystem call, a `connect`, a `start`/`stop`/`kill`/`remove` on a
// handle cannot observe the process default at all.
//
// So the gate covers exactly the default-dependent statics this adapter calls
// — `Sandbox.builder(...)` (the native builder is constructed by that call,
// so the whole chain through `create()` is held), `Sandbox.get` and
// `Sandbox.listWith` — and NOTHING else. Holding it across a bound instance
// call would be worse than useless: a single long-running exec would block
// every other backend's work in the process for the run's whole lifetime,
// buying no safety, because that exec was never reading the slot.
//
// Calls that want the SAME backend join the open scope and run concurrently —
// they cannot observe a wrong backend, because it is already theirs. A call
// that wants a DIFFERENT backend queues until the open scope has fully closed
// and the SDK has restored the previous value. Queueing is FIFO-fair: a newly
// arriving same-backend call joins only when nobody is already waiting, so a
// steady stream on one backend cannot starve the other indefinitely.
//
// Honest limits, both properties of the SDK's global state rather than of this
// gate: SDK calls made elsewhere in the process (another library, direct
// `microsandbox` use) are not routed through here and can still observe a
// scoped backend; and a callback that itself re-entered the gate with a
// different backend would wait on a scope it is holding open, so this adapter
// never nests gated calls.

type BackendScope = {
  key: string;
  active: number;
  closing: boolean;
  entered: Promise<void>;
  release: () => void;
  exited: Promise<void>;
};

let currentBackendScope: BackendScope | null = null;
const backendScopeWaiters: Array<() => void> = [];

/**
 * Is this runtime bound to the LOCAL backend?
 *
 * Two capability claims hinge on it — snapshot support and isolation — so it is
 * a named predicate rather than an inline `=== "local"` repeated at each site.
 */
function isLocalBackend(backend: MicrosandboxBackend): boolean {
  return backend === "local";
}

/**
 * Stable identity for a backend value. The API key is hashed rather than
 * stored, so a long-lived comparison key never holds the secret itself.
 */
function backendKey(backend: MicrosandboxBackend): string {
  if (backend === "local") {
    return "local";
  }
  if ("profile" in backend) {
    return `cloud:profile:${backend.profile}`;
  }
  const digest = createHash("sha256").update(backend.apiKey, "utf8").digest("hex").slice(0, 16);
  return `cloud:url:${backend.url ?? ""}:key:${digest}`;
}

async function withBackendScope<T>(
  sdk: MicrosandboxSdk,
  backend: MicrosandboxBackend,
  fn: () => Promise<T> | T,
  queueTimeoutMs: number,
): Promise<T> {
  const key = backendKey(backend);
  const queueDeadline = Date.now() + queueTimeoutMs;
  for (;;) {
    const open = currentBackendScope;
    if (open && !open.closing && open.key === key) {
      open.active += 1;
      try {
        // The scope may still be opening; running before it is entered would
        // run against whatever backend the process last had.
        await open.entered;
        return await fn();
      } finally {
        await leaveBackendScope(open);
      }
    }
    if (open) {
      // BOUNDED. An abandoned scope holder (a create or lookup that outlived
      // its client-side deadline) is still in flight and still owns the
      // process-wide backend, so this wait can otherwise never end.
      const remainingMs = queueDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new MicrosandboxBackendBusyError(queueTimeoutMs);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        new Promise<false>((resolve) => {
          // A stale resolver left here after the race is harmless: the waiter
          // list is spliced wholesale on release and resolving a promise
          // nobody awaits is a no-op.
          backendScopeWaiters.push(() => resolve(false));
        }),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), remainingMs);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        throw new MicrosandboxBackendBusyError(queueTimeoutMs);
      }
      continue;
    }

    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    let failEntry!: (error: unknown) => void;
    const entered = new Promise<void>((resolve, reject) => {
      markEntered = resolve;
      failEntry = reject;
    });
    // Nobody may await `entered` before its rejection handler is attached
    // below, and an unobserved rejection would otherwise surface as a process
    // warning; the catch here is the handler of record.
    entered.catch(() => undefined);
    const scope: BackendScope = {
      key,
      active: 1,
      closing: false,
      entered,
      release,
      exited: Promise.resolve(),
    };
    currentBackendScope = scope;

    let scopeCall: Promise<unknown>;
    try {
      // The scope stays open for as long as anyone is inside it: the SDK's
      // callback resolves only once the last participant has left.
      scopeCall = Promise.resolve(
        sdk.withDefaultBackend(backend, () => {
          markEntered();
          return drained;
        }),
      );
    } catch (error) {
      // A synchronous failure to push the scope — the SDK's own missing-native-
      // bindings guard throws exactly like this. Nothing ran, so free the gate
      // rather than wedging every later call in the process.
      abandonBackendScope(scope);
      throw error;
    }
    scope.exited = scopeCall.then(
      () => undefined,
      (error: unknown) => {
        // Rejected before the callback ran: the scope was never entered.
        // Rejected after: the caller's own call already carries the outcome.
        failEntry(error);
      },
    );

    try {
      await entered;
    } catch (error) {
      // FAIL CLOSED. Running the call anyway would send this runtime's work to
      // whatever backend the process default happens to hold.
      abandonBackendScope(scope);
      throw error;
    }

    try {
      return await fn();
    } finally {
      await leaveBackendScope(scope);
    }
  }
}

async function leaveBackendScope(scope: BackendScope): Promise<void> {
  scope.active -= 1;
  if (scope.active > 0 || scope.closing) {
    return;
  }
  scope.closing = true;
  scope.release();
  // Wait for the SDK to restore the previous backend BEFORE any queued call on
  // a different backend is allowed to open its own scope.
  await scope.exited;
  releaseBackendGate(scope);
}

/** Free the gate for a scope that never opened. */
function abandonBackendScope(scope: BackendScope): void {
  scope.closing = true;
  scope.release();
  releaseBackendGate(scope);
}

function releaseBackendGate(scope: BackendScope): void {
  if (currentBackendScope === scope) {
    currentBackendScope = null;
  }
  const waiters = backendScopeWaiters.splice(0);
  for (const wake of waiters) {
    wake();
  }
}

/**
 * One page of a label listing, validated before anything is read out of it.
 *
 * A listing is the ANSWER a warm-lease decision is made from, so a page this
 * adapter cannot read is a failure, never an empty result: quietly returning a
 * short list is indistinguishable to the caller from "there is nothing else",
 * and the caller then launches a sandbox it did not need or under-counts a
 * quota it is enforcing.
 */
function readSandboxPage(
  page: unknown,
  previousCursor: string | undefined,
  pageNumber: number,
): { sandboxes: MsbSandboxHandle[]; nextCursor?: string } {
  if (typeof page !== "object" || page === null) {
    throw new MicrosandboxPaginationError(pageNumber, "the provider returned a page that is not an object");
  }
  const record = page as { sandboxes?: unknown; nextCursor?: unknown };
  if (!Array.isArray(record.sandboxes)) {
    throw new MicrosandboxPaginationError(
      pageNumber,
      "the provider returned a page whose sandbox list is unreadable",
    );
  }
  const sandboxes = record.sandboxes as MsbSandboxHandle[];
  const cursor = record.nextCursor;
  if (cursor === undefined || cursor === null || cursor === "") {
    return { sandboxes };
  }
  if (typeof cursor !== "string") {
    throw new MicrosandboxPaginationError(
      pageNumber,
      "the provider returned a next-page cursor that is not a string",
    );
  }
  if (previousCursor !== undefined && cursor === previousCursor) {
    throw new MicrosandboxPaginationError(
      pageNumber,
      "the provider returned a next-page cursor identical to the one just used, so the listing cannot advance",
    );
  }
  return { sandboxes, nextCursor: cursor };
}

/**
 * What this runtime knows about one sandbox name.
 *
 * `owned` is the whole reason this registry exists: it is what separates a
 * sandbox this runtime launched (and may therefore stop, start, or delete)
 * from one it merely attached to. It is sticky-true — a later attach that does
 * not claim ownership cannot demote a sandbox this process launched, because
 * demoting it would strand a microVM nothing can reclaim.
 */
type RegisteredSandbox = {
  sandbox?: MsbSandbox;
  owned: boolean;
};

export class MicrosandboxRuntime implements SandboxRuntime, WorkflowRuntime {
  readonly id = "microsandbox";

  /**
   * Bootstrap-plane capabilities. These describe what THIS ADAPTER exposes
   * through the port, not everything the SDK can do — the same convention the
   * Daytona adapter follows.
   *
   * TWO OF THESE ARE BACKEND-SENSITIVE, and both were previously reported as
   * flat process-wide constants — which published a claim about the cloud
   * backend that this package cannot stand behind. They are now derived from
   * the backend this instance is bound to.
   *
   *  - `pty: false` — the SDK's `ExecOptionsBuilder.tty(true)` and
   *    `ExecHandle.resize()` are real, but the port has no pty method and this
   *    adapter never allocates one.
   *  - `snapshots` — LOCAL only. `launch` sources a sandbox from a snapshot via
   *    the builder's `fromSnapshot`, and what that consumes is a snapshot
   *    ARTIFACT: a host-local directory (the SDK stores them under
   *    `~/.microsandbox/snapshots/<name>/` and indexes them in a local DB
   *    cache). A cloud create has no access to that directory, so the cloud
   *    backend reports `false` and refuses the pairing outright — see the
   *    constructor. Note the adapter only ever CONSUMES a snapshot; it never
   *    creates one, so `SandboxHandle.snapshot()` is not on this path.
   *  - `isolation` — `'strong'` on LOCAL, `'unknown'` on CLOUD. Locally the SDK
   *    boots each sandbox as a microVM with its own guest kernel on a
   *    virtualization-capable host (KVM on Linux, Apple Silicon on macOS, WHP
   *    on Windows 10+), which this package can stand behind. The cloud
   *    backend's isolation, region placement and resource enforcement are
   *    vendor-documented but NOT observable from here, and this adapter runs no
   *    measurement against them — so it reports `'unknown'` rather than
   *    publishing an unverified `'strong'`. See {@link IsolationLevel}.
   *  - `persistentHandle: true` — a sandbox is re-resolvable by name from a
   *    fresh process via `Sandbox.get(name)` + `connect()`, and
   *    `launchDetached` sets `detached(true)` so it outlives this process.
   *  - `streamingLogs: false` — the SDK ships `logStream({follow:true})` and
   *    `execStream`, but this adapter's log path is a durable file read, so
   *    claiming a streaming capability here would be claiming a code path that
   *    does not exist.
   *
   * NOT SUPPORTED, and deliberately absent rather than silently ignored: custom
   * or published PORTS. The SDK builder exposes `port()`/`portBind()`/`portUdp()`,
   * but the ports this package targets have no public-port surface to express
   * them, so this adapter never calls them and never implies a reachable port.
   */
  readonly capabilities: RuntimeCapabilities;

  /**
   * Both true, and declared rather than left to default so the reasoning is on
   * the record. `warmLease`: `Sandbox.listWith(b => b.labels(...))` is a real
   * server-side label query with cursor pagination, so a warm-lease lookup is
   * meaningful. `lifecycle`: `start`/`stop` map onto `SandboxHandle.start()` /
   * `SandboxHandle.stop()`, which genuinely resume and halt a microVM — unlike
   * the E2B adapter, where both are no-ops. Both apply to sandboxes this
   * runtime OWNS; an attached sandbox is deliberately left alone.
   */
  readonly declaredCapabilities = { warmLease: true, lifecycle: true } as const;

  private readonly backend: MicrosandboxBackend;
  private readonly image?: string;
  private readonly snapshot?: string;
  private readonly homeDir: string;
  private readonly defaultWorkdir?: string;
  private readonly cpus?: number;
  private readonly memoryMiB?: number;
  private readonly idleTimeoutSeconds?: number;
  private readonly maxDurationSeconds?: number;
  private readonly replaceExisting: boolean;
  private readonly namePrefix: string;
  private readonly runStateDir: string;
  private readonly shell: string;
  private readonly connectTimeoutMs: number;
  private readonly lookupTimeoutMs: number;
  private readonly listPageSize: number;
  private readonly backendQueueTimeoutMs: number;
  private readonly injectedSdk?: MicrosandboxSdk;
  private sdkPromise?: Promise<MicrosandboxSdk>;

  // What this runtime knows about each sandbox name: the live instance
  // resolved in this process (if any) and whether this runtime owns it. A
  // cross-request access (an async-run poll tick) that misses the instance
  // re-resolves by name via `Sandbox.get(name).connect()` — the reattach that
  // lets a run outlive the request that started it.
  private readonly registry = new Map<string, RegisteredSandbox>();

  // Reclamations of creates that landed after their deadline, keyed by name.
  // A later launch of the same name waits for one so the two cannot race.
  private readonly pendingReclaims = new Map<string, Promise<void>>();

  constructor(options: MicrosandboxRuntimeOptions) {
    if (!options.image && !options.snapshot) {
      throw new Error(
        "MicrosandboxRuntime requires either `image` or `snapshot`: neither has a default that is correct for another consumer",
      );
    }
    if (options.image && options.snapshot) {
      throw new Error(
        "MicrosandboxRuntime accepts `image` or `snapshot`, not both: a sandbox has exactly one rootfs source",
      );
    }
    // Refused HERE — before the lazy `import("microsandbox")`, before any SDK
    // call, before a single byte leaves the process. A snapshot source is a
    // local-backend-only configuration, so this is a static fact about the
    // pairing rather than something the provider has to be asked about;
    // deferring it to `launch` would surface it as an opaque remote failure on
    // a path the caller was told existed.
    //
    // PROVENANCE: that Microsandbox CLOUD does not support snapshot-sourced
    // creates is vendor documentation, relayed by the sandbox program lead as a
    // release blocker; it is NOT derivable from microsandbox@0.6.11's typings,
    // which carry no cloud/local gating on the snapshot surface. What IS
    // checkable from the installed package, and what makes the restriction
    // coherent, is that a snapshot artifact is host-local: the SDK documents
    // them under `~/.microsandbox/snapshots/<name>/` and lists them from a
    // local DB cache, and a cloud create cannot resolve a host path.
    if (options.snapshot && !isLocalBackend(options.backend)) {
      throw new Error(
        "MicrosandboxRuntime cannot boot from a `snapshot` on the cloud backend: a snapshot artifact is host-local "
          + "(the SDK resolves it under ~/.microsandbox/snapshots/), so a cloud create cannot reach it. "
          + "Use `image` on the cloud backend, or set `backend: \"local\"` to boot from a snapshot.",
      );
    }
    this.backend = options.backend;
    if (options.image !== undefined) {
      this.image = options.image;
    }
    if (options.snapshot !== undefined) {
      this.snapshot = options.snapshot;
    }
    this.homeDir = options.homeDir;
    if (options.workdir !== undefined) {
      this.defaultWorkdir = options.workdir;
    }
    if (options.cpus !== undefined) {
      this.cpus = options.cpus;
    }
    if (options.memoryMiB !== undefined) {
      this.memoryMiB = options.memoryMiB;
    }
    if (options.idleTimeoutSeconds !== undefined) {
      this.idleTimeoutSeconds = options.idleTimeoutSeconds;
    }
    if (options.maxDurationSeconds !== undefined) {
      this.maxDurationSeconds = options.maxDurationSeconds;
    }
    this.capabilities = {
      pty: false,
      snapshots: isLocalBackend(options.backend),
      isolation: isLocalBackend(options.backend) ? "strong" : "unknown",
      persistentHandle: true,
      streamingLogs: false,
    };
    this.replaceExisting = options.replaceExisting ?? false;
    this.namePrefix = options.namePrefix ?? "";
    this.runStateDir = (options.runStateDir ?? DEFAULT_RUN_STATE_DIR).replace(/\/+$/, "");
    this.shell = options.shell ?? DEFAULT_SHELL;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.listPageSize = options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE;
    this.backendQueueTimeoutMs = options.backendQueueTimeoutMs ?? DEFAULT_BACKEND_QUEUE_TIMEOUT_MS;
    if (options.sdk !== undefined) {
      this.injectedSdk = options.sdk;
    }
  }

  // --- lookup --------------------------------------------------------------

  async findByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    // Exclusions are applied DURING the drain, never to the collected page:
    // filtering afterwards would let a page full of already-claimed sandboxes
    // answer "nothing warm available" while the next page held a free one.
    const handles = await this.collectByLabels(labels, {
      states: options.states === undefined ? ["STARTED"] : options.states,
      cap: 1,
      requestSize: options.limit ?? options.pageSize,
      excludeIds: options.excludeIds,
      timeoutMs: options.timeoutMs,
      claim: options.owned ?? false,
      description: "listing matching sandboxes",
    });
    return handles[0] ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    return this.collectByLabels(labels, {
      states: options.states === undefined ? ["STARTED"] : options.states,
      // `limit` caps RESULTS as well as sizing the request; `pageSize` only
      // sizes the request. Treating a page size as a result cap would silently
      // truncate a listing the caller asked to receive in full.
      ...(options.limit !== undefined ? { cap: options.limit } : {}),
      requestSize: options.limit ?? options.pageSize,
      excludeIds: options.excludeIds,
      timeoutMs: options.timeoutMs,
      claim: options.owned ?? false,
      description: "listing matching sandboxes",
    });
  }

  async countByLabels(
    labels: Record<string, string>,
    options: SandboxCountOptions = {},
  ): Promise<number> {
    const maxCount = options.maxCount === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxCount));
    if (maxCount === 0) {
      // Short-circuit: a cap of zero can be answered without a network call.
      return 0;
    }
    const handles = await this.collectByLabels(labels, {
      states: options.states === undefined ? ["STARTED"] : options.states,
      ...(Number.isFinite(maxCount) ? { cap: maxCount } : {}),
      requestSize: options.limit ?? options.pageSize,
      timeoutMs: options.timeoutMs,
      description: "counting matching sandboxes",
    });
    return handles.length;
  }

  /**
   * Drain the cursor-paginated, server-side label listing, keeping the entries
   * that match `states` and are not excluded, and stopping as soon as `cap`
   * such handles are collected or the lookup deadline elapses.
   */
  private async collectByLabels(
    labels: Record<string, string>,
    options: {
      states: readonly string[] | null;
      cap?: number;
      requestSize?: number | undefined;
      excludeIds?: readonly string[] | undefined;
      timeoutMs?: number | undefined;
      /**
       * Register what the listing finds, with this ownership. A lookup is an
       * attach, so it is `false` unless the caller explicitly claims what it
       * finds — the same rule the Daytona adapter applies at its own
       * `registerSandbox` call sites. Omitted entirely for a count, which
       * resolves nothing the caller can act on.
       */
      claim?: boolean;
      description: string;
    },
  ): Promise<RuntimeHandle[]> {
    // Request size, resolved exactly as Daytona/E2B/local resolve it, so a
    // caller that tuned one provider's lookup gets the same request shape here.
    const limit = options.requestSize ?? this.listPageSize;
    const excluded = new Set(options.excludeIds ?? []);
    const deadline = this.lookupDeadline(options.timeoutMs);
    const handles: RuntimeHandle[] = [];
    let cursor: string | undefined;
    // Bounded so a backend that keeps handing back the same cursor cannot spin
    // this loop forever. The deadline bounds it in wall-clock terms too.
    for (let page = 0; page < 1_000; page += 1) {
      const cursorForPage = cursor;
      const raw = await this.awaitWithin(
        this.withBackendStatic((sdk) =>
          sdk.Sandbox.listWith((builder) => {
            let configured = builder.limit(limit);
            if (hasEntries(labels)) {
              configured = configured.labels(labels);
            }
            if (cursorForPage) {
              configured = configured.cursor(cursorForPage);
            }
            return configured;
          }),
        ),
        deadline,
        options.description,
      );
      const result = readSandboxPage(raw, cursorForPage, page + 1);
      for (const entry of result.sandboxes) {
        if (!matchesState(entry.status, options.states) || excluded.has(entry.name)) {
          continue;
        }
        if (options.claim !== undefined) {
          this.register(entry.name, { owned: options.claim });
        }
        handles.push(handleFromSandboxHandle(entry));
        if (options.cap !== undefined && handles.length >= options.cap) {
          return handles;
        }
      }
      if (!result.nextCursor) {
        return handles;
      }
      cursor = result.nextCursor;
    }
    return handles;
  }

  async getById(
    id: string,
    options: {
      states?: readonly string[] | null;
      owned?: boolean;
      homeDir?: string;
      workdir?: string;
    } = {},
  ): Promise<RuntimeHandle | null> {
    const entry = await this.lookupHandle(id);
    if (!entry) {
      return null;
    }
    // `undefined` means "the caller did not filter"; `null` means "any state".
    const states = options.states === undefined ? null : options.states;
    if (!matchesState(entry.status, states)) {
      return null;
    }
    // Ownership defaults to FALSE, exactly as it does on the Daytona adapter:
    // resolving a sandbox by name is an attach, and an attach is not a claim.
    // `stop`, `start` and `destroy` refuse to touch a sandbox that was never
    // claimed, so a lease-reattach path cannot delete a sandbox it borrowed.
    this.register(id, { owned: options.owned ?? false });
    const handle = handleFromSandboxHandle(entry);
    if (options.homeDir !== undefined) {
      handle.homeDir = options.homeDir;
    }
    if (options.workdir !== undefined) {
      handle.workdir = options.workdir;
    }
    return handle;
  }

  // --- launch --------------------------------------------------------------

  async launch(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    return this.createSandbox(options, false);
  }

  async launchDetached(options: LaunchOptions = {}): Promise<RuntimeHandle> {
    // A detached sandbox keeps running after this Node process exits, so a
    // short-lived request context can return before the workload finishes and a
    // later tick can reattach by name.
    return this.createSandbox(options, true);
  }

  private async createSandbox(
    options: LaunchOptions,
    detached: boolean,
  ): Promise<RuntimeHandle> {
    const name = this.resolveName(options.name);
    // A previous create under this name may still be being reclaimed. Waiting
    // keeps the reclamation from killing the sandbox this call is about to
    // create under the same name.
    const pending = this.pendingReclaims.get(name);
    if (pending) {
      await pending;
    }
    const workdir = options.workdir ?? this.defaultWorkdir;
    const create = this.withBackendStatic(async (sdk) => {
      let builder = sdk.Sandbox.builder(name);
      builder = this.snapshot
        ? builder.fromSnapshot(this.snapshot)
        : builder.image(this.image as string);
      if (this.cpus !== undefined) {
        builder = builder.cpus(this.cpus);
      }
      if (this.memoryMiB !== undefined) {
        builder = builder.memory(this.memoryMiB);
      }
      if (this.idleTimeoutSeconds !== undefined) {
        builder = builder.idleTimeout(this.idleTimeoutSeconds);
      }
      if (this.maxDurationSeconds !== undefined) {
        builder = builder.maxDuration(this.maxDurationSeconds);
      }
      if (workdir !== undefined) {
        builder = builder.workdir(workdir);
      }
      if (hasEntries(options.env)) {
        builder = builder.envs(options.env);
      }
      const labels = mergeLabels(options.labels, options.label);
      if (hasEntries(labels)) {
        builder = builder.labels(labels);
      }
      if (detached) {
        builder = builder.detached(true);
      }
      if (this.replaceExisting) {
        builder = builder.replace();
      }
      return builder.create();
    });

    // The builder has no create-timeout setter, and `maxDuration` is a sandbox
    // LIFETIME budget — mapping the caller's boot deadline onto it would kill
    // every long-lived sandbox the moment that deadline elapsed. So the create
    // deadline is enforced here instead.
    let sandbox: MsbSandbox;
    if (options.createTimeoutSeconds) {
      const timeoutMs = options.createTimeoutSeconds * 1000;
      try {
        sandbox = await withDeadline(create, timeoutMs, name);
      } catch (error) {
        if (error instanceof MicrosandboxCreateTimeoutError) {
          this.reclaimLateCreate(name, create);
        }
        throw error;
      }
    } else {
      sandbox = await create;
    }

    this.register(name, { sandbox, owned: true });
    const handle: RuntimeHandle = { id: name, state: "STARTED", homeDir: this.homeDir };
    if (workdir !== undefined) {
      handle.workdir = workdir;
    }
    return handle;
  }

  /**
   * Take responsibility for a create that lost the race with its deadline.
   *
   * The SDK offers no way to cancel an in-flight create, so the promise is
   * watched instead of dropped. Two things follow from that, and both matter:
   * the eventual rejection is consumed here (an abandoned rejected promise is
   * an unhandled rejection, which crashes a Node process configured to treat
   * them as fatal), and an eventual SUCCESS is reclaimed — the caller already
   * saw a failure, so a sandbox nobody is waiting for would otherwise burn
   * provider resources and hold its name against the next launch.
   */
  private reclaimLateCreate(name: string, create: Promise<MsbSandbox>): void {
    const reclaimed = create.then(
      async () => {
        try {
          await this.forceDestroy(name);
        } catch {
          // Best effort. The sandbox stays addressable under its deterministic
          // name, so an operator (or a later launch of the same name) can still
          // reclaim it.
        }
      },
      () => {
        // The create failed on its own: there is nothing to reclaim, and the
        // caller already has the timeout error.
      },
    );
    const tracked = reclaimed.finally(() => {
      if (this.pendingReclaims.get(name) === tracked) {
        this.pendingReclaims.delete(name);
      }
    });
    this.pendingReclaims.set(name, tracked);
  }

  private resolveName(requested?: string): string {
    const name = requested ?? `${this.namePrefix}${randomUUID()}`;
    const byteLength = Buffer.byteLength(name, "utf8");
    if (byteLength > MAX_SANDBOX_NAME_BYTES) {
      throw new MicrosandboxNameTooLongError(name, byteLength);
    }
    return name;
  }

  // --- exec ----------------------------------------------------------------

  /** Bootstrap-plane exec. Same call as `runScript`, narrower result shape. */
  async exec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await this.runScript(handle, {
      command,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { output: result.output, exitCode: result.exitCode ?? 0 };
  }

  async runScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    const cwd = options.cwd ?? handle.workdir;
    // `shell(script)` takes no options, so a configurable POSIX shell with
    // `-c` is what carries cwd / env / timeout onto a command string. The
    // command travels as an argv element, so nothing quotes or rewrites it.
    // Off the gate: `sandbox` is bound to the backend it was resolved on, so
    // this reads no process-wide state — and holding the gate for the whole
    // command would block every other backend in the process meanwhile.
    const output = await sandbox.execWith(this.shell, (builder) => {
        let configured = builder.args(["-c", options.command]);
        if (cwd !== undefined) {
          configured = configured.cwd(cwd);
        }
        if (hasEntries(options.env)) {
          configured = configured.envs(options.env);
        }
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          configured = configured.timeout(options.timeoutMs);
        }
      return configured;
    });
    const stdout = output.stdout();
    const stderr = output.stderr();
    // A non-zero exit is a RESULT here, not an exception: the SDK resolves
    // `ExecOutput` with `code`/`success` rather than throwing.
    return {
      output: combineOutput(stdout, stderr),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      exitCode: typeof output.code === "number" ? output.code : null,
    };
  }

  /**
   * Submit one durable async run.
   *
   * The guest wrapper (see {@link MICROSANDBOX_RUN_ADMIT_SCRIPT}) claims the
   * session's run directory with an atomic `mkdir`, so this is idempotent in
   * the way that actually matters for an outcome-unknown submit: a retry of
   * the SAME command adopts the run that is already there (`reconciled: true`)
   * instead of starting a second one, and a retry with a DIFFERENT command is
   * refused instead of overwriting the first run's state.
   */
  async startScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    suppressInputEcho?: boolean;
  }): Promise<AsyncRunStartResult> {
    const sandbox = await this.requireSandbox(handle);
    const sessionId = options.sessionId ?? `run-${handle.id}-${randomUUID()}`;
    const dir = this.scriptRunDir(sessionId);
    const cwd = options.cwd ?? handle.workdir;
    const output = await sandbox.execWith(this.shell, (builder) => {
        let configured = builder.args([
          "-c",
          MICROSANDBOX_RUN_ADMIT_SCRIPT,
          "msb-admit",
          options.command,
          dir,
          this.runStateDir,
          this.shell,
        ]);
        if (cwd !== undefined) {
          configured = configured.cwd(cwd);
        }
        if (hasEntries(options.env)) {
          configured = configured.envs(options.env);
        }
        // The caller's `timeoutMs` bounds the SUBMIT call only. It is
        // deliberately NOT applied to the backgrounded command: the command's
        // lifetime is the sandbox's, and applying the submit deadline here
        // would kill every long-running run the moment submission completed.
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          configured = configured.timeout(options.timeoutMs);
        }
      return configured;
    });
    const marker = output.stdout().trim();
    if (marker.startsWith("ADMITTED ")) {
      return { sessionId, commandId: marker.slice("ADMITTED ".length).trim() };
    }
    if (marker.startsWith("CLAIMED ")) {
      return {
        sessionId,
        commandId: marker.slice("CLAIMED ".length).trim(),
        reconciled: true,
      };
    }
    if (marker === "CONFLICT") {
      throw new MicrosandboxSessionConflictError(sessionId);
    }
    throw new Error(
      `Microsandbox async run admission for session "${sessionId}" returned no verdict (exit ${output.code}): ${
        summarize(output.stderr() || marker)
      }`,
    );
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<AsyncRunStatus> {
    const sandbox = await this.requireSandbox(handle);
    const dir = this.scriptRunDir(sessionId);
    let marker: string;
    try {
      const output = await sandbox.execWith(this.shell, (builder) =>
        builder.args(["-c", MICROSANDBOX_RUN_STATUS_SCRIPT, "msb-status", dir]),
      );
      marker = (output.stdout() ?? "").trim();
    } catch {
      // A failed probe says nothing about the run. Report it as unfinished and
      // let the caller poll again, exactly as a dropped status read should.
      return { exitCode: null };
    }
    if (marker.startsWith("EXIT ")) {
      const parsed = Number.parseInt(marker.slice("EXIT ".length).trim(), 10);
      if (Number.isFinite(parsed)) {
        return { exitCode: parsed };
      }
      // The wrapper finished and recorded something unreadable. Inventing a
      // code would be a lie and reporting "running" would poll forever.
      throw new MicrosandboxRunLostError(
        sessionId,
        commandId,
        "its recorded exit code is unreadable",
      );
    }
    if (marker === "RUNNING") {
      return { exitCode: null };
    }
    if (marker === "MISSING") {
      throw new MicrosandboxRunLostError(
        sessionId,
        commandId,
        "its run-state directory is gone",
      );
    }
    if (marker.startsWith("LOST")) {
      const reason = marker.slice("LOST".length).trim();
      throw new MicrosandboxRunLostError(
        sessionId,
        commandId,
        reason === "sandbox-restarted"
          ? "the sandbox restarted while it was running"
          : "its process is gone and it never recorded an exit code",
      );
    }
    // Unrecognized output is an unreadable probe, not a verdict.
    return { exitCode: null };
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    const outPath = `${this.scriptRunDir(sessionId)}/out`;
    const output = await this.readFileBestEffort(sandbox, outPath, SCRIPT_LOG_READ_MAX_BYTES);
    // exitCode stays null: `getScriptStatus` is the single source of truth for
    // the exit code, matching the Daytona, E2B and local adapters.
    return { output, exitCode: null, cmdId: commandId };
  }

  // --- bootstrap-plane async exec aliases ----------------------------------

  async startExec(
    handle: RuntimeHandle,
    command: string,
    options: ExecOptions & { sessionId?: string } = {},
  ): Promise<AsyncExecStartResult> {
    return this.startScript(handle, { command, ...options });
  }

  async getExecStatus(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<AsyncExecStatus> {
    return this.getScriptStatus(handle, sessionId, commandId);
  }

  /**
   * Terminal result of an async run: its captured output AND the exit code the
   * run actually recorded.
   *
   * The exit code comes from `getScriptStatus`, never from the log read.
   * `getScriptLogs` reports `exitCode: null` by design, and defaulting that to
   * `0` here would report every unfinished — and every lost — run as a success.
   */
  async getExecLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<ExecResult> {
    const status = await this.getScriptStatus(handle, sessionId, commandId);
    if (status.exitCode === null) {
      throw new MicrosandboxRunNotFinishedError(sessionId, commandId);
    }
    const logs = await this.getScriptLogs(handle, sessionId, commandId);
    return { output: logs.output, exitCode: status.exitCode };
  }

  // --- files ---------------------------------------------------------------

  /**
   * Put one file into the guest.
   *
   * A `string` source is a HOST PATH and a `Buffer` source is file CONTENT —
   * the same split the Daytona adapter uses, so this class's `uploadFile` and
   * `uploadBundle` cannot disagree with each other.
   */
  async uploadFile(
    handle: RuntimeHandle,
    source: string | Buffer,
    destination: string,
  ): Promise<void> {
    const sandbox = await this.requireSandbox(handle);
    const fs = sandbox.fs();
    await this.ensureParentDir(fs, destination);
    if (typeof source === "string") {
      await fs.copyFromHost(source, destination);
      return;
    }
    await fs.write(destination, toUint8Array(source));
  }

  async uploadBundle(handle: RuntimeHandle, options: {
    files: Array<{ source: string | Buffer; destination: string }>;
  }): Promise<void> {
    for (const file of options.files) {
      await this.uploadFile(handle, file.source, file.destination);
    }
  }

  async downloadFile(
    handle: RuntimeHandle,
    source: string,
    destination?: string,
  ): Promise<Buffer | void> {
    const sandbox = await this.requireSandbox(handle);
    const fs = sandbox.fs();
    if (destination) {
      await fs.copyToHost(source, destination);
      return;
    }
    const bytes = await fs.read(source);
    return Buffer.from(bytes);
  }

  async getHomeDir(handle: RuntimeHandle): Promise<string> {
    // The guest home directory is a property of the image, which this package
    // does not choose, so it is injected rather than probed.
    return handle.homeDir ?? this.homeDir;
  }

  // --- lifecycle -----------------------------------------------------------
  //
  // Every method below changes remote state, so every one of them first asks
  // whether this runtime OWNS the sandbox. A sandbox is owned when this runtime
  // launched it, or when the caller said so explicitly via
  // `getById(id, { owned: true })`. Anything else was borrowed — a warm lease
  // found by label, a sandbox another process launched — and borrowing does not
  // confer the right to halt, boot, or delete it.

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    if (!this.isOwned(handle.id)) {
      // Not ours: booting someone else's stopped sandbox would charge them for
      // a microVM they chose to have stopped.
      return handle;
    }
    const entry = await this.lookupHandle(handle.id);
    if (!entry) {
      throw new Error(`Microsandbox sandbox "${handle.id}" is no longer available`);
    }
    const sandbox = await entry.start();
    this.register(handle.id, { sandbox });
    return { ...handle, state: "STARTED" };
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    if (!this.isOwned(handle.id)) {
      return;
    }
    const entry = await this.lookupHandle(handle.id);
    if (!entry) {
      // Already gone: stopping is idempotent, so this is success, not an error.
      return;
    }
    this.forgetInstance(handle.id);
    await entry.stop();
  }

  /**
   * Halt the sandbox AND drop its database record — but only if this runtime
   * owns it.
   *
   * Both halves of the teardown matter: the name is the identity, so leaving a
   * stopped record behind would make the next `launch` under that name collide.
   * The ownership check matters more: `destroy` is the one call here that
   * cannot be undone, and a lease-reattach path that resolved a borrowed
   * sandbox by name must not be able to delete it. An unowned (or unknown)
   * handle drops this runtime's local state and makes no remote call at all.
   */
  async destroy(handle: RuntimeHandle): Promise<void> {
    if (!this.isOwned(handle.id)) {
      this.registry.delete(handle.id);
      return;
    }
    this.forgetInstance(handle.id);
    await this.forceDestroy(handle.id);
    // Dropped only after the remote teardown succeeded: keeping the ownership
    // record through a failure is what lets the caller retry it.
    this.registry.delete(handle.id);
  }

  /**
   * Kill + remove by name, with no ownership check.
   *
   * Private on purpose: the only callers are `destroy` (which has already
   * checked) and the reclamation of a create that landed after its deadline
   * (which is reclaiming a sandbox this runtime itself asked for).
   */
  private async forceDestroy(name: string): Promise<void> {
    const entry = await this.lookupHandle(name);
    if (!entry) {
      return;
    }
    try {
      await entry.kill();
    } catch (error) {
      // `remove` requires a stopped sandbox; a kill that failed because it was
      // already stopped must not block the removal that frees the name.
      if (!isSandboxNotFound(error) && !isAlreadyStopped(error)) {
        throw error;
      }
    }
    try {
      await entry.remove();
    } catch (error) {
      if (!isSandboxNotFound(error)) {
        throw error;
      }
    }
  }

  // --- internals -----------------------------------------------------------

  private async sdk(): Promise<MicrosandboxSdk> {
    if (this.injectedSdk) {
      return this.injectedSdk;
    }
    if (!this.sdkPromise) {
      // Lazy — keeps `microsandbox` and its platform-specific native addon out
      // of every non-microsandbox consumer.
      const loading = import("microsandbox").then(
        (mod) => mod as unknown as MicrosandboxSdk,
        (error: unknown) => {
          // A cached rejection would fail every later call for the life of the
          // process, so the slot is cleared and the constraint that most often
          // explains the failure is stated instead of buried.
          if (this.sdkPromise === loading) {
            delete this.sdkPromise;
          }
          throw new Error(
            "MicrosandboxRuntime could not load its optional peer dependency \"microsandbox\" (>=0.6.11 <0.7.0). "
              + "That package declares Node.js >= 22 and ships a platform-specific native addon "
              + "(macOS arm64, Linux x64/arm64, Windows x64/arm64); its local backend additionally requires "
              + `hardware virtualization (KVM, Apple Silicon, or WHP). Underlying error: ${errorMessage(error)}`,
            { cause: error },
          );
        },
      );
      this.sdkPromise = loading;
    }
    return this.sdkPromise;
  }

  /**
   * Run one DEFAULT-DEPENDENT SDK static with this runtime's backend in scope.
   *
   * `setDefaultBackend` is never called from this adapter: constructing a
   * runtime must not mutate the host process. The scoped form IS process-wide
   * while it is open, which is why every static goes through the module's
   * backend gate (see `withBackendScope`) rather than opening its own scope.
   *
   * ONLY the three statics this adapter calls belong here — `Sandbox.builder`
   * (through its terminal `create()`), `Sandbox.get` and `Sandbox.listWith`.
   * Operations on a resolved `Sandbox` or `SandboxHandle` are bound to the
   * backend they were resolved on and are issued directly, off the gate.
   */
  private async withBackendStatic<T>(
    fn: (sdk: MicrosandboxSdk) => Promise<T> | T,
  ): Promise<T> {
    const sdk = await this.sdk();
    return withBackendScope(sdk, this.backend, () => fn(sdk), this.backendQueueTimeoutMs);
  }

  private async lookupHandle(name: string): Promise<MsbSandboxHandle | null> {
    try {
      return (await this.withBackendStatic((sdk) => sdk.Sandbox.get(name))) ?? null;
    } catch (error) {
      if (isSandboxNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private register(
    name: string,
    patch: { sandbox?: MsbSandbox; owned?: boolean },
  ): RegisteredSandbox {
    const existing = this.registry.get(name);
    const sandbox = patch.sandbox ?? existing?.sandbox;
    const entry: RegisteredSandbox = {
      // Sticky: an attach that does not claim ownership cannot demote a
      // sandbox this runtime launched, because demoting it would leave a
      // microVM this process is responsible for with nothing able to reclaim
      // it.
      owned: (existing?.owned ?? false) || (patch.owned ?? false),
      ...(sandbox ? { sandbox } : {}),
    };
    this.registry.set(name, entry);
    return entry;
  }

  private isOwned(name: string): boolean {
    return this.registry.get(name)?.owned ?? false;
  }

  /** Drop the live connection but keep what this runtime knows about the name. */
  private forgetInstance(name: string): void {
    const existing = this.registry.get(name);
    if (!existing) {
      return;
    }
    this.registry.set(name, { owned: existing.owned });
  }

  private async requireSandbox(handle: RuntimeHandle): Promise<MsbSandbox> {
    const cached = this.registry.get(handle.id)?.sandbox;
    if (cached) {
      return cached;
    }
    const entry = await this.lookupHandle(handle.id);
    if (!entry) {
      throw new Error(`Microsandbox sandbox "${handle.id}" is no longer available`);
    }
    // `connect` attaches WITHOUT taking lifecycle ownership, so a poll tick
    // that reattaches cannot accidentally stop a sandbox it did not launch.
    const sandbox = await entry.connectWithTimeout(this.connectTimeoutMs);
    this.register(handle.id, { sandbox });
    return sandbox;
  }

  private async ensureParentDir(fs: MsbFsOps, destination: string): Promise<void> {
    const parent = parentDir(destination);
    if (!parent) {
      return;
    }
    try {
      await fs.mkdir(parent);
    } catch {
      // Best effort: an already-present directory is the common case and must
      // not fail the upload that follows.
    }
  }

  private async readFileBestEffort(
    sandbox: MsbSandbox,
    path: string,
    maxBytes: number,
  ): Promise<string> {
    // Read through a bounded `tail -c` rather than `fs.readToString`: it yields
    // "" instead of throwing while the file is still absent, and caps the bytes
    // pulled back to the caller.
    try {
      const output = await sandbox.execWith(this.shell, (builder) =>
        builder.args([
          "-c",
          `tail -c ${maxBytes} ${shellSingleQuote(path)} 2>/dev/null || true`,
        ]),
      );
      return output.stdout() ?? "";
    } catch {
      return "";
    }
  }

  private lookupDeadline(timeoutMs: number | undefined): { endsAt: number; timeoutMs: number } {
    const requested = timeoutMs ?? this.lookupTimeoutMs;
    const normalized = Number.isFinite(requested) && requested > 0
      ? Math.max(1, Math.ceil(requested))
      : this.lookupTimeoutMs;
    return { endsAt: Date.now() + normalized, timeoutMs: normalized };
  }

  private async awaitWithin<T>(
    operation: Promise<T>,
    deadline: { endsAt: number; timeoutMs: number },
    description: string,
  ): Promise<T> {
    const remainingMs = deadline.endsAt - Date.now();
    if (remainingMs <= 0) {
      throw new MicrosandboxLookupTimeoutError(deadline.timeoutMs, description);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new MicrosandboxLookupTimeoutError(deadline.timeoutMs, description)),
            remainingMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Guest directory holding one session's run state.
   *
   * The encoding is reversible, so two different session ids can never land on
   * one directory. A sanitizing replacement cannot promise that: it maps `a/b`
   * and `a_b` onto the same path, which is enough to hand one run's exit code
   * to the other.
   */
  private scriptRunDir(sessionId: string): string {
    return `${this.runStateDir}/${encodeRunSegment(sessionId)}`;
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * Normalize an SDK status onto the `STARTED`/`STOPPED` vocabulary the delivery
 * path reasons about.
 *
 * `draining` reads as STOPPED on purpose: a draining sandbox is on its way
 * down, so handing it back as a warm lease would hand a caller a sandbox that
 * is about to disappear underneath it.
 */
function normalizeStatus(status: MicrosandboxStatus | undefined): string {
  return status === "running" ? "STARTED" : "STOPPED";
}

function matchesState(
  status: MicrosandboxStatus | undefined,
  states: readonly string[] | null,
): boolean {
  if (states === null) {
    return true;
  }
  return states.includes(normalizeStatus(status));
}

function handleFromSandboxHandle(entry: MsbSandboxHandle): RuntimeHandle {
  return {
    id: entry.name,
    state: normalizeStatus(entry.status),
    ...(entry.createdAt ? { createdAt: entry.createdAt.toISOString() } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt.toISOString() } : {}),
  };
}

function mergeLabels(
  labels: Record<string, string> | undefined,
  label: string | undefined,
): Record<string, string> {
  return {
    ...(labels ?? {}),
    ...(label ? { label } : {}),
  };
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) {
    return stdout.endsWith("\n") || stderr.startsWith("\n")
      ? `${stdout}${stderr}`
      : `${stdout}\n${stderr}`;
  }
  return stdout || stderr || "";
}

/**
 * Reversible path-segment encoding for a session id.
 *
 * Every byte outside `[A-Za-z0-9_-]` becomes `%XX`, including `%` itself, so
 * distinct ids always produce distinct segments. An id long enough to threaten
 * the guest filesystem's 255-byte filename limit collapses to a digest instead;
 * the leading `.` cannot be produced by the encoder, so a digest segment can
 * never be confused with an encoded one.
 */
function encodeRunSegment(sessionId: string): string {
  const encoded = sessionId.replace(/[^A-Za-z0-9_-]/g, (character) =>
    [...Buffer.from(character, "utf8")]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
  if (Buffer.byteLength(encoded, "utf8") <= MAX_RUN_SEGMENT_BYTES) {
    return encoded;
  }
  return `.${createHash("sha256").update(sessionId, "utf8").digest("hex")}`;
}

/** Exact when the SDK's typed error code is present; textual only as a fallback. */
function isSandboxNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    // The SDK tags every error with a `MicrosandboxErrorCode`, so when a code is
    // present it is authoritative and no message sniffing happens at all.
    return code === "sandboxNotFound";
  }
  const name = (error as { name?: unknown }).name;
  if (name === "SandboxNotFoundError") {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /sandbox\s+not\s+found/i.test(message);
}

function isAlreadyStopped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /already\s+stopped|not\s+running/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bound a provider string before it is interpolated into an error message. */
function summarize(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed || "(no output)";
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  sandboxName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MicrosandboxCreateTimeoutError(sandboxName, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function parentDir(path: string): string | null {
  const index = path.lastIndexOf("/");
  if (index <= 0) {
    return null;
  }
  return path.slice(0, index);
}

function toUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function hasEntries(record?: Record<string, string>): record is Record<string, string> {
  return !!record && Object.keys(record).length > 0;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
