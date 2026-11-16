/** SDK-free configuration for the boxd adapter. */

/** Machine sizes boxd offers, as vCPU and memory. */
export type BoxdMachineSize =
  | { vcpu: 1; memory: "4G" }
  | { vcpu: 2; memory: "8G" }
  | { vcpu: 4; memory: "16G" }
  | { vcpu: 8; memory: "32G" };

export interface BoxdRuntimeOptions {
  /** boxd API key. Never read from ambient process state. */
  apiKey: string;
  /**
   * Organization that owns and is billed for the machines. Omit to use the
   * organization the API key belongs to.
   */
  org?: string;
  /** Region machines are created and looked up in, e.g. `"fra"` or `"nyc"`. */
  region?: string;
  /** Optional API endpoint override; omitted to use the SDK's default endpoint. */
  baseUrl?: string;
  /**
   * Prefix for machine names, and the value of the ownership label every
   * machine this runtime creates carries. Lowercase letters, digits, hyphen.
   */
  namePrefix: string;
  /**
   * Label key that marks machines as owned by this runtime. Default
   * `agent-relay-sandbox`. Callers may not set it through launch labels.
   */
  ownerLabelKey?: string;
  /** Home directory of the machine user. Default `/home/boxd`. */
  defaultHomeDir?: string;
  /** Machine size. Omit to use the organization's default size. */
  size?: BoxdMachineSize;
  /**
   * Keep machines off the organization's private network and without in-VM
   * credentials. Default `true`, because sandboxes run agent-written code.
   */
  isolated?: boolean;
  /**
   * Create machines from this snapshot (name or id) instead of the base image.
   * The machine gets the snapshot's size, so `size` cannot be set with it.
   */
  fromSnapshot?: string;
  /**
   * Seconds without network traffic before a machine goes to standby. `0`
   * disables standby. Default `0`: agent runs can be CPU-only for minutes.
   */
  autoSuspendTimeoutSeconds?: number;
  /**
   * Seconds of idleness before a machine hibernates (memory and disk kept,
   * woken by the next command). `0` disables it. Omit to keep the
   * organization's default. Set `0` for long commands that use no network.
   */
  autoHibernateTimeoutSeconds?: number;
  /**
   * Delete each machine this many seconds after it is created, whatever state
   * it is in. Omit for machines that live until `destroy()`.
   */
  deleteAfterSeconds?: number;
  /** Default client-side request deadline. */
  requestTimeoutMs?: number;
  /** Deadline for one file upload or download. Default 10 minutes. */
  transferTimeoutMs?: number;
  /** Default total deadline for create, including readiness. */
  createTimeoutMs?: number;
  /** Default total deadline for list/get/count operations. */
  lookupTimeoutMs?: number;
  /** Deadline for a lifecycle operation or delete to reach a settled state. */
  lifecycleSettleTimeoutMs?: number;
  /** Lifecycle and delete-verification polling interval. */
  pollIntervalMs?: number;
}
