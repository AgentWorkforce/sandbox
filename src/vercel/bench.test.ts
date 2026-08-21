import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeHandle } from "../types.js";
import {
  BenchBoundsError,
  percentile,
  projectCost,
  runBenchmark,
  type BenchDeps,
  type BenchRuntime,
  type LedgerEvent,
} from "./bench.js";

/**
 * These tests exist because the harness's guards are the only thing standing
 * between a benchmark and a leaked, billing sandbox. Exercising them against a
 * fake is the last chance to find out they do not work; the alternative is
 * finding out against a real account.
 */

type FakeOptions = {
  failCreateFor?: (name: string) => boolean;
  failExec?: boolean;
  /** Override the readiness probe result so a bad exit code can be exercised. */
  execResult?: () => { output: string; exitCode: number | null };
  /** Throw from `listOwned`, which is what the sweep calls. */
  failListOwned?: boolean;
  /**
   * Choose the *shape* of the destroy failure per sandbox:
   * `null` never fails; `"verification"` throws an error whose name matches
   * `VercelDestroyVerificationError` (accepted delete, unproven absence);
   * `"submit"` throws a plain error (submission never accepted).
   */
  destroyFailureFor?: (name: string) => "verification" | "submit" | null;
  /** Names that stay behind after destroy, i.e. a leak the sweep must catch. */
  survivors?: string[];
};

/** Mirror the runtime's typed error by name so the bench harness can classify it. */
class FakeDestroyVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VercelDestroyVerificationError";
  }
}

class FakeRuntime implements BenchRuntime {
  readonly live = new Set<string>();
  readonly created: string[] = [];
  readonly destroyed: string[] = [];
  private tick = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  async launch({ name }: { name?: string }): Promise<RuntimeHandle> {
    const id = name!;
    if (this.options.failCreateFor?.(id)) {
      throw new Error(`429 rate limited: ${id}`);
    }
    this.created.push(id);
    this.live.add(id);
    return { id, state: "STARTED" };
  }

  async runScript(_handle: RuntimeHandle, _options: { command: string }) {
    if (this.options.failExec) {
      throw new Error("exec blew up");
    }
    this.tick += 1;
    if (this.options.execResult) {
      return this.options.execResult();
    }
    return { output: `2\n4096\nREADY`, exitCode: 0 };
  }

  async listOwned() {
    if (this.options.failListOwned) {
      throw new Error("provider list is unreachable");
    }
    return [...this.live].map((name) => ({
      name,
      providerStatus: "running",
      vcpus: 2,
      memoryMiB: 4096,
      activeCpuMs: 1_000,
      wallClockMs: 30_000,
    }));
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    this.destroyed.push(handle.id);
    const failure = this.options.destroyFailureFor?.(handle.id) ?? null;
    if (failure === "verification") {
      throw new FakeDestroyVerificationError(
        `absence not verified for ${handle.id}`,
      );
    }
    if (failure === "submit") {
      throw new Error(`delete request rejected for ${handle.id}`);
    }
    if (!this.options.survivors?.includes(handle.id)) {
      this.live.delete(handle.id);
    }
  }
}

function deps(
  runtime: BenchRuntime,
  log: LedgerEvent[],
  overrides: Partial<BenchDeps> = {},
): BenchDeps {
  let clock = 1_000;
  return {
    runtime,
    ledger: (entry) => log.push(entry),
    prefix: "awf-bench-t",
    runId: "t",
    limits: { maxSandboxes: 16, vcpus: 2, burstWidth: 4 },
    now: () => (clock += 10),
    ...overrides,
  };
}

