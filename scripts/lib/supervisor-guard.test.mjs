import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireSupervisorLease,
  createBoundedCoalescer,
  createRestartPolicy,
  circuitOpenExitCode,
  parseResidentSetBytes,
  resourceCeilingDecision,
} from "./supervisor-guard.mjs";

function paths() {
  const root = mkdtempSync(join(tmpdir(), "chief-supervisor-guard-"));
  return { lockDir: join(root, "lock"), checkpointDir: join(root, "checkpoints") };
}

test("a live fenced lease admits exactly one supervisor", () => {
  const location = paths();
  const first = acquireSupervisorLease({
    ...location,
    owner: "first",
    pid: 101,
    nowMs: 1_000,
    token: "fence-1",
    isProcessAlive: (pid) => pid === 101,
  });
  assert.throws(
    () => acquireSupervisorLease({
      ...location,
      owner: "second",
      pid: 202,
      nowMs: 5_000,
      token: "fence-2",
      isProcessAlive: (pid) => pid === 101,
    }),
    /held by first/u,
  );
  assert.equal(first.release(), true);
});

test("a deterministic supervisor storm elects one owner", () => {
  const location = paths();
  let winners = 0;
  let rejected = 0;
  for (let contender = 0; contender < 100; contender += 1) {
    try {
      acquireSupervisorLease({
        ...location,
        owner: `contender-${contender}`,
        pid: 1_000 + contender,
        nowMs: 10_000,
        token: `fence-${contender}`,
        isProcessAlive: () => true,
      });
      winners += 1;
    } catch (error) {
      assert.match(error.message, /lease is held/u);
      rejected += 1;
    }
  }
  assert.deepEqual({ winners, rejected }, { winners: 1, rejected: 99 });
});

test("a recycled pid with an expired lease is treated as stale, not live", () => {
  const location = paths();
  acquireSupervisorLease({
    ...location,
    owner: "first",
    pid: 101,
    nowMs: 1_000,
    ttlMs: 100,
    token: "fence-1",
    isProcessAlive: () => true,
  });
  // "isProcessAlive" returns true here to simulate an OS recycling pid 101
  // for an unrelated process after a reboot. Without the expiresAt fallback
  // this would throw "held by first" forever.
  const second = acquireSupervisorLease({
    ...location,
    owner: "second",
    pid: 202,
    nowMs: 5_000,
    ttlMs: 100,
    token: "fence-2",
    isProcessAlive: () => true,
  });
  assert.equal(second.release(), true);
});

test("a lease with a live pid and unexpired ttl still blocks takeover", () => {
  const location = paths();
  acquireSupervisorLease({
    ...location,
    owner: "first",
    pid: 101,
    nowMs: 1_000,
    ttlMs: 90_000,
    token: "fence-1",
    isProcessAlive: () => true,
  });
  assert.throws(
    () => acquireSupervisorLease({
      ...location,
      owner: "second",
      pid: 202,
      nowMs: 5_000,
      ttlMs: 90_000,
      token: "fence-2",
      isProcessAlive: () => true,
    }),
    /held by first/u,
  );
});

test("genuine lease contention is tagged so callers can distinguish it from real faults", () => {
  const location = paths();
  acquireSupervisorLease({
    ...location,
    owner: "first",
    pid: 101,
    nowMs: 1_000,
    token: "fence-1",
    isProcessAlive: () => true,
  });
  assert.throws(
    () => acquireSupervisorLease({
      ...location,
      owner: "second",
      pid: 202,
      nowMs: 5_000,
      token: "fence-2",
      isProcessAlive: () => true,
    }),
    (error) => error.code === "LEASE_CONTENDED",
  );
});

test("an unreadable lease file surfaces as an uncoded fault, not benign contention", () => {
  const location = paths();
  acquireSupervisorLease({
    ...location,
    owner: "first",
    pid: 101,
    nowMs: 1_000,
    token: "fence-1",
    isProcessAlive: () => true,
  });
  writeFileSync(join(location.lockDir, "lease.json"), "{not-json", "utf8");
  assert.throws(
    () => acquireSupervisorLease({
      ...location,
      owner: "second",
      pid: 202,
      nowMs: 100_000,
      token: "fence-2",
      isProcessAlive: () => true,
    }),
    (error) => error.code !== "LEASE_CONTENDED" && /unreadable/u.test(error.message),
  );
});

