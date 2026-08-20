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
 * Hard bound on pages drained for one lookup. Reaching it is a failure, never
 * a result — see the throw at the end of `collectByLabels`.
 */
const MAX_LIST_PAGES = 1_000;
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

/**
 * Where the guest's process table lives. Passed to the run scripts as an
 * argument rather than written into them, so the same scripts can be executed
 * against a synthetic procfs in tests; the value the adapter sends is never
 * anything else, and is never taken from caller-supplied environment.
 */
const GUEST_PROC_ROOT = "/proc";

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
 * Read a pid's START TIME (field 22 of `/proc/<pid>/stat`, in clock ticks
 * since boot) into stdout, or fail with a non-zero status when procfs cannot
 * answer.
 *
 * WHY IT IS PART OF RUN IDENTITY. A pid alone does not identify a process: the
 * guest can recycle it, and a recycled pid answers `kill -0` exactly like the
 * original, so a run whose process died would keep reporting RUNNING forever
 * as soon as something else landed on its number. Start time is the field that
 * makes the pair unique for the lifetime of a boot — two processes on the same
 * pid cannot share it.
 *
 * The parse is byte-careful for one specific reason: field 2 is the executable
 * name in parentheses and MAY CONTAIN SPACES AND PARENTHESES, so splitting the
 * line on whitespace from the left is wrong. Every field after it is numeric or
 * a single flag character, so the LAST `") "` in the line is always the end of
 * that field — which is what `##*") "` finds. Start time is then the 20th field
 * of the remainder (22 overall, less the pid and the name).
 *
 * @internal Shared by both scripts below; not part of the public API.
 */
const MSB_STARTTIME_FN = [
  // `$1` procfs root, `$2` pid. The root is a PARAMETER rather than a literal
  // so the identity check is executable against a synthetic procfs in tests —
  // on every platform, not only on hosts that have a real one. It is passed by
  // the adapter as a positional argument and is never read from the
  // environment, which the caller controls: a run's liveness verdict must not
  // be redirectable by whoever submitted it.
  "msb_starttime() {",
  '  msb_st=$(cat "$1/$2/stat" 2>/dev/null) || return 1',
  '  msb_rest=${msb_st##*") "}',
  '  if [ "$msb_rest" = "$msb_st" ]; then return 1; fi',
  "  set -- $msb_rest",
  '  if [ "$#" -lt 20 ]; then return 1; fi',
  '  printf %s "${20}"',
  "}",
].join("\n");

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
  "proc_root=$5",
  MSB_STARTTIME_FN,
  'mkdir -p "$parent" 2>/dev/null || true',
  'if mkdir "$dir" 2>/dev/null; then',
  // Record the command BEFORE starting anything: a crash between the two
  // leaves a claimed-but-dead session, which the status probe reports as lost,
  // rather than an unattributable running process.
  '  printf %s "$cmd" > "$dir/cmd"',
  // Boot identity, used by the status probe to tell "still running" from "the
  // sandbox restarted and this pid now belongs to someone else". Absent on a
  // guest without procfs, in which case the probe falls back to pid liveness.
  '  cat "$proc_root/sys/kernel/random/boot_id" > "$dir/boot" 2>/dev/null || true',
  // The command runs in a CHILD shell, so an `exit 7` inside it cannot skip
  // the exit-code record: the child exits, the wrapper writes its status.
  '  nohup "$shell_path" -c \'"$3" -c "$1" > "$2/out" 2>&1; printf %s "$?" > "$2/exit"\' msb-run "$cmd" "$dir" "$shell_path" > /dev/null 2>&1 &',
  "  run_pid=$!",
  '  printf %s "$run_pid" > "$dir/pid"',
  // Pid + start time is the run's identity. Written only when procfs actually
  // answered: an EMPTY `start` file would be indistinguishable from "recorded
  // a start time of nothing", and the probe would then compare against it.
  "  start_ticks=$(msb_starttime \"$proc_root\" \"$run_pid\") || start_ticks=''",
  '  if [ -n "$start_ticks" ]; then printf %s "$start_ticks" > "$dir/start"; fi',
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
 * `RUNNING`, `MISSING`, `UNKNOWN <reason>`, or `LOST <reason>`.
 *
 * The exit file is checked first and again last: the wrapper writes it as its
 * final act, so re-reading after the liveness probe closes the window where a
 * run finishes mid-probe and would otherwise read as lost.
 *
 * LIVENESS IS THREE CHECKS, not one, because each answers a different way of
 * losing a run:
 *  - boot id, for "the sandbox restarted underneath it";
 *  - `kill -0`, for "the process is gone";
 *  - START TIME, for "the pid is alive but it is somebody else's now". Without
 *    the third, a recycled pid reports RUNNING forever, which is the one
 *    failure a poll loop cannot end on.
 *
 * FALLBACK, stated because it is a real reduction in what the probe can tell
 * apart: when the guest has no procfs, admission records no start time and the
 * probe degrades to boot id + pid liveness — exactly the behaviour before start
 * time existed. The fallback is chosen by the ABSENCE of a recorded start time,
 * never by a failure to read the current one: if a start time was recorded and
 * the current read fails while the pid is alive, the probe emits an explicit
 * UNKNOWN marker. That is neither proof of continued life nor proof of pid
 * reuse, so the adapter turns it into a retryable status-probe error.
 *
 * @internal Exported only for the protocol tests (see above).
 */
