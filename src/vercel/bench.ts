/**
 * Live benchmark core for the Vercel adapter.
 *
 * Split out from the CLI in `scripts/vercel-bench.ts` so the safety guards are
 * testable against a fake runtime *before* they are pointed at a real account.
 * A harness whose ledger-before-use and verified-cleanup guards have never been
 * exercised is exactly the unverified claim this package refuses to make about
 * anything else.
 *
 * Not exported from the package barrel: this is an internal measurement tool,
 * not public API.
 */

import type { RuntimeHandle } from "../types.js";

/** The slice of the runtime the benchmark needs. Keeps fakes cheap. */
export interface BenchRuntime {
  launch(options: {
    name?: string;
    labels?: Record<string, string>;
  }): Promise<RuntimeHandle>;
  runScript(
    handle: RuntimeHandle,
    options: { command: string; timeoutMs?: number },
  ): Promise<{ output: string; exitCode: number | null }>;
  listOwned(options?: {
    includeTerminated?: boolean;
    states?: readonly string[] | null;
  }): Promise<
    Array<{
      name: string;
      providerStatus: string;
      vcpus?: number;
      memoryMiB?: number;
      activeCpuMs?: number;
      wallClockMs?: number;
    }>
  >;
  destroy(handle: RuntimeHandle): Promise<void>;
}

export type LedgerEvent = {
  event:
    | "run-start"
    | "intent"
    | "created"
    | "error"
    | "destroyed-verified"
    | "destroy-unverified"
    | "burst-start"
    | "survivor"
    | "run-end";
  name: string;
  [key: string]: unknown;
};

export interface BenchLimits {
  /** Absolute ceiling on sandboxes created by one invocation. */
  maxSandboxes: number;
  /** vCPUs per sandbox, echoed into the cost projection. */
  vcpus: number;
  /** Concurrency probe width. */
  burstWidth: number;
}

export interface BenchDeps {
  runtime: BenchRuntime;
  /** Must be durable before the create call goes out. */
  ledger(entry: LedgerEvent): void;
  prefix: string;
  runId: string;
  limits: BenchLimits;
  now?: () => number;
}

export class BenchBoundsError extends Error {
  constructor(requested: number, max: number) {
    super(
      `benchmark would create ${requested} sandboxes, exceeding the cap of ${max}`,
    );
    this.name = "BenchBoundsError";
  }
}

export type Sample = {
  index: number;
  createMs: number;
  stateAfterCreate: string;
  firstExecMs: number;
  execExitCode: number | null;
  execOutput: string;
  vcpus?: number;
  memoryMiB?: number;
  activeCpuMs?: number;
  wallClockMs?: number;
  destroyed: boolean;
  verifiedGone: boolean;
  error?: string;
};

/**
 * Cost for one sandbox-hour at a given shape and CPU utilisation.
 *
 * The two lines are always reported separately and never blended. Active CPU
 * excludes I/O wait; provisioned memory does not — it is wall-clock. Collapsing
 * them into one number is precisely how the "cheapest provider" claim gets
 * overstated for idle-heavy agent workloads.
 */
export function projectCost(vcpus: number, utilisation: number) {
  const memoryGb = vcpus * 2; // the provider allocates 2 GB per vCPU
  const cpuPerHour = vcpus * utilisation * 0.128;
  const memoryPerHour = memoryGb * 0.0212;
  return {
    utilisation,
    cpuPerHour: round4(cpuPerHour),
    memoryPerHour: round4(memoryPerHour),
    totalPerHour: round4(cpuPerHour + memoryPerHour),
  };
}

