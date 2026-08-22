/**
 * Modal benchmark harness: ledger, cost guards, and measurement.
 *
 * This module is deliberately separate from any live credential. It contains
 * no I/O of its own — it drives a `SandboxRuntime` that the caller supplies —
 * so every guard below is unit-testable against a fake runtime, and the guards
 * are proven *before* they are trusted with a real account.
 *
 * The safety model has three independent layers, and each one alone is
 * sufficient to stop a runaway:
 *
 *  1. **Ledger before use.** Every sandbox is recorded as *intended* before the
 *     create call is made, not after it returns. A create that times out or
 *     crashes mid-flight still leaves a record, so a sandbox that was actually
 *     provisioned can never be invisible to cleanup.
 *  2. **Bounded cost.** A projected cost is computed for each sandbox from
 *     Modal's published rates and charged against a hard budget *before* the
 *     create. The run aborts rather than exceeding it.
 *  3. **Verified cleanup.** Teardown runs in a `finally`, and afterwards each
 *     ledger entry is re-checked against the provider. Anything still present
 *     is reported as a leak rather than being assumed gone.
 */

import type { RuntimeHandle } from "../types.js";
import type { SandboxRuntime } from "../port.js";
import { MODAL_MIN_CPU_CORES } from "./config.js";

// --- published rates -------------------------------------------------------

/**
 * Modal's published per-second rates, read from <https://modal.com/pricing> on
 * 2026-08-21.
 *
 * Note the two cards. Modal bills **Sandboxes at roughly 3× its own Functions**,
 * and the pricing page presents both in one table, so quoting the Function rate
 * for a sandbox workload understates it threefold. Only the Sandbox card is
 * correct for this adapter; the Function card is kept solely so the ratio can
 * be asserted in a test rather than restated as a comment.
 *
 * Provider pricing is time-unstable. Re-verify before these decide anything.
 */
export const MODAL_RATES = {
  /** Sandbox/Notebook rate, USD per **physical core** per second. */
  sandboxCpuCoreSecondUsd: 0.00003942,
  /** Sandbox/Notebook rate, USD per GiB of memory per second. */
  sandboxMemoryGiBSecondUsd: 0.00000667,
  /** Ordinary Function rate, USD per physical core per second. */
  functionCpuCoreSecondUsd: 0.0000131,
  /** Ordinary Function rate, USD per GiB of memory per second. */
  functionMemoryGiBSecondUsd: 0.00000222,
  /** Volume storage, USD per GiB per month. Not charged per second. */
  volumeStorageGiBMonthUsd: 0.09,
  /** Modal counts one physical core as this many vCPU. */
  vcpuPerPhysicalCore: 2,
} as const;

export type ModalCostInput = {
  /** Physical cores reserved. Modal's floor is 0.125. */
  cpuCores: number;
  /** Memory reserved, in GiB. */
  memoryGiB: number;
  /** Wall-clock seconds the sandbox is expected to run. */
  seconds: number;
};

/**
 * Projected USD cost of one sandbox at Modal's **Sandbox** rate.
 *
 * Deliberately not clamped or rounded: a budget guard that quietly rounds a
 * projection down is a budget guard that can be walked past.
 */
export function estimateModalSandboxCostUsd(input: ModalCostInput): number {
  requireCpuAtLeastFloor(input.cpuCores);
  requireFinitePositive(input.memoryGiB, "memoryGiB");
  requireFiniteNonNegative(input.seconds, "seconds");
  return (
    input.cpuCores * MODAL_RATES.sandboxCpuCoreSecondUsd
    + input.memoryGiB * MODAL_RATES.sandboxMemoryGiBSecondUsd
  ) * input.seconds;
}

/** The same shape billed as an ordinary Function, for ratio reporting only. */
export function estimateModalFunctionCostUsd(input: ModalCostInput): number {
  requireCpuAtLeastFloor(input.cpuCores);
  requireFinitePositive(input.memoryGiB, "memoryGiB");
  requireFiniteNonNegative(input.seconds, "seconds");
  return (
    input.cpuCores * MODAL_RATES.functionCpuCoreSecondUsd
    + input.memoryGiB * MODAL_RATES.functionMemoryGiBSecondUsd
  ) * input.seconds;
}

