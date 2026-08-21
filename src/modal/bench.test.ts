import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MODAL_RATES,
  ModalBenchLedger,
  ModalBudgetExceededError,
  ModalLeakedSandboxError,
  estimateModalFunctionCostUsd,
  estimateModalSandboxCostUsd,
  percentile,
  runModalBenchmark,
} from "../index.js";
import type { ModalBenchReport, RuntimeHandle, SandboxRuntime } from "../index.js";

// The benchmark harness is the one component that spends real money, so its
// guards are proven here against a fake runtime *before* they are ever trusted
// with a live account. No test in this file touches a network.

// --- fake runtime -----------------------------------------------------------

type FakeRuntimeSpec = {
  createMs?: number;
  failCreateAt?: number[];
  /** Sandboxes whose destroy throws. */
  destroyFailsFor?: string[];
  /** Sandboxes that remain present after destroy — i.e. leak. */
  stillPresentAfterDestroy?: string[];
  /** Drop `getById`, so absence cannot be proven. */
  omitGetById?: boolean;
  execMs?: number;
};

function fakeRuntime(spec: FakeRuntimeSpec = {}) {
  let clock = 0;
  // A monotonic attempt counter, deliberately NOT `created.length`: that would
  // reuse an index after a failed create and would race under concurrency,
  // which is exactly what these tests exercise.
  let attempts = 0;
  const created: string[] = [];
  const destroyed: string[] = [];
  const now = () => clock;

  const runtime: SandboxRuntime = {
    id: "modal-fake",
    findByLabels: async () => null,
    findAllByLabels: async () => [],
    countByLabels: async () => 0,
    launch: async (options) => {
      const index = attempts;
      attempts += 1;
      clock += spec.createMs ?? 100;
      if (spec.failCreateAt?.includes(index)) {
        throw new Error(`create failed at ${index}`);
      }
      const id = `sb-${index}`;
      created.push(id);
      void options;
      return { id } satisfies RuntimeHandle;
    },
    runScript: async () => {
      clock += spec.execMs ?? 10;
      return { output: "", exitCode: 0 };
    },
    uploadBundle: async () => {},
    destroy: async (handle) => {
      if (spec.destroyFailsFor?.includes(handle.id)) {
        throw new Error(`destroy failed for ${handle.id}`);
      }
      destroyed.push(handle.id);
    },
    ...(spec.omitGetById
      ? {}
      : {
        getById: async (id: string) =>
          spec.stillPresentAfterDestroy?.includes(id) ? ({ id } as RuntimeHandle) : null,
      }),
  };
  return { runtime, created, destroyed, now };
}

const SHAPE = { cpuCores: 1, memoryGiB: 4 };

// --- cost model -------------------------------------------------------------

describe("Modal cost model", () => {
  it("prices the 2 vCPU / 4 GiB reference shape at the published sandbox rate", () => {
    // Modal counts one physical core as two vCPU, so 2 vCPU is cpu: 1.
    const perHour = estimateModalSandboxCostUsd({ ...SHAPE, seconds: 3600 });
    assert.ok(
      Math.abs(perHour - 0.23796) < 1e-9,
      `expected $0.23796/hour at the reference shape, got ${perHour}`,
    );
  });

  it("confirms Modal bills sandboxes at ~3x its own function rate", () => {
    const sandbox = estimateModalSandboxCostUsd({ ...SHAPE, seconds: 3600 });
    const fn = estimateModalFunctionCostUsd({ ...SHAPE, seconds: 3600 });
    const ratio = sandbox / fn;
    // The headline economics finding, asserted rather than left in a comment.
    assert.ok(ratio > 3.0 && ratio < 3.01, `expected a ~3x sandbox premium, got ${ratio}`);
  });

  it("keeps the documented vCPU-per-core definition, which the whole model rests on", () => {
    assert.equal(MODAL_RATES.vcpuPerPhysicalCore, 2);
  });

  it("scales linearly with time and returns zero for zero seconds", () => {
    const oneMinute = estimateModalSandboxCostUsd({ ...SHAPE, seconds: 60 });
    const twoMinutes = estimateModalSandboxCostUsd({ ...SHAPE, seconds: 120 });
    assert.ok(Math.abs(twoMinutes - oneMinute * 2) < 1e-12);
    assert.equal(estimateModalSandboxCostUsd({ ...SHAPE, seconds: 0 }), 0);
  });

  it("rejects a non-finite shape rather than projecting NaN into a budget guard", () => {
    assert.throws(
      () => estimateModalSandboxCostUsd({ cpuCores: Number.NaN, memoryGiB: 4, seconds: 60 }),
      /cpuCores/,
    );
    assert.throws(
      () => estimateModalSandboxCostUsd({ cpuCores: 1, memoryGiB: 4, seconds: -1 }),
      /seconds/,
    );
  });
});

