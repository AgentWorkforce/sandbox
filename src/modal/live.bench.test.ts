import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModalRuntime, estimateModalSandboxCostUsd, runModalBenchmark } from "../index.js";

// ---------------------------------------------------------------------------
// Live Modal benchmark. UNLIKE the Agent37 live smoke test, this one CREATES
// BILLABLE RESOURCES, so it is gated harder and guarded on three axes.
//
// Nothing here runs unless MODAL_LIVE_BENCH=1 *and* both halves of the token
// pair are present. Modal does not use a single bearer key.
//
//   MODAL_LIVE_BENCH=1 MODAL_BENCH_APP=agent-relay-bench \
//   MODAL_BENCH_IMAGE=python:3.13 MODAL_ENVIRONMENT=<non-main-env> \
//     op run --env-file=<(printf '%s\n%s\n' \
//        'MODAL_TOKEN_ID=op://AI Agents/Modal/MODAL_TOKEN_ID' \
//        'MODAL_TOKEN_SECRET=op://AI Agents/Modal/MODAL_TOKEN_SECRET') -- \
//     node --test --import tsx src/modal/live.bench.test.ts
//
// Guards, all enforced by `runModalBenchmark` and unit-tested in bench.test.ts
// against a fake runtime before ever being trusted here:
//
//   - ledger-before-use: intent is recorded before the create is issued, so a
//     create that dies mid-flight still leaves something for cleanup to find;
//   - bounded cost: a projection at Modal's published sandbox rate is charged
//     against MODAL_BENCH_BUDGET_USD *before* each create, and the run aborts
//     rather than exceeding it;
//   - verified cleanup: teardown runs in a `finally` and every id is re-checked
//     against the provider afterwards; a survivor throws.
//
// The sandbox lifetime is held deliberately short. It is the number the budget
// projects against, because a leaked sandbox bills for its whole lifetime
// rather than for however long the benchmark meant to keep it.
//
// Credentials are read from the environment here and nowhere else. They are
// never printed, asserted on, or interpolated into a message.
// ---------------------------------------------------------------------------

const enabled = process.env.MODAL_LIVE_BENCH === "1";
const tokenId = process.env.MODAL_TOKEN_ID ?? "";
const tokenSecret = process.env.MODAL_TOKEN_SECRET ?? "";
const appName = process.env.MODAL_BENCH_APP ?? "";
const imageTag = process.env.MODAL_BENCH_IMAGE ?? "";

const skip = !enabled
  ? "MODAL_LIVE_BENCH is not 1"
  : !tokenId
    ? "MODAL_TOKEN_ID is not set"
    : !tokenSecret
      ? "MODAL_TOKEN_SECRET is not set (Modal needs a token pair, not one key)"
      : !appName
        ? "MODAL_BENCH_APP is not set"
        : !imageTag
          ? "MODAL_BENCH_IMAGE is not set"
          : false;

/** Reference shape from the economics doc: 2 vCPU = 1 physical Modal core. */
const SHAPE = { cpuCores: 1, memoryGiB: 4 } as const;
/** Short on purpose: this is what the budget projects against. */
const LIFETIME_SECONDS = 120;
/** Absolute ceiling for the whole run. Overridable, but never unbounded. */
const BUDGET_USD = Number(process.env.MODAL_BENCH_BUDGET_USD ?? "0.50");

function benchRuntime(namePrefix: string): ModalRuntime {
  return new ModalRuntime({
    credentials: { tokenId, tokenSecret },
    appName,
    imageTag,
    // Never create the App implicitly on a live account.
    createAppIfMissing: false,
    defaultHomeDir: "/root",
    namePrefix,
    maxLifetimeMs: LIFETIME_SECONDS * 1000,
    resources: { cpu: SHAPE.cpuCores, memoryMiB: SHAPE.memoryGiB * 1024 },
    ...(process.env.MODAL_ENVIRONMENT
      ? { environment: process.env.MODAL_ENVIRONMENT }
      : {}),
  });
}

describe("Modal live benchmark (BILLABLE — creates real sandboxes)", () => {
  it("n=1 canary: create, first exec, verified teardown", { skip }, async () => {
    const runtime = benchRuntime("relay-canary");
    try {
      const report = await runModalBenchmark(runtime, {
        count: 1,
        budgetUsd: Math.min(BUDGET_USD, estimateModalSandboxCostUsd({
          ...SHAPE,
          seconds: LIFETIME_SECONDS,
        }) * 3),
        shape: SHAPE,
        projectedLifetimeSeconds: LIFETIME_SECONDS,
        measureFirstExec: true,
        labels: { lane: "modal-adapter-0821", run: "canary" },
      });

      assert.equal(report.succeeded, 1, "the canary sandbox must reach a usable state");
      assert.equal(report.leaked.length, 0, "the canary must leave nothing behind");
      assert.ok(report.createMsP50 !== null);
      assert.ok(report.firstExecMsP50 !== null, "first exec must succeed, not just create");

      // Printed so the promotion comment can quote a measured number rather
      // than an adjective. No credential is in scope here.
      console.log("[modal canary]", JSON.stringify({
        createMsP50: report.createMsP50,
        firstExecMsP50: report.firstExecMsP50,
        projectedCostUsd: report.projectedCostUsd,
      }));
    } finally {
      await runtime.close();
    }
  });

  it("n=7 concurrent: cold-create spread and cleanup discipline", { skip }, async () => {
    const runtime = benchRuntime("relay-bench");
    try {
      const report = await runModalBenchmark(runtime, {
        count: 7,
        budgetUsd: BUDGET_USD,
        shape: SHAPE,
        projectedLifetimeSeconds: LIFETIME_SECONDS,
        concurrent: true,
        measureFirstExec: true,
        labels: { lane: "modal-adapter-0821", run: "n7" },
      });

      assert.equal(report.leaked.length, 0, "no sandbox may survive teardown");
      console.log("[modal n=7]", JSON.stringify({
        requested: report.requested,
        succeeded: report.succeeded,
        failed: report.failed,
        createMsP50: report.createMsP50,
        createMsP95: report.createMsP95,
        firstExecMsP50: report.firstExecMsP50,
        firstExecMsP95: report.firstExecMsP95,
        projectedCostUsd: report.projectedCostUsd,
      }));
    } finally {
      await runtime.close();
    }
  });

  it("warmLease probe: a tagged sandbox is returned by a tag-filtered list", { skip }, async () => {
    // This is the single capability promotion this lane most wants. It is a
    // separate probe rather than an assertion inside the bench run, because a
    // warm-lease failure is a capability fact, not a latency measurement.
    const runtime = benchRuntime("relay-warmlease");
    const labels = { lane: "modal-adapter-0821", probe: "warmlease" };
    let sandboxId: string | undefined;
    try {
      const handle = await runtime.launch({ labels });
      sandboxId = handle.id;
      const found = await runtime.findAllByLabels(labels);
      assert.ok(
        found.some((candidate) => candidate.id === handle.id),
        "a sandbox tagged at create must come back from a tag-filtered list",
      );
    } finally {
      if (sandboxId) {
        await runtime.destroy({ id: sandboxId });
        assert.equal(
          await runtime.getById(sandboxId),
          null,
          "the probe sandbox must be verifiably gone",
        );
      }
      await runtime.close();
    }
  });
});