/** Nearest-rank percentile. NaN entries are dropped, not treated as zero. */
export function percentile(values: readonly number[], p: number): number {
  const clean = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (clean.length === 0) {
    return NaN;
  }
  const rank = Math.ceil((p / 100) * clean.length) - 1;
  return clean[Math.min(Math.max(rank, 0), clean.length - 1)]!;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Measure one sandbox end to end.
 *
 * The name is ledgered *before* `launch` is called. A record written after the
 * response would be lost exactly when it matters — a crash between submit and
 * response leaves a live sandbox nobody wrote down.
 *
 * Teardown runs in `finally`, so a failed measurement still destroys what it
 * created. `destroyed` and `verifiedGone` are tracked separately because they
 * are different facts, and conflating them is how a leak gets reported as a
 * clean run.
 */
export async function measureOne(
  deps: BenchDeps,
  index: number,
): Promise<Sample> {
  const clock = deps.now ?? (() => Date.now());
  const sample: Sample = {
    index,
    createMs: NaN,
    stateAfterCreate: "unknown",
    firstExecMs: NaN,
    execExitCode: null,
    execOutput: "",
    destroyed: false,
    verifiedGone: false,
  };
  const intended = `${deps.prefix}-s${index}`;
  deps.ledger({ event: "intent", name: intended, index });
  let handle: RuntimeHandle | undefined;
  try {
    const t0 = clock();
    handle = await deps.runtime.launch({
      name: intended,
      labels: { bench: deps.runId },
    });
    sample.createMs = clock() - t0;
    sample.stateAfterCreate = handle.state ?? "unknown";
    deps.ledger({
      event: "created",
      name: handle.id,
      createMs: Math.round(sample.createMs),
    });

    const t1 = clock();
    const exec = await deps.runtime.runScript(handle, {
      command: "nproc; free -m | awk '/Mem:/{print $2}'; echo READY",
      timeoutMs: 60_000,
    });
    sample.firstExecMs = clock() - t1;
    sample.execExitCode = exec.exitCode;
    sample.execOutput = exec.output.trim();

    const owned = await deps.runtime.listOwned({ includeTerminated: true });
    const row = owned.find((entry) => entry.name === handle!.id);
    sample.vcpus = row?.vcpus;
    sample.memoryMiB = row?.memoryMiB;
    sample.activeCpuMs = row?.activeCpuMs;
    sample.wallClockMs = row?.wallClockMs;
  } catch (error) {
    sample.error = describe(error);
    deps.ledger({ event: "error", name: intended, error: sample.error });
  } finally {
    // `finally` rather than a trailing block. Today the catch above is total,
    // so the two are equivalent and no test can tell them apart — but the
    // moment anyone makes that catch selective, a trailing block would silently
    // stop tearing down on the rethrown path. The cost of being right in
    // advance is one keyword.
    if (handle) {
      try {
        await deps.runtime.destroy(handle);
        sample.destroyed = true;
        sample.verifiedGone = true;
        deps.ledger({ event: "destroyed-verified", name: handle.id });
      } catch (error) {
        sample.destroyed = true;
        sample.verifiedGone = false;
        deps.ledger({
          event: "destroy-unverified",
          name: handle.id,
          error: describe(error),
        });
      }
    }
  }
  return sample;
}

export interface BurstResult {
  width: number;
  admitted: number;
  rejected: number;
  rejections: string[];
  verifiedGone: number;
  caveat: string;
}

/** Concurrency probe: launch a burst, then tear all of it down. */
export async function burstProbe(deps: BenchDeps): Promise<BurstResult> {
  const width = deps.limits.burstWidth;
  deps.ledger({ event: "burst-start", name: deps.prefix, width });
  const names = Array.from({ length: width }, (_, i) => `${deps.prefix}-b${i}`);
  for (const name of names) {
    deps.ledger({ event: "intent", name, burst: true });
  }
  const settled = await Promise.allSettled(
    names.map((name) =>
      deps.runtime.launch({ name, labels: { bench: deps.runId, kind: "burst" } }),
    ),
  );
  const rejections = settled
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => describe(r.reason));

  let verifiedGone = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      continue;
    }
    try {
      await deps.runtime.destroy(result.value);
      verifiedGone += 1;
      deps.ledger({
        event: "destroyed-verified",
        name: result.value.id,
        burst: true,
      });
    } catch (error) {
      deps.ledger({
        event: "destroy-unverified",
        name: result.value.id,
        burst: true,
        error: describe(error),
      });
    }
  }
  return {
    width,
    admitted: settled.length - rejections.length,
    rejected: rejections.length,
    rejections: rejections.slice(0, 4),
    verifiedGone,
    // The provider ramps its vCPU allocation rate with sustained use and decays
    // it after ~10 idle minutes, so this is the rate in force now, not a cap.
    caveat:
      "dynamic vCPU allocation rate — measures the current rate, not a fixed cap",
  };
}

