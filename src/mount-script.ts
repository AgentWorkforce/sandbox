/**
 * Shell snippets for running the `relayfile-mount` daemon inside a sandbox.
 *
 * Callers that drive the mount — a command-at-a-time executor, a runner that
 * submits one multi-line script, and a generator that emits sandbox-resident
 * bootstrap JS — would otherwise each hand-roll near-identical bash. This
 * module is the single builder for all of them, and owns the command
 * templates the bootstrap generator embeds.
 *
 * The contract: helpers take primitives, do their own shell quoting, and
 * return ready-to-run bash. Callers must not re-quote.
 */

import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";

export type RelayfileMountShellOptions = {
  /** Relayfile base URL, e.g. `https://your-relayfile-host.example`. */
  baseUrl: string;
  /** Workspace id the path-scoped token is bound to. */
  workspaceId: string;
  /** Local mirror root inside the sandbox, e.g. `/home/<user>/workspace`. */
  localDir: string;
  /**
   * Private relayfile-mount state directory. Required: it is sandbox-image
   * specific, and it must sit OUTSIDE the mounted workspace so sync metadata
   * never appears in the Relayfile tree.
   */
  stateDir: string;
  /** Path-scoped relayfile token (`relay_pa_*`). */
  token: string;
  /**
   * Optional logical path scopes. The daemon accepts repeated
   * `--remote-path` args; callers pass the scopes they care about here so the
   * continuous sync never pulls a full workspace export.
   */
  paths?: readonly string[];
  /**
   * Whether relayfile-mount should use the WebSocket event stream. Omit to use
   * the CLI default. Set false to fall back to bounded `/fs/events` polling,
   * which suits hosts that cannot hold a long-lived WebSocket request open.
   */
  websocket?: boolean;
  /**
   * Lazily materialize GitHub repo subtrees on first access instead of eagerly
   * hydrating every repo file during bootstrap.
   */
  lazyRepos?: boolean;
  /**
   * Path to a JSON creds file (`{"token": "relay_pa_…", "mintedAt"?, "expiresAt"?}`)
   * the daemon re-reads on 401 so a refreshed token heals the mount without a
   * restart. Passed as the RELAYFILE_MOUNT_CREDS_FILE env var rather than a
   * `--creds-file` flag because pre-creds binaries reject an unknown flag but
   * ignore the env var, so one spelling works across every binary a snapshot
   * may carry.
   */
  credsFilePath?: string;
  /**
   * How the launch token reaches the daemon.
   *
   *   - `'argv'` (default): rendered as `--token <literal>`. The token is
   *     visible in `ps aux`, `/proc/<pid>/cmdline`, and any observability
   *     agent that captures process command lines. Preserved as the default
   *     for backwards compatibility with binaries that only read `--token`.
   *   - `'env'`: rendered as an `env RELAYFILE_MOUNT_TOKEN=<literal>` prefix,
   *     omitted from argv entirely. Requires a daemon build that reads the
   *     `RELAYFILE_MOUNT_TOKEN` env var. Confirm that capability before
   *     flipping the default to `'env'`.
   *   - `'creds-file'`: no token literal is rendered at all — not in argv, not
   *     in the env prefix. The daemon reads the credential from the mode-0600
   *     file named by `credsFilePath`, which is therefore required. This is the
   *     only ingress that leaves a generated on-disk script free of a reusable
   *     credential, so it is what the detached initial-sync launcher should use
   *     wherever the daemon build is known to honour RELAYFILE_MOUNT_CREDS_FILE.
   *
   * `'creds-file'` is opt-in rather than implied by `credsFilePath` alone.
   * Pre-creds binaries ignore the unknown env var (see `credsFilePath`), so
   * dropping `--token` for them would turn a working mount into a silent
   * authentication failure rather than a loud one.
   *
   * The credentials-in-argv exposure was tracked as AgentWorkforce/sandbox#21;
   * the credential-in-generated-script exposure as AgentWorkforce/sandbox#30.
   */
  tokenIngress?: "argv" | "env" | "creds-file";
};

/**
 * The local-layout value and --local-dir are one contract.
 *
 * Every invocation uses explicit `exact` layout, so --local-dir is the final
 * on-disk mirror root. For a remote root such as `/github/repos/acme/cloud`,
 * builders first recover the unscoped base (for callers that already passed
 * the joined path) and then append that remote root themselves. Multi-path
 * mounts run one process per remote root because exact layout intentionally
 * rejects repeated --remote-path values.
 *
 * The flag is deliberate. A binary too old to understand explicit layout
 * now fails loudly instead of ignoring an env var and silently mirroring at
 * the wrong depth. Every production image currently in scope (v0.10.35+) has
 * the explicit layout contract.
 */
const EXACT_LOCAL_LAYOUT_ARG = `--local-layout ${shellQuote("exact")}`;

/**
 * Optional `env` prefix for relayfile-mount invocations. When the caller
 * provides a creds file, points the daemon at it via
 * RELAYFILE_MOUNT_CREDS_FILE (see `credsFilePath` docs for the version-skew
 * rationale). When `tokenIngress === 'env'`, adds
 * RELAYFILE_MOUNT_TOKEN=<literal> so the launch token never enters argv.
 * When `tokenIngress === 'creds-file'` no token literal is emitted at all —
 * the creds file is the sole ingress.
 * The explicit `env` executable is required because initial-sync commands can
 * sit directly behind coreutils `timeout`, which does not shell-parse a bare
 * `VAR=value` assignment.
 */