// --- ledger ----------------------------------------------------------------

export type ModalLedgerEntryState =
  /** Recorded before the create call was issued. Outcome unknown. */
  | "intended"
  /** Create returned a handle. */
  | "created"
  /** Create failed and reported no handle. */
  | "create-failed"
  /** Destroy returned without error. */
  | "destroyed"
  /** Destroy was attempted and threw. */
  | "destroy-failed"
  /** Confirmed absent from the provider after teardown. */
  | "verified-gone"
  /** Still present after teardown. A leak. */
  | "leaked";

export type ModalLedgerEntry = {
  readonly label: string;
  state: ModalLedgerEntryState;
  sandboxId?: string;
  projectedCostUsd: number;
  error?: string;
};

/**
 * A record of every sandbox this harness intended to create.
 *
 * "Intended" is the important word. Recording only successful creates would
 * lose exactly the sandboxes most likely to leak: those whose create call
 * timed out or was interrupted after the provider had already provisioned
 * them. An entry is written before the attempt and updated after.
 */
export class ModalBenchLedger {
  private readonly entries: ModalLedgerEntry[] = [];
  private readonly budgetUsd: number;

  constructor(options: { budgetUsd: number }) {
    requireFinitePositive(options.budgetUsd, "budgetUsd");
    this.budgetUsd = options.budgetUsd;
  }

  /** Total projected cost of everything recorded so far. */
  committedUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.projectedCostUsd, 0);
  }

  remainingUsd(): number {
    return this.budgetUsd - this.committedUsd();
  }

  /**
   * Reserve budget and record intent. Throws *before* any provider call if the
   * projection would breach the cap, so the guard cannot be raced by the
   * create it is guarding.
   */
  recordIntent(label: string, projectedCostUsd: number): ModalLedgerEntry {
    requireFiniteNonNegative(projectedCostUsd, "projectedCostUsd");
    const wouldCommit = this.committedUsd() + projectedCostUsd;
    if (wouldCommit > this.budgetUsd) {
      throw new ModalBudgetExceededError({
        budgetUsd: this.budgetUsd,
        committedUsd: this.committedUsd(),
        requestedUsd: projectedCostUsd,
        label,
      });
    }
    const entry: ModalLedgerEntry = { label, state: "intended", projectedCostUsd };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly ModalLedgerEntry[] {
    return this.entries;
  }

  /** Entries that may still correspond to a live provider resource. */
  outstanding(): readonly ModalLedgerEntry[] {
    return this.entries.filter((entry) =>
      entry.state !== "verified-gone"
      && entry.state !== "create-failed"
    );
  }

  leaked(): readonly ModalLedgerEntry[] {
    return this.entries.filter((entry) => entry.state === "leaked");
  }
}

/** A create was refused because it would breach the run's cost cap. */
export class ModalBudgetExceededError extends Error {
  readonly budgetUsd: number;
  readonly committedUsd: number;
  readonly requestedUsd: number;

  constructor(options: {
    budgetUsd: number;
    committedUsd: number;
    requestedUsd: number;
    label: string;
  }) {
    super(
      `Modal benchmark refused to create "${options.label}": projected $${options.requestedUsd.toFixed(6)} `
        + `on top of $${options.committedUsd.toFixed(6)} would exceed the $${options.budgetUsd.toFixed(6)} cap`,
    );
    this.name = "ModalBudgetExceededError";
    this.budgetUsd = options.budgetUsd;
    this.committedUsd = options.committedUsd;
    this.requestedUsd = options.requestedUsd;
  }
}

/** Teardown finished with provider resources still present. */
export class ModalLeakedSandboxError extends Error {
  readonly leaked: readonly ModalLedgerEntry[];

  constructor(leaked: readonly ModalLedgerEntry[]) {
    super(
      `Modal benchmark leaked ${leaked.length} sandbox(es) that are still present after teardown: `
        + leaked.map((entry) => `${entry.label}=${entry.sandboxId ?? "unknown-id"}`).join(", "),
    );
    this.name = "ModalLeakedSandboxError";
    this.leaked = leaked;
  }
}

