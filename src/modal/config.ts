/**
 * SDK-free configuration for the Modal adapter.
 *
 * Nothing in this module imports the vendor SDK, so config can be constructed,
 * validated, and asserted on without pulling in a gRPC stack.
 *
 * Modal's object model is not the one this package's port assumes, and the
 * difference is load-bearing rather than cosmetic:
 *
 *  - A Modal Sandbox is **a child of an App**, created from an **Image**.
 *    `sandboxes.create(app, image, params)` takes both as required arguments.
 *    There is no "just make me a sandbox" entry point, so `appName` and
 *    `imageTag` are required here. No default is correct for every consumer,
 *    and this package bakes none in.
 *  - A Modal Sandbox has a **maximum lifetime**, after which the provider
 *    terminates it. The SDK's default is five minutes. That default is a trap
 *    for every caller who expects E2B/Daytona semantics, so `maxLifetimeMs` is
 *    required and always sent explicitly — see {@link ModalRuntimeOptions.maxLifetimeMs}.
 *  - A Modal Sandbox **cannot be stopped and restarted**. `terminate()` is the
 *    only lifecycle transition and it is terminal.
 */

/**
 * Modal credentials. Modal does not use a single bearer key: it authenticates
 * with a token *pair*. Both halves are required, and neither is ever read from
 * ambient process state — credential sourcing belongs to the caller.
 */
export interface ModalCredentials {
  /** Modal token id, conventionally prefixed `ak-`. */
  tokenId: string;
  /** Modal token secret, conventionally prefixed `as-`. */
  tokenSecret: string;
}

/** Compute shape requested for each sandbox. Drives both placement and billing. */
export interface ModalResourceShape {
  /**
   * Reservation of **physical** CPU cores; may be fractional. Modal counts one
   * physical core as two vCPU, so a "2 vCPU" reference shape is `cpu: 1`.
   * Modal enforces a floor of 0.125 cores per container.
   */
  cpu?: number;
  /** Hard CPU limit in physical cores. Omitted means no limit beyond the reservation. */
  cpuLimit?: number;
  /** Memory reservation in MiB. */
  memoryMiB?: number;
  /** Hard memory limit in MiB. */
  memoryLimitMiB?: number;
}

export interface ModalRuntimeOptions {
  /** Modal token pair. Required; never sourced from the environment here. */
  credentials: ModalCredentials;

  /**
   * Name of the Modal App that owns every sandbox this runtime creates.
   * Required: Modal has no appless sandbox, and no app name is universally
   * correct. The adapter resolves it with `apps.fromName(name, {createIfMissing})`.
   */
  appName: string;

  /**
   * Whether the adapter may create `appName` if it does not exist. Defaults to
   * `false`: creating provider-side objects as a side effect of a lookup is the
   * kind of thing a caller should opt into, not discover.
   */
  createAppIfMissing?: boolean;

  /**
   * Registry tag for the sandbox image, e.g. `python:3.13` or a private
   * registry reference. Required for the same reason as `appName`.
   */
  imageTag: string;

  /**
   * Modal environment name. Omitted means the credential's default environment.
   * Set it to scope resources away from `main`.
   */
  environment?: string;

  /** Optional control-plane endpoint override. Omitted uses the SDK's endpoint. */
  endpoint?: string;

  /**
   * Home directory inside the image. Required because it is image-specific and
   * no universal default exists.
   */
  defaultHomeDir: string;

  /** Working directory for the sandbox and for exec'd commands. Defaults to `defaultHomeDir`. */
  workdir?: string;

  /**
   * Prefix identifying resources this runtime is allowed to own. Used both as
   * the sandbox name prefix and as the value of the ownership tag.
   */
  namePrefix: string;

  /**
   * Tag key carrying the ownership marker. Defaults to `agentRelayOwner`.
   *
   * Ownership is enforced through Modal's **server-side tag filter**, not
   * through client-side name matching: `sandboxes.list({ tags })` returns only
   * sandboxes carrying *all* the given tags, so injecting the ownership tag
   * into every lookup makes cross-tenant collision structurally impossible
   * rather than merely unlikely.
   */
  ownerTagKey?: string;

