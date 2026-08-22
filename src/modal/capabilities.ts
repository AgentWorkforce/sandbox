import type {
  DeclaredSandboxRuntimeCapabilities,
  SandboxCapabilityModes,
} from "../port.js";
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

/**
 * Structured capability modes for the Modal adapter.
 *
 * Every cell below restates, in the type system, something this file already
 * documented in prose. That is the whole reason to fill them in: the booleans
 * above cannot distinguish "Modal cannot do this" from "Modal can, but our port
 * exposes no operation reaching it" from "nobody has checked yet", and this
 * adapter is the one that had to work around that by hand — see
 * {@link MODAL_STRUCTURALLY_FALSE}.
 *
 * Note what is deliberately *not* here: `warmLease` stays a `false` boolean
 * pending the live canary. Modes describe the shape of a capability, not its
 * verification state, so a mode is not a back door for promoting a cell that
 * the house rule keeps unproven.
 */
export const modalCapabilityModes = {
  /**
   * `buffered`, not `separate-streams`.
   *
   * Modal's `exec()` does return live `stdout`/`stderr` as separate
   * `ReadableStream`s, and `runScript` does hand back separated `stdout` and
   * `stderr` fields. But both streaming members of the union require output to
   * be *streamed live*, and the adapter drains both pipes to completion with
   * `readText()` before it returns anything. Separated-after-the-fact is still
   * buffered. Declaring `separate-streams` would promise callers an incremental
   * channel this port does not have.
   */
  outputStreams: "buffered",
  /**
   * Anything written is lost when the sandbox goes away, and on Modal it always
   * goes away: `terminate()` is the only lifecycle transition and it is
   * terminal. There is no stop/start pair for state to survive across, so
   * `persistent` cannot apply.
   */
  filesystem: "ephemeral",
  /**
   * The structural fact behind `neverIdle: false` in
   * {@link MODAL_STRUCTURALLY_FALSE}, now stated in the type rather than in a
   * hand-maintained list. *Every* Modal Sandbox carries a maximum lifetime —
   * five minutes by default, 24 hours at the ceiling (`MODAL_MAX_LIFETIME_MS`),
   * and the provider terminates it when that elapses. There is no "no deadline"
   * setting, so no live run can ever move this.
   *
   * `deadline` says that on its own; per the union's own note, a provider that
   * always terminates at a deadline cannot offer a never-idle tier, so this
   * needs no separate `unsupported`.
   */
  lifetime: "deadline",
  /**
   * `not-exposed`, emphatically not `unsupported`: Modal supports PTY on both
   * `create` and `exec` (`pty: true`). This package's port declares no PTY
   * operation, so it is unreachable *here*. It moves if someone adds one — and
   * `isPendingEvidence()` correctly reports false for it, because no canary
   * against Modal can change a fact about our own port surface.
   */
  interactive: "not-exposed",
  /**
   * Also `not-exposed`. Modal has real filesystem snapshots —
   * `snapshotFilesystem()` and `snapshotDirectory(path)`, both returning an
   * `Image` reusable as a create source. The port exposes no snapshot
   * operation, so the capability is not reachable through it.
   *
   * This is exactly the cell the absence vocabulary was added to protect:
   * `modalObservedCapabilities.snapshotCapture` is a *pending* observation
   * about the provider, while this is a *settled* fact about our port. A canary
   * may promote that one; it must never promote this one.
   */
  snapshots: "not-exposed",
} as const satisfies SandboxCapabilityModes;