// --- percentiles ------------------------------------------------------------

describe("Modal benchmark percentiles", () => {
  it("returns null for no samples rather than claiming zero", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([], 95), null);
  });

  it("interpolates linearly", () => {
    assert.equal(percentile([10, 20], 50), 15);
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  });

  it("handles a single sample and the exact bounds", () => {
    assert.equal(percentile([42], 95), 42);
    assert.equal(percentile([1, 2, 3], 0), 1);
    assert.equal(percentile([1, 2, 3], 100), 3);
  });

  it("rejects an out-of-range percentile", () => {
    assert.throws(() => percentile([1], 101), /within \[0, 100\]/);
  });
});

// --- ledger and budget ------------------------------------------------------

describe("Modal benchmark ledger", () => {
  it("refuses an intent that would breach the cap, before any provider call", () => {
    const ledger = new ModalBenchLedger({ budgetUsd: 1 });
    ledger.recordIntent("a", 0.6);
    assert.throws(
      () => ledger.recordIntent("b", 0.5),
      (error: unknown) => error instanceof ModalBudgetExceededError,
    );
    // The refused entry must not be committed.
    assert.equal(ledger.all().length, 1);
    assert.ok(Math.abs(ledger.remainingUsd() - 0.4) < 1e-12);
  });

  it("allows an intent that exactly reaches the cap", () => {
    const ledger = new ModalBenchLedger({ budgetUsd: 1 });
    assert.doesNotThrow(() => ledger.recordIntent("a", 1));
    assert.equal(ledger.remainingUsd(), 0);
  });

  it("counts an intended-but-unconfirmed entry as outstanding", () => {
    const ledger = new ModalBenchLedger({ budgetUsd: 1 });
    ledger.recordIntent("a", 0.1);
    assert.equal(ledger.outstanding().length, 1, "intent alone must be treated as possibly live");
  });
});

// --- the run ----------------------------------------------------------------

