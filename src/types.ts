/**
 * How strongly a runtime isolates a workload from the host.
 *
 * `'unknown'` is deliberately NOT a synonym for weak. It is for a provider
 * whose isolation this package has not established as fact — most often a
 * hosted backend whose internals are documented by the vendor but not
 * observable from here. Encoding such a case as `'strong'` would publish a
 * guarantee nobody verified, and encoding it as `'none'`/`'process'` would
 * publish a limitation that may not exist. A caller that requires a specific
 * guarantee must treat `'unknown'` as "not established" and decide for itself.
 */
export type IsolationLevel = 'none' | 'process' | 'strong' | 'unknown';

export interface RuntimeCapabilities {
  pty: boolean;
  snapshots: boolean;
  isolation: IsolationLevel;
  persistentHandle: boolean;
  streamingLogs: boolean;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  label?: string;
  name?: string;
  labels?: Record<string, string>;
  workdir?: string;
  createTimeoutSeconds?: number;
  /**
   * Deadline after which the instance is a leak — the caller promises the
   * instance is safe to reap once wall-clock passes this timestamp. Together
   * with `attributionTag`, this is the reap-ephemeral contract: an out-of-
   * process reaper (see `scripts/reap-ephemeral.ts`) DELETEs instances that
   * carry BOTH fields when `ephemeralUntil` is in the past. Adapters that
   * accept this option persist it on the instance's provider-side metadata
   * so it survives caller crashes.
   *
   * Number: Unix milliseconds. String: ISO-8601 (parsed and re-encoded to
   * millis at persist time; consistency with the reaper is on the adapter).
   *
   * **Never sweep on labels alone.** `metadata.ephemeral === 'true'` is a
   * caller-set label, not a lifecycle contract — sweeping on it deletes
   * healthy warm-lease instances that legitimately carry the same label.
   * The safe contract is `attributionTag + ephemeralUntil<past>`, both
   * required.
   */
  ephemeralUntil?: number | string;
  /**
   * Opaque tag identifying which system launched this instance for the
   * reap-ephemeral contract. Any two systems that share a tag agree to
   * reap each other's leaked instances; a tag with no counter-reaper leaks
   * quietly. Combined with `ephemeralUntil` per the contract above.
   *
   * Suggested shape: `<system-slug>:<lane-slug>` (e.g.,
   * `bench:sandbox-provider-comparison-0819`). Kept as an opaque string
   * so the reap contract does not force a shared taxonomy.
   */
  attributionTag?: string;
}

export interface RuntimeHandle {
  id: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  homeDir?: string;
  workdir?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  output: string;
  exitCode: number;
  /**
   * True when the provider capped captured output and `output` is therefore
   * incomplete. Optional and additive; `undefined` means the provider did not
   * report truncation, not that the output is known to be complete. A given
   * adapter may guarantee more than this baseline for its own reads — see
   * that adapter's implementation for the stronger claim, if any.
   */
  truncated?: boolean;
}

export interface AsyncExecStartResult {
  sessionId: string;
  commandId: string;
  /**
   * True when an outcome-unknown transport failure was resolved by finding
   * the exact command in the fresh deterministic session.
   */
  reconciled?: true;
}

export interface AsyncExecStatus {
  exitCode: number | null;
}

export interface WorkflowRuntime {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;

  launch(options?: LaunchOptions): Promise<RuntimeHandle>;
  launchDetached?(options?: LaunchOptions): Promise<RuntimeHandle>;
  getById?(
    id: string,
    options?: { owned?: boolean; homeDir?: string; workdir?: string; states?: readonly string[] | null },
  ): Promise<RuntimeHandle | null>;
  findAllByLabels?(
    labels: Record<string, string>,
    options?: { states?: readonly string[] | null; limit?: number; pageSize?: number },
  ): Promise<RuntimeHandle[]>;
  exec(handle: RuntimeHandle, command: string, options?: ExecOptions): Promise<ExecResult>;
  startExec?(handle: RuntimeHandle, command: string, options?: ExecOptions & { sessionId?: string }): Promise<AsyncExecStartResult>;
  getExecStatus?(handle: RuntimeHandle, sessionId: string, commandId: string): Promise<AsyncExecStatus>;
  getExecLogs?(handle: RuntimeHandle, sessionId: string, commandId: string): Promise<ExecResult>;
  uploadFile(handle: RuntimeHandle, source: string | Buffer, destination: string): Promise<void>;
  downloadFile(handle: RuntimeHandle, source: string, destination?: string): Promise<Buffer | void>;
  getHomeDir(handle: RuntimeHandle): Promise<string>;
  start?(handle: RuntimeHandle): Promise<RuntimeHandle>;
  stop?(handle: RuntimeHandle): Promise<void>;
  destroy(handle: RuntimeHandle): Promise<void>;
}
