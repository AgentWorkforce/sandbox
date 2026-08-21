import type { DeclaredSandboxRuntimeCapabilities } from "../port.js";
import type { RuntimeCapabilities } from "../types.js";

/**
 * SDK-free capability metadata for the Modal adapter.
 *
 * House rule: a behavioral claim stays `false` until a live probe against the
 * pinned SDK establishes it. "The SDK has a method for it" is not evidence —
 * a method can exist and degrade, and a capability means *reachable through
 * this package's port*, not *present in the vendor surface*.
 */
export const modalSandboxCapabilities = {
  /**
   * Modal genuinely has server-side label search: `sandboxes.list({ tags })`
   * returns only sandboxes carrying all the given tags, and the adapter routes
   * every lookup through it. That is a real warm-lease implementation, unlike
   * providers where `findAllByLabels` degrades to `[]`.
   *
   * It is nevertheless declared `false` until the live canary proves that a
   * tagged sandbox is actually returned by a tag-filtered list. Promoting it
   * on the strength of a type signature is exactly the inference this field
   * exists to prevent, and `false` fails in the safe direction: the
   * orchestrator declines to rely on warm leases rather than leaking them.
   */
  warmLease: false,
  /**
   * Permanently false, and not pending verification.
   *
   * Modal exposes no stop/start for a Sandbox. `terminate()` is the only
   * lifecycle transition and it is terminal — there is no suspend, resume, or
   * wake. The adapter therefore omits `start`/`stop` entirely rather than
   * shipping no-ops, and this flag records the structural fact for the
   * capability resolver, which cannot see an absent method.
   */
  lifecycle: false,
} as const satisfies DeclaredSandboxRuntimeCapabilities;

/**
 * Bootstrap-plane capabilities. Note this is `RuntimeCapabilities` from
 * `../types.js` — the live in-sandbox plane — and NOT the orchestration-plane
 * `SandboxRuntimeCapabilities`. The two are deliberately distinct.
 */
export const modalWorkflowCapabilities = {
  /**
   * Modal supports PTY on both `create` and `exec` (`pty: true`, which
   * multiplexes stderr into stdout). This package's port exposes no PTY
   * operation, so it is not reachable here.
   */
  pty: false,
  /**
   * Modal exposes real filesystem snapshots — `snapshotFilesystem()` and
   * `snapshotDirectory(path)`, both returning an `Image` reusable as a create
   * source (30-day default TTL, `ttlMs: null` to retain indefinitely). This
   * package's port exposes no snapshot operation, so the capability is not
   * reachable through it. Documented here so the surface is not lost.
   */
  snapshots: false,
  /** Modal Sandboxes are gVisor-isolated containers with their own filesystem. */
  isolation: "strong",
  /** A sandbox id survives the client: `sandboxes.fromId(id)` re-resolves it. */
  persistentHandle: true,
  /**
   * `exec()` returns live `stdout`/`stderr` as `ReadableStream`s, so Modal can
   * genuinely stream. The adapter drains them to completion to satisfy the
   * port's buffered `RunScriptResult`, and the port exposes no streaming
   * surface, so this is false *for this port* while true of the provider.
   */
  streamingLogs: false,
} as const satisfies RuntimeCapabilities;

/**
 * Cells proven by a live run against Modal. Everything starts `false` and is
 * promoted only by an observation recorded in the adapter's docs, never by
 * reading the SDK's types.
 */
export type ModalObservedCapabilities = {
  /** A terminated sandbox verifiably left the account, checked by re-lookup. */
  cleanupVerified: boolean;
  /** `snapshotFilesystem` produced an Image that booted a new sandbox. */
  snapshotCapture: boolean;
  /** Tag-filtered `list()` returned a sandbox we tagged at create. */
  warmLease: boolean;
  /** `fromId` re-resolved a sandbox created by a different client instance. */
  reattach: boolean;
  /** stop -> settled -> start -> exec succeeded. Structurally impossible on Modal. */
  lifecycle: boolean;
  /**
   * A sandbox can be kept alive indefinitely with no termination deadline.
   *
   * Structurally false on Modal, like {@link lifecycle}, and for the same kind
   * of reason: *every* Modal Sandbox carries a maximum lifetime. It defaults to
   * five minutes, it can be raised only as far as 24 hours, and the provider
   * terminates the sandbox when it elapses. There is no "no deadline" setting.
   * Past 24 hours Modal's own guidance is to snapshot the filesystem and
   * restore it into a *new* sandbox, which is a rebuild rather than a
   * continuation. No live run can promote this.
   */
  neverIdle: boolean;
  /** A sandbox outlived Modal's 5-minute default because we set maxLifetimeMs. */
  lifetimeOverride: boolean;
  /** Concurrent creates all reached ready without provider-side throttling. */
  concurrencyCeiling: boolean;
};

/** Nothing promoted yet: no live run has happened. Awaiting credentials. */
export const modalObservedCapabilities: ModalObservedCapabilities = {
  cleanupVerified: false,
  snapshotCapture: false,
  warmLease: false,
  reattach: false,
  lifecycle: false,
  neverIdle: false,
  lifetimeOverride: false,
  concurrencyCeiling: false,
};

/**
 * Cells that are **settled structural facts**, not pending observations.
 *
 * The distinction matters for review: everything else in
 * {@link modalObservedCapabilities} is `false` only because no live run has
 * happened yet and will flip when one does. These two are `false` because the
 * provider cannot do the thing at all, so a future canary must not "promote"
 * them and a future reader must not try to "fix" them.
 */
export const MODAL_STRUCTURALLY_FALSE = [
  "lifecycle",
  "neverIdle",
] as const satisfies ReadonlyArray<keyof ModalObservedCapabilities>;
