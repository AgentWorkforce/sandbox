import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { BoxdRuntime, resolveSandboxRuntimeCapabilities } from "../index.js";
import type { RuntimeHandle } from "../types.js";

// ---------------------------------------------------------------------------
// Live smoke test against real boxd.
//
// Skipped unless BOXD_LIVE_SMOKE=1 and BOXD_API_KEY are set. It creates ONE
// machine, runs the adapter's whole surface against it, and deletes it through
// the adapter's own destroy() as its last step. If a step fails, the machine
// is left in place for inspection; it carries the label
// `agent-relay-sandbox=<prefix>`, so `findAllByLabels` finds it again.
//
//   BOXD_LIVE_SMOKE=1 BOXD_API_KEY=... [BOXD_ORG=...] [BOXD_REGION=fra] \
//     [BOXD_LIVE_NAME_PREFIX=relay-sandbox-smoke] \
//     node --test --import tsx src/boxd/live.smoke.test.ts
//
// The key is read from `process.env` here and never printed or asserted on.
// ---------------------------------------------------------------------------

const enabled = process.env.BOXD_LIVE_SMOKE === "1";
const apiKey = process.env.BOXD_API_KEY ?? "";
const org = process.env.BOXD_ORG || undefined;
const region = process.env.BOXD_REGION || "fra";
const namePrefix = process.env.BOXD_LIVE_NAME_PREFIX || "relay-sandbox-smoke";

const skip = !enabled
  ? "BOXD_LIVE_SMOKE is not 1"
  : !apiKey
    ? "BOXD_API_KEY is not set"
    : false;

function runtime(overrides: { apiKey?: string } = {}): BoxdRuntime {
  return new BoxdRuntime({
    apiKey: overrides.apiKey ?? apiKey,
    ...(org ? { org } : {}),
    region,
    namePrefix,
    size: { vcpu: 2, memory: "8G" },
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  return work().finally(() => {
    process.stderr.write(`# boxd live: ${label} ${Date.now() - started}ms\n`);
  });
}

describe("boxd live smoke", { skip }, () => {
  const lane = `smoke-${Date.now().toString(36)}`;
  const primary = runtime();
  let handle: RuntimeHandle;

  it("launches an isolated machine that runs commands", async () => {
    handle = await timed("launch to first command", () =>
      primary.launch({ labels: { lane }, env: { SMOKE_LAUNCH_ENV: "from launch" } }));
    process.stderr.write(`# boxd live: machine ${handle.id}\n`);
    assert.equal(handle.state, "STARTED");
    const first = await timed("first exec", () => primary.exec(handle, "echo ready"));
    assert.equal(first.output.trim(), "ready");
  });

  it("returns real exit codes, separate streams, env and cwd", async () => {
    const result = await primary.runScript(handle, {
      command: "echo out; echo err >&2; echo \"$SMOKE_LAUNCH_ENV|$SMOKE_EXEC_ENV\"; pwd; exit 7",
      env: { SMOKE_EXEC_ENV: "it's per exec" },
      cwd: "/tmp",
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, "out\nfrom launch|it's per exec\n/tmp\n");
    assert.equal(result.stderr, "err\n");
  });

  it("ends a command at its timeout", async () => {
    const started = Date.now();
    await assert.rejects(
      primary.runScript(handle, { command: "sleep 30; echo late", timeoutMs: 2_000 }),
      { name: "BoxdCommandTimeoutError" },
    );
    assert.ok(Date.now() - started < 20_000);
    const leftover = await primary.exec(handle, "pgrep -fx 'sleep 30' >/dev/null && echo alive || echo gone");
    assert.equal(leftover.output.trim(), "gone");
  });

  it("round-trips a 5 MiB file byte for byte", async () => {
    const bytes = randomBytes(5 * 1024 * 1024);
    await timed("upload 5 MiB", () =>
      primary.uploadFile(handle, bytes, "/home/boxd/smoke/nested/blob.bin"));
    const inMachine = await primary.exec(handle, "sha256sum /home/boxd/smoke/nested/blob.bin");
    assert.equal(inMachine.output.split(" ")[0], sha256(bytes));
    const back = await timed("download 5 MiB", () =>
      primary.downloadFile(handle, "/home/boxd/smoke/nested/blob.bin")) as Buffer;
    assert.equal(sha256(back), sha256(bytes));
    await assert.rejects(primary.downloadFile(handle, "/home/boxd/smoke/missing"), { code: "ENOENT" });
  });

  it("keeps a background process running between commands", async () => {
    await primary.exec(handle, "nohup sleep 600 >/dev/null 2>&1 & echo started");
    const check = await primary.exec(handle, "pgrep -fx 'sleep 600' >/dev/null && echo alive");
    assert.equal(check.output.trim(), "alive");
  });

  it("finds the machine by label and by id from a second runtime", async () => {
    const second = runtime();
    try {
      const found = await second.findAllByLabels({ lane });
      assert.deepEqual(found.map((h) => h.id), [handle.id]);
      assert.equal(await second.countByLabels({ lane }), 1);
      assert.equal(await second.findByLabels({ lane: `${lane}-none` }), null);
      const reattached = await second.getById(handle.id);
      assert.ok(reattached);
      const ran = await second.exec(reattached, "cat /proc/sys/kernel/hostname >/dev/null && echo ok");
      assert.equal(ran.output.trim(), "ok");
      assert.equal(resolveSandboxRuntimeCapabilities(second).warmLease, true);
    } finally {
      await second.close();
    }
  });

  it("stops, then starts on the next command with the disk intact", async () => {
    await primary.exec(handle, "echo kept > /home/boxd/smoke/marker");
    await timed("stop", () => primary.stop(handle));
    assert.equal(handle.state, "STOPPED");
    const after = await timed("exec on stopped machine", () =>
      primary.exec(handle, "cat /home/boxd/smoke/marker"));
    assert.equal(after.output.trim(), "kept");
    assert.equal(handle.state, "STARTED");
  });

  it("rejects a wrong API key with an authentication error", async () => {
    const wrong = runtime({ apiKey: "not-a-real-key-contract-probe" });
    try {
      await assert.rejects(wrong.countByLabels({ lane }), (error: Error) => {
        assert.match(error.name, /AuthenticationError|PermissionDeniedError/);
        return true;
      });
    } finally {
      await wrong.close();
    }
  });

  it("destroys the machine and verifies it is gone", async () => {
    const id = handle.id;
    await timed("destroy", () => primary.destroy(handle));
    assert.equal(await primary.getById(id), null);
    await primary.close();
  });
});
