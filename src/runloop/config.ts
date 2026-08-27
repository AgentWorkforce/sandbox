/** SDK-free configuration for the Runloop adapter. */
export interface RunloopRuntimeOptions {
  /** Runloop bearer token. Never read from ambient process state. */
  apiKey: string;
  /** Optional API base URL for a non-default Runloop control plane. */
  baseUrl?: string;
  /** Home directory in the selected Devbox image. */
  defaultHomeDir: string;
  /** Stable caller identity persisted in Devbox metadata. */
  ownerTag: string;
  /** Optional Blueprint ID used for every launch. */
  blueprintId?: string;
  /** Optional Blueprint name used for every launch. */
  blueprintName?: string;
  /** Optional Snapshot ID used for every launch. */
  snapshotId?: string;
  /** Per-request timeout passed to the official SDK. */
  requestTimeoutMs?: number;
  /** Interval between async execution status reads. */
  pollIntervalMs?: number;
}
