/** SDK-free configuration for the Freestyle adapter. */
export type FreestylePersistence =
  | { type: "persistent" }
  | { type: "sticky"; priority: number }
  | { type: "ephemeral" };

export interface FreestyleRuntimeOptions {
  /** Freestyle server API key. Never read from ambient process state. */
  apiKey: string;
  /** Optional API origin override; omitted to use the pinned SDK's endpoint. */
  baseUrl?: string;
  /** Image-specific home directory. Required because no universal default exists. */
  defaultHomeDir: string;
  /** Prefix used to identify resources this runtime is allowed to own. */
  namePrefix: string;
  /** Optional opaque snapshot id used as the create source. */
  snapshotId?: string;
  /** Explicit persistence policy; the adapter never selects a vendor tier. */
  persistence: FreestylePersistence;
  /** Forwarded exactly on create and start. `null` means never idle. */
  idleTimeoutSeconds?: number | null;
  /** Default client-side request deadline. */
  requestTimeoutMs?: number;
  /** Default total deadline for create when the caller does not provide one. */
  createTimeoutMs?: number;
  /** Default total deadline for list/get/count operations. */
  lookupTimeoutMs?: number;
  /** Deadline for a lifecycle operation to reach a settled state. */
  lifecycleSettleTimeoutMs?: number;
  /** Lifecycle and delete-verification polling interval. */
  pollIntervalMs?: number;
}
