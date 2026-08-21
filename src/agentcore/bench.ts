/**
 * Live benchmark core for the AgentCore adapter.
 *
 * Split out from the CLI in `scripts/agentcore-bench.ts` so the safety guards
 * are testable against a fake runtime *before* they are pointed at a real AWS
 * account, mirroring the Vercel adapter's `bench.ts`. A harness whose
 * ledger-before-use and bounds guards have never been exercised is exactly
 * the unverified claim this package refuses to make about anything else.
 *
 * Not exported from the package barrel: this is an internal measurement
 * tool, not public API.
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
  destroy(handle: RuntimeHandle): Promise<void>;
}

export type LedgerEvent = {
  event:
    | "run-start"
    | "intent"
    | "created"
    | "idle-hold-start"
    | "idle-hold-end"
    | "error"
    | "destroyed-verified"
    | "destroy-unverified"
    | "run-end";
  name: string;
  [key: string]: unknown;
};

export interface BenchLimits {
  /** Absolute ceiling on sessions created by one invocation. */
  maxSessions: number;
}

export interface BenchDeps {
  runtime: BenchRuntime;
  /** Must be durable before the create call goes out. */
  ledger(entry: LedgerEvent): void;
  namePrefix: string;
  runId: string;
  limits: BenchLimits;
  /** Milliseconds to hold one session idle for the billing measurement. */
  idleHoldMs: number;
  now?: () => number;
}

export class BenchBoundsError extends Error {
  constructor(requested: number, max: number) {
    super(
      `benchmark would create ${requested} sessions, exceeding the cap of ${max}`,
    );
    this.name = "BenchBoundsError";
  }
}

export type Sample = {
  index: number;
  createMs: number;
  firstExecMs: number;
  execExitCode: number | null;
  destroyed: boolean;
  verifiedGone: boolean;
  error?: string;
};

/**
 * Run `count` cold create → exec → destroy samples. Refuses to start if
 * `count` exceeds `limits.maxSessions` — the caller must lower the request
 * rather than have it silently clamped, since a silently truncated n=7 read
 * as n=7 to anyone who did not re-derive it from the ledger.
 */
export async function runColdCreateSamples(
  deps: BenchDeps,
  count: number,
): Promise<Sample[]> {
  if (count > deps.limits.maxSessions) {
    throw new BenchBoundsError(count, deps.limits.maxSessions);
  }
  const now = deps.now ?? Date.now;
  deps.ledger({ event: "run-start", name: deps.runId, count });
  const samples: Sample[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${deps.namePrefix}-${deps.runId}-${index}`;
    deps.ledger({ event: "intent", name, index });
    const sample: Sample = {
      index,
      createMs: 0,
      firstExecMs: 0,
      execExitCode: null,
      destroyed: false,
      verifiedGone: false,
    };
    let handle: RuntimeHandle | undefined;
    try {
      const createStart = now();
      handle = await deps.runtime.launch({ name });
      sample.createMs = now() - createStart;
      deps.ledger({ event: "created", name, sessionId: handle.id, createMs: sample.createMs });

      const execStart = now();
      const result = await deps.runtime.runScript(handle, { command: "echo ready" });
      sample.firstExecMs = now() - execStart;
      sample.execExitCode = result.exitCode;
    } catch (error) {
      sample.error = error instanceof Error ? error.message : String(error);
      deps.ledger({ event: "error", name, error: sample.error });
    } finally {
      if (handle) {
        try {
          await deps.runtime.destroy(handle);
          sample.destroyed = true;
          sample.verifiedGone = true;
          deps.ledger({ event: "destroyed-verified", name, sessionId: handle.id });
        } catch (error) {
          deps.ledger({
            event: "destroy-unverified",
            name,
            sessionId: handle.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    samples.push(sample);
  }
  deps.ledger({ event: "run-end", name: deps.runId, sampleCount: samples.length });
  return samples;
}

export type IdleHoldResult = {
  sessionId: string;
  createdAt: number;
  idleHoldMs: number;
  releasedAt: number;
  /**
   * This canary can only observe wall-clock elapsed time, not a dollar
   * figure: AWS Cost Explorer / CUR data typically lands with several hours
   * to a day of latency, so no single benchmark run can read back a
   * confirmed cost for a session it just tore down. What this canary
   * produces is a *correlation key* (session id + start/end timestamps) a
   * follow-up Cost Explorer query filtered to those timestamps can be
   * checked against — see `docs/agentcore.md` for the two-step protocol.
   */
  destroyed: boolean;
  verifiedGone: boolean;
};

/**
 * Hold one session idle for `deps.idleHoldMs`, then destroy it and record the
 * correlation key needed for the deferred Cost Explorer read-back. This is
 * the load-bearing measurement for the idle-billing question (see
 * `capabilities.ts`'s `idleMemoryBillingConfirmedFree`): it does not by
 * itself resolve that field, since the dollar evidence arrives out of band.
 */
export async function runIdleHoldCanary(deps: BenchDeps): Promise<IdleHoldResult> {
  const now = deps.now ?? Date.now;
  const name = `${deps.namePrefix}-${deps.runId}-idle`;
  deps.ledger({ event: "intent", name });
  const handle = await deps.runtime.launch({ name });
  const createdAt = now();
  deps.ledger({ event: "created", name, sessionId: handle.id });
  deps.ledger({ event: "idle-hold-start", name, sessionId: handle.id, idleHoldMs: deps.idleHoldMs });
  await sleep(deps.idleHoldMs);
  const releasedAt = now();
  deps.ledger({ event: "idle-hold-end", name, sessionId: handle.id, elapsedMs: releasedAt - createdAt });
  let destroyed = false;
  try {
    await deps.runtime.destroy(handle);
    destroyed = true;
    deps.ledger({ event: "destroyed-verified", name, sessionId: handle.id });
  } catch (error) {
    deps.ledger({
      event: "destroy-unverified",
      name,
      sessionId: handle.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    sessionId: handle.id,
    createdAt,
    idleHoldMs: deps.idleHoldMs,
    releasedAt,
    destroyed,
    verifiedGone: destroyed,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
