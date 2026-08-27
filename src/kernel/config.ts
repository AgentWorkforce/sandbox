/** SDK-free configuration for the Kernel adapter. */
export interface KernelRuntimeOptions {
  /** Kernel API key. Never read from ambient process state. */
  apiKey: string;
  /** Optional Kernel project ID. */
  projectId?: string;
  /** Optional Kernel project name. */
  project?: string;
  /** Optional API base URL override. */
  baseUrl?: string;
  /** Home directory in the Kernel browser VM. */
  defaultHomeDir: string;
  /** Stable caller identity persisted in browser tags. */
  ownerTag: string;
  /** Lowercase prefix used for every created browser name. */
  namePrefix: string;
  /** Provider-enforced inactivity timeout, from 10 seconds through 72 hours. */
  timeoutSeconds: number;
  /** Per-request timeout passed to the official SDK. */
  requestTimeoutMs?: number;
  /** How long teardown verification may poll. */
  destroyTimeoutMs?: number;
  /** Teardown verification polling interval. */
  pollIntervalMs?: number;
}