describe("bench guard: ledger before use", () => {
  it("writes the intent record before the create call goes out", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime();
    // Interleave the runtime's own calls into the same log so ordering is
    // observable rather than assumed.
    const traced: BenchRuntime = {
      ...runtime,
      launch: async (options) => {
        log.push({ event: "created", name: `CALL:${options.name}` });
        return runtime.launch(options);
      },
      runScript: runtime.runScript.bind(runtime),
      listOwned: runtime.listOwned.bind(runtime),
      destroy: runtime.destroy.bind(runtime),
    };

    await runBenchmark(deps(traced, log), "canary");

    const intent = log.findIndex(
      (e) => e.event === "intent" && e.name === "awf-bench-t-s0",
    );
    const call = log.findIndex((e) => e.name === "CALL:awf-bench-t-s0");
    assert.ok(intent !== -1, "intent must be ledgered");
    assert.ok(call !== -1, "create must be called");
    assert.ok(
      intent < call,
      "a name ledgered only after the response is lost exactly when it matters",
    );
  });

  it("ledgers the intent even when the create itself fails", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({ failCreateFor: () => true });
    const report = await runBenchmark(deps(runtime, log), "canary");

    assert.ok(log.some((e) => e.event === "intent"));
    assert.ok(log.some((e) => e.event === "error"));
    assert.equal(report.cleanup.created, 0);
    assert.equal(report.clean, true, "nothing was created, so nothing leaked");
  });
});

describe("bench guard: bounded cost", () => {
  it("refuses up front to exceed the sandbox cap", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime();
    await assert.rejects(
      runBenchmark(
        deps(runtime, log, {
          limits: { maxSandboxes: 3, vcpus: 2, burstWidth: 4 },
        }),
        "full", // 7 sequential + 4 burst = 11, over the cap of 3
      ),
      BenchBoundsError,
    );
    assert.deepEqual(
      runtime.created,
      [],
      "a bound checked after the fact is not a bound",
    );
  });

  it("stays inside the cap for the modes it does run", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime();
    const report = await runBenchmark(deps(runtime, log), "full");
    assert.equal(runtime.created.length, 7 + 4);
    assert.ok(runtime.created.length <= 16);
    assert.equal(report.n, 7);
    assert.equal(report.burst?.width, 4);
  });
});

describe("bench guard: verified cleanup", () => {
  it("destroys every sandbox it created", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime();
    const report = await runBenchmark(deps(runtime, log), "full");

    assert.deepEqual(
      [...runtime.created].sort(),
      [...runtime.destroyed].sort(),
    );
    assert.equal(report.cleanup.destroyed, report.cleanup.verifiedGone);
    assert.deepEqual(report.cleanup.survivors, []);
    assert.equal(report.clean, true);
  });

  it("still tears down when the measurement itself throws", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({ failExec: true });
    const report = await runBenchmark(deps(runtime, log), "canary");

    assert.deepEqual(runtime.destroyed, ["awf-bench-t-s0"]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.clean, true, "a failed measurement must not leak");
  });

  it("reports destroyed and verifiedGone separately when verification fails", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({
      destroyFailureFor: (name) => (name.endsWith("s0") ? "verification" : null),
      survivors: ["awf-bench-t-s0"],
    });
    const report = await runBenchmark(deps(runtime, log), "canary");

    assert.equal(report.cleanup.destroyed, 1);
    assert.equal(
      report.cleanup.verifiedGone,
      0,
      "an unverified delete is not a clean one",
    );
    assert.deepEqual(report.cleanup.survivors, ["awf-bench-t-s0"]);
    assert.equal(report.clean, false);
    assert.ok(log.some((e) => e.event === "destroy-unverified"));
    assert.ok(log.some((e) => e.event === "survivor"));
  });

  it("does not count a failed delete submission as destroyed", async () => {
    // Submission failure means the provider never accepted the delete, so the
    // sandbox is presumed still alive — the cleanup counter cannot claim it as
    // torn down. The sweep is what confirms it, and it MUST be able to run
    // even when destroy rejected before submission.
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({
      destroyFailureFor: (name) => (name.endsWith("s0") ? "submit" : null),
      survivors: ["awf-bench-t-s0"],
    });
    const report = await runBenchmark(deps(runtime, log), "canary");

    assert.equal(
      report.cleanup.destroyed,
      0,
      "a rejected submit must not be counted as destroyed",
    );
    assert.equal(report.cleanup.verifiedGone, 0);
    assert.deepEqual(report.cleanup.survivors, ["awf-bench-t-s0"]);
    assert.equal(report.clean, false);
    assert.ok(log.some((e) => e.event === "destroy-submit-failed"));
    assert.ok(log.some((e) => e.event === "survivor"));
  });

  it("catches a leak the destroy call itself reported as successful", async () => {
    // The nastiest case: destroy resolves, but the sandbox is still there. Only
    // the independent sweep can see it.
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({ survivors: ["awf-bench-t-s0"] });
    const report = await runBenchmark(deps(runtime, log), "canary");

    assert.equal(report.cleanup.verifiedGone, 1, "destroy claimed success");
    assert.deepEqual(
      report.cleanup.survivors,
      ["awf-bench-t-s0"],
      "the sweep is what catches a delete that lied",
    );
    assert.equal(report.clean, false);
  });
});

