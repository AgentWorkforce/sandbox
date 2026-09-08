import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { createProviderSetup, ProviderSetupError, type ProviderSetupStatus } from "./index.js";

test("setup is explicit, while status/readiness only read current scoped state", async () => {
  const calls: unknown[] = [];
  let current: ProviderSetupStatus = { status: "approval-required" };
  const setup = createProviderSetup({
    async prewarm(provider, options) { calls.push(["prewarm", provider, options]); return current; },
    async status(provider) { calls.push(["status", provider]); return current; },
  });
  assert.deepEqual(calls, []);
  assert.equal(await setup.hasAvailableCredentials("e2b"), false);
  assert.deepEqual(calls, [["status", "e2b"]]);
  assert.deepEqual(await setup.prewarm("e2b", { idempotencyKey: "request-1" }), current);
  assert.deepEqual(calls[1], ["prewarm", "e2b", { idempotencyKey: "request-1" }]);
  current = { status: "warming", retryAfterMs: 1000 };
  assert.deepEqual(await setup.status("e2b"), current);
  assert.equal(await setup.hasAvailableCredentials("e2b"), false);
  current = { status: "ready" };
  assert.equal(await setup.hasAvailableCredentials("e2b"), true);
  current = { status: "unavailable" };
  assert.equal(await setup.hasAvailableCredentials("e2b"), false);
  for (const required of ["action-required", "review-required"] as const) {
    current = { status: required };
    assert.deepEqual(await setup.status("e2b"), current);
    assert.equal(await setup.hasAvailableCredentials("e2b"), false);
  }
  assert.equal(calls.filter((call) => (call as string[])[0] === "prewarm").length, 1);
});

test("separate tenant backends and provider IDs cannot share cached readiness", async () => {
  const first = createProviderSetup({
    async prewarm() { return { status: "unavailable" }; },
    async status(provider) { return { status: provider === "e2b" ? "ready" : "unavailable" }; },
  });
  const second = createProviderSetup({
    async prewarm() { return { status: "unavailable" }; },
    async status() { return { status: "unavailable" }; },
  });
  assert.equal(await first.hasAvailableCredentials("e2b"), true);
  assert.equal(await first.hasAvailableCredentials("daytona"), false);
  assert.equal(await second.hasAvailableCredentials("e2b"), false);
});

for (const operation of ["prewarm", "status", "hasAvailableCredentials"] as const) {
  test(`${operation} rejects malformed or sensitive backend results without exposing them`, async () => {
    const invalid: unknown[] = [
      null, true, [], "ready", { status: "complete" },
      { status: "ready", secret: "private-value" },
      { status: "ready", api_key: "private-value" },
      { status: "ready", [Symbol("private-value")]: true },
      { status: "warming" }, { status: "warming", retryAfterMs: 0 },
      { status: "warming", retryAfterMs: Infinity }, { status: "warming", retryAfterMs: 60_001 },
      { status: "warming", retryAfterMs: 1000, accountId: "private-value" },
    ];
    for (const value of invalid) {
      const setup = createProviderSetup({
        async prewarm() { return value as ProviderSetupStatus; },
        async status() { return value as ProviderSetupStatus; },
      });
      await assert.rejects(setup[operation]("e2b", { idempotencyKey: "request-1" }), (error: unknown) => {
        assert.ok(error instanceof ProviderSetupError);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(inspect(error, { showHidden: true, depth: 10 }), /private-value/);
        return true;
      });
    }
  });
}

test("backend failure is sanitized and an uncertain setup mutation is never retried", async () => {
  let calls = 0;
  const fail = async (): Promise<ProviderSetupStatus> => {
    calls += 1;
    throw new Error("secret=private-value");
  };
  const setup = createProviderSetup({ prewarm: fail, status: fail });
  await assert.rejects(setup.prewarm("e2b", { idempotencyKey: "request-1" }), (error: unknown) => {
    assert.ok(error instanceof ProviderSetupError);
    assert.doesNotMatch(inspect(error, { showHidden: true, depth: 10 }), /private-value/);
    return true;
  });
  assert.equal(calls, 1);
});

test("invalid setup identifiers are rejected before touching the backend", async () => {
  let calls = 0;
  const read = async (): Promise<ProviderSetupStatus> => { calls += 1; return { status: "ready" }; };
  const setup = createProviderSetup({ prewarm: read, status: read });
  for (const value of ["", " ", "provider\nsecret", "x".repeat(129)]) {
    await assert.rejects(setup.prewarm(value, { idempotencyKey: "request-1" }), TypeError);
    await assert.rejects(setup.prewarm("e2b", { idempotencyKey: value }), TypeError);
    await assert.rejects(setup.status(value), TypeError);
  }
  assert.equal(calls, 0);
});

test("normalized status snapshots the validated value rather than re-reading a backend getter", async () => {
  let reads = 0;
  const value = { status: "warming", get retryAfterMs() { return ++reads === 1 ? 1000 : "private-value"; } };
  const read = async () => value as ProviderSetupStatus;
  const setup = createProviderSetup({ prewarm: read, status: read });
  assert.deepEqual(await setup.status("e2b"), { status: "warming", retryAfterMs: 1000 });
  assert.equal(reads, 1);
});