describe("Modal benchmark run", () => {
  it("tears down and verifies every sandbox it created", async () => {
    const { runtime, created, destroyed, now } = fakeRuntime();
    const report = await runModalBenchmark(runtime, {
      count: 3,
      budgetUsd: 1,
      shape: SHAPE,
      projectedLifetimeSeconds: 120,
      now,
    });
    assert.equal(report.succeeded, 3);
    assert.deepEqual(destroyed.sort(), created.sort());
    assert.equal(report.leaked.length, 0);
    for (const entry of report.ledger) {
      assert.equal(entry.state, "verified-gone");
    }
  });

  it("aborts on the budget cap and still tears down what it already created", async () => {
    const { runtime, destroyed, now } = fakeRuntime();
    // Two sandboxes fit the cap; the third must be refused.
    const perSandbox = estimateModalSandboxCostUsd({ ...SHAPE, seconds: 120 });
    await assert.rejects(
      () =>
        runModalBenchmark(runtime, {
          count: 3,
          budgetUsd: perSandbox * 2.5,
          shape: SHAPE,
          projectedLifetimeSeconds: 120,
          now,
        }),
      (error: unknown) => error instanceof ModalBudgetExceededError,
    );
    assert.equal(destroyed.length, 2, "the two created sandboxes must still be destroyed");
  });

  it("reports a sandbox that survives teardown as a leak, loudly", async () => {
    const { runtime, now } = fakeRuntime({ stillPresentAfterDestroy: ["sb-1"] });
    await assert.rejects(
      () =>
        runModalBenchmark(runtime, {
          count: 2,
          budgetUsd: 1,
          shape: SHAPE,
          projectedLifetimeSeconds: 120,
          now,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ModalLeakedSandboxError);
        assert.equal(error.leaked.length, 1);
        assert.equal(error.leaked[0]?.sandboxId, "sb-1");
        return true;
      },
    );
  });

  it("treats a failed destroy as a leak rather than as success", async () => {
    const { runtime, now } = fakeRuntime({
      destroyFailsFor: ["sb-0"],
      stillPresentAfterDestroy: ["sb-0"],
    });
    await assert.rejects(
      () =>
        runModalBenchmark(runtime, {
          count: 1,
          budgetUsd: 1,
          shape: SHAPE,
          projectedLifetimeSeconds: 120,
          now,
        }),
      (error: unknown) => error instanceof ModalLeakedSandboxError,
    );
  });

  it("does not claim verified-gone when the runtime cannot re-resolve by id", async () => {
    const { runtime, now } = fakeRuntime({ omitGetById: true });
    const report = await runModalBenchmark(runtime, {
      count: 1,
      budgetUsd: 1,
      shape: SHAPE,
      projectedLifetimeSeconds: 120,
      now,
    });
    // Destroyed, but absence was never proven, so it must not read as verified.
    assert.equal(report.ledger[0]?.state, "destroyed");
    assert.notEqual(report.ledger[0]?.state, "verified-gone");
  });

  it("records a create failure without counting it as a live resource", async () => {
    const { runtime, now } = fakeRuntime({ failCreateAt: [0] });
    const report = await runModalBenchmark(runtime, {
      count: 2,
      budgetUsd: 1,
      shape: SHAPE,
      projectedLifetimeSeconds: 120,
      now,
    });
    assert.equal(report.failed, 1);
    assert.equal(report.succeeded, 1);
    assert.equal(report.leaked.length, 0);
    assert.ok(report.ledger.some((entry) => entry.state === "create-failed"));
  });

  it("measures create and first-exec latency separately", async () => {
    const { runtime, now } = fakeRuntime({ createMs: 200, execMs: 50 });
    const report = await runModalBenchmark(runtime, {
      count: 3,
      budgetUsd: 1,
      shape: SHAPE,
      projectedLifetimeSeconds: 120,
      measureFirstExec: true,
      now,
    });
    assert.equal(report.createMsP50, 200);
    assert.equal(report.firstExecMsP50, 50);
  });

  it("tears down every sandbox even when a concurrent create throws", async () => {
    const { runtime, destroyed, now } = fakeRuntime({ failCreateAt: [1] });
    const report = await runModalBenchmark(runtime, {
      count: 3,
      budgetUsd: 1,
      shape: SHAPE,
      projectedLifetimeSeconds: 120,
      concurrent: true,
      now,
    });
    assert.equal(destroyed.length, 2);
    assert.equal(report.leaked.length, 0);
  });

  it("projects the worst case, not the expected case", async () => {
    const { runtime, now } = fakeRuntime();
    const report: ModalBenchReport = await runModalBenchmark(runtime, {
      count: 2,
      budgetUsd: 1,
      shape: SHAPE,
      // The budget must cover the full lifetime: a leaked sandbox bills for all
      // of it, not for how long the benchmark meant to keep it.
      projectedLifetimeSeconds: 300,
      now,
    });
    const expected = estimateModalSandboxCostUsd({ ...SHAPE, seconds: 300 }) * 2;
    assert.ok(Math.abs(report.projectedCostUsd - expected) < 1e-12);
  });

  it("rejects a non-positive count", async () => {
    const { runtime } = fakeRuntime();
    await assert.rejects(
      () =>
        runModalBenchmark(runtime, {
          count: 0,
          budgetUsd: 1,
          shape: SHAPE,
          projectedLifetimeSeconds: 120,
        }),
      /positive integer/,
    );
  });

  it("rejects a fractional count rather than silently under-running", async () => {
    // `Math.floor(2.7)` would silently run 2 sandboxes for a request that
    // named 2.7 — a benchmark for a shape the caller never asked for.
    const { runtime } = fakeRuntime();
    await assert.rejects(
      () =>
        runModalBenchmark(runtime, {
          count: 2.7,
          budgetUsd: 1,
          shape: SHAPE,
          projectedLifetimeSeconds: 120,
        }),
      /positive integer/,
    );
  });

  it("rejects a non-positive projectedLifetimeSeconds", async () => {
    // Zero seconds reserves $0 in the ledger but still creates sandboxes with
    // a positive provider lifetime, so the budget guard cannot stop the run.
    const { runtime } = fakeRuntime();
    await assert.rejects(
      () =>
        runModalBenchmark(runtime, {
          count: 1,
          budgetUsd: 1,
          shape: SHAPE,
          projectedLifetimeSeconds: 0,
        }),
      /projectedLifetimeSeconds/,
    );
  });

  it("does not record firstExecMs when the canary command exits nonzero", async () => {
    // A first-exec measurement for a command that failed is a green latency
    // on a red canary — exactly the shape a promotion decision should NOT
    // rest on.
    const { runtime } = fakeRuntime();
    const failingRuntime = {
      ...runtime,
      runScript: async () => ({ output: "", exitCode: 1 }),
    };
    const report = await runModalBenchmark(failingRuntime, {
      count: 1,
      budgetUsd: 1,
      shape: SHAPE,
      projectedLifetimeSeconds: 120,
      measureFirstExec: true,
      now: () => 0,
    });
    assert.equal(report.firstExecMsP50, null);
    assert.equal(report.samples[0]?.firstExecMs, undefined);
    assert.match(report.samples[0]?.error ?? "", /exit(ed)? with code 1/);
  });

  it("reconciles a launch that threw with a stray sandbox from the label sweep", async () => {
    // Simulates the failure mode: launch rejects but the provider had already
    // provisioned a sandbox; the label sweep in teardown must catch it.
    let attempts = 0;
    const strayId = "sb-orphaned-42";
    const destroyed: string[] = [];
    const runtime: SandboxRuntime = {
      id: "modal-fake-reconcile",
      launch: async () => {
        attempts += 1;
        throw new Error("client-side deadline fired but the create landed anyway");
      },
      findByLabels: async () => null,
      findAllByLabels: async () => attempts > 0 ? [{ id: strayId } as RuntimeHandle] : [],
      countByLabels: async () => 0,
      runScript: async () => ({ output: "", exitCode: 0 }),
      uploadBundle: async () => {},
      destroy: async (handle) => {
        destroyed.push(handle.id);
      },
      getById: async () => null,
    };
    const report = await runModalBenchmark(runtime, {
      count: 1,
      budgetUsd: 1,
      shape: SHAPE,
      projectedLifetimeSeconds: 120,
      labels: { lane: "reconcile-test" },
      now: () => 0,
    });
    assert.deepEqual(destroyed, [strayId], "the stray must be destroyed");
    assert.equal(report.leaked.length, 0);
    assert.equal(report.ledger[0]?.sandboxId, strayId);
    assert.equal(report.ledger[0]?.state, "verified-gone");
  });
});