export const MICROSANDBOX_RUN_STATUS_SCRIPT = [
  "set -u",
  "dir=$1",
  "proc_root=$2",
  MSB_STARTTIME_FN,
  'if [ -f "$dir/exit" ]; then',
  '  printf "EXIT %s\\n" "$(cat "$dir/exit" 2>/dev/null)"',
  "  exit 0",
  "fi",
  'if [ ! -d "$dir" ]; then',
  '  printf "MISSING\\n"',
  "  exit 0",
  "fi",
  'boot=$(cat "$dir/boot" 2>/dev/null) || boot=""',
  'now=$(cat "$proc_root/sys/kernel/random/boot_id" 2>/dev/null) || now=""',
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
  // The pid is alive. Is it still OUR process? Only a recorded start time can
  // answer; without one the probe says RUNNING, as it did before.
  '  recorded=$(cat "$dir/start" 2>/dev/null) || recorded=""',
  '  if [ -n "$recorded" ]; then',
  '    if ! current=$(msb_starttime "$proc_root" "$run_pid"); then',
  '      printf "UNKNOWN starttime-unreadable\\n"',
  "      exit 0",
  "    fi",
  '    if [ "$current" != "$recorded" ]; then',
  '      printf "LOST pid-reused\\n"',
  "      exit 0",
  "    fi",
  "  fi",
  '  printf "RUNNING\\n"',
  "  exit 0",
  "fi",
  'if [ -f "$dir/exit" ]; then',
  '  printf "EXIT %s\\n" "$(cat "$dir/exit" 2>/dev/null)"',
  "  exit 0",
  "fi",
  'printf "LOST process-gone\\n"',
].join("\n");

/**
 * Read one run's captured output.
 *
 * Arguments: `$1` log path, `$2` byte cap. Exits 0 with the last `$2` bytes of
 * the file, or 0 with NO output when the file is genuinely absent; any other
 * failure exits non-zero.
 *
 * THE EXIT CODE IS THE WHOLE POINT. The previous form of this read was
 * `tail -c N path 2>/dev/null || true`, which flattened three different
 * situations — "the run has not written anything yet", "the log is
 * unreadable", and "the guest call failed" — onto the same empty string. Empty
 * output is a legitimate answer for a run that printed nothing, so a caller
 * cannot tell that reading from an unreadable one. Absence is now the ONLY
 * condition that yields empty-and-successful; everything else fails loudly and
 * the adapter raises {@link MicrosandboxLogReadError}.
 *
 * The cap is read as one byte MORE than the caller's limit, so the adapter can
 * see that a longer file exists and report `truncated` rather than handing back
 * a tail that reads like a complete log.
 *
 * @internal Exported only for the protocol tests (see above).
 */