/** Independent audit: nothing under this lane's prefix may survive a run. */
export async function sweep(deps: BenchDeps): Promise<string[]> {
  const survivors = await deps.runtime.listOwned({
    includeTerminated: true,
    states: null,
  });
  for (const entry of survivors) {
    deps.ledger({
      event: "survivor",
      name: entry.name,
      status: entry.providerStatus,
    });
  }
  return survivors.map((entry) => entry.name);
}

export type BenchMode = "canary" | "full" | "sweep";

export interface BenchReport {
  runId: string;
  prefix: string;
  mode: BenchMode;
  n: number;
  coldCreate: { p50Ms: number; p95Ms: number };
  firstExec: { p50Ms: number; p95Ms: number };
  readyStateAfterCreate: string[];
  deliveredShape: { vcpus: number[]; memoryMiB: number[]; documented: string };
  cleanup: {
    created: number;
    destroyed: number;
    verifiedGone: number;
    survivors: string[];
  };
  burst: BurstResult | null;
  costProjection: {
    shape: string;
    note: string;
    perHour: ReturnType<typeof projectCost>[];
  };
  errors: Array<{ index: number; error: string }>;
  /** True only when every created sandbox was proven gone. */
  clean: boolean;
}

/**
 * Run the benchmark.
 *
 * Refuses up front to exceed the sandbox cap: a bound checked after the fact is
 * not a bound. The sweep runs in `finally`, so an aborted run still audits.
 */
export async function runBenchmark(
  deps: BenchDeps,
  mode: BenchMode,
): Promise<BenchReport> {
  deps.ledger({ event: "run-start", name: deps.prefix, mode });
  const n = mode === "sweep" ? 0 : mode === "full" ? 7 : 1;
  const burstCount = mode === "full" ? deps.limits.burstWidth : 0;
  if (n + burstCount > deps.limits.maxSandboxes) {
    throw new BenchBoundsError(n + burstCount, deps.limits.maxSandboxes);
  }

  const samples: Sample[] = [];
  let burst: BurstResult | null = null;
  try {
    for (let i = 0; i < n; i += 1) {
      samples.push(await measureOne(deps, i));
    }
    if (mode === "full") {
      burst = await burstProbe(deps);
    }
  } finally {
    deps.ledger({ event: "run-end", name: deps.prefix });
  }

  const survivors = await sweep(deps);
  const createMs = samples.map((s) => s.createMs);
  const observedVcpus = samples.find((s) => s.vcpus)?.vcpus
    ?? deps.limits.vcpus;
  const destroyed = samples.filter((s) => s.destroyed).length
    + (burst?.admitted ?? 0);
  const verifiedGone = samples.filter((s) => s.verifiedGone).length
    + (burst?.verifiedGone ?? 0);

  return {
    runId: deps.runId,
    prefix: deps.prefix,
    mode,
    n: samples.length,
    coldCreate: {
      p50Ms: Math.round(percentile(createMs, 50)),
      p95Ms: Math.round(percentile(createMs, 95)),
    },
    firstExec: {
      p50Ms: Math.round(percentile(samples.map((s) => s.firstExecMs), 50)),
      p95Ms: Math.round(percentile(samples.map((s) => s.firstExecMs), 95)),
    },
    readyStateAfterCreate: [...new Set(samples.map((s) => s.stateAfterCreate))],
    deliveredShape: {
      vcpus: [...new Set(samples.map((s) => s.vcpus).filter(isNumber))],
      memoryMiB: [...new Set(samples.map((s) => s.memoryMiB).filter(isNumber))],
      documented: "1 or even 2-32 vCPUs, default 2; 2 GB memory per vCPU",
    },
    cleanup: {
      created: samples.filter((s) => Number.isFinite(s.createMs)).length,
      destroyed,
      verifiedGone,
      survivors,
    },
    burst,
    costProjection: {
      shape: `${observedVcpus} vCPU / ${observedVcpus * 2} GB`,
      note:
        "Active CPU excludes I/O wait; provisioned memory is billed on WALL "
        + "CLOCK. The memory line is a floor an idle-heavy agent cannot duck.",
      perHour: [1, 0.5, 0.1, 0].map((u) => projectCost(observedVcpus, u)),
    },
    errors: samples
      .filter((s) => s.error)
      .map((s) => ({ index: s.index, error: s.error! })),
    clean: survivors.length === 0 && destroyed === verifiedGone,
  };
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number";
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
