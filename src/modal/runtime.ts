import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  DeclaredSandboxRuntimeCapabilities,
  RunScriptResult,
  SandboxCapabilityModes,
  SandboxCountOptions,
  SandboxLookupOptions,
  SandboxRuntime,
} from "../port.js";
import type { RuntimeHandle } from "../types.js";
import {
  modalCapabilityModes,
  modalSandboxCapabilities,
} from "./capabilities.js";
import {
  type ModalRuntimeOptions,
  type ResolvedModalRuntimeOptions,
  resolveModalRuntimeOptions,
} from "./config.js";
import {
  createOfficialModalClient,
  type ModalClientFactory,
  type ModalClientLike,
  type ModalSandboxCreateParams,
  type ModalSandboxLike,
} from "./internal/sdk.js";

/**
 * Modal sandbox runtime.
 *
 * ## How Modal's model differs, and what this adapter does about it
 *
 * **Sandboxes are children of an App, built from an Image.** `create` takes
 * both, so the runtime resolves one `App` and one `Image` up front and reuses
 * them. Neither has a default; both come from config.
 *
 * **Sandboxes have a maximum lifetime and the SDK default is five minutes.**
 * The provider terminates the sandbox when it elapses, running work included.
 * `maxLifetimeMs` is therefore required config and is always sent explicitly.
 * It is unrelated to any request deadline — see the note on
 * `createTimeoutSeconds` in {@link ModalRuntime.launch}.
 *
 * **Sandboxes cannot be stopped and restarted.** `terminate()` is the only
 * lifecycle transition and it is terminal. `start`/`stop` are absent from this
 * class rather than present as no-ops, and `lifecycle: false` is declared so
 * the capability resolver — which cannot see an absent method — agrees.
 *
 * **Ownership rides on Modal's native, server-side tags.** Every sandbox is
 * created carrying an ownership tag, every lookup filters on it server-side,
 * and every destructive or reattaching operation re-checks it. Collision
 * safety is structural here, not a naming convention.
 *
 * **Async exec is deliberately not implemented.** Modal's `exec` hands back a
 * live `ContainerProcess`, but nothing public re-resolves one from an id after
 * the fact. Implementing `startScript` without a real `getScriptStatus` would
 * let a caller submit a command it could never poll or reap — precisely the
 * failure the port's all-or-nothing `asyncExec` rule exists to prevent. The
 * trio is omitted, so the resolver derives `asyncExec: false`.
 *
 * **V1 `create` is pinned on purpose.** Modal also offers
 * `experimentalCreate` (the V2 backend). V2 sandboxes do not support tags and
 * are not returned by `sandboxes.list()`, which would silently destroy both the
 * ownership model and the cleanup story above. Do not "upgrade" this call.
 */
export class ModalRuntime implements SandboxRuntime {
  readonly id = "modal";

  readonly declaredCapabilities: Partial<DeclaredSandboxRuntimeCapabilities> =
    modalSandboxCapabilities;

  readonly declaredCapabilityModes: Partial<SandboxCapabilityModes> =
    modalCapabilityModes;

  private readonly options: ResolvedModalRuntimeOptions;
  private readonly clientFactory: ModalClientFactory;
  private clientPromise: Promise<ModalClientLike> | null = null;
  private contextPromise: Promise<ModalContext> | null = null;
  /**
   * Reconciliation tasks that outlive their caller.
   *
   * The only source today is `launch()` racing a `sandboxes.create()` past its
   * client-side deadline: when the deadline fires the create can still complete
   * and hand back a sandbox that would otherwise bill silently. `close()` awaits
   * these before releasing the gRPC channel so that a reconciliation cannot be
   * orphaned by teardown.
   */
  private readonly reconciliations = new Set<Promise<void>>();

  constructor(options: ModalRuntimeOptions & { clientFactory?: ModalClientFactory }) {
    this.options = resolveModalRuntimeOptions(options);
    this.clientFactory = options.clientFactory ?? createOfficialModalClient;
    reconcileModalCapabilities(this);
  }

  // --- lookup -------------------------------------------------------------

