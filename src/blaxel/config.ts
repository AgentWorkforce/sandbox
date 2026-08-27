/** SDK-free configuration for the Blaxel adapter. */
export interface BlaxelRuntimeOptions {
  /** Blaxel API key. Never read from ambient process state. */
  apiKey: string;
  /** Blaxel workspace owning every Sandbox. */
  workspace: string;
  /** Home directory in the selected Sandbox image. */
  defaultHomeDir: string;
  /** Stable caller identity persisted as a provider label. */
  ownerTag: string;
  /** Lowercase prefix used for every provider resource name. */
  namePrefix: string;
  /** Optional Sandbox image. */
  image?: string;
  /** Optional memory allocation in MiB. */
  memoryMb?: number;
  /** Required provider-side maximum age, for example `2h`. */
  maxAge: string;
  /** Optional provider-side terminated-record retention, for example `1h`. */
  terminatedRetention?: string;
  /** Delete verification deadline. */
  destroyTimeoutMs?: number;
  /** Polling interval for process and delete status. */
  pollIntervalMs?: number;
}