// --- measurement -----------------------------------------------------------

export type ModalBenchSample = {
  readonly label: string;
  /** Milliseconds from issuing create to receiving a handle. */
  readonly createMs: number;
  /** Milliseconds from handle to a successful first exec, when measured. */
  readonly firstExecMs?: number;
  readonly sandboxId?: string;
  readonly error?: string;
};

export type ModalBenchReport = {
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly samples: readonly ModalBenchSample[];
  readonly createMsP50: number | null;
  readonly createMsP95: number | null;
  readonly firstExecMsP50: number | null;
  readonly firstExecMsP95: number | null;
  readonly projectedCostUsd: number;
  readonly ledger: readonly ModalLedgerEntry[];
  readonly leaked: readonly ModalLedgerEntry[];
};

/**
 * Linear-interpolated percentile over a sorted copy of `values`.
 *
 * Returns `null` for an empty input rather than 0, because "no samples" and
 * "zero milliseconds" are different claims and the second one is a lie.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`percentile p must be within [0, 100]; got ${String(p)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower]!;
  }
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
}

export type ModalBenchOptions = {
  /** How many sandboxes to create. The canary run uses 1. */
  count: number;
  /** Hard USD cap for the whole run. */
  budgetUsd: number;
  /** Shape used for the cost projection. Must match the runtime's config. */
  shape: { cpuCores: number; memoryGiB: number };
  /**
   * Seconds each sandbox is *assumed* to live, for the projection. Should be
   * the configured max lifetime, not the expected duration: the budget must
   * cover the worst case, because a sandbox that leaks bills for its whole
   * lifetime.
   */
  projectedLifetimeSeconds: number;
  /** Run creates concurrently. The canary should stay sequential. */
  concurrent?: boolean;
  /** Also time a first exec against each sandbox. */
  measureFirstExec?: boolean;
  /** Command used for the first-exec measurement. */
  firstExecCommand?: string;
  /** Labels stamped on every sandbox, for ownership and post-hoc audit. */
  labels?: Record<string, string>;
  /** Injected clock, so tests are deterministic. */
  now?: () => number;
};

/**
 * Run the benchmark.
 *
 * Cleanup is unconditional and verified. Even when the run aborts on the
 * budget guard or a create throws, teardown still runs over everything the
 * ledger recorded, and the returned report names anything that survived.
 */
