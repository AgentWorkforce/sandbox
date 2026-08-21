import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BenchBoundsError,
  runColdCreateSamples,
  runIdleHoldCanary,
  type BenchRuntime,
  type LedgerEvent,
} from "./bench.js";
import type { RuntimeHandle } from "../types.js";

function fakeRuntime(overrides: Partial<BenchRuntime> = {}): BenchRuntime {
  let counter = 0;
  return {
    launch: async () => ({ id: `sess-${++counter}`, state: "READY" }) satisfies RuntimeHandle,
    runScript: async () => ({ output: "ready", exitCode: 0 }),
    destroy: async () => {},
    ...overrides,
  };
}

describe("runColdCreateSamples", () => {
  it("refuses to run when count exceeds the configured cap", async () => {
    const events: LedgerEvent[] = [];
    await assert.rejects(
      () =>
        runColdCreateSamples(
          {
            runtime: fakeRuntime(),
            ledger: (e) => events.push(e),
            namePrefix: "bench",
            runId: "run-1",
            limits: { maxSessions: 2 },
            idleHoldMs: 0,
          },
          3,
        ),
      BenchBoundsError,
    );
    // The bound is checked before anything durable happens.
    assert.equal(events.length, 0);
  });

  it("writes a ledger entry before every create call", async () => {
    const events: LedgerEvent[] = [];
    let launched = 0;
    await runColdCreateSamples(
      {
        runtime: fakeRuntime({ launch: async () => { launched += 1; return { id: `s-${launched}`, state: "READY" }; } }),
        ledger: (e) => events.push(e),
        namePrefix: "bench",
        runId: "run-2",
        limits: { maxSessions: 5 },
        idleHoldMs: 0,
      },
      2,
    );
    const intents = events.filter((e) => e.event === "intent").length;
    const created = events.filter((e) => e.event === "created").length;
    assert.equal(intents, 2);
    assert.equal(created, 2);
    // Every "created" is preceded somewhere by an "intent" — ledger-before-use.
    const firstIntentIndex = events.findIndex((e) => e.event === "intent");
    const firstCreatedIndex = events.findIndex((e) => e.event === "created");
    assert.ok(firstIntentIndex < firstCreatedIndex);
  });

  it("still records destroy-unverified and continues when destroy fails", async () => {
    const events: LedgerEvent[] = [];
    const samples = await runColdCreateSamples(
      {
        runtime: fakeRuntime({ destroy: async () => { throw new Error("stuck"); } }),
        ledger: (e) => events.push(e),
        namePrefix: "bench",
        runId: "run-3",
        limits: { maxSessions: 5 },
        idleHoldMs: 0,
      },
      1,
    );
    assert.equal(samples[0].destroyed, false);
    assert.equal(samples[0].verifiedGone, false);
    assert.ok(events.some((e) => e.event === "destroy-unverified"));
  });

  it("captures an exec error on the sample without losing the destroy step", async () => {
    let destroyed = false;
    const samples = await runColdCreateSamples(
      {
        runtime: fakeRuntime({
          runScript: async () => { throw new Error("exec blew up"); },
          destroy: async () => { destroyed = true; },
        }),
        ledger: () => {},
        namePrefix: "bench",
        runId: "run-4",
        limits: { maxSessions: 5 },
        idleHoldMs: 0,
      },
      1,
    );
    assert.equal(samples[0].error, "exec blew up");
    assert.equal(destroyed, true);
    assert.equal(samples[0].destroyed, true);
  });

  it("produces exactly `count` samples with distinct names", async () => {
    const names = new Set<string>();
    await runColdCreateSamples(
      {
        runtime: fakeRuntime(),
        ledger: (e) => { if (e.event === "intent") names.add(e.name); },
        namePrefix: "bench",
        runId: "run-5",
        limits: { maxSessions: 5 },
        idleHoldMs: 0,
      },
      4,
    );
    assert.equal(names.size, 4);
  });
});

describe("runIdleHoldCanary", () => {
  it("holds for the full idleHoldMs before destroying", async () => {
    const events: LedgerEvent[] = [];
    let clock = 0;
    const result = await runIdleHoldCanary({
      runtime: fakeRuntime(),
      ledger: (e) => events.push(e),
      namePrefix: "idle",
      runId: "run-6",
      limits: { maxSessions: 1 },
      idleHoldMs: 5,
      now: () => (clock += 1),
    });
    assert.equal(result.destroyed, true);
    assert.equal(result.verifiedGone, true);
    assert.ok(events.some((e) => e.event === "idle-hold-start"));
    assert.ok(events.some((e) => e.event === "idle-hold-end"));
    // idle-hold-start must precede idle-hold-end, and both bracket the sleep.
    const startIdx = events.findIndex((e) => e.event === "idle-hold-start");
    const endIdx = events.findIndex((e) => e.event === "idle-hold-end");
    assert.ok(startIdx < endIdx);
  });

  it("returns a correlation key (session id + timestamps) even though it cannot confirm cost", async () => {
    const result = await runIdleHoldCanary({
      runtime: fakeRuntime(),
      ledger: () => {},
      namePrefix: "idle",
      runId: "run-7",
      limits: { maxSessions: 1 },
      idleHoldMs: 1,
    });
    assert.equal(typeof result.sessionId, "string");
    assert.ok(result.sessionId.length > 0);
    assert.ok(result.releasedAt >= result.createdAt);
  });

  it("still reports the correlation key when destroy fails", async () => {
    const result = await runIdleHoldCanary({
      runtime: fakeRuntime({ destroy: async () => { throw new Error("stuck"); } }),
      ledger: () => {},
      namePrefix: "idle",
      runId: "run-8",
      limits: { maxSessions: 1 },
      idleHoldMs: 1,
    });
    assert.equal(result.destroyed, false);
    assert.equal(result.verifiedGone, false);
    assert.equal(typeof result.sessionId, "string");
  });
});
