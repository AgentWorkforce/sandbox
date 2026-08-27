export interface DepotResources {
  vcpus?: number;
  memoryMb?: number;
  diskGb?: number;
}

/** SDK-free configuration for the Depot adapter. */
export interface DepotRuntimeOptions {
  /** Depot bearer token. Never read from ambient process state. */
  token: string;
  /** Organization required by service/app tokens and multi-org user tokens. */
  orgId?: string;
  /** Optional API endpoint override. */
  endpoint?: string;
  /** Home directory in the chosen OCI image. */
  defaultHomeDir: string;
  /** Stable caller identity persisted in the Sandbox environment. */
  ownerTag: string;
  /** Lowercase prefix used for every created Sandbox name. */
  namePrefix: string;
  /** OCI image reference. Omitted to use the provider default. */
  imageRef?: string;
  /** Requested resource shape. */
  resources?: DepotResources;
  /** Provider-enforced Sandbox lifetime in minutes. */
  timeoutMinutes?: number;
  /** How long teardown verification may poll. */
  destroyTimeoutMs?: number;
  /** Teardown verification polling interval. */
  pollIntervalMs?: number;
}