describe("bench guard: burst probe", () => {
  it("tears down the sandboxes a partially-rejected burst did admit", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({
      failCreateFor: (name) => name.endsWith("b2") || name.endsWith("b3"),
    });
    const report = await runBenchmark(deps(runtime, log), "full");

    assert.equal(report.burst?.rejected, 2);
    assert.equal(report.burst?.admitted, 2);
    assert.equal(report.burst?.verifiedGone, 2);
    assert.deepEqual(report.cleanup.survivors, []);
    assert.match(report.burst!.caveat, /not a fixed cap/);
  });

  it("counts burst admits inside cleanup.created", async () => {
    // `destroyed` and `verifiedGone` include burst admits, so `created` must
    // include them too, or the cleanup summary is internally inconsistent.
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime();
    const report = await runBenchmark(deps(runtime, log), "full");
    assert.equal(report.cleanup.created, report.n + (report.burst?.admitted ?? 0));
    assert.equal(report.cleanup.created, report.cleanup.destroyed);
  });
});

describe("bench guard: readiness probe", () => {
  it("fails the sample when the readiness probe exits nonzero", async () => {
    // A green-looking latency for a sandbox that never became ready would let
    // the harness publish a "shape and speed" report against a broken box.
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({
      execResult: () => ({ output: "boom", exitCode: 1 }),
    });
    const report = await runBenchmark(deps(runtime, log), "canary");
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!.error, /readiness probe/);
    // Cleanup still ran: the sandbox we created must not survive the failure.
    assert.deepEqual(report.cleanup.survivors, []);
  });

  it("fails the sample when the readiness probe returns no exit code", async () => {
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({
      execResult: () => ({ output: "", exitCode: null }),
    });
    const report = await runBenchmark(deps(runtime, log), "canary");
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!.error, /no exit code/);
  });
});

describe("bench guard: sweep in finally", () => {
  it("captures a sweep-failure in the report instead of losing it", async () => {
    // The sweep is the independent proof of cleanup; a rejection that stops
    // the whole `runBenchmark` promise from resolving would strip operators
    // of both the report and the exit-code signal.
    const log: LedgerEvent[] = [];
    const runtime = new FakeRuntime({ failListOwned: true });
    const report = await runBenchmark(deps(runtime, log), "canary");
    assert.match(report.cleanup.sweepError ?? "", /provider list is unreachable/);
    assert.equal(
      report.clean,
      false,
      "a sweep that never ran cannot certify a clean run",
    );
    assert.ok(log.some((e) => e.event === "sweep-failed"));
  });
});

describe("bench arithmetic", () => {
  it("computes nearest-rank percentiles and ignores missing samples", () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
    assert.equal(percentile([NaN, 10, NaN], 50), 10);
    assert.ok(Number.isNaN(percentile([], 50)));
  });

  it("keeps the CPU and memory lines separate at every utilisation", () => {
    // The default 2 vCPU / 4 GB shape, the numbers the economics doc quotes.
    const saturated = projectCost(2, 1);
    const agent = projectCost(2, 0.1);
    const idle = projectCost(2, 0);

    assert.equal(saturated.totalPerHour, 0.3408);
    assert.equal(agent.totalPerHour, 0.1104);
    assert.equal(idle.totalPerHour, 0.0848);

    // The memory line is identical across all three: it is wall-clock, not
    // active. This is the whole correction to the "cheapest provider" premise,
    // so it is pinned rather than left to a comment.
    assert.equal(saturated.memoryPerHour, 0.0848);
    assert.equal(agent.memoryPerHour, 0.0848);
    assert.equal(idle.memoryPerHour, 0.0848);
    assert.equal(idle.cpuPerHour, 0);
  });
});