function mountEnvPrefix(
  opts: Pick<RelayfileMountShellOptions, "credsFilePath" | "tokenIngress" | "token">,
): string {
  if (opts.tokenIngress === "creds-file" && !opts.credsFilePath) {
    // Fail at build time, not as an unauthenticated daemon in the sandbox:
    // this ingress deliberately renders no token, so without a creds file the
    // command carries no credential by any route.
    throw new Error(
      "relayfile mount tokenIngress 'creds-file' requires credsFilePath",
    );
  }
  const parts: string[] = [];
  if (opts.credsFilePath) {
    parts.push(`RELAYFILE_MOUNT_CREDS_FILE=${shellQuote(opts.credsFilePath)}`);
  }
  if (opts.tokenIngress === "env") {
    parts.push(`RELAYFILE_MOUNT_TOKEN=${shellQuote(opts.token)}`);
  }
  return parts.length > 0 ? `env ${parts.join(" ")} ` : "";
}

export type RelayfileMountInitialSyncOptions = RelayfileMountShellOptions & {
  /**
   * Optional timeout for a pre-handler sync. When set, the command uses
   * coreutils `timeout`; if it is unavailable, the sync fails so callers can
   * gracefully continue without risking an unbounded pre-handler sync.
   */
  timeoutSeconds?: number;
  /**
   * Optional idle timeout for pre-handler sync. Unlike timeoutSeconds, this
   * cancels only when mount state stops progressing for N seconds.
   */
  idleTimeoutSeconds?: number;
};

export type RelayfileMountDaemonOptions = RelayfileMountShellOptions & {
  /** Daemon sync interval. Defaults to `1s` for near-real-time writeback. */
  interval?: string;
  /** Path the daemon redirects stdout/stderr to. Defaults to `/tmp/relayfile-mount.log`. */
  logPath?: string;
};

export type RelayfileMountShellTemplate = {
  startShellTemplate: string;
  flushShellTemplate: string;
  pathArgsPlaceholderArg: string;
  pathArgTemplate: string;
  placeholders: {
    baseUrl: string;
    workspaceId: string;
    localDir: string;
    token: string;
    pathArgs: string;
    path: string;
  };
};

const DEFAULT_TEMPLATE_PLACEHOLDERS: RelayfileMountShellTemplate["placeholders"] = {
  baseUrl: "__relayfile_base_url__",
  workspaceId: "__relayfile_workspace_id__",
  localDir: "__relayfile_local_dir__",
  token: "__relayfile_token__",
  pathArgs: "__relayfile_path_args__",
  path: "__relayfile_path__",
};

/**
 * Bash command that starts a `relayfile-mount` daemon in the background and
 * echoes the daemon PID on stdout (so callers can capture it and kill the
 * process later). The daemon redirects all output to `logPath` so it does
 * not pollute the caller's stdout/stderr.
 *
 * Mirrors the inline command originally in
 * `executor.ts:startRelayfileMount` (#???) — see the file-level comment for
 * the migration story.
 */
export function buildRelayfileMountStartShell(opts: RelayfileMountDaemonOptions): string {
  const scopedRoots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  if (scopedRoots.length > 1) {
    return buildRelayfileMountMultiStartShell({ ...opts, paths: scopedRoots });
  }
  const [mount] = exactMounts(opts.localDir, scopedRoots);
  const args = buildMountArgs({ ...opts, ...mount });
  const interval = opts.interval ?? "1s";
  const logPath = opts.logPath ?? "/tmp/relayfile-mount.log";
  return [
    `${mountEnvPrefix(opts)}nohup relayfile-mount`,
    ...args,
    `--interval ${shellQuote(interval)}`,
    `> ${shellQuote(logPath)} 2>&1 & echo $!`,
  ].join(" ");
}

/**
 * Bash command that runs a one-time relayfile-mount sync (`--once`). Pushes
 * any pending local writes upstream and exits. Use this:
 *   - As an explicit pre-handler sync so the mount mirror is populated
 *     before the handler reads from it (executor's initial-sync pattern).
 *   - As a post-handler flush before sandbox teardown so writeback drafts
 *     the handler created (e.g. `ctx.github.comment` files) reach
 *     relayfile cloud before the sandbox stops.
 */
export function buildRelayfileMountFlushShell(opts: RelayfileMountShellOptions): string {
  const scopedRoots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const commands = exactMounts(opts.localDir, scopedRoots).map((mount) => [
    `${mountEnvPrefix(opts)}relayfile-mount --once`,
    ...buildMountArgs({ ...opts, ...mount }),
  ].join(" "));
  return composeIndependentMountCommands(commands);
}

/**
 * Post-handler CLEANUP flush command — the durable cure for cleanup flushes
 * that time out on large mirrors. Identical to
 * {@link buildRelayfileMountFlushShell} EXCEPT the mode flag is the shell
 * variable `$relayfile_mount_flush_mode`, which the lifecycle shell probes
 * once into `--flush-outbox-once` (O(durable outbox); flushes only
 * `.relay/outbox/pending` and exits WITHOUT a full-tree reconcile —
 * scanLocalFiles/pushLocal/pullRemote — so a large mirror can't blow the
 * cleanup `timeout`) on daemons that support it, else `--once` on older ones,
 * whose behavior is unchanged. Emitted as a SINGLE command (the flag is one
 * expanded token) so it stays valid inside the cleanup's `timeout Ns ...`
 * wrapper — an inline `if/fi` would break `timeout`. The flag choice does not
 * change the exit-code/`.relay/state.json` contract the cleanup gate reads: a
 * real outbox-flush failure still exits nonzero and leaves pending, so the
 * loud-fail stays load-bearing.
 */