  /**
   * **Maximum sandbox lifetime.** Required, and deliberately so.
   *
   * Modal terminates a sandbox once this elapses, whether or not work is still
   * running, and the SDK's own default is 5 minutes. Every other provider this
   * package adapts treats a sandbox as living until told otherwise, so silently
   * inheriting a 5-minute cap would strand callers' long-running work with no
   * diagnosable cause. Making it required forces the decision into the open.
   *
   * This is NOT a request deadline. For that, see `createTimeoutMs`.
   */
  maxLifetimeMs: number;

  /**
   * Idle timeout in milliseconds — an independent knob from `maxLifetimeMs`.
   * Omitted means Modal applies no idle termination.
   */
  idleTimeoutMs?: number;

  /** Compute shape for each sandbox. Omitted fields fall back to Modal's defaults. */
  resources?: ModalResourceShape;

  /** Cloud provider to place sandboxes on. Omitted lets Modal choose. */
  cloud?: string;

  /** Region(s) to place sandboxes in. Omitted lets Modal choose. */
  regions?: string[];

  /** Block all outbound network access from the sandbox. */
  blockNetwork?: boolean;

  /** Per-request deadline handed to the SDK client. Default 30_000. */
  requestTimeoutMs?: number;

  /** Total deadline for a create call. Default 120_000. */
  createTimeoutMs?: number;

  /** Total deadline for list/get/count calls. Default 30_000. */
  lookupTimeoutMs?: number;

  /** Default deadline for a single exec when the caller does not supply one. Default 120_000. */
  execTimeoutMs?: number;

  /** Deadline for terminate plus its post-condition check. Default 60_000. */
  destroyTimeoutMs?: number;

  /** Deadline for a file upload. Default 60_000. */
  uploadTimeoutMs?: number;

  /** Polling interval for delete verification. Default 500. */
  pollIntervalMs?: number;

  /**
   * Re-check each listed sandbox's tags in-process instead of trusting the
   * server-side filter. Defaults to `true`.
   *
   * `sandboxes.list({ tags })` is documented to return only sandboxes carrying
   * all the requested tags, and this adapter's whole ownership model rests on
   * that. But a filter that is silently ignored, partially applied, or changed
   * by a future release would hand a caller a **foreign sandbox as a warm
   * lease** — strictly worse than returning no lease at all, because the caller
   * would then exec into someone else's container. Until `warmLease` is
   * promoted by a live probe, the filter is an unproven claim, and this adapter
   * does not build ownership on unproven claims.
   *
   * The cost is real and worth stating: unlike providers that return tags
   * inline with the listing, Modal's `Sandbox` object exposes `getTags()` as a
   * separate call, so verification costs **one extra round trip per candidate**.
   * Callers who have measured the filter and accept the risk can set this to
   * `false`; the default errs toward correctness.
   */
  verifyTagsClientSide?: boolean;
}

/** Defaults applied by {@link resolveModalRuntimeOptions}. */
export const MODAL_DEFAULTS = {
  ownerTagKey: "agentRelayOwner",
  createAppIfMissing: false,
  verifyTagsClientSide: true,
  requestTimeoutMs: 30_000,
  createTimeoutMs: 120_000,
  lookupTimeoutMs: 30_000,
  execTimeoutMs: 120_000,
  destroyTimeoutMs: 60_000,
  uploadTimeoutMs: 60_000,
  pollIntervalMs: 500,
} as const;

/**
 * Modal's documented floor for a CPU reservation. Requesting less is rejected
 * here rather than at the provider, so the failure names the real cause.
 */
export const MODAL_MIN_CPU_CORES = 0.125;

/**
 * Modal's documented hard ceiling on a sandbox's maximum lifetime: 24 hours.
 *
 * Beyond this the provider offers no continuous-run option at all — its own
 * guidance is to take a filesystem snapshot and restore it into a *new*
 * sandbox. So a request for a longer-lived sandbox is not merely optimistic,
 * it is unsatisfiable, and it fails here rather than at create time.
 */