export async function runModalBenchmark(
  runtime: SandboxRuntime,
  options: ModalBenchOptions,
): Promise<ModalBenchReport> {
  // Reject a non-integer instead of silently truncating: a caller who passes
  // `count: 2.7` almost certainly typed a wrong number, and running 2 without
  // saying so buys a benchmark for a shape that was never requested.
  if (
    !Number.isFinite(options.count)
    || !Number.isInteger(options.count)
    || options.count < 1
  ) {
    throw new Error(
      `Modal benchmark count must be a positive integer; got ${String(options.count)}`,
    );
  }
  const count = options.count;
  // A zero-lifetime projection reserves $0 in the ledger but still creates
  // sandboxes with a positive provider lifetime, so the budget guard cannot
  // stop the run before it bills. Guard here where the value crosses into the
  // guard rather than deep in the estimator.
  if (
    !Number.isFinite(options.projectedLifetimeSeconds)
    || options.projectedLifetimeSeconds <= 0
  ) {
    throw new Error(
      "Modal benchmark projectedLifetimeSeconds must be a finite, positive number of seconds "
        + "(and should cover the runtime's configured maxLifetimeMs, because a leaked "
        + `sandbox bills for its whole lifetime); got ${String(options.projectedLifetimeSeconds)}`,
    );
  }
  const now = options.now ?? (() => Date.now());
  const ledger = new ModalBenchLedger({ budgetUsd: options.budgetUsd });
  const perSandboxUsd = estimateModalSandboxCostUsd({
    cpuCores: options.shape.cpuCores,
    memoryGiB: options.shape.memoryGiB,
    seconds: options.projectedLifetimeSeconds,
  });

  const samples: ModalBenchSample[] = [];
  const labels = options.labels ?? {};

  // Only sweep-by-label if the caller supplied labels *and* the runtime can
  // list by them. Without both, a stray sandbox cannot be attributed to this
  // run and the entry stays `create-failed` — the pre-existing shape.
  const canReconcileByLabel = Object.keys(labels).length > 0
    && typeof runtime.findAllByLabels === "function";

  const acquire = async (index: number): Promise<void> => {
    const label = `bench-${index}`;
    // Budget check and ledger write happen together, before any provider call.
    const entry = ledger.recordIntent(label, perSandboxUsd);
    const startedAt = now();
    let handle: RuntimeHandle;
    try {
      handle = await runtime.launch({ name: label, labels });
    } catch (error) {
      entry.error = errorMessage(error);
      // Leave the entry `intended` when a label sweep can reconcile it:
      // `launch` throwing does not prove the provider created nothing, and
      // marking `create-failed` here would hide any sandbox that materialised
      // after the client-side deadline fired. Teardown's sweep either
      // reattaches the stray and destroys it, or promotes the entry to
      // `create-failed` once absence has been checked.
      if (!canReconcileByLabel) {
        entry.state = "create-failed";
      }
      samples.push({ label, createMs: now() - startedAt, error: entry.error });
      return;
    }
    const createMs = now() - startedAt;
    entry.state = "created";
    entry.sandboxId = handle.id;

    let firstExecMs: number | undefined;
    let execError: string | undefined;
    if (options.measureFirstExec) {
      const execStartedAt = now();
      try {
        const result = await runtime.runScript(handle, {
          command: options.firstExecCommand ?? "echo modal-bench-ready",
        });
        // A canary that exits nonzero is a failure, not a latency sample.
        // Recording `firstExecMs` for a failed command would let the harness
        // report a green measurement for a command that never worked.
        if (result.exitCode === 0) {
          firstExecMs = now() - execStartedAt;
        } else {
          execError = `first exec exited with code ${String(result.exitCode ?? "unknown")}`;
        }
      } catch (error) {
        execError = errorMessage(error);
      }
    }

    samples.push({
      label,
      createMs,
      sandboxId: handle.id,
      ...(firstExecMs === undefined ? {} : { firstExecMs }),
      ...(execError === undefined ? {} : { error: execError }),
    });
  };

  let abortError: unknown;
  try {
    if (options.concurrent) {
      // `allSettled`, not `all`: one create failing must not skip teardown for
      // the others, which would be exactly how a concurrency test leaks.
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_unused, index) => acquire(index)),
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected && rejected.status === "rejected") {
        abortError = rejected.reason;
      }
    } else {
      for (let index = 0; index < count; index += 1) {
        await acquire(index);
      }
    }
  } catch (error) {
    // A budget breach aborts the run but must never skip teardown.
    abortError = error;
  } finally {
    await teardown(runtime, ledger, labels);
  }

  const leaked = ledger.leaked();
  const report: ModalBenchReport = {
    requested: count,
    succeeded: samples.filter((sample) => sample.sandboxId !== undefined && !sample.error).length,
    failed: samples.filter((sample) => sample.error !== undefined).length,
    samples,
    createMsP50: percentile(successfulCreates(samples), 50),
    createMsP95: percentile(successfulCreates(samples), 95),
    firstExecMsP50: percentile(firstExecs(samples), 50),
    firstExecMsP95: percentile(firstExecs(samples), 95),
    projectedCostUsd: ledger.committedUsd(),
    ledger: ledger.all(),
    leaked,
  };

  if (leaked.length > 0) {
    // Loud by design. A silent leak on a metered provider is the one failure
    // mode this harness exists to prevent.
    throw Object.assign(new ModalLeakedSandboxError(leaked), { report });
  }
  if (abortError !== undefined) {
    throw Object.assign(toError(abortError), { report });
  }
  return report;
}

/**
 * Destroy everything the ledger knows about, then prove it is gone.
 *
 * Every entry is attempted even if an earlier one throws, because stopping at
 * the first failure would strand the rest.
 */