export const MICROSANDBOX_RUN_LOG_SCRIPT = [
  "set -u",
  "path=$1",
  "cap=$2",
  // Absent is not an error: a run that has not yet written its first byte, and
  // a run that printed nothing at all, both legitimately have no log.
  // `-f` alone cannot make that distinction: it is false for BOTH a missing
  // path and an existing directory/device/socket. A symlink is rejected too;
  // the run protocol writes a regular file at this exact path.
  'if [ -L "$path" ]; then exit 1; fi',
  'if [ -f "$path" ]; then exec tail -c "$cap" "$path"; fi',
  'if [ -e "$path" ]; then exit 1; fi',
  "exit 0",
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

/**
 * The process-wide default backend could not be restored, so no later
 * default-dependent SDK static may be issued from this process.
 *
 * `withDefaultBackend` sets one process-global slot and restores it on the way
 * out. When the RESTORE is what failed, the slot holds an unknown value: not
 * necessarily this runtime's backend, not necessarily the previous one. Every
 * static the adapter calls reads that slot, so the only two honest options are
 * to guess or to stop. This adapter stops — permanently, for the life of the
 * process, because nothing it is willing to do can re-establish the truth.
 * (Calling `setDefaultBackend` to force a known value would mutate the host
 * process on behalf of a library, which this adapter never does.)
 *
 * Sandbox and handle instances resolved BEFORE the failure are unaffected and
 * still usable: the SDK binds each one to the backend it was resolved on (its
 * typings call this "backend retained by this sandbox"), so their exec,
 * filesystem and lifecycle calls read no global state.
 */
export class MicrosandboxBackendPoisonedError extends Error {
  override readonly name = "MicrosandboxBackendPoisonedError";

  constructor(cause: unknown) {
    super(
      "Microsandbox cannot issue any further backend-dependent SDK call from this process: restoring the "
        + "process-wide default backend failed, so its current value is unknown and a call issued now could "
        + `run against the wrong backend. Restart the process. Underlying error: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

/**
 * A command finished, but the SDK reported no exit code for it.
 *
 * The bootstrap-plane `ExecResult.exitCode` is a number, so this adapter would
 * have to INVENT one — and the only plausible invention, `0`, is the value that
 * says "this succeeded". A command whose outcome the provider did not report is
 * not a command that succeeded, so the caller is told the outcome is unknown
 * instead of being told a comfortable lie it cannot detect.
 */
export class MicrosandboxUnknownOutcomeError extends Error {
  override readonly name = "MicrosandboxUnknownOutcomeError";
  readonly sandboxName: string;

  constructor(sandboxName: string) {
    super(
      `Microsandbox exec on sandbox "${sandboxName}" completed without an exit code, so its outcome is `
        + "unknown; it is reported as unknown rather than defaulted to success",
    );
    this.sandboxName = sandboxName;
  }
}

/**
 * The status probe for an async run did not produce a verdict.
 *
 * Distinct from {@link MicrosandboxRunLostError}, which IS a verdict — the run
 * is over and cannot complete. This error says the adapter learned NOTHING:
 * the guest call failed, a required guest-state read was unavailable, or it
 * answered something this protocol does not define. Returning "still running"
 * for any of those would be a positive claim the probe never made, and a poll
 * loop reading it would wait for an outcome that may already have happened.
 *
 * It is safe to retry: nothing about the run was changed by asking.
 */
export class MicrosandboxStatusProbeError extends Error {
  override readonly name = "MicrosandboxStatusProbeError";
  readonly sessionId: string;
  readonly commandId: string;
  /**
   * `"transport"` — the probe call or a required guest-state read failed.
   * `"unrecognized"` — it answered off-protocol.
   */
  readonly reason: "transport" | "unrecognized";
  /** Retrying is harmless; the probe has no side effects on the run. */
  readonly retryable = true;

  constructor(
    sessionId: string,
    commandId: string,
    reason: "transport" | "unrecognized",
    detail: string,
    cause?: unknown,
  ) {
    super(
      `Microsandbox could not determine the status of run "${sessionId}" (${reason}): ${detail}. `
        + "The run's state is unchanged and the probe may be retried; it is NOT reported as still running, "
        + "because that would be an observation this probe did not make.",
      cause === undefined ? undefined : { cause },
    );
    this.sessionId = sessionId;
    this.commandId = commandId;
    this.reason = reason;
  }
}

/**
 * A run's captured output could not be read.
 *
 * Raised instead of returning `""`. An empty log is a legitimate outcome — a
 * command that printed nothing has one — so a failed read that answered `""`
 * would be indistinguishable from a real result, and the caller would record
 * "the command produced no output" as a fact about a read that never happened.
 * A genuinely ABSENT log file still yields `""`, which is the one case where
 * empty is the truth.
 */
export class MicrosandboxLogReadError extends Error {
  override readonly name = "MicrosandboxLogReadError";
  readonly sessionId: string;
  readonly path: string;

  constructor(sessionId: string, path: string, detail: string, cause?: unknown) {
    super(
      `Microsandbox could not read the log for run "${sessionId}" at ${path}: ${detail}. `
        + "Reported as a failure rather than as empty output, which would be indistinguishable from a run "
        + "that printed nothing.",
      cause === undefined ? undefined : { cause },
    );
    this.sessionId = sessionId;
    this.path = path;
  }
}

/**
 * `startScript`/`startExec` was given a `timeoutMs`, which this adapter cannot
 * honour as the port defines it.
 *
 * The port's `timeoutMs` is the COMMAND's lifetime. For a synchronous
 * `runScript` that is exactly what the SDK's `ExecOptionsBuilder.timeout` gives,
 * so the sync path honours it. An async run is different: it is detached inside
 * the guest by the durable wrapper and outlives the submit call, so the submit
 * call's timeout bounds nothing about the command.
 *
 * The adapter previously applied it to the submit call anyway. That is the
 * failure mode this error exists to remove — a caller that asked for a 30s
 * command budget got a 30s SUBMIT budget and a command that runs forever, with
 * nothing in the result to say so.
 *
 * It is refused rather than approximated because the honest enforcement is not
 * available here: killing the run's shell on expiry would leave that shell's
 * own descendants running, so the adapter would report a terminated run while
 * the work continued — a fabricated outcome, which is worse than a refusal. Use
 * `maxDurationSeconds` for a sandbox-lifetime bound, or put the bound in the
 * command itself (`timeout 30 ...`), where the guest can enforce it properly.
 */
export class MicrosandboxRunTimeoutUnsupportedError extends Error {
  override readonly name = "MicrosandboxRunTimeoutUnsupportedError";
  readonly sessionId: string;
  readonly timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(
      `Microsandbox cannot apply a ${timeoutMs}ms command timeout to the async run "${sessionId}": the port `
        + "defines `timeoutMs` as the command's lifetime, and an async run is detached in the guest, so the "
        + "submit call's timeout would bound nothing. Nothing was submitted. Bound the sandbox with "
        + "`maxDurationSeconds`, or put the timeout inside the command.",
    );
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
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

/**
 * One queued caller, in arrival order.
 *
 * A waiter is an OBJECT rather than a bare callback so that a timed-out or
 * cancelled caller can be found by identity, and so the gate can be handed to
 * exactly one of them (see {@link promoteNextBackendWaiter}).
 */
type BackendWaiter = {
  readonly key: string;
  readonly wake: () => void;
};

let currentBackendScope: BackendScope | null = null;
const backendScopeWaiters: BackendWaiter[] = [];

/**
 * The waiter the gate is currently RESERVED for, if any.
 *
 * Waking the head of the queue is not by itself FIFO: between the wake and the
 * woken caller re-checking the gate, a brand-new arrival can observe a free
 * gate and take it, so the queue's order decides nothing and a waiter can be
 * skipped repeatedly. While this is set the gate is spoken for, and every
 * caller other than this one must queue — which is what actually makes the
 * handoff ordered.
 */
let backendGateHandoffTo: BackendWaiter | null = null;

/**
 * Set once the SDK fails to RESTORE the process-wide default backend, after
 * which no default-dependent static may be issued from this process again.
 *
 * Deliberately permanent and deliberately module-scoped: the damage is to the
 * SDK's process-global slot, so it is not a property of any one runtime
 * instance, and no action this adapter is willing to take can re-establish
 * what that slot now holds. See {@link MicrosandboxBackendPoisonedError}.
 *
 * The FLAG carries whether the gate is poisoned; the cause is kept beside it.
 * Using the cause as its own sentinel would lose exactly the rejections that
 * carry no value — `Promise.reject()`, `reject(null)` — and those poison the
 * process default just as thoroughly as a rejection with an `Error` does.
 */
let backendGatePoisoned = false;
let backendGatePoisonCause: unknown;

/**
 * Reset the module-global gate. TEST-ONLY.
 *
 * The gate is process-global on purpose, and poisoning it is permanent on
 * purpose — which makes the poison path untestable in-process without a way
 * back. Exported from the module but NOT from the package barrel, so it is
 * reachable from this file's tests and from nowhere a consumer imports.
 *
 * @internal
 */
export function __resetBackendGateForTests(): void {
  currentBackendScope = null;
  backendScopeWaiters.splice(0);
  backendGateHandoffTo = null;
  backendGatePoisoned = false;
  backendGatePoisonCause = undefined;
}

/**
 * How many callers are queued on the gate right now. TEST-ONLY.
 *
 * The leak this exists to catch is INVISIBLE from the outside: a waiter that
 * timed out still reports the same typed `MicrosandboxBackendBusyError` to its
 * caller whether or not it deregistered itself, so a test written against
 * observable behaviour alone passes against the bug. The only discriminating
 * signal is the length of the queue itself, so the queue is what the test
 * asserts on.
 *
 * @internal
 */
export function __backendGateWaiterCountForTests(): number {
  return backendScopeWaiters.length;
}

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
  signal?: AbortSignal,
): Promise<T> {
  const key = backendKey(backend);
  const queueDeadline = Date.now() + queueTimeoutMs;
  // Set once this caller has been handed the gate as the FIFO head. It may
  // then take the gate even though callers are still queued BEHIND it — which
  // is the whole point of the handoff — but it owes the queue a promotion if
  // it then leaves without taking the gate.
  let holdsTurn = false;
  const yieldTurn = (): void => {
    if (holdsTurn) {
      holdsTurn = false;
      promoteNextBackendWaiter();
    }
  };
  try {
    for (;;) {
      if (backendGatePoisoned) {
        throw new MicrosandboxBackendPoisonedError(backendGatePoisonCause);
      }
      if (signal?.aborted) {
        // ADMISSION CANCELLED. The caller's overall deadline has already
        // expired, so `fn` must never run: a static admitted after its own
        // deadline is a call the caller has stopped waiting for and will
        // never read the result of.
        throw signal.reason;
      }
      const open = currentBackendScope;
      // JOINING IS THE STARVATION RISK, so it is conditional on an empty queue.
      // A same-backend call may share an open scope only when NOBODY is waiting
      // and the gate is not already promised to a waiter; the moment a call on
      // another backend has queued, later same-backend arrivals queue behind it
      // too. Without that condition a steady stream of same-backend work keeps
      // the scope permanently occupied and the other backend never runs — which
      // is the failure this gate's own comment claimed it prevented.
      if (
        open &&
        !open.closing &&
        open.key === key &&
        (holdsTurn || (backendScopeWaiters.length === 0 && backendGateHandoffTo === null))
      ) {
        open.active += 1;
        // Joining does not hold the gate — the open scope does — so a turn
        // taken here is handed straight back to the queue.
        yieldTurn();
        try {
          // The scope may still be opening; running before it is entered would
          // run against whatever backend the process last had.
          await open.entered;
          return await fn();
        } finally {
          await leaveBackendScope(open);
        }
      }
      if (
        open ||
        (!holdsTurn && (backendScopeWaiters.length > 0 || backendGateHandoffTo !== null))
      ) {
        // BOUNDED. An abandoned scope holder (a create or lookup that outlived
        // its client-side deadline) is still in flight and still owns the
        // process-wide backend, so this wait can otherwise never end.
        const remainingMs = queueDeadline - Date.now();
        if (remainingMs <= 0) {
          throw new MicrosandboxBackendBusyError(queueTimeoutMs);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let wake!: () => void;
        const woken = new Promise<"woken">((resolve) => {
          wake = () => resolve("woken");
        });
        const waiter: BackendWaiter = { key, wake };
        backendScopeWaiters.push(waiter);
        let onAbort: (() => void) | undefined;
        const outcomes: Array<Promise<"woken" | "timeout" | "aborted">> = [
          woken,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), remainingMs);
          }),
        ];
        if (signal) {
          outcomes.push(
            new Promise<"aborted">((resolve) => {
              onAbort = () => resolve("aborted");
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          );
        }
        const outcome = await Promise.race(outcomes);
        if (timer) {
          clearTimeout(timer);
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        if (outcome === "woken") {
          // The gate was reserved for THIS waiter by name, so nothing else can
          // have taken it in between. Consume the reservation and re-check.
          backendGateHandoffTo = null;
          holdsTurn = true;
          continue;
        }
        // Deregister. The waiter list is no longer spliced wholesale on
        // release, but a timed-out or cancelled waiter left behind would still
        // be woken later and, worse, would hold a handoff the gate then waits
        // on forever — so it both leaves the queue and passes on any turn it
        // was given in the same tick.
        dropBackendWaiter(waiter);
        if (outcome === "aborted") {
          throw signal!.reason;
        }
        throw new MicrosandboxBackendBusyError(queueTimeoutMs);
      }

      return await openBackendScope(sdk, backend, key, fn, () => {
        // Taking the gate consumes the turn: ownership now lives in the scope,
        // and the queue is promoted when that scope releases.
        holdsTurn = false;
      });
    }
  } finally {
    yieldTurn();
  }
}

/**
 * Open a NEW scope on a free gate and run `fn` inside it.
 *
 * Split out from {@link withBackendScope} only so the queueing loop above stays
 * readable; it is never called on a gate that is already held.
 */
async function openBackendScope<T>(
  sdk: MicrosandboxSdk,
  backend: MicrosandboxBackend,
  key: string,
  fn: () => Promise<T> | T,
  onTaken: () => void,
): Promise<T> {
  {
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
    onTaken();

    // Distinguishes the two ways `withDefaultBackend` can reject, which need
    // opposite handling: before the callback ran, nothing of ours executed and
    // the process default was never changed; after it ran, the rejection can
    // only be the SDK failing to RESTORE, and the slot is then unknown.
    let callbackRan = false;
    let scopeCall: Promise<unknown>;
    try {
      // The scope stays open for as long as anyone is inside it: the SDK's
      // callback resolves only once the last participant has left.
      scopeCall = Promise.resolve(
        sdk.withDefaultBackend(backend, () => {
          callbackRan = true;
          markEntered();
          return drained;
        }),
      );
    } catch (error) {
      if (callbackRan) {
        // The SDK entered our callback and then threw on the SAME stack while
        // restoring the previous process default. `Promise.resolve(...)`
        // never receives a value in this form, so the asynchronous rejection
        // handler below cannot observe it; callback entry is nevertheless the
        // decisive proof that the global slot was changed and is now unknown.
        backendGatePoisoned = true;
        backendGatePoisonCause = error;
      }
      // Pre-callback, this is a harmless synchronous failure to push the scope.
      // Post-callback, freeing the now-poisoned gate wakes queued callers so
      // they fail immediately with MicrosandboxBackendPoisonedError.
      abandonBackendScope(scope);
      throw error;
    }
    scope.exited = scopeCall.then(
      () => undefined,
      (error: unknown) => {
        if (!callbackRan) {
          // Rejected BEFORE the callback ran: the scope was never entered, so
          // the process default was never changed and nothing ran under it.
          // `entered` rejects and this call fails closed, below.
          failEntry(error);
          return;
        }
        // Rejected AFTER the callback ran. The callback returns a promise that
        // resolves only once the last participant has left, so the SDK had
        // already re-entered its own teardown: this rejection is the RESTORE
        // failing. The process-wide slot now holds an unknown value.
        //
        // Swallowing it — which is what returning here would do — hands the
        // gate to the next backend as if the previous one had been cleanly
        // restored, and that call then runs against whatever the slot actually
        // holds. So it is recorded as poison for every later static, and
        // rethrown so the participant that closed the scope is TOLD rather
        // than left believing the call completed cleanly.
        backendGatePoisoned = true;
        backendGatePoisonCause = error;
        throw error;
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
    // EARLY LEAVER. Its own call finished, but the restore it depends on has
    // not happened yet: the scope closes only when the LAST participant
    // leaves. Returning here would let a joined caller report success while
    // the very same scope goes on to fail its restore — two callers running
    // concurrently against one backend, one told the truth and one not.
    //
    // Awaiting cannot deadlock: this participant has already decremented, so
    // the count it is waiting on no longer includes itself, and `exited`
    // settles as soon as the last one leaves.
    await scope.exited;
    return;
  }
  scope.closing = true;
  scope.release();
  try {
    // Wait for the SDK to restore the previous backend BEFORE any queued call
    // on a different backend is allowed to open its own scope.
    await scope.exited;
  } finally {
    // Released even when the restore FAILED. The gate is poisoned by then, so
    // waking the queue does not let anyone through — it converts a wait that
    // would otherwise run to its timeout into an immediate, typed refusal.
    releaseBackendGate(scope);
  }
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
  promoteNextBackendWaiter();
}

/**
 * Hand the free gate to the OLDEST waiter, and to that waiter alone.
 *
 * Waking every waiter at once and letting them re-race is not FIFO by any
 * definition: all of them find the gate free, and which one actually takes it
 * is decided by microtask scheduling order, so a waiter can lose that race
 * arbitrarily many times while later arrivals win it. Reserving the gate for
 * one named waiter is what makes the queue's order mean something.
 */
function promoteNextBackendWaiter(): void {
  if (currentBackendScope !== null || backendGateHandoffTo !== null) {
    return;
  }
  const next = backendScopeWaiters.shift();
  if (!next) {
    return;
  }
  backendGateHandoffTo = next;
  next.wake();
}

/**
 * Remove a waiter that will never take the gate, and pass on any reservation
 * it was holding.
 *
 * The reservation matters more than the queue slot: a waiter that timed out in
 * the same tick it was promoted still owns `backendGateHandoffTo`, and every
 * other caller defers to that reservation — so dropping it without promoting a
 * successor wedges the gate permanently on a caller that has already left.
 */
function dropBackendWaiter(waiter: BackendWaiter): void {
  const queued = backendScopeWaiters.indexOf(waiter);
  if (queued !== -1) {
    backendScopeWaiters.splice(queued, 1);
  }
  if (backendGateHandoffTo === waiter) {
    backendGateHandoffTo = null;
    promoteNextBackendWaiter();
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
  seenCursors: ReadonlySet<string>,
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
  // THE ENVELOPE IS NOT THE DATA. An array of unusable entries is exactly as
  // unreadable as a missing array, and it fails the same way: every entry is
  // dropped by the state filter, the drain ends, and the caller is told there
  // is nothing warm — from a page the provider did in fact return sandboxes on.
  // A handle is only usable if it has an addressable name, because the name IS
  // the identity here, and a status, because the state filter reads it.
  const sandboxes = record.sandboxes.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new MicrosandboxPaginationError(
        pageNumber,
        `entry ${index} of the page is not a sandbox object`,
      );
    }
    const { name, status } = entry as { name?: unknown; status?: unknown };
    if (typeof name !== "string" || name.trim() === "") {
      throw new MicrosandboxPaginationError(
        pageNumber,
        `entry ${index} of the page has no usable sandbox name, so it cannot be addressed`,
      );
    }
    if (typeof status !== "string" || status.trim() === "") {
      throw new MicrosandboxPaginationError(
        pageNumber,
        `sandbox "${name}" was returned without a usable status, so it cannot be filtered by state`,
      );
    }
    return entry as MsbSandboxHandle;
  });
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
  // EVERY cursor already used, not just the previous one. A backend that walks
  // A → B → A advances on each individual step, so comparing against only the
  // last cursor sees progress forever while re-serving the same two pages —
  // the drain then ends on the 1000-page bound at best, and duplicates every
  // sandbox it collected on the way.
  if (seenCursors.has(cursor)) {
    throw new MicrosandboxPaginationError(
      pageNumber,
      `the provider returned a next-page cursor it has already served, so the listing is cycling rather than advancing`,
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
   *  - `snapshots` — LOCAL only, and the claim is about THIS ADAPTER's boot
   *    path, not about the provider's hosted service. `launch` sources a
   *    sandbox through the builder's `fromSnapshot`, which consumes a
   *    host-local artifact: the installed SDK's typings describe `Snapshot` as
   *    "an artifact on disk" and resolve one under
   *    `~/.microsandbox/snapshots/<name>/`. This adapter never transfers that
   *    artifact anywhere, so on a remote backend there is nothing for a create
   *    to resolve — hence `false`, and a constructor that refuses the pairing.
   *    Note the adapter only ever CONSUMES a snapshot; it never creates one, so
   *    `SandboxHandle.snapshot()` is not on this path.
   *  - `isolation` — `'strong'` on LOCAL, `'unknown'` on CLOUD, and both values
   *    describe what this package has ESTABLISHED rather than what any provider
   *    documentation says. Locally the SDK boots each sandbox as a microVM with
   *    its own guest kernel on a virtualization-capable host, and the installed
   *    package states that requirement itself (Node 22+, a native addon, KVM /
   *    Apple Silicon / WHP), so `'strong'` rests on something checkable here.
   *    For the cloud backend this adapter observes nothing about isolation,
   *    region placement or resource enforcement and measures nothing against
   *    them, so it reports `'unknown'` — which is a statement about this
   *    package's evidence, not an assertion that the guarantee is absent. See
   *    {@link IsolationLevel}.
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
    // call, before a single byte leaves the process. Deferring it to `launch`
    // would surface it as an opaque remote failure on a path the caller was
    // told existed.
    //
    // WHAT THIS REFUSAL RESTS ON, stated exactly, because a capability claim is
    // only worth what its evidence is. It is NOT a claim about what the vendor's
    // hosted service does or does not implement — this package has no way to
    // observe that. It is a statement about the ADAPTER'S OWN CONTRACT plus one
    // fact that is checkable in the installed package:
    //
    //  - checkable: a snapshot is a HOST-LOCAL ARTIFACT. `microsandbox@0.6.11`'s
    //    `native/index.d.ts` declares `Snapshot` as "A snapshot artifact on
    //    disk", resolves `SandboxHandle.snapshot(name)` "under
    //    `~/.microsandbox/snapshots/<name>/`", and offers `Snapshot.listDir(dir)`
    //    to walk a directory of them. `builder.fromSnapshot(pathOrName)` consumes
    //    that artifact.
    //  - contract: this adapter only ever CONSUMES a snapshot by path or name
    //    from the calling host, and it does not transfer one anywhere. A create
    //    issued against a remote backend therefore has nothing this adapter has
    //    put within its reach.
    //
    // So the pairing is refused because THIS ADAPTER cannot make it work, which
    // is a fact about code in this repository. `capabilities.snapshots` reports
    // the same thing per backend, and neither claims anything about the hosted
    // service's own capabilities.
    if (options.snapshot && !isLocalBackend(options.backend)) {
      throw new Error(
        "MicrosandboxRuntime cannot boot from a `snapshot` on the cloud backend: a snapshot is a host-local "
          + "artifact (the SDK's own typings resolve one under ~/.microsandbox/snapshots/ and describe it as an "
          + "artifact on disk), and this adapter consumes it from the calling host without transferring it, so a "
          + "create issued against a remote backend has nothing to resolve. "
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
      // truncate a listing the caller asked to receive in full. A non-integral
      // or negative cap is floored onto zero, which `collectByLabels` answers
      // without a call — the same rule `countByLabels` applies to `maxCount`.
      ...resultCap(options.limit),
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
    const handles = await this.collectByLabels(labels, {
      states: options.states === undefined ? ["STARTED"] : options.states,
      ...resultCap(options.maxCount),
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
    // A cap of zero is answerable without a network call, and answering it
    // WITH one is how a cap of zero used to return a result: the cap was
    // checked only after an entry had already been collected. Negative and
    // fractional caps normalize onto it rather than meaning something
    // accidental.
    if (options.cap !== undefined && options.cap <= 0) {
      return [];
    }
    // Request size, resolved exactly as Daytona/E2B/local resolve it, so a
    // caller that tuned one provider's lookup gets the same request shape here
    // — except that a zero or negative size is not a request shape at all, so
    // it falls back to the configured page size instead of being sent.
    const limit = positivePageSize(options.requestSize) ?? this.listPageSize;
    const excluded = new Set(options.excludeIds ?? []);
    const deadline = this.lookupDeadline(options.timeoutMs);
    const handles: RuntimeHandle[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    // Bounded so a backend that keeps handing back fresh cursors cannot spin
    // this loop forever. The deadline bounds it in wall-clock terms too.
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const cursorForPage = cursor;
      const raw = await this.awaitWithinCancelling(
        (signal) =>
          this.withBackendStatic(
            (sdk) =>
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
            signal,
          ),
        deadline,
        options.description,
      );
      // Recorded BEFORE the page is validated, so the cursor that fetched this
      // page counts as seen: a provider that hands back the cursor it was just
      // given is the degenerate cycle, and it has to fail on the same check as
      // the longer A → B → A one.
      if (cursorForPage !== undefined) {
        seenCursors.add(cursorForPage);
      }
      const result = readSandboxPage(raw, seenCursors, page + 1);
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
    // THE BOUND IS A FAILURE, NOT AN ANSWER. Falling out of this loop meant
    // returning what had been collected so far, which is the exact shape of a
    // complete listing — the caller cannot tell a drain that gave up after a
    // thousand pages from one that genuinely ended, so it under-counts a quota
    // or launches a sandbox it already had. Every other way this drain can end
    // badly already throws; this one now does too.
    throw new MicrosandboxPaginationError(
      MAX_LIST_PAGES,
      `the listing still had more pages at the ${MAX_LIST_PAGES}-page safety bound, so it cannot be drained `
        + "to a trustworthy end; no partial result is returned",
    );
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
    const timeoutMs = options.createTimeoutSeconds
      ? options.createTimeoutSeconds * 1000
      : undefined;
    const controller = timeoutMs === undefined ? undefined : new AbortController();
    let createStarted = false;
    const create = this.withBackendStatic(async (sdk) => {
      // Once this flips, `builder.create()` is reached in the same synchronous
      // turn: every preceding builder method is synchronous. A deadline after
      // this point cannot cancel provider work, so the late-create watcher
      // below must retain responsibility for its eventual outcome.
      createStarted = true;
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
    }, controller?.signal);

    // The builder has no create-timeout setter, and `maxDuration` is a sandbox
    // LIFETIME budget — mapping the caller's boot deadline onto it would kill
    // every long-lived sandbox the moment that deadline elapsed. So the create
    // deadline is enforced here instead.
    let sandbox: MsbSandbox;
    if (timeoutMs !== undefined) {
      try {
        sandbox = await withDeadline(create, timeoutMs, name, controller);
      } catch (error) {
        if (error instanceof MicrosandboxCreateTimeoutError && createStarted) {
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

  /**
   * Bootstrap-plane exec. Same call as `runScript`, narrower result shape.
   *
   * `ExecResult.exitCode` is a `number`, and `RunScriptResult.exitCode` is
   * `number | null`, so this is where a missing outcome would have to be
   * invented. It is not: a `null` becomes a typed error rather than the `0`
   * that would report an unobserved command as a successful one.
   */
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
    if (result.exitCode === null) {
      throw new MicrosandboxUnknownOutcomeError(handle.id);
    }
    return {
      output: result.output,
      exitCode: result.exitCode,
      ...(result.truncated ? { truncated: true } : {}),
    };
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
    const sessionId = options.sessionId ?? `run-${handle.id}-${randomUUID()}`;
    // REFUSED BEFORE ANYTHING IS SUBMITTED, so a caller that asked for a
    // command budget it will not get is told before a process exists rather
    // than after one is running unbounded. See the error's own docs for why it
    // is refused instead of approximated.
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      throw new MicrosandboxRunTimeoutUnsupportedError(sessionId, options.timeoutMs);
    }
    const sandbox = await this.requireSandbox(handle);
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
          GUEST_PROC_ROOT,
        ]);
        if (cwd !== undefined) {
          configured = configured.cwd(cwd);
        }
        if (hasEntries(options.env)) {
          configured = configured.envs(options.env);
        }
        // No `timeout(...)` here, and that is the point: the only timeout this
        // call could set is the SUBMIT call's, and the port's `timeoutMs` means
        // the COMMAND's lifetime. Setting it here would satisfy the type and
        // silently mean something else, so a `timeoutMs` is refused above
        // instead.
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
    let probeExit: number | undefined;
    let probeStderr = "";
    try {
      const output = await sandbox.execWith(this.shell, (builder) =>
        builder.args(["-c", MICROSANDBOX_RUN_STATUS_SCRIPT, "msb-status", dir, GUEST_PROC_ROOT]),
      );
      marker = (output.stdout() ?? "").trim();
      probeExit = typeof output.code === "number" ? output.code : undefined;
      probeStderr = output.stderr() ?? "";
    } catch (error) {
      // A FAILED PROBE SAYS NOTHING ABOUT THE RUN, which is exactly why it can
      // no longer be reported as `{ exitCode: null }`. That value means "asked,
      // and it is still running" — a positive observation this call did not
      // make. A caller polling on it treats a broken transport as a healthy
      // long-running command and waits out an outcome that may already exist.
      throw new MicrosandboxStatusProbeError(
        sessionId,
        commandId,
        "transport",
        `the probe call failed: ${errorMessage(error)}`,
        error,
      );
    }
    if (probeExit !== undefined && probeExit !== 0) {
      // The call was delivered but the probe script itself failed — an
      // unreadable run directory, a guest without `/bin/sh`. Same reasoning.
      throw new MicrosandboxStatusProbeError(
        sessionId,
        commandId,
        "transport",
        `the probe exited ${probeExit}: ${summarize(probeStderr || marker)}`,
      );
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
    if (marker === "UNKNOWN starttime-unreadable") {
      throw new MicrosandboxStatusProbeError(
        sessionId,
        commandId,
        "transport",
        "the run recorded a process start time, but its current start time could not be read from procfs",
      );
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
      throw new MicrosandboxRunLostError(sessionId, commandId, describeLostReason(reason));
    }
    // Unrecognized output is an unreadable probe, NOT a verdict — and least of
    // all the verdict "still running". Reporting one here is how a poll loop
    // runs forever against a guest whose probe is answering something this
    // protocol never defined.
    throw new MicrosandboxStatusProbeError(
      sessionId,
      commandId,
      "unrecognized",
      `the probe answered ${summarize(marker)}, which is not a verdict this protocol defines`,
    );
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    const sandbox = await this.requireSandbox(handle);
    const outPath = `${this.scriptRunDir(sessionId)}/out`;
    const log = await this.readRunLog(sandbox, sessionId, outPath, SCRIPT_LOG_READ_MAX_BYTES);
    // exitCode stays null: `getScriptStatus` is the single source of truth for
    // the exit code, matching the Daytona, E2B and local adapters.
    return {
      output: log.output,
      exitCode: null,
      cmdId: commandId,
      // Present only when the read actually bounded something. An absent
      // `truncated` means the log is complete — never "unknown".
      ...(log.truncated ? { truncated: true } : {}),
    };
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
    return {
      output: logs.output,
      exitCode: status.exitCode,
      // Carried through rather than dropped: the bootstrap plane's consumer is
      // the one that would otherwise read a tail as the whole output.
      ...(logs.truncated ? { truncated: true } : {}),
    };
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
    signal?: AbortSignal,
  ): Promise<T> {
    const sdk = await this.sdk();
    return withBackendScope(sdk, this.backend, () => fn(sdk), this.backendQueueTimeoutMs, signal);
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

  /**
   * Read one run's captured output, bounded, without turning a failure into an
   * empty log.
   *
   * The read goes through {@link MICROSANDBOX_RUN_LOG_SCRIPT} rather than
   * `fs.readToString` for two reasons that both matter to the caller: an
   * ABSENT log is a success with no output (a run that has printed nothing has
   * one), and everything else — an unreadable file, a failed guest call — is a
   * failure. The previous form could not tell those apart, because it answered
   * `""` to all of them.
   *
   * One byte MORE than the cap is requested, so a longer log is detectable
   * rather than silently tailed: the extra byte is what turns "here is the
   * output" into "here is the last `maxBytes` of it".
   */
  private async readRunLog(
    sandbox: MsbSandbox,
    sessionId: string,
    path: string,
    maxBytes: number,
  ): Promise<{ output: string; truncated: boolean }> {
    let output: MsbExecOutput;
    try {
      output = await sandbox.execWith(this.shell, (builder) =>
        builder.args([
          "-c",
          MICROSANDBOX_RUN_LOG_SCRIPT,
          "msb-log",
          path,
          String(maxBytes + 1),
        ]),
      );
    } catch (error) {
      throw new MicrosandboxLogReadError(
        sessionId,
        path,
        `the guest call failed: ${errorMessage(error)}`,
        error,
      );
    }
    if (typeof output.code === "number" && output.code !== 0) {
      throw new MicrosandboxLogReadError(
        sessionId,
        path,
        `the read exited ${output.code}: ${summarize(output.stderr() ?? "")}`,
      );
    }
    const text = output.stdout() ?? "";
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength <= maxBytes) {
      return { output: text, truncated: false };
    }
    // More than the cap came back, so the log is longer than what is being
    // returned. The caller is handed the TAIL and told it is one.
    return {
      output: bytes.subarray(bytes.byteLength - maxBytes).toString("utf8"),
      truncated: true,
    };
  }

  private lookupDeadline(timeoutMs: number | undefined): { endsAt: number; timeoutMs: number } {
    const requested = timeoutMs ?? this.lookupTimeoutMs;
    const normalized = Number.isFinite(requested) && requested > 0
      ? Math.max(1, Math.ceil(requested))
      : this.lookupTimeoutMs;
    return { endsAt: Date.now() + normalized, timeoutMs: normalized };
  }

  /**
   * Run `build` under the ONE overall deadline, cancelling its admission when
   * that deadline expires.
   *
   * Racing a timer against the operation is not enough on its own. The gate is
   * a queue, so a lookup that gives up while queued is still queued: it can be
   * admitted later and issue a static against the process default long after
   * the caller stopped waiting for it. The signal is what actually withdraws
   * it from the queue.
   */
  private async awaitWithinCancelling<T>(
    build: (signal: AbortSignal) => Promise<T>,
    deadline: { endsAt: number; timeoutMs: number },
    description: string,
  ): Promise<T> {
    const controller = new AbortController();
    try {
      return await this.awaitWithin(build(controller.signal), deadline, description);
    } catch (error) {
      controller.abort(
        error instanceof MicrosandboxLookupTimeoutError
          ? error
          : new MicrosandboxLookupTimeoutError(deadline.timeoutMs, description),
      );
      throw error;
    }
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

/** Turn the status script's `LOST <reason>` token into something a human reads. */
function describeLostReason(reason: string): string {
  if (reason === "sandbox-restarted") {
    return "the sandbox restarted while it was running";
  }
  if (reason === "pid-reused") {
    return "its process is gone and the guest has since reused its pid for something else";
  }
  return "its process is gone and it never recorded an exit code";
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
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new MicrosandboxCreateTimeoutError(sandboxName, timeoutMs);
          // A caller still waiting for the backend gate has not issued any
          // provider work, so aborting withdraws it from admission entirely.
          // Once its callback started, AbortSignal intentionally cannot cancel
          // the provider promise; reclaimLateCreate keeps watching that path.
          controller?.abort(error);
          reject(error);
        }, timeoutMs);
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

/**
 * A page-request size the provider can actually be asked for, or `undefined`
 * when the caller's value is not one.
 *
 * `limit: 0` and `limit: -1` are not page sizes; sending either would ask the
 * backend to interpret them, and the two mainstream interpretations —
 * "everything" and "nothing" — are opposite. The caller's configured default
 * is used instead, and the RESULT cap (a separate concern, resolved by the
 * caller of this helper) is what honours a zero.
 */
/**
 * Normalize a caller's RESULT cap onto `collectByLabels`'s `cap` option.
 *
 * Returns a spreadable fragment so "no cap" is the absence of the key rather
 * than a sentinel. The three edges are decided, not accidental:
 *  - `undefined` — no cap; drain the whole listing.
 *  - `Infinity` — no cap; it is the explicit spelling of the same thing.
 *  - anything else, INCLUDING `NaN`, negatives and fractions — floored onto a
 *    non-negative integer, with `NaN` becoming `0`. A cap nobody can interpret
 *    resolves to "return nothing", never to "return everything": the first is
 *    visibly wrong to the caller, the second silently drains a listing it asked
 *    to bound.
 */
function resultCap(requested: number | undefined): { cap?: number } {
  if (requested === undefined || requested === Number.POSITIVE_INFINITY) {
    return {};
  }
  return { cap: Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0 };
}

function positivePageSize(requested: number | undefined): number | undefined {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return undefined;
  }
  return Math.floor(requested);
}

function hasEntries(record?: Record<string, string>): record is Record<string, string> {
  return !!record && Object.keys(record).length > 0;
}
