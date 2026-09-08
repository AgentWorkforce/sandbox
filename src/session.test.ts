import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandbox, withSandbox, SandboxNotReadyError } from "./core/index.js";
import type { SandboxRuntime } from "./port.js";
import { createProviderSetup, type ProviderSetupStatus } from "./setup/index.js";

function fixture() {
  const calls: unknown[] = [];
  const runtime: SandboxRuntime = {
    id: "test",
    async findByLabels() { return null; },
    async findAllByLabels() { return []; },
    async countByLabels() { return 0; },
    async uploadBundle() {},
    async launch(options) { calls.push(["launch", options]); return { id: "provider-id" }; },
    async runScript(handle, options) { calls.push(["run", handle.id, options]); return { output: "hello", exitCode: 0 }; },
    async destroy(handle) { calls.push(["destroy", handle.id]); },
  };
  return { runtime, calls };
}

test("quickstart launches, runs and cleans up the same provider sandbox with caller options", async () => {
  const { runtime, calls } = fixture();
  const result = await withSandbox({ runtime, launch: { name: "hello" } }, async (sandbox) => {
    assert.equal(sandbox.id, "provider-id");
    return sandbox.run("echo hello", { timeoutMs: 1000 });
  });
  assert.deepEqual(result, { output: "hello", exitCode: 0 });
  assert.deepEqual(calls, [
    ["launch", { name: "hello" }],
    ["run", "provider-id", { command: "echo hello", timeoutMs: 1000 }],
    ["destroy", "provider-id"],
  ]);
});

test("workload exceptions still clean up and preserve the original exception", async () => {
  const { runtime, calls } = fixture();
  const failure = new Error("work failed");
  await assert.rejects(withSandbox({ runtime }, async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(calls.at(-1), ["destroy", "provider-id"]);
});

test("workload plus cleanup failure preserves both errors", async () => {
  const { runtime } = fixture();
  const work = new Error("work failed");
  const cleanup = new Error("cleanup failed");
  runtime.destroy = async () => { throw cleanup; };
  await assert.rejects(withSandbox({ runtime }, async () => { throw work; }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [work, cleanup]);
    return true;
  });
});

test("successful work does not hide failed cleanup", async () => {
  const { runtime } = fixture();
  const cleanup = new Error("cleanup failed");
  runtime.destroy = async () => { throw cleanup; };
  await assert.rejects(withSandbox({ runtime }, async () => "done"), (error) => error === cleanup);
});

test("an unknown launch outcome is not retried or guessed at for cleanup", async () => {
  const { runtime, calls } = fixture();
  const failure = new Error("launch outcome unknown");
  runtime.launch = async () => { calls.push("launch"); throw failure; };
  await assert.rejects(withSandbox({ runtime }, async () => "unreachable"), (error) => error === failure);
  assert.deepEqual(calls, ["launch"]);
});

test("concurrent destroy calls share cleanup; failed cleanup is retryable without allowing more commands", async () => {
  const { runtime } = fixture();
  let attempts = 0;
  runtime.destroy = async () => { if (++attempts === 1) throw new Error("try again"); };
  const sandbox = await createSandbox({ runtime });
  const first = sandbox.destroy();
  assert.equal(sandbox.destroy(), first);
  await assert.rejects(first, /try again/);
  await assert.rejects(sandbox.run("echo late"), /closing or destroyed/);
  await sandbox.destroy();
  await sandbox.destroy();
  assert.equal(attempts, 2);
});

test("setup readiness gates allocation without initiating prewarm; withdrawal never blocks cleanup", async () => {
  const { runtime, calls } = fixture();
  let status: ProviderSetupStatus = { status: "approval-required" };
  let prewarms = 0;
  const port = createProviderSetup({
    async prewarm() { prewarms += 1; return status; },
    async status() { return status; },
  });
  const options = { runtime, readiness: { providerId: "e2b", port } };
  await assert.rejects(createSandbox(options), SandboxNotReadyError);
  assert.deepEqual(calls, []);
  status = { status: "ready" };
  const sandbox = await createSandbox(options);
  status = { status: "unavailable" };
  await assert.rejects(createSandbox(options), SandboxNotReadyError);
  await sandbox.destroy();
  assert.deepEqual(calls, [["launch", undefined], ["destroy", "provider-id"]]);
  assert.equal(prewarms, 0);
});

test("malformed or throwing readiness cannot launch or leak backend errors", async () => {
  const { runtime, calls } = fixture();
  for (const read of [
    async () => ({ secret: "private-value" }) as unknown as boolean,
    async (): Promise<boolean> => { throw new Error("private-value"); },
  ]) {
    await assert.rejects(createSandbox({ runtime, readiness: { providerId: "e2b", port: { hasAvailableCredentials: read } } }),
      (error: unknown) => {
        assert.ok(error instanceof SandboxNotReadyError);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private-value/);
        return true;
      });
  }
  assert.deepEqual(calls, []);
});