async function teardown(
  runtime: SandboxRuntime,
  ledger: ModalBenchLedger,
  labels: Record<string, string>,
): Promise<void> {
  // Pass 1: destroy sandboxes we already have ids for.
  for (const entry of ledger.outstanding()) {
    if (entry.sandboxId === undefined) {
      continue;
    }
    try {
      await runtime.destroy({ id: entry.sandboxId });
      entry.state = "destroyed";
    } catch (error) {
      entry.state = "destroy-failed";
      entry.error = errorMessage(error);
    }
  }

  // Pass 2: reconcile launches that threw without returning a handle. A
  // `launch` rejection does not prove the provider created nothing — a
  // sandbox that landed just after the client-side deadline fired would
  // otherwise leak invisibly. Sweep by the caller's labels, associate any
  // stray with an outstanding no-id entry, and destroy it. This is why the
  // acquire loop leaves such entries `intended` rather than `create-failed`.
  const unaccounted = ledger.outstanding().filter((entry) => entry.sandboxId === undefined);
  const canSweep = unaccounted.length > 0
    && Object.keys(labels).length > 0
    && typeof runtime.findAllByLabels === "function";
  if (canSweep) {
    const knownIds = new Set(
      ledger.all()
        .map((entry) => entry.sandboxId)
        .filter((id): id is string => id !== undefined),
    );
    let strays: RuntimeHandle[] = [];
    try {
      strays = (await runtime.findAllByLabels!(labels))
        .filter((handle) => !knownIds.has(handle.id));
    } catch (error) {
      // A sweep failure is not fatal, but it does mean any remaining no-id
      // entries have to fall through as unverified — see below.
      for (const entry of unaccounted) {
        entry.error = errorMessage(error);
      }
    }
    for (const entry of unaccounted) {
      const match = strays.shift();
      if (match === undefined) {
        // Sweep ran and no matching stray exists: this create truly failed.
        entry.state = "create-failed";
        entry.error ??= "create rejected and no stray sandbox was found by label sweep";
        continue;
      }
      entry.sandboxId = match.id;
      try {
        await runtime.destroy(match);
        entry.state = "destroyed";
      } catch (error) {
        entry.state = "destroy-failed";
        entry.error = errorMessage(error);
      }
    }
  } else {
    for (const entry of unaccounted) {
      entry.state = "leaked";
      entry.error ??= "create outcome unknown: no sandbox id was ever observed "
        + "and no label sweep was possible";
    }
  }

  // Pass 3: verify. `destroy` returning is not proof; a re-lookup reporting
  // absence is.
  for (const entry of ledger.outstanding()) {
    if (entry.sandboxId === undefined) {
      continue;
    }
    if (typeof runtime.getById !== "function") {
      // Without reattach there is no way to prove absence, so it is not
      // claimed. The entry stays outstanding rather than being upgraded.
      continue;
    }
    try {
      const found = await runtime.getById(entry.sandboxId);
      entry.state = found === null ? "verified-gone" : "leaked";
    } catch (error) {
      entry.state = "leaked";
      entry.error = errorMessage(error);
    }
  }
}

// --- helpers ---------------------------------------------------------------

function successfulCreates(samples: readonly ModalBenchSample[]): number[] {
  return samples.filter((s) => s.sandboxId !== undefined).map((s) => s.createMs);
}

function firstExecs(samples: readonly ModalBenchSample[]): number[] {
  return samples
    .map((s) => s.firstExecMs)
    .filter((value): value is number => value !== undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Modal benchmark ${field} must be a finite, positive number; got ${String(value)}`);
  }
}

function requireFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Modal benchmark ${field} must be a finite, non-negative number; got ${String(value)}`,
    );
  }
}

/**
 * Modal charges as if the reservation were at least its per-container floor.
 * Accepting a below-floor CPU value in the estimator would understate spend
 * and let the budget guard be walked past.
 */
function requireCpuAtLeastFloor(cpuCores: number): void {
  if (!Number.isFinite(cpuCores) || cpuCores < MODAL_MIN_CPU_CORES) {
    throw new Error(
      `Modal benchmark cpuCores must be a finite number >= ${MODAL_MIN_CPU_CORES} `
        + `physical cores (Modal's per-container floor); got ${String(cpuCores)}`,
    );
  }
}