export function buildRelayfileMountCleanupFlushShell(
  opts: RelayfileMountShellOptions,
): string {
  const scopedRoots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const mounts = exactMounts(opts.localDir, scopedRoots);
  if (mounts.length === 1) {
    return [
      `${mountEnvPrefix(opts)}relayfile-mount "$relayfile_mount_flush_mode"`,
      ...buildMountArgs({ ...opts, ...mounts[0]! }),
    ].join(" ");
  }
  const commands = mounts.map((mount) => [
    `${mountEnvPrefix(opts)}relayfile-mount "$1"`,
    ...buildMountArgs({ ...opts, ...mount }),
  ].join(" "));
  const script = independentMountCommandsScript(commands);
  return `sh -c ${shellQuote(script)} relayfile-mount-cleanup "$relayfile_mount_flush_mode"`;
}

export function buildRelayfileMountInitialSyncShell(
  opts: RelayfileMountInitialSyncOptions,
): string {
  const commands = buildInitialSyncCommands(opts);
  const command = composeIndependentMountCommands(commands);
  if (opts.idleTimeoutSeconds && opts.idleTimeoutSeconds > 0) {
    return buildIdleWatchedCommand(
      command,
      initialSyncProgressFiles(opts),
      opts.idleTimeoutSeconds,
    );
  }
  if (!opts.timeoutSeconds || opts.timeoutSeconds <= 0) {
    return command;
  }
  const timeout = `${Math.ceil(opts.timeoutSeconds)}s`;
  const timedCommand = composeIndependentMountCommands(
    commands.map((entry) => `timeout ${shellQuote(timeout)} ${entry}`),
  );
  return [
    "{",
    "if command -v timeout >/dev/null 2>&1; then",
    `${timedCommand};`,
    "else",
    "echo 'timeout command unavailable for relayfile initial sync' >&2;",
    "false;",
    "fi;",
    "}",
  ].join(" ");
}

export const RELAYFILE_INITIAL_SYNC_SCRIPT_PATH = "/tmp/relayfile-initial-sync.sh";
export const RELAYFILE_INITIAL_SYNC_EXIT_PATH = "/tmp/relayfile-initial-sync.exit";
export const RELAYFILE_INITIAL_SYNC_LOG_PATH = "/tmp/relayfile-initial-sync.log";
export const RELAYFILE_INITIAL_SYNC_PID_PATH = "/tmp/relayfile-initial-sync.pid";

export type RelayfileMountInitialSyncRunOptions = {
  runId?: string;
};

