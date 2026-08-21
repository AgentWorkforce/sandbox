/**
 * SDK-free configuration for the Vercel Sandbox adapter.
 *
 * Nothing in this module imports `@vercel/sandbox`. Consumers can construct and
 * type-check a configuration without the optional peer dependency installed.
 */

/**
 * Credentials for the Vercel Sandbox API.
 *
 * Vercel Sandbox cannot be addressed with a bare API key: every request is
 * scoped to a team and a project. `token` accepts either a personal access
 * token or an OIDC token; the other two fields are required in both cases.
 *
 * These are always injected. The adapter never reads `VERCEL_TOKEN`,
 * `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, or `VERCEL_OIDC_TOKEN` from ambient
 * process state, because a runtime that silently picks up an operator's shell
 * credentials cannot be reasoned about by its caller.
 */
export interface VercelCredentials {
  /** Personal access token or OIDC token. */
  token: string;
  /** Team that owns the project. */
  teamId: string;
  /** Project the sandboxes are created under. */
  projectId: string;
}

/**
 * Sandbox environment selection. Exactly one of the two forms, mirroring the
 * provider's own mutual exclusion between the legacy runtime and VCR images.
 */
export type VercelSandboxSource =
  | { type: "image"; image: string }
  /** Legacy Vercel-managed runtime. Deprecated upstream; accepted for parity. */
  | { type: "runtime"; runtime: string }
  /** Provider default (`vercel/sandbox/universal:latest` at time of writing). */
  | { type: "default" };

export interface VercelRuntimeOptions extends VercelCredentials {
  /**
   * Prefix used to identify sandboxes this runtime is allowed to own.
   *
   * Ownership is by name, because a Vercel sandbox's name *is* its identity
   * within a project. Every created sandbox is named `<prefix>-<suffix>`, and
   * the adapter refuses to mutate or delete anything outside that prefix.
   */
  namePrefix: string;
  /**
   * Image-specific home directory. Required because no default is correct for
   * every image; the managed universal image uses `/vercel/sandbox`.
   */
  defaultHomeDir: string;
  /** Explicit environment selection; the adapter never picks an image itself. */
  source?: VercelSandboxSource;
  /**
   * vCPUs per sandbox. The provider allocates 2048 MB of memory per vCPU, so
   * memory is not separately configurable. Omitted means the provider default.
   */
  vcpus?: number;
  /**
   * Wall-clock lifetime in milliseconds after which the provider terminates
   * the sandbox. Vercel has no never-idle tier: a sandbox always carries a
   * termination deadline, so this is a real bound and not a hint.
   */
  sandboxTimeoutMs?: number;
  /**
   * Whether the provider restores the filesystem across sessions. Explicit
   * because the durability contract differs materially between the two.
   */
  persistent?: boolean;
  /** Ports to expose. The provider caps this at 15. */
  ports?: readonly number[];
  /**
   * Default environment variables baked into the sandbox at create time and
   * inherited by every command.
   */
  env?: Readonly<Record<string, string>>;

  // --- deadlines -----------------------------------------------------------
  // Every remote operation carries an explicit deadline. They are separate
  // fields rather than one global timeout because their honest magnitudes
  // differ by two orders of magnitude, and collapsing them would force the
  // cheapest operation to wait as long as the most expensive one.

  /** Fallback per-request deadline for operations without a specific one. */
  requestTimeoutMs?: number;
  /** Total deadline for sandbox creation. */
  createTimeoutMs?: number;
  /** Total deadline for list/get lookups. */
  lookupTimeoutMs?: number;
  /** Default total deadline for a command when the caller supplies none. */
  execTimeoutMs?: number;
  /** Total deadline for a single file read/write/mkdir. */
  fileTimeoutMs?: number;
  /** Deadline for a lifecycle transition to reach a settled state. */
  lifecycleTimeoutMs?: number;
  /** Deadline for delete submission plus verification of absence. */
  deleteTimeoutMs?: number;
  /** Lifecycle and delete-verification polling interval. */
  pollIntervalMs?: number;
  /**
   * Absolute ceiling on any single SDK call including the SDK's own internal
   * retries.
   *
   * The vendor SDK retries some failures internally (it depends on
   * `async-retry`). Without an absolute signal that spans the whole call, a
   * request that is retried N times can outlive the caller's deadline by a
   * multiple of it. This value caps the entire retry chain, not one attempt.
   */
  retryDeadlineMs?: number;

  // --- pagination ----------------------------------------------------------
  /** Page size used when listing sandboxes. */
  listPageSize?: number;
  /**
   * Hard cap on pages walked during a single listing, so a large or
   * pathologically paginated project cannot turn a lookup into an unbounded
   * crawl. Exceeding it is an error, never a silently truncated result.
   */
  maxListPages?: number;
}