export const MODAL_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Config with every optional field resolved. */
export type ResolvedModalRuntimeOptions =
  & Omit<ModalRuntimeOptions, keyof typeof MODAL_DEFAULTS | "workdir">
  & { [K in keyof typeof MODAL_DEFAULTS]-?: NonNullable<ModalRuntimeOptions[K]> }
  & { workdir: string };

function requireNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`ModalRuntime requires a non-empty ${field}`);
  }
  return trimmed;
}

/**
 * A positive, finite duration. Non-finite values are rejected rather than
 * coerced: `NaN` propagated into a deadline comparison silently disables the
 * deadline instead of failing, which is the worst of both outcomes.
 */
function requirePositiveMs(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(
      `ModalRuntime ${field} must be a finite, positive number of milliseconds; got ${String(value)}`,
    );
  }
  return resolved;
}

/** Validate and normalize caller config. Throws on anything unusable. */
export function resolveModalRuntimeOptions(
  options: ModalRuntimeOptions,
): ResolvedModalRuntimeOptions {
  const tokenId = requireNonEmpty(options.credentials?.tokenId, "credentials.tokenId");
  const tokenSecret = requireNonEmpty(
    options.credentials?.tokenSecret,
    "credentials.tokenSecret",
  );
  const appName = requireNonEmpty(options.appName, "appName");
  const imageTag = requireNonEmpty(options.imageTag, "imageTag");
  const defaultHomeDir = requireNonEmpty(options.defaultHomeDir, "defaultHomeDir");
  const namePrefix = requireNonEmpty(options.namePrefix, "namePrefix");
  const ownerTagKey = requireNonEmpty(
    options.ownerTagKey ?? MODAL_DEFAULTS.ownerTagKey,
    "ownerTagKey",
  );

  // Required and unforgiving: inheriting Modal's 5-minute default silently caps
  // every caller's work.
  if (options.maxLifetimeMs === undefined) {
    throw new Error(
      "ModalRuntime requires an explicit maxLifetimeMs: a Modal Sandbox is terminated by "
        + "the provider once its maximum lifetime elapses, and the SDK default is 5 minutes. "
        + "No default here would be correct for every caller.",
    );
  }
  const maxLifetimeMs = requirePositiveMs(options.maxLifetimeMs, Number.NaN, "maxLifetimeMs");
  if (maxLifetimeMs > MODAL_MAX_LIFETIME_MS) {
    throw new Error(
      `ModalRuntime maxLifetimeMs (${maxLifetimeMs}) exceeds Modal's documented 24-hour ceiling `
        + `(${MODAL_MAX_LIFETIME_MS}). Modal has no longer-lived sandbox: past 24 hours its own `
        + "guidance is to snapshot the filesystem and restore into a new sandbox.",
    );
  }

  const idleTimeoutMs = options.idleTimeoutMs === undefined
    ? undefined
    : requirePositiveMs(options.idleTimeoutMs, Number.NaN, "idleTimeoutMs");
  if (idleTimeoutMs !== undefined && idleTimeoutMs > maxLifetimeMs) {
    // Not fatal for Modal, but it always means the caller misread one of the
    // two knobs: an idle timeout longer than the hard lifetime can never fire.
    throw new Error(
      `ModalRuntime idleTimeoutMs (${idleTimeoutMs}) exceeds maxLifetimeMs (${maxLifetimeMs}); `
        + "the idle timeout could never fire before the sandbox is terminated outright",
    );
  }

  const resources = options.resources;
  if (resources?.cpu !== undefined) {
    if (!Number.isFinite(resources.cpu) || resources.cpu < MODAL_MIN_CPU_CORES) {
      throw new Error(
        `ModalRuntime resources.cpu must be a finite number >= ${MODAL_MIN_CPU_CORES} `
          + `physical cores; got ${String(resources.cpu)}`,
      );
    }
  }
  if (resources?.memoryMiB !== undefined) {
    if (!Number.isFinite(resources.memoryMiB) || resources.memoryMiB <= 0) {
      throw new Error(
        `ModalRuntime resources.memoryMiB must be a finite, positive number; got ${String(resources.memoryMiB)}`,
      );
    }
  }
  // Hard limits are validated on their own before any comparison with a
  // reservation. Otherwise `cpuLimit: NaN` or `memoryLimitMiB: -1` slips
  // through whenever the matching reservation is omitted, and the failure
  // resurfaces at `sandboxes.create` with a message that no longer names the
  // real cause.
  if (resources?.cpuLimit !== undefined) {
    if (!Number.isFinite(resources.cpuLimit) || resources.cpuLimit < MODAL_MIN_CPU_CORES) {
      throw new Error(
        `ModalRuntime resources.cpuLimit must be a finite number >= ${MODAL_MIN_CPU_CORES} `
          + `physical cores; got ${String(resources.cpuLimit)}`,
      );
    }
  }
  if (resources?.memoryLimitMiB !== undefined) {
    if (!Number.isFinite(resources.memoryLimitMiB) || resources.memoryLimitMiB <= 0) {
      throw new Error(
        `ModalRuntime resources.memoryLimitMiB must be a finite, positive number; `
          + `got ${String(resources.memoryLimitMiB)}`,
      );
    }
  }
  if (
    resources?.cpu !== undefined && resources.cpuLimit !== undefined
    && resources.cpuLimit < resources.cpu
  ) {
    throw new Error(
      `ModalRuntime resources.cpuLimit (${resources.cpuLimit}) is below resources.cpu (${resources.cpu})`,
    );
  }
  if (
    resources?.memoryMiB !== undefined && resources.memoryLimitMiB !== undefined
    && resources.memoryLimitMiB < resources.memoryMiB
  ) {
    throw new Error(
      `ModalRuntime resources.memoryLimitMiB (${resources.memoryLimitMiB}) is below `
        + `resources.memoryMiB (${resources.memoryMiB})`,
    );
  }

  // `blockNetwork` and `regions` are independent Modal parameters: a
  // sandbox can legitimately need outbound-network isolation *and* placement
  // in a specific region for data residency, latency, or capacity reasons.
  // Blocking network access does not make physical placement meaningless.

  return {
    credentials: { tokenId, tokenSecret },
    appName,
    imageTag,
    defaultHomeDir,
    workdir: options.workdir?.trim() || defaultHomeDir,
    namePrefix,
    ownerTagKey,
    createAppIfMissing: options.createAppIfMissing ?? MODAL_DEFAULTS.createAppIfMissing,
    verifyTagsClientSide: options.verifyTagsClientSide
      ?? MODAL_DEFAULTS.verifyTagsClientSide,
    maxLifetimeMs,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(resources === undefined ? {} : { resources }),
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
    ...(options.regions === undefined ? {} : { regions: options.regions }),
    ...(options.blockNetwork === undefined ? {} : { blockNetwork: options.blockNetwork }),
    requestTimeoutMs: requirePositiveMs(
      options.requestTimeoutMs,
      MODAL_DEFAULTS.requestTimeoutMs,
      "requestTimeoutMs",
    ),
    createTimeoutMs: requirePositiveMs(
      options.createTimeoutMs,
      MODAL_DEFAULTS.createTimeoutMs,
      "createTimeoutMs",
    ),
    lookupTimeoutMs: requirePositiveMs(
      options.lookupTimeoutMs,
      MODAL_DEFAULTS.lookupTimeoutMs,
      "lookupTimeoutMs",
    ),
    execTimeoutMs: requirePositiveMs(
      options.execTimeoutMs,
      MODAL_DEFAULTS.execTimeoutMs,
      "execTimeoutMs",
    ),
    destroyTimeoutMs: requirePositiveMs(
      options.destroyTimeoutMs,
      MODAL_DEFAULTS.destroyTimeoutMs,
      "destroyTimeoutMs",
    ),
    uploadTimeoutMs: requirePositiveMs(
      options.uploadTimeoutMs,
      MODAL_DEFAULTS.uploadTimeoutMs,
      "uploadTimeoutMs",
    ),
    pollIntervalMs: requirePositiveMs(
      options.pollIntervalMs,
      MODAL_DEFAULTS.pollIntervalMs,
      "pollIntervalMs",
    ),
  };
}