  async findByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    // Preserve a caller-supplied `limit: 0`: a zero-result lookup is a valid
    // question with a defined answer, not a value to round up to one.
    if (normalizePositiveInt(options.limit) === 0) {
      return null;
    }
    const matches = await this.findAllByLabels(labels, { ...options, limit: 1 });
    return matches[0] ?? null;
  }

  /**
   * Server-side tag search.
   *
   * Two honesty notes:
   *
   *  - Modal's `list` yields sandboxes carrying *at least* the requested tags,
   *    so the ownership tag is merged into the filter rather than applied after
   *    the fact. A foreign sandbox is never fetched, let alone returned.
   *  - Modal's `Sandbox` object carries **no state field**. The only way to
   *    learn whether one is running is `poll()`, one round trip each. So state
   *    is left `undefined` unless the caller actually asked to filter on it,
   *    in which case each candidate costs one extra call. Reporting a guessed
   *    state for free would be worse than reporting none.
   */
  async findAllByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const tags = this.buildLookupTags(labels, options.owned);
    const limit = normalizePositiveInt(options.limit) ?? Number.POSITIVE_INFINITY;
    if (limit === 0) {
      return [];
    }
    const excluded = new Set(options.excludeIds ?? []);
    const states = options.states ?? null;
    const deadline = this.deadline(options.timeoutMs ?? this.options.lookupTimeoutMs, "findAllByLabels");

    const context = await this.context(deadline);
    const matches: RuntimeHandle[] = [];
    const iterator = context.client.sandboxes
      .list(this.listParams(context, tags))[Symbol.asyncIterator]();
    // `for await` awaits `iterator.next()` outside `deadline.run`, so a stalled
    // list page can outlive `timeoutMs` and the caller's budget stops meaning
    // anything. Drive the iterator by hand and wrap each fetch in the deadline.
    for (;;) {
      const step = await deadline.run(Promise.resolve(iterator.next()));
      if (step.done) {
        break;
      }
      const sandbox = step.value;
      if (excluded.has(sandbox.sandboxId)) {
        continue;
      }
      if (!(await this.tagsReallyMatch(sandbox, tags, deadline))) {
        continue;
      }
      if (states === null) {
        matches.push(this.toHandle(sandbox.sandboxId));
      } else {
        const state = await deadline.run(sandbox.poll().then(exitCodeToState));
        if (!states.includes(state)) {
          continue;
        }
        matches.push(this.toHandle(sandbox.sandboxId, state));
      }
      if (matches.length >= limit) {
        break;
      }
    }
    return matches;
  }

  async countByLabels(
    labels: Record<string, string>,
    options: SandboxCountOptions = {},
  ): Promise<number> {
    const tags = this.buildLookupTags(labels, true);
    const states = options.states ?? null;
    // `maxCount` is an early exit for the *count*: stop paging once the caller
    // has learned enough, and report exactly what was counted. `limit` is a
    // page-size hint elsewhere in the port and treating it as a ceiling here
    // would silently undercount matching sandboxes.
    const ceiling = normalizePositiveInt(options.maxCount) ?? Number.POSITIVE_INFINITY;
    if (ceiling === 0) {
      return 0;
    }
    const deadline = this.deadline(options.timeoutMs ?? this.options.lookupTimeoutMs, "countByLabels");

    const context = await this.context(deadline);
    let count = 0;
    const iterator = context.client.sandboxes
      .list(this.listParams(context, tags))[Symbol.asyncIterator]();
    // Same reason as findAllByLabels: the iterator advance must sit inside the
    // deadline or a stalled page defeats the caller's timeoutMs.
    for (;;) {
      const step = await deadline.run(Promise.resolve(iterator.next()));
      if (step.done) {
        break;
      }
      const sandbox = step.value;
      if (!(await this.tagsReallyMatch(sandbox, tags, deadline))) {
        continue;
      }
      if (states !== null) {
        const state = await deadline.run(sandbox.poll().then(exitCodeToState));
        if (!states.includes(state)) {
          continue;
        }
      }
      count += 1;
      if (count >= ceiling) {
        break;
      }
    }
    return count;
  }

  /**
   * Re-resolve a sandbox by id.
   *
   * Ownership is re-checked here, not assumed. `fromId` will happily return any
   * sandbox in the workspace, so a caller holding a synthesized or stale id
   * could otherwise reattach to a sandbox belonging to another lane. A foreign
   * sandbox reads as absent (`null`) rather than raising, because "not one of
   * mine" and "not there" are the same answer to this question.
   *
   * Unlike `findAllByLabels`/`countByLabels`, this path is not server-side
   * tag-filtered: Modal's `fromId` accepts no tag argument, so a foreign
   * sandbox is fetched before `isOwned()` can reject it. That costs one extra
   * `getTags()` round trip for a lookup a lane could otherwise have skipped;
   * the trade is deliberate because `fromId` is the only reattach primitive
   * Modal exposes.
   */
  async getById(
    id: string,
    options: { states?: readonly string[] | null; owned?: boolean } = {},
  ): Promise<RuntimeHandle | null> {
    const sandboxId = id?.trim();
    if (!sandboxId) {
      return null;
    }
    const deadline = this.deadline(this.options.lookupTimeoutMs, "getById");
    const context = await this.context(deadline);

    let sandbox: ModalSandboxLike;
    try {
      sandbox = await deadline.run(context.client.sandboxes.fromId(sandboxId));
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }

    if (options.owned !== false && !(await this.isOwned(sandbox, deadline))) {
      return null;
    }

    const states = options.states ?? null;
    if (states === null) {
      return this.toHandle(sandbox.sandboxId);
    }
    const state = await deadline.run(sandbox.poll().then(exitCodeToState));
    return states.includes(state) ? this.toHandle(sandbox.sandboxId, state) : null;
  }

  // --- lifecycle ----------------------------------------------------------

  /**
   * Create a sandbox.
   *
   * `createTimeoutSeconds` is a **client-side deadline on this call**. It is
   * deliberately NOT forwarded to Modal's `timeoutMs`, which despite the name
   * is the sandbox's maximum lifetime. Conflating them would make a caller who
   * asked to wait 30 s for provisioning receive a sandbox that self-destructs
   * 30 s later. Lifetime comes from `maxLifetimeMs` config and nowhere else.
   */
  async launch(options: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  } = {}): Promise<RuntimeHandle> {
    const tags = this.buildOwnedTags(options.labels ?? {});
    const timeoutMs = options.createTimeoutSeconds === undefined
      ? this.options.createTimeoutMs
      : secondsToMs(options.createTimeoutSeconds, "createTimeoutSeconds");
    const deadline = this.deadline(timeoutMs, "launch");
    const context = await this.context(deadline);

    const params: ModalSandboxCreateParams = {
      name: this.sandboxName(options.name),
      tags,
      workdir: this.options.workdir,
      // Always explicit. Omitting this is how a caller silently inherits
      // Modal's 5-minute cap.
      timeoutMs: this.options.maxLifetimeMs,
      ...(this.options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.options.idleTimeoutMs }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(this.options.resources?.cpu === undefined ? {} : { cpu: this.options.resources.cpu }),
      ...(this.options.resources?.cpuLimit === undefined
        ? {}
        : { cpuLimit: this.options.resources.cpuLimit }),
      ...(this.options.resources?.memoryMiB === undefined
        ? {}
        : { memoryMiB: this.options.resources.memoryMiB }),
      ...(this.options.resources?.memoryLimitMiB === undefined
        ? {}
        : { memoryLimitMiB: this.options.resources.memoryLimitMiB }),
      ...(this.options.cloud === undefined ? {} : { cloud: this.options.cloud }),
      ...(this.options.regions === undefined ? {} : { regions: this.options.regions }),
      ...(this.options.blockNetwork === undefined
        ? {}
        : { blockNetwork: this.options.blockNetwork }),
    };

    // Hold the raw create promise so it outlives the deadline race. If the
    // caller's client-side budget fires before Modal responds, the create can
    // still complete and hand back a billed sandbox with no handle in reach.
    // Reconcile that outcome in the background — see `trackReconciliation`.
    const pending = context.client.sandboxes.create(context.app, context.image, params);
    let sandbox: ModalSandboxLike;
    try {
      sandbox = await deadline.run(pending);
    } catch (error) {
      if (error instanceof ModalDeadlineExceededError) {
        this.trackReconciliation(this.reconcileOrphanedCreate(pending));
      }
      throw error;
    }
    return this.toHandle(sandbox.sandboxId, "running");
  }

  /**
   * Terminate a create that outlived its deadline.
   *
   * Runs after `launch()` has already rejected, so the caller has no handle
   * for the sandbox that might still be materialising. Failure modes here are
   * all silent by design: if the create ultimately rejects there is nothing to
   * clean up; if terminate fails there is no caller to raise to. `close()`
   * awaits these before releasing the gRPC channel so a reconciliation cannot
   * be orphaned by teardown.
   */
  private async reconcileOrphanedCreate(pending: Promise<ModalSandboxLike>): Promise<void> {
    let sandbox: ModalSandboxLike;
    try {
      sandbox = await pending;
    } catch {
      return;
    }
    try {
      await sandbox.terminate({ wait: false });
    } catch {
      // The next label sweep — either the caller's or this runtime's cleanup —
      // is the safety net. There is no useful action to take from here.
    }
  }

  private trackReconciliation(work: Promise<void>): void {
    this.reconciliations.add(work);
    void work.finally(() => this.reconciliations.delete(work));
  }

  /**
   * Terminate a sandbox and verify it is gone.
   *
   * Ownership is checked before the terminate, not after. `destroy` is
   * irreversible, so paying one extra round trip to be certain the sandbox is
   * ours is the correct trade — a mis-routed handle must fail loudly rather
   * than delete another lane's work.
   *
   * Verification prefers Modal's own signal: `terminate({ wait: true })`
   * resolves with an exit code only once the sandbox has actually finished. If
   * the provider resolves without one, the adapter falls back to polling until
   * `poll()` reports a finished sandbox, so `cleanupVerified` never rests on a
   * request merely having been accepted.
   */
  async destroy(handle: RuntimeHandle): Promise<void> {
    const sandboxId = requireHandleId(handle);
    const deadline = this.deadline(this.options.destroyTimeoutMs, "destroy");
    const context = await this.context(deadline);

    let sandbox: ModalSandboxLike;
    try {
      sandbox = await deadline.run(context.client.sandboxes.fromId(sandboxId));
    } catch (error) {
      // Already absent is success: destroy is idempotent by contract.
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    if (!(await this.isOwned(sandbox, deadline))) {
      throw new ModalForeignSandboxError(sandboxId, this.options.namePrefix);
    }

    const settled = await deadline.run(sandbox.terminate({ wait: true }));
    if (typeof settled === "number") {
      return;
    }
    await this.waitUntilGone(sandbox, deadline);
  }

  // --- files --------------------------------------------------------------

  async uploadBundle(
    handle: RuntimeHandle,
    options: { files: Array<{ source: string | Buffer; destination: string }> },
  ): Promise<void> {
    const sandboxId = requireHandleId(handle);
    if (options.files.length === 0) {
      return;
    }
    const deadline = this.deadline(this.options.uploadTimeoutMs, "uploadBundle");
    const context = await this.context(deadline);
    const sandbox = await this.ownedSandbox(sandboxId, context, deadline);

    // Sequential on purpose. Modal's filesystem writes go through the same
    // per-sandbox command router; firing a bundle in parallel buys little and
    // makes a partial failure much harder to attribute to a file.
    for (const file of options.files) {
      deadline.assertNotExpired();
      const destination = file.destination?.trim();
      if (!destination) {
        throw new Error("ModalRuntime uploadBundle requires a non-empty destination for every file");
      }
      if (!destination.startsWith("/")) {
        // Modal requires absolute remote paths and rejects anything else
        // server-side; failing here names the offending file.
        throw new Error(
          `ModalRuntime uploadBundle requires an absolute destination path; got "${destination}"`,
        );
      }
      const bytes = typeof file.source === "string"
        ? new Uint8Array(Buffer.from(file.source, "utf8"))
        : new Uint8Array(file.source);
      await deadline.run(sandbox.filesystem.writeBytes(bytes, destination));
    }
  }

  // --- exec ---------------------------------------------------------------

  /**
   * Run a command to completion and return its buffered output.
   *
   * Modal's `exec` takes an **argv array**, not a shell string, so the caller's
   * command is wrapped in `sh -lc`. Without that wrapping every pipeline,
   * redirect, and variable expansion a caller writes would be passed through as
   * a literal argument.
   *
   * stdout, stderr, and the exit code are awaited together. Draining the
   * streams only after `wait()` resolves risks deadlocking against a process
   * that fills a pipe buffer and blocks before exiting.
   */
  async runScript(
    handle: RuntimeHandle,
    options: {
      command: string;
      sessionId?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    },
  ): Promise<RunScriptResult> {
    const sandboxId = requireHandleId(handle);
    const command = options.command?.trim();
    if (!command) {
      throw new Error("ModalRuntime runScript requires a non-empty command");
    }
    const timeoutMs = options.timeoutMs ?? this.options.execTimeoutMs;
    const deadline = this.deadline(timeoutMs, "runScript");
    const context = await this.context(deadline);
    const sandbox = await this.ownedSandbox(sandboxId, context, deadline);

    const process = await deadline.run(sandbox.exec(["sh", "-lc", command], {
      workdir: handle.workdir ?? this.options.workdir,
      // Hand Modal the same budget, so the provider kills a runaway command
      // even if this client goes away. The outer deadline is a second line of
      // defence, not the only one.
      timeoutMs,
      stdout: "pipe",
      stderr: "pipe",
      ...(options.env === undefined ? {} : { env: options.env }),
    }));

    const [stdout, stderr, exitCode] = await deadline.run(Promise.all([
      process.stdout.readText(),
      process.stderr.readText(),
      process.wait(),
    ]));

    return {
      output: stdout + stderr,
      stdout,
      stderr,
      exitCode,
      // Modal reports no truncation signal on these streams. `undefined` means
      // "not reported", never "known complete", so it is left off entirely.
    };
  }

  // --- internals ----------------------------------------------------------

  /** Tags every sandbox this runtime creates must carry. */
  private ownerTags(): Record<string, string> {
    return { [this.options.ownerTagKey]: this.options.namePrefix };
  }

  /**
   * Merge caller labels with the ownership tag, refusing to let a caller
   * overwrite it. Silently winning that collision either way is a bug: our
   * value would make a foreign sandbox look owned, theirs would make ours
   * invisible to cleanup.
   */
  private buildOwnedTags(labels: Record<string, string>): Record<string, string> {
    if (Object.hasOwn(labels, this.options.ownerTagKey)) {
      throw new ModalTagCollisionError(this.options.ownerTagKey);
    }
    return { ...labels, ...this.ownerTags() };
  }

  private buildLookupTags(
    labels: Record<string, string>,
    owned: boolean | undefined,
  ): Record<string, string> {
    // `owned: false` is an explicit opt-out for cross-lane audits. Anything
    // else — including `undefined` — scopes the search to this runtime.
    if (owned === false) {
      return { ...labels };
    }
    return this.buildOwnedTags(labels);
  }

  private listParams(
    context: ModalContext,
    tags: Record<string, string>,
  ): { appId?: string; tags: Record<string, string>; environment?: string } {
    return {
      tags,
      ...(context.app.appId === undefined ? {} : { appId: context.app.appId }),
      ...(this.options.environment === undefined
        ? {}
        : { environment: this.options.environment }),
    };
  }

  /**
   * Confirm in-process that a listed sandbox really carries the tags we
   * filtered on.
   *
   * The server-side filter is the mechanism this adapter's ownership rests on,
   * and it has not yet been proven live — `warmLease` is still `false`. A
   * filter that is silently ignored or partially applied would return a foreign
   * sandbox, and handing that back as a warm lease is worse than returning
   * nothing: the caller would exec into another tenant's container. So the
   * claim is re-checked against the sandbox's own tags rather than trusted.
   *
   * Skipped when there is nothing to check, so an unfiltered audit listing
   * (`owned: false` with no labels) does not pay for a round trip that could
   * not reject anything.
   */
  private async tagsReallyMatch(
    sandbox: ModalSandboxLike,
    wanted: Record<string, string>,
    deadline: Deadline,
  ): Promise<boolean> {
    const entries = Object.entries(wanted);
    if (!this.options.verifyTagsClientSide || entries.length === 0) {
      return true;
    }
    let actual: Record<string, string>;
    try {
      actual = await deadline.run(sandbox.getTags());
    } catch (error) {
      // A sandbox that vanished between `list` and `getTags` is a non-match,
      // not a lookup failure — otherwise one racing termination would abort
      // the entire scan and hide every other candidate from the caller.
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
    return entries.every(([key, value]) => actual[key] === value);
  }

  private async isOwned(sandbox: ModalSandboxLike, deadline: Deadline): Promise<boolean> {
    const tags = await deadline.run(sandbox.getTags());
    return tags[this.options.ownerTagKey] === this.options.namePrefix;
  }

  /**
   * Resolve a sandbox by id and prove ownership before returning it.
   *
   * Every write-or-execute path that takes a caller-supplied id must go
   * through this: `fromId` will happily return any sandbox in the workspace,
   * so a stale or synthesized handle would otherwise let a caller reattach to
   * another lane's sandbox and mutate it. `destroy` uses its own resolution
   * because it must also treat an already-absent sandbox as success — the
   * only shape here that is idempotent.
   */
  private async ownedSandbox(
    sandboxId: string,
    context: ModalContext,
    deadline: Deadline,
  ): Promise<ModalSandboxLike> {
    const sandbox = await deadline.run(context.client.sandboxes.fromId(sandboxId));
    if (!(await this.isOwned(sandbox, deadline))) {
      throw new ModalForeignSandboxError(sandboxId, this.options.namePrefix);
    }
    return sandbox;
  }

  private async waitUntilGone(sandbox: ModalSandboxLike, deadline: Deadline): Promise<void> {
    for (;;) {
      const exitCode = await deadline.run(sandbox.poll());
      if (exitCode !== null) {
        return;
      }
      deadline.assertNotExpired();
      await sleep(this.options.pollIntervalMs);
    }
  }

  private sandboxName(name: string | undefined): string {
    const suffix = name?.trim() || randomUUID();
    return `${this.options.namePrefix}-${suffix}`;
  }

  private toHandle(id: string, state?: string): RuntimeHandle {
    return {
      id,
      homeDir: this.options.defaultHomeDir,
      workdir: this.options.workdir,
      ...(state === undefined ? {} : { state }),
    };
  }

  private deadline(totalMs: number, operation: string): Deadline {
    return new Deadline(totalMs, operation, this.options.requestTimeoutMs);
  }

  private client(): Promise<ModalClientLike> {
    this.clientPromise ??= Promise.resolve(this.clientFactory(this.options)).catch((error) => {
      // Do not cache a rejected client: a transient construction failure would
      // otherwise poison every later call for the lifetime of the runtime.
      this.clientPromise = null;
      throw error;
    });
    return this.clientPromise;
  }

  /**
   * Resolve the App and Image once and reuse them. Both are required by every
   * `create`, neither changes over the runtime's life, and each resolution is
   * a round trip.
   */
  private context(deadline: Deadline): Promise<ModalContext> {
    this.contextPromise ??= (async () => {
      const client = await this.client();
      const app = await client.apps.fromName(this.options.appName, {
        createIfMissing: this.options.createAppIfMissing,
        ...(this.options.environment === undefined
          ? {}
          : { environment: this.options.environment }),
      });
      const image = client.images.fromRegistry(this.options.imageTag);
      return { client, app, image };
    })().catch((error) => {
      this.contextPromise = null;
      throw error;
    });
    return deadline.run(this.contextPromise);
  }

  /**
   * Release the gRPC channel.
   *
   * Not part of `SandboxRuntime`, but necessary: the SDK holds an open HTTP/2
   * connection, and a Node process that never calls this will not exit on its
   * own. Long-lived hosts can ignore it; short-lived scripts and tests cannot.
   */
  async close(): Promise<void> {
    // Drain reconciliations first: releasing the gRPC channel while an orphan
    // terminate is still in flight would abandon exactly the resource this
    // path exists to clean up.
    if (this.reconciliations.size > 0) {
      await Promise.allSettled([...this.reconciliations]);
    }
    const pending = this.clientPromise;
    this.clientPromise = null;
    this.contextPromise = null;
    if (!pending) {
      return;
    }
    try {
      (await pending).close();
    } catch {
      // Closing a channel that is already gone is not an error worth raising
      // from a teardown path.
    }
  }
}

type ModalContext = {
  client: ModalClientLike;
  app: { appId?: string };
  image: { imageId?: string };
};

// --- errors ---------------------------------------------------------------

/** A handle that does not carry this runtime's ownership tag. */
export class ModalForeignSandboxError extends Error {
  readonly sandboxId: string;
  readonly expectedOwner: string;

  constructor(sandboxId: string, expectedOwner: string) {
    super(
      `Modal sandbox ${sandboxId} is not owned by "${expectedOwner}": refusing to operate on it`,
    );
    this.name = "ModalForeignSandboxError";
    this.sandboxId = sandboxId;
    this.expectedOwner = expectedOwner;
  }
}

/** A caller label collided with the reserved ownership tag key. */
export class ModalTagCollisionError extends Error {
  readonly tagKey: string;

  constructor(tagKey: string) {
    super(
      `Label key "${tagKey}" is reserved for Modal sandbox ownership and cannot be set by a caller`,
    );
    this.name = "ModalTagCollisionError";
    this.tagKey = tagKey;
  }
}

/**
 * An operation exceeded its explicit client-side deadline.
 *
 * Two independent caps bound any Modal call: this per-operation budget, and
 * the SDK's own per-request `requestTimeoutMs`. They fail differently on
 * purpose — the SDK's cap surfaces as a gRPC error from the vendor, this one
 * as `ModalDeadlineExceededError` — so the error *type* already says which
 * fired. The message names the sibling cap anyway, because a reader looking at
 * a timeout usually needs to check both numbers before concluding the network
 * was slow.
 */
export class ModalDeadlineExceededError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;
  /** The SDK's per-request cap, when the runtime knew it. */
  readonly requestTimeoutMs: number | undefined;

  constructor(operation: string, timeoutMs: number, requestTimeoutMs?: number) {
    super(
      `Modal ${operation} exceeded its ${timeoutMs}ms operation deadline`
        + (requestTimeoutMs === undefined
          ? ""
          : ` (the SDK's per-request cap is ${requestTimeoutMs}ms and fails separately, `
            + "as a gRPC error rather than this one)"),
    );
    this.name = "ModalDeadlineExceededError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }
}

/** Declared capabilities disagree with what this class actually implements. */
export class ModalCapabilityMismatchError extends Error {
  readonly mismatches: readonly string[];

  constructor(mismatches: readonly string[]) {
    super(`Modal adapter capability reconciliation failed:\n  - ${mismatches.join("\n  - ")}`);
    this.name = "ModalCapabilityMismatchError";
    this.mismatches = mismatches;
  }
}

// --- capability reconciliation --------------------------------------------

/**
 * Assert at construction time that every declared capability matches what this
 * class actually implements.
 *
 * The point is to fail on the developer's machine rather than in production.
 * A declaration and an implementation drift apart silently — someone adds a
 * `stop` that no-ops, or flips `warmLease` to true while `findAllByLabels`
 * still returns `[]` — and the orchestrator believes the declaration. Every
 * rule below encodes a way this adapter could lie.
 */
export function reconcileModalCapabilities(runtime: SandboxRuntime): void {
  const declared = runtime.declaredCapabilities ?? {};
  const mismatches: string[] = [];

  const has = (method: keyof SandboxRuntime): boolean =>
    typeof runtime[method] === "function";

  // lifecycle: declaring it true while start/stop are absent would tell the
  // orchestrator it can suspend a sandbox that has no suspend.
  if (declared.lifecycle === true && !(has("start") && has("stop"))) {
    mismatches.push(
      "declaredCapabilities.lifecycle is true but start/stop are not implemented "
        + "(Modal exposes no stop/start for a Sandbox; terminate is terminal)",
    );
  }
  // Scoped to Modal on purpose, and NOT a general rule.
  //
  // For most providers, `start`/`stop` present with `lifecycle: false` is the
  // legitimate shape of a real implementation awaiting a live probe — the
  // orchestrator reads the declaration, not method presence, so the under-claim
  // is safe and is the only way a capability can wait for evidence. Forbidding
  // it would make evidence-gating impossible.
  //
  // Modal is the narrow case where the check still holds: the SDK exposes no
  // stop/start for a Sandbox *at all*, so a `start`/`stop` appearing on this
  // class could not be an unproven implementation. It could only be a
  // fabrication or a no-op, and either would tell the orchestrator a Modal
  // sandbox can be suspended when nothing can suspend it.
  if (declared.lifecycle !== true && (has("start") || has("stop"))) {
    mismatches.push(
      "declaredCapabilities.lifecycle is not true but start/stop are implemented. "
        + "Modal exposes no stop/start for a Sandbox, so these cannot be a real "
        + "implementation awaiting a live probe — only a no-op or a fabrication. "
        + "(This check is Modal-specific: elsewhere, methods present with "
        + "lifecycle:false is the correct way to gate a capability on evidence.)",
    );
  }

  // warmLease: a true declaration promises real server-side label search.
  if (declared.warmLease === true && !has("findAllByLabels")) {
    mismatches.push(
      "declaredCapabilities.warmLease is true but findAllByLabels is not implemented",
    );
  }

  // asyncExec is all-or-nothing. A partial trio is the exact shape that lets a
  // caller submit a command it can never poll or reap.
  const asyncParts = [
    ["startScript", has("startScript")],
    ["getScriptStatus", has("getScriptStatus")],
    ["getScriptLogs", has("getScriptLogs")],
    ["getById", has("getById")],
  ] as const;
  const present = asyncParts.filter(([, ok]) => ok).map(([name]) => name);
  const execParts = asyncParts.slice(0, 3);
  const execPresent = execParts.filter(([, ok]) => ok);
  if (execPresent.length > 0 && execPresent.length < execParts.length) {
    mismatches.push(
      `async exec is all-or-nothing but only [${present.join(", ")}] are implemented: `
        + "Modal cannot re-resolve a ContainerProcess by id, so the trio must stay absent",
    );
  }

  // --- modes ---------------------------------------------------------------
  //
  // The booleans above can only be wrong about *whether* a capability exists.
  // The modes can be wrong about its *shape*, which is the subtler lie: a mode
  // that over-claims reads as settled fact rather than as a pending cell, and
  // `isPendingEvidence()` reports false for it, so nothing downstream will ever
  // revisit it. Each rule below is a shape this adapter could misstate.
  const modes = runtime.declaredCapabilityModes ?? {};

  // Modal terminates every sandbox at a deadline that always exists — five
  // minutes by default, MODAL_MAX_LIFETIME_MS at the ceiling. "never-idle" is
  // the one lifetime Modal structurally cannot offer, which is exactly why
  // `neverIdle` sits in MODAL_STRUCTURALLY_FALSE.
  if (modes.lifetime === "never-idle") {
    mismatches.push(
      'declaredCapabilityModes.lifetime is "never-idle" but every Modal Sandbox '
        + "carries a maximum lifetime the provider enforces (see "
        + "MODAL_STRUCTURALLY_FALSE.neverIdle); there is no no-deadline setting",
    );
  }

  // A live-stream mode promises callers an incremental channel. `runScript`
  // drains both pipes with readText() before returning, and the port exposes no
  // streaming surface at all, so any streaming member is a claim this adapter
  // cannot honor no matter what the provider can do.
  if (
    modes.outputStreams === "combined-stream"
    || modes.outputStreams === "separate-streams"
  ) {
    mismatches.push(
      `declaredCapabilityModes.outputStreams is "${modes.outputStreams}" but runScript `
        + "drains stdout/stderr to completion before returning and the port exposes no "
        + 'streaming operation; the honest value is "buffered"',
    );
  }

  // Filesystem persistence means surviving a stop/start of the same sandbox.
  // Modal has no such pair, so "persistent" cannot be true here.
  if (modes.filesystem === "persistent") {
    mismatches.push(
      'declaredCapabilityModes.filesystem is "persistent" but Modal has no stop/start '
        + "pair for state to survive across; terminate is the only transition and it is "
        + "terminal",
    );
  }

  // PTY and snapshots are real on Modal and unreachable through this port. That
  // asymmetry is the whole reason "not-exposed" exists, and it is the pair most
  // likely to be "corrected" upward by someone reading the provider's docs
  // instead of this package's port.
  if (modes.interactive === "pty" && !has("startScript")) {
    mismatches.push(
      'declaredCapabilityModes.interactive is "pty" but this package\'s port declares no '
        + 'PTY operation; Modal supports pty:true, so the honest value is "not-exposed" '
        + '(a fact about our port) rather than a positive claim',
    );
  }
  if (modes.snapshots === "snapshot" || modes.snapshots === "snapshot-and-fork") {
    mismatches.push(
      `declaredCapabilityModes.snapshots is "${modes.snapshots}" but this package's port `
        + "declares no snapshot operation; Modal has snapshotFilesystem/snapshotDirectory, "
        + 'so the honest value is "not-exposed" rather than a positive claim',
    );
  }

  // The port's own resolver is the final authority; make sure it agrees.
  const required = [
    "findByLabels",
    "findAllByLabels",
    "countByLabels",
    "launch",
    "uploadBundle",
    "runScript",
    "destroy",
  ] as const;
  for (const method of required) {
    if (!has(method)) {
      mismatches.push(`SandboxRuntime requires ${method} but it is not implemented`);
    }
  }

  if (mismatches.length > 0) {
    throw new ModalCapabilityMismatchError(mismatches);
  }
}

// --- helpers --------------------------------------------------------------

/**
 * An absolute client-side budget for one logical operation.
 *
 * Racing a promise does not cancel the work behind it — the SDK's own
 * `timeoutMs` handles the wire. This bounds the *caller's* wait so a hung
 * provider cannot stall an operation indefinitely, and it is shared across
 * every round trip an operation makes rather than being reset per call.
 */
class Deadline {
  private readonly expiresAt: number;

  constructor(
    private readonly totalMs: number,
    private readonly operation: string,
    private readonly requestTimeoutMs?: number,
  ) {
    this.expiresAt = Date.now() + totalMs;
  }

  private expired(): ModalDeadlineExceededError {
    return new ModalDeadlineExceededError(this.operation, this.totalMs, this.requestTimeoutMs);
  }

  remainingMs(): number {
    return this.expiresAt - Date.now();
  }

  assertNotExpired(): void {
    if (this.remainingMs() <= 0) {
      throw this.expired();
    }
  }

  async run<T>(work: Promise<T>): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      throw this.expired();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(this.expired()), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Modal reports no state enum; a finished sandbox is one with an exit code. */
function exitCodeToState(exitCode: number | null): string {
  return exitCode === null ? "running" : "terminated";
}

function requireHandleId(handle: RuntimeHandle): string {
  const id = handle?.id?.trim();
  if (!id) {
    throw new Error("ModalRuntime requires a handle carrying a non-empty sandbox id");
  }
  return id;
}

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`ModalRuntime expected a finite, non-negative count; got ${String(value)}`);
  }
  return Math.floor(value);
}

function secondsToMs(seconds: number, field: string): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `ModalRuntime ${field} must be a finite, positive number of seconds; got ${String(seconds)}`,
    );
  }
  return seconds * 1000;
}

/**
 * Modal raises `NotFoundError` by name. Matching on the name rather than on an
 * imported class keeps this module free of the vendor SDK, which is the whole
 * point of the internal/sdk.ts boundary.
 */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}