function relayfileInitialSyncPath(path: string, runId: string | undefined): string {
  if (!runId) {
    return path;
  }
  const safeRunId = runId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${path}.${safeRunId}`;
}

/**
 * Bash that launches the (idle-watched) initial sync in the background and
 * returns immediately, echoing the launcher PID. Daytona's exec path cannot
 * host a single long-running command: the proxy read-times-out around 120s
 * (a gateway timeout) and callers add their own client-side fail-fast, so a
 * first materialization with real data (a populated /github tree, a cold
 * workspace export) gets killed mid-sync. Instead the sync runs detached in
 * the sandbox — preserving the in-sandbox idle watchdog — and callers poll
 * `buildRelayfileMountInitialSyncStatusShell` with short execs until the
 * exit sentinel appears.
 */
export function buildRelayfileMountInitialSyncBackgroundShell(
  opts: RelayfileMountInitialSyncOptions,
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const scriptPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_SCRIPT_PATH,
    runOptions.runId,
  );
  const exitPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_EXIT_PATH,
    runOptions.runId,
  );
  const logPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_LOG_PATH,
    runOptions.runId,
  );
  const pidPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_PID_PATH,
    runOptions.runId,
  );
  const syncShell = buildRelayfileMountInitialSyncShell(opts);
  const runner = [
    "if command -v setsid >/dev/null 2>&1; then",
    `  setsid sh ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1 &`,
    "else",
    `  sh ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1 &`,
    "fi;",
    "relayfile_initial_sync_pid=$!;",
    `echo "$relayfile_initial_sync_pid" > ${shellQuote(pidPath)};`,
    "relayfile_initial_sync_status=0;",
    'wait "$relayfile_initial_sync_pid" || relayfile_initial_sync_status=$?;',
    // Shred the generated script the moment the sync is done with it, and do
    // it BEFORE the exit sentinel lands: a poller that sees the sentinel must
    // never be able to race back and read the script. The log, pid and exit
    // sentinels survive — they are the non-secret failure diagnostics.
    `rm -f ${shellQuote(scriptPath)};`,
    `echo "$relayfile_initial_sync_status" > ${shellQuote(exitPath)}`,
  ].join(" ");
  return [
    "set -e",
    `rm -f ${shellQuote(scriptPath)} ${shellQuote(exitPath)} ${shellQuote(logPath)} ${shellQuote(pidPath)}`,
    // The script can carry a credential (see `tokenIngress`), so it must never
    // exist group/world-readable for even an instant. `umask 077` in a subshell
    // constrains the mode at creation — a chmod after the write would leave a
    // readable window a sibling process could win. Quoted heredoc delimiter:
    // the sync shell lands in the file verbatim, with no re-quoting hazards
    // from nesting it in `sh -c`.
    `(umask 077 && cat > ${shellQuote(scriptPath)}) <<'RELAYFILE_INITIAL_SYNC_EOF'
${syncShell}
RELAYFILE_INITIAL_SYNC_EOF`,
    // Defence in depth: confirm the mode that actually landed before handing
    // the script to a detached process. GNU/busybox spell it `stat -c %a`,
    // BSD `stat -f %Lp`. If neither exists we cannot read the mode back, but
    // the umask above already fixed it at creation, so `unknown` is tolerated
    // rather than failing a sandbox shut for lacking `stat`.
    `relayfile_initial_sync_mode=$(stat -c %a ${shellQuote(scriptPath)} 2>/dev/null || stat -f %Lp ${shellQuote(scriptPath)} 2>/dev/null || echo unknown)`,
    'case "$relayfile_initial_sync_mode" in',
    "  600|unknown) ;;",
    "  *)",
    `    rm -f ${shellQuote(scriptPath)};`,
    '    echo "relayfile initial sync script is mode $relayfile_initial_sync_mode, not 600; refusing to launch" >&2;',
    "    exit 1",
    "    ;;",
    "esac",
    `nohup sh -c ${shellQuote(runner)} >/dev/null 2>&1 & echo $!`,
  ].join("\n");
}

const RELAYFILE_INITIAL_SYNC_EXIT_MARKER = "relayfile-initial-sync-exit:";
const RELAYFILE_INITIAL_SYNC_RUNNING_MARKER = "relayfile-initial-sync-running";

/** Short, idempotent status probe for the backgrounded initial sync. */
export function buildRelayfileMountInitialSyncStatusShell(
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const exitPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_EXIT_PATH,
    runOptions.runId,
  );
  const pidPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_PID_PATH,
    runOptions.runId,
  );
  return [
    `if [ -f ${shellQuote(exitPath)} ]; then`,
    `echo "${RELAYFILE_INITIAL_SYNC_EXIT_MARKER}$(cat ${shellQuote(exitPath)})";`,
    `elif [ -f ${shellQuote(pidPath)} ]; then`,
    `relayfile_initial_sync_pid=$(cat ${shellQuote(pidPath)} 2>/dev/null || true);`,
    'case "$relayfile_initial_sync_pid" in',
    `  ''|*[!0-9]*) echo ${RELAYFILE_INITIAL_SYNC_RUNNING_MARKER} ;;`,
    '  *)',
    '    if kill -0 "$relayfile_initial_sync_pid" 2>/dev/null; then',
    `      echo ${RELAYFILE_INITIAL_SYNC_RUNNING_MARKER};`,
    "    else",
    `      echo "${RELAYFILE_INITIAL_SYNC_EXIT_MARKER}127";`,
    "    fi",
    "    ;;",
    "esac",
    "else",
    `echo ${RELAYFILE_INITIAL_SYNC_RUNNING_MARKER};`,
    "fi",
  ].join(" ");
}

export function buildRelayfileMountInitialSyncKillShell(
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const pidPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_PID_PATH,
    runOptions.runId,
  );
  return [
    `if [ -f ${shellQuote(pidPath)} ]; then`,
    `relayfile_initial_sync_pid=$(cat ${shellQuote(pidPath)} 2>/dev/null || true);`,
    'case "$relayfile_initial_sync_pid" in',
    "  ''|*[!0-9]*) ;;",
    '  *)',
    '    kill -TERM -- "-$relayfile_initial_sync_pid" 2>/dev/null || true;',
    '    kill "$relayfile_initial_sync_pid" 2>/dev/null || true',
    "    ;;",
    "esac",
    "fi",
  ].join(" ");
}

export function buildRelayfileMountInitialSyncLogTailShell(
  lines = 40,
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const logPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_LOG_PATH,
    runOptions.runId,
  );
  return `tail -n ${Math.max(1, Math.floor(lines))} ${shellQuote(logPath)} 2>/dev/null || true`;
}

export type RelayfileMountInitialSyncStatus =
  | { state: "running" }
  | { state: "exited"; exitCode: number }
  // The probe's output is a closed set (exit marker or running marker), so
  // anything else means the exec channel itself is broken — callers fail
  // fast instead of polling garbage until their deadline.
  | { state: "unknown" };

export function parseRelayfileMountInitialSyncStatus(
  output: string,
): RelayfileMountInitialSyncStatus {
  const match = output.match(
    new RegExp(`${RELAYFILE_INITIAL_SYNC_EXIT_MARKER}(-?\\d+)`),
  );
  const exitCode = match?.[1];
  if (exitCode !== undefined) {
    return { state: "exited", exitCode: Number.parseInt(exitCode, 10) };
  }
  if (output.includes(RELAYFILE_INITIAL_SYNC_RUNNING_MARKER)) {
    return { state: "running" };
  }
  return { state: "unknown" };
}

export function buildRelayfileMountPathArgsShell(paths: readonly string[]): string {
  return scopedRemoteRoots(paths, { allowProviderRoot: true })
    .map(buildMountPathArg)
    .join("");
}

export function buildRelayfileMountShellTemplate(
  placeholders: Partial<RelayfileMountShellTemplate["placeholders"]> = {},
  // `stateDir` is required (sandbox-image specific); `interval` / `websocket`
  // stay optional.
  options:
    & Pick<RelayfileMountDaemonOptions, "stateDir">
    & Partial<Pick<RelayfileMountDaemonOptions, "interval" | "websocket">>,
): RelayfileMountShellTemplate {
  const resolved = { ...DEFAULT_TEMPLATE_PLACEHOLDERS, ...placeholders };
  const baseOpts = {
    baseUrl: resolved.baseUrl,
    workspaceId: resolved.workspaceId,
    localDir: resolved.localDir,
    token: resolved.token,
    ...options,
  };
  const pathArgsPlaceholderArg = buildMountPathArg(resolved.pathArgs);
  const pathArgTemplate = buildMountPathArg(resolved.path);
  return {
    startShellTemplate: buildDynamicMountStartTemplate(
      baseOpts,
      pathArgsPlaceholderArg,
    ),
    flushShellTemplate: buildDynamicMountOnceTemplate(
      baseOpts,
      pathArgsPlaceholderArg,
    ),
    pathArgsPlaceholderArg,
    pathArgTemplate,
    placeholders: resolved,
  };
}

function buildMountArgs(opts: RelayfileMountShellOptions): string[] {
  return [
    EXACT_LOCAL_LAYOUT_ARG,
    `--base-url ${shellQuote(opts.baseUrl)}`,
    `--workspace ${shellQuote(opts.workspaceId)}`,
    `--local-dir ${shellQuote(opts.localDir)}`,
    `--state-dir ${shellQuote(opts.stateDir)}`,
    // Token goes via env prefix (see mountEnvPrefix) when tokenIngress === 'env'
    // and is not rendered at all when tokenIngress === 'creds-file', so in
    // neither case does it enter argv. Otherwise it is emitted as --token for
    // backwards compat with daemon builds that only read the flag.
    ...(opts.tokenIngress === "env" || opts.tokenIngress === "creds-file"
      ? []
      : [`--token ${shellQuote(opts.token)}`]),
    ...(opts.websocket === false ? ["--websocket=false"] : []),
    ...(opts.lazyRepos ? ["--lazy-repos"] : []),
    ...scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true })
      .map((path) => `--remote-path ${shellQuote(path)}`),
  ];
}

/**
 * Private state file the initial sync is pinned to via `--state-file`.
 *
 * `buildIdleWatchedCommand` cancels the sync when this file stops advancing,
 * so the *only* safe way to name it is to pin it — never to guess where the
 * mount would otherwise put it. The digest mirrors relayfile's mount identity
 * tuple (`MountStateID` in `internal/mountsync/state_path.go`): workspace,
 * normalized remote root, normalized local root, and mount kind. That keeps
 * concurrent mounts in the same sandbox from reading, overwriting, or
 * mistaking one another's checkpoints for watchdog progress.
 */
function initialSyncStateFile(
  opts: Pick<RelayfileMountShellOptions, "workspaceId">,
  remoteRoot: string,
  localRoot: string,
): string {
  const mountIdentity = [
    opts.workspaceId.trim(),
    posixPath.normalize(remoteRoot.trim() || "/"),
    posixPath.normalize(localRoot.trim()),
    "initial-sync",
  ].join("\0");
  const mountId = createHash("sha256")
    .update(mountIdentity, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `/tmp/relayfile-mount-initial-sync-${mountId}.json`;
}

function initialSyncStateFiles(opts: RelayfileMountInitialSyncOptions): string[] {
  const roots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  if (roots.length > 0) {
    return exactMounts(opts.localDir, roots).map((mount) =>
      initialSyncStateFile(opts, mount.paths[0]!, mount.localDir)
    );
  }
  const [mount] = exactMounts(opts.localDir, []);
  return [initialSyncStateFile(opts, "/", mount!.localDir)];
}

function buildInitialSyncCommands(opts: RelayfileMountInitialSyncOptions): string[] {
  const roots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const stateFiles = initialSyncStateFiles(opts);
  return exactMounts(opts.localDir, roots)
    .map((mount, index) => {
      const args = [
        ...buildMountArgs({ ...opts, ...mount }),
        `--state-file ${shellQuote(stateFiles[index]!)}`,
      ];
      return [`${mountEnvPrefix(opts)}relayfile-mount --once`, ...args].join(" ");
    });
}

/**
 * The files whose mtime the idle watchdog reads as "the sync is still making
 * progress". Every entry MUST be a path `buildInitialSyncCommands` pinned via
 * `--state-file` — relayfile-mount checkpoints private state every 32 files
 * during a bootstrap traversal, so a pinned path advances steadily and a
 * genuine stall is the only thing that stops it.
 *
 * The unscoped branch used to name `<state-dir>/.relayfile-mount-state.json`,
 * which no relayfile-mount build ever writes (the legacy file of that name
 * lived under the LOCAL root, not the state dir). `[ -f ... ]` was therefore
 * always false, the marker was touched once at launch and never again, and
 * the idle watchdog degraded into an unconditional hard kill at the idle
 * timeout — killing initial syncs that were demonstrably still progressing.
 */
function initialSyncProgressFiles(opts: RelayfileMountInitialSyncOptions): string[] {
  return initialSyncStateFiles(opts);
}

function buildIdleWatchedCommand(
  command: string,
  progressFiles: readonly string[],
  idleTimeoutSeconds: number,
): string {
  const idle = Math.max(1, Math.ceil(idleTimeoutSeconds));
  const poll = Math.max(1, Math.min(5, Math.floor(idle / 3) || 1));
  const progressArgs = progressFiles.map(shellQuote).join(" ");
  return [
    "(",
    `set -- ${progressArgs};`,
    "relayfile_mount_marker=$(mktemp /tmp/relayfile-mount-progress.XXXXXX) || exit 1;",
    'touch "$relayfile_mount_marker";',
    `(${command}) &`,
    "relayfile_mount_sync_pid=$!;",
    "relayfile_mount_status=0;",
    'while kill -0 "$relayfile_mount_sync_pid" 2>/dev/null; do',
    '  for relayfile_mount_progress_file in "$@"; do',
    '    if [ -f "$relayfile_mount_progress_file" ] && [ "$relayfile_mount_progress_file" -nt "$relayfile_mount_marker" ]; then',
    '      touch "$relayfile_mount_marker";',
    "    fi;",
    "  done;",
    "  relayfile_mount_now=$(date +%s);",
    '  relayfile_mount_marker_mtime=$(date -r "$relayfile_mount_marker" +%s 2>/dev/null || stat -c %Y "$relayfile_mount_marker" 2>/dev/null || echo "$relayfile_mount_now");',
    `  if [ $((relayfile_mount_now - relayfile_mount_marker_mtime)) -ge ${idle} ]; then`,
    `    echo 'relayfile initial sync made no progress for ${idle}s; canceling' >&2;`,
    '    kill "$relayfile_mount_sync_pid" 2>/dev/null || true;',
    '    wait "$relayfile_mount_sync_pid" 2>/dev/null || true;',
    '    rm -f "$relayfile_mount_marker";',
    "    exit 124;",
    "  fi;",
    `  sleep ${poll};`,
    "done;",
    'wait "$relayfile_mount_sync_pid" || relayfile_mount_status=$?;',
    'rm -f "$relayfile_mount_marker";',
    'exit "$relayfile_mount_status";',
    ")",
  ].join(" ");
}

function scopedRemoteRoots(
  paths: readonly string[],
  options: { allowProviderRoot?: boolean } = {},
): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const root = scopedRemoteRoot(path, options);
    if (root) {
      roots.add(root);
    }
  }
  return [...roots].sort();
}

function scopedRemoteRoot(
  path: string,
  options: { allowProviderRoot?: boolean } = {},
): string | null {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const withoutGlob = trimmed.endsWith("/**") ? trimmed.slice(0, -3) : trimmed;
  const normalized = withoutGlob.replace(/\/{2,}/g, "/").replace(/\/$/u, "");
  if (!normalized || normalized === "/" || normalized.includes("*")) {
    return null;
  }
  if (normalized.slice(1).split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`relayfile remote root contains a traversal segment: ${path}`);
  }
  if (!options.allowProviderRoot && normalized.slice(1).split("/").length < 2) {
    return null;
  }
  return normalized;
}

function unscopedLocalDir(localRoot: string, remoteRoots: readonly string[]): string {
  let normalizedRoot = localRoot.replace(/\/+$/u, "");
  const suffixes = remoteRoots
    .map((remoteRoot) => remoteRoot.replace(/^\/+/u, "").replace(/\/+$/u, ""))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const suffix of suffixes) {
    if (!suffix) {
      continue;
    }
    if (normalizedRoot === suffix) {
      normalizedRoot = "";
      continue;
    }
    if (normalizedRoot.endsWith(`/${suffix}`)) {
      normalizedRoot = normalizedRoot.slice(0, -suffix.length).replace(/\/+$/u, "");
      continue;
    }
    const nestedSuffix = `/${suffix}/`;
    const nestedIndex = normalizedRoot.indexOf(nestedSuffix);
    if (nestedIndex !== -1) {
      normalizedRoot = normalizedRoot.slice(0, nestedIndex).replace(/\/+$/u, "");
    }
  }
  return normalizedRoot || "/";
}

type ExactMount = Pick<RelayfileMountShellOptions, "localDir" | "paths"> & {
  paths: readonly string[];
};

/**
 * Resolve the final exact-layout mount root(s).
 *
 * Callers are allowed to pass either the unscoped base (`/workspace`) or an
 * already joined single-path directory (`/workspace/github/repos/acme/app`).
 * Recovering the base first prevents a double append, then every remote root
 * gets its own exact-layout invocation and final on-disk directory.
 */
function exactMounts(localRoot: string, remoteRoots: readonly string[]): ExactMount[] {
  const unscopedRoot = unscopedLocalDir(localRoot, remoteRoots);
  if (remoteRoots.length === 0) {
    return [{ localDir: unscopedRoot, paths: [] }];
  }
  return remoteRoots.map((remoteRoot) => {
    const localDir = posixPath.join(
      unscopedRoot,
      remoteRoot.replace(/^\/+/, ""),
    );
    const localPrefix = unscopedRoot === "/" ? "/" : `${unscopedRoot}/`;
    if (localDir !== unscopedRoot && !localDir.startsWith(localPrefix)) {
      throw new Error(`relayfile remote root escapes local mount root: ${remoteRoot}`);
    }
    return { localDir, paths: [remoteRoot] };
  });
}

/**
 * Resolve the public on-disk roots owned by the exact-layout mount processes.
 * Lifecycle consumers use this same computation for timeout budgets and
 * `.relay` observability so command generation and teardown cannot disagree
 * about where a mount's public state lives.
 */
export function resolveRelayfileMountExactLayout(
  opts: Pick<RelayfileMountShellOptions, "localDir" | "paths">,
): { baseLocalDir: string; mountLocalDirs: string[] } {
  const remoteRoots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const mounts = exactMounts(opts.localDir, remoteRoots);
  return {
    baseLocalDir: unscopedLocalDir(opts.localDir, remoteRoots),
    mountLocalDirs: mounts.map((mount) => mount.localDir),
  };
}

/**
 * Run every independent mount root and return the first failure only after
 * all roots have had a chance to flush. Teardown must never let a bad first
 * root discard pending writes from the remaining roots.
 */
function independentMountCommandsScript(commands: readonly string[]): string {
  return [
    "relayfile_mount_flush_status=0",
    ...commands.map((command) => [
      `${command} || {`,
      "relayfile_mount_flush_code=$?;",
      'if [ "$relayfile_mount_flush_status" -eq 0 ]; then relayfile_mount_flush_status=$relayfile_mount_flush_code; fi;',
      "}",
    ].join(" ")),
    'exit "$relayfile_mount_flush_status"',
  ].join("; ");
}

function composeIndependentMountCommands(commands: readonly string[]): string {
  if (commands.length === 1) {
    return commands[0]!;
  }
  const script = independentMountCommandsScript(commands);
  return `sh -c ${shellQuote(script)}`;
}

function buildMountPathArg(path: string): string {
  return ` --remote-path ${shellQuote(path)}`;
}

const DYNAMIC_LOCAL_DIR = "__relayfile_dynamic_local_dir__";
// Must be absolute so scopedRemoteRoots/buildMountArgs retain the sentinel
// until dynamicMountArgs replaces it with the late-bound shell variable.
const DYNAMIC_REMOTE_PATH = "/__relayfile_dynamic_remote_path__";

function dynamicMountArgs(
  opts: RelayfileMountShellOptions,
  includeRemotePath: boolean,
): string[] {
  return buildMountArgs({
    ...opts,
    localDir: DYNAMIC_LOCAL_DIR,
    paths: includeRemotePath ? [DYNAMIC_REMOTE_PATH] : [],
  }).map((arg) => arg
    .replace(shellQuote(opts.baseUrl), '"$relayfile_mount_base_url"')
    .replace(shellQuote(opts.workspaceId), '"$relayfile_mount_workspace_id"')
    .replace(shellQuote(opts.token), '"$relayfile_mount_token"')
    .replace(shellQuote(DYNAMIC_LOCAL_DIR), '"$relayfile_mount_local_dir"')
    .replace(shellQuote(DYNAMIC_REMOTE_PATH), '"$relayfile_mount_remote_path"'));
}

function dynamicMountTemplateSetup(opts: RelayfileMountShellOptions): string[] {
  return [
    `relayfile_mount_base_url=${shellQuote(opts.baseUrl)};`,
    `relayfile_mount_workspace_id=${shellQuote(opts.workspaceId)};`,
    `relayfile_mount_local_root=${shellQuote(opts.localDir)};`,
    `relayfile_mount_token=${shellQuote(opts.token)};`,
  ];
}

function dynamicMountPathSetup(): string[] {
  return [
    'relayfile_mount_remote_path="$2";',
    "shift 2;",
    'relayfile_mount_local_dir="${relayfile_mount_local_root%/}/${relayfile_mount_remote_path#/}";',
  ];
}

/**
 * Validate late-bound `--remote-path <root>` pairs before daemon startup and
 * recover an unscoped base when the rendered localDir already ends with one
 * of those roots. Validation runs in a command-substitution subshell, so its
 * `shift` calls do not consume the execution pass's positional arguments.
 * Callers also wrap the whole template in a subshell, keeping the initial
 * `set --` private from the embedding shell.
 */
function dynamicMountPreflight(pathArgsPlaceholderArg: string): string[] {
  return [
    "relayfile_mount_preflight() {",
    'relayfile_mount_preflight_root="$1";',
    "shift;",
    'while [ "$#" -gt 0 ]; do',
    'if [ "$#" -lt 2 ] || [ "$1" != "--remote-path" ]; then echo "invalid relayfile mount path args" >&2; exit 2; fi;',
    'relayfile_mount_remote_path="$2";',
    'case "$relayfile_mount_remote_path" in /*) ;; *) echo "relayfile remote root must be absolute" >&2; exit 2 ;; esac;',
    'case "/${relayfile_mount_remote_path#/}/" in */../*|*/./*) echo "relayfile remote root contains a traversal segment" >&2; exit 2 ;; esac;',
    'relayfile_mount_remote_suffix="${relayfile_mount_remote_path#/}";',
    'relayfile_mount_remote_suffix="${relayfile_mount_remote_suffix%/}";',
    'if [ -z "$relayfile_mount_remote_suffix" ]; then echo "relayfile remote root must not be empty" >&2; exit 2; fi;',
    'case "$relayfile_mount_preflight_root" in',
    '"$relayfile_mount_remote_suffix") relayfile_mount_preflight_root=/ ;;',
    '*/"$relayfile_mount_remote_suffix") relayfile_mount_preflight_root="${relayfile_mount_preflight_root%"/$relayfile_mount_remote_suffix"}"; [ -n "$relayfile_mount_preflight_root" ] || relayfile_mount_preflight_root=/ ;;',
    '*/"$relayfile_mount_remote_suffix"/*) relayfile_mount_preflight_root="${relayfile_mount_preflight_root%%"/$relayfile_mount_remote_suffix/"*}"; [ -n "$relayfile_mount_preflight_root" ] || relayfile_mount_preflight_root=/ ;;',
    "esac;",
    "shift 2;",
    "done;",
    'printf \'%s\\n\' "$relayfile_mount_preflight_root";',
    "};",
    `set --${pathArgsPlaceholderArg};`,
    'relayfile_mount_validated_local_root=$(relayfile_mount_preflight "$relayfile_mount_local_root" "$@") || exit $?;',
    'relayfile_mount_local_root="$relayfile_mount_validated_local_root";',
  ];
}

/**
 * The shell-template consumer supplies its remote roots after this package is
 * built, so it cannot use the static exactMounts helper. Parse the same
 * repeated `--remote-path <root>` pairs in the rendered shell and apply the
 * identical base/root join before launching one exact-layout daemon per root.
 */
function buildDynamicMountStartTemplate(
  opts: RelayfileMountDaemonOptions,
  pathArgsPlaceholderArg: string,
): string {
  const interval = opts.interval ?? "1s";
  const logPath = opts.logPath ?? "/tmp/relayfile-mount.log";
  const pathlessStart = [
    `${mountEnvPrefix(opts)}nohup relayfile-mount`,
    ...dynamicMountArgs(opts, false),
    `--interval ${shellQuote(interval)}`,
    `> ${shellQuote(logPath)} 2>&1 & echo $!`,
  ].join(" ");
  const dynamicStart = [
    `${mountEnvPrefix(opts)}relayfile-mount`,
    ...dynamicMountArgs(opts, true),
    `--interval ${shellQuote(interval)}`,
    `>> ${shellQuote(logPath)} 2>&1 &`,
    'relayfile_mount_pids="$relayfile_mount_pids $!";',
  ].join(" ");
  return [
    "(",
    ...dynamicMountTemplateSetup(opts),
    ...dynamicMountPreflight(pathArgsPlaceholderArg),
    'if [ "$#" -eq 0 ]; then',
    'relayfile_mount_local_dir="$relayfile_mount_local_root";',
    `${pathlessStart};`,
    "else",
    "(",
    "relayfile_mount_pids='';",
    'while [ "$#" -gt 0 ]; do',
    'if [ "$#" -lt 2 ] || [ "$1" != "--remote-path" ]; then echo "invalid relayfile mount path args" >&2; exit 2; fi;',
    ...dynamicMountPathSetup(),
    dynamicStart,
    "done;",
    "trap 'kill $relayfile_mount_pids 2>/dev/null || true; wait' INT TERM EXIT;",
    "wait",
    `) >/dev/null 2>&1 & echo $!;`,
    "fi;",
    ")",
  ].join(" ");
}

function buildDynamicMountOnceTemplate(
  opts: RelayfileMountShellOptions,
  pathArgsPlaceholderArg: string,
): string {
  const pathlessOnce = [
    `${mountEnvPrefix(opts)}relayfile-mount --once`,
    ...dynamicMountArgs(opts, false),
  ].join(" ");
  const dynamicOnce = [
    `${mountEnvPrefix(opts)}relayfile-mount --once`,
    ...dynamicMountArgs(opts, true),
  ].join(" ");
  return [
    "(",
    ...dynamicMountTemplateSetup(opts),
    ...dynamicMountPreflight(pathArgsPlaceholderArg),
    'if [ "$#" -eq 0 ]; then',
    'relayfile_mount_local_dir="$relayfile_mount_local_root";',
    `${pathlessOnce};`,
    "else",
    "relayfile_mount_flush_status=0;",
    'while [ "$#" -gt 0 ]; do',
    'if [ "$#" -lt 2 ] || [ "$1" != "--remote-path" ]; then echo "invalid relayfile mount path args" >&2; exit 2; fi;',
    ...dynamicMountPathSetup(),
    `${dynamicOnce} || {`,
    "relayfile_mount_flush_code=$?;",
    'if [ "$relayfile_mount_flush_status" -eq 0 ]; then relayfile_mount_flush_status=$relayfile_mount_flush_code; fi;',
    "};",
    "done;",
    'exit "$relayfile_mount_flush_status";',
    "fi;",
    ")",
  ].join(" ");
}

function buildRelayfileMountMultiStartShell(opts: RelayfileMountDaemonOptions): string {
  const roots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const interval = opts.interval ?? "1s";
  const logPath = opts.logPath ?? "/tmp/relayfile-mount.log";
  const starts = exactMounts(opts.localDir, roots).map((mount) => [
    `${mountEnvPrefix(opts)}relayfile-mount`,
    ...buildMountArgs({ ...opts, ...mount }),
    `--interval ${shellQuote(interval)}`,
    `>> ${shellQuote(logPath)} 2>&1 &`,
    "relayfile_mount_pids=\"$relayfile_mount_pids $!\";",
  ].join(" "));
  return [
    "(",
    "relayfile_mount_pids='';",
    ...starts,
    "trap 'kill $relayfile_mount_pids 2>/dev/null || true; wait' INT TERM EXIT;",
    "wait",
    ") >/dev/null 2>&1 & echo $!",
  ].join(" ");
}

/**
 * POSIX-safe single-quote escape. `foo` → `'foo'`, `foo's` → `'foo'\''s'`.
 * Conservative — quotes every value, even ones that don't strictly need it,
 * so callers never have to think about characters that would otherwise be
 * shell-interpreted (spaces, `$`, etc.).
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