test("a takeover race on the dead-lease checkpoint throws a clean, coded error", () => {
  const location = paths();
  acquireSupervisorLease({
    ...location,
    owner: "first",
    pid: 101,
    nowMs: 1_000,
    ttlMs: 100,
    token: "fence-1",
  });
  // Occupy the exact checkpoint path this contender is about to rename the
  // dead lease onto, as if another contender's checkpoint got there first.
  // A non-empty destination makes renameSync fail with ENOTEMPTY, the real
  // fs error this scenario produces.
  const occupiedCheckpoint = join(location.checkpointDir, "5000-fence-1");
  mkdirSync(occupiedCheckpoint, { recursive: true });
  writeFileSync(join(occupiedCheckpoint, "occupied"), "x");
  assert.throws(
    () => acquireSupervisorLease({
      ...location,
      owner: "second",
      pid: 202,
      nowMs: 5_000,
      ttlMs: 100,
      token: "fence-2",
    }),
    (error) => error.code === "LEASE_CONTENDED" && /raced with another contender/u.test(error.message),
  );
});

test("replacement checkpoints a dead lease before taking ownership", () => {
  const location = paths();
  const first = acquireSupervisorLease({
    ...location,
    owner: "first",
    pid: 101,
    nowMs: 1_000,
    ttlMs: 100,
    token: "fence-1",
  });
  const second = acquireSupervisorLease({
    ...location,
    owner: "second",
    pid: 202,
    nowMs: 2_000,
    ttlMs: 100,
    token: "fence-2",
  });
  assert.equal(first.release(), false, "stale owner cannot delete its replacement");
  assert.equal(second.release(), true);
  const checkpoint = JSON.parse(readFileSync(
    join(location.checkpointDir, "2000-fence-1", "lease.json"),
    "utf8",
  ));
  assert.equal(checkpoint.token, "fence-1");
});

test("restart policy is exponential, capped, jittered, then opens", () => {
  const policy = createRestartPolicy({
    baseMs: 100,
    maxMs: 250,
    maxFailures: 4,
    windowMs: 10_000,
    jitterRatio: 0.1,
    random: () => 1,
  });
  assert.deepEqual(policy.recordFailure(0), { action: "restart", failures: 1, delayMs: 110 });
  assert.deepEqual(policy.recordFailure(1), { action: "restart", failures: 2, delayMs: 220 });
  assert.deepEqual(policy.recordFailure(2), { action: "restart", failures: 3, delayMs: 250 });
  const open = policy.recordFailure(3);
  assert.deepEqual(open, { action: "open", failures: 4 });
  assert.equal(circuitOpenExitCode(open), 0, "circuit-open is a deliberate clean exit");
  assert.equal(circuitOpenExitCode({ action: "restart" }), null);
});

test("healthy interval resets the circuit history", () => {
  const policy = createRestartPolicy({ baseMs: 100, maxFailures: 2, jitterRatio: 0 });
  assert.equal(policy.recordFailure(0).action, "restart");
  policy.recordHealthy();
  assert.equal(policy.recordFailure(1).action, "restart");
});

test("duplicate subscriptions coalesce and distinct work stays bounded", async () => {
  const coalescer = createBoundedCoalescer({ maxPending: 1 });
  let calls = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = coalescer.run("refresh", async () => { calls += 1; await held; return 7; });
  const duplicate = coalescer.run("refresh", async () => { calls += 1; return 8; });
  assert.equal(first, duplicate);
  assert.throws(() => coalescer.run("restart", async () => 9), /queue ceiling/u);
  release();
  assert.equal(await first, 7);
  assert.equal(calls, 1);
  assert.equal(coalescer.size, 0);
});

test("a 2,000-event subscription storm executes once", async () => {
  const coalescer = createBoundedCoalescer({ maxPending: 2 });
  let calls = 0;
  const promises = Array.from({ length: 2_000 }, () =>
    coalescer.run("websocket-refresh", async () => {
      calls += 1;
      await Promise.resolve();
      return "ok";
    }));
  assert.deepEqual(await Promise.all(promises), Array(2_000).fill("ok"));
  assert.equal(calls, 1);
});

test("resident memory telemetry parses ps output without guessing", () => {
  assert.equal(parseResidentSetBytes("  2048\n"), 2 * 1024 * 1024);
  assert.equal(parseResidentSetBytes("not-a-number"), null);
  assert.equal(resourceCeilingDecision(1024, 1024), "within-ceiling");
  assert.equal(resourceCeilingDecision(1025, 1024), "terminate");
  assert.equal(resourceCeilingDecision(null, 1024), "unknown");
});
