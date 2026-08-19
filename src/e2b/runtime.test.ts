import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import * as pkg from "../index.js";
import {
  E2BSandboxRuntime,
  resolveSandboxRuntimeCapabilities,
} from "../index.js";
import type {
  E2BSandboxStatics,
  RuntimeHandle,
} from "../index.js";

const API_KEY = "test-api-key";
const TEMPLATE = "test-template";

describe("E2BSandboxRuntime public contract", () => {
  it("must-fire: exports the adapter and all truthful capabilities", () => {
    const { statics } = fakeStatics();
    const runtime = createRuntime(statics);

    assert.equal(pkg.E2BSandboxRuntime, E2BSandboxRuntime);
    assert.deepEqual(runtime.capabilities, {
      pty: false,
      snapshots: true,
      isolation: "strong",
      persistentHandle: true,
      streamingLogs: false,
    });
    assert.deepEqual(resolveSandboxRuntimeCapabilities(runtime), {
      asyncExec: true,
      reattach: true,
      detachedLaunch: false,
      warmLease: true,
      lifecycle: true,
    });
  });

  it("must-not-fire: does not advertise unsupported PTY, streaming, or detached launch", () => {
    const { statics } = fakeStatics();
    const runtime = createRuntime(statics);

    assert.equal(runtime.capabilities.pty, false);
    assert.equal(runtime.capabilities.streamingLogs, false);
    assert.equal("launchDetached" in runtime, false);
    assert.equal(resolveSandboxRuntimeCapabilities(runtime).detachedLaunch, false);
  });

  it("must-not-fire: rejects an empty provider-specific template before an SDK call", () => {
    const { statics, calls } = fakeStatics();

    assert.throws(
      () => new E2BSandboxRuntime({ apiKey: API_KEY, template: "  ", sandbox: statics }),
      /template is required/u,
    );
    assert.equal(calls.create.length, 0);
  });
});

describe("E2BSandboxRuntime launch and lookup", () => {
  it("must-fire: launches the requested template with labels, env, request timeout, and workdir", async () => {
    const sandbox = fakeSandbox({ id: "sbx-created" });
    const { statics, calls } = fakeStatics({ createSandbox: sandbox });
    const runtime = createRuntime(statics, { createTimeoutMs: 90_000 });

    const handle = await runtime.launch({
      label: "fallback-name",
      name: "  preferred-name  ",
      labels: { purpose: "test" },
      env: { AGENT_ID: "agent-1" },
      workdir: "/workspace/repo",
      createTimeoutSeconds: 12.5,
    });

    assert.deepEqual(handle, {
      id: "sbx-created",
      state: "STARTED",
      workdir: "/workspace/repo",
    });
    assert.deepEqual(calls.create, [{
      template: TEMPLATE,
      options: {
        apiKey: API_KEY,
        requestTimeoutMs: 12_500,
        metadata: { purpose: "test", name: "preferred-name" },
        envs: { AGENT_ID: "agent-1" },
      },
    }]);
    assert.equal("timeoutMs" in calls.create[0]!.options, false);
  });

  it("must-not-fire: omits empty metadata/env and never substitutes a provider default template", async () => {
    const { statics, calls } = fakeStatics();
    const runtime = createRuntime(statics, { createTimeoutMs: 77_000 });

    await runtime.launch({ labels: {}, env: {} });

    assert.deepEqual(calls.create, [{
      template: TEMPLATE,
      options: { apiKey: API_KEY, requestTimeoutMs: 77_000 },
    }]);
  });

  it("must-not-fire: propagates launch failures unchanged", async () => {
    const upstream = new Error("provider rejected create");
    const { statics } = fakeStatics({ createError: upstream });
    const runtime = createRuntime(statics);

    await assert.rejects(() => runtime.launch(), upstream);
  });

  it("must-fire: findByLabels uses the SDK metadata object, state filter, page size, and first eligible match", async () => {
    const pages = [[
      sandboxInfo("sbx-paused", "paused"),
      sandboxInfo("sbx-busy", "running"),
      sandboxInfo("sbx-selected", "running"),
    ], [sandboxInfo("sbx-must-not-read", "running")]];
    const { statics, calls } = fakeStatics({ pages });
    const runtime = createRuntime(statics);

    const handle = await runtime.findByLabels(
      { purpose: "worker", region: "test" },
      { excludeIds: ["sbx-busy"], limit: 3, owned: true, workdir: "/work" },
    );

    assert.deepEqual(handle, { id: "sbx-selected", state: "STARTED", workdir: "/work" });
    assert.deepEqual(calls.list, [{
      apiKey: API_KEY,
      limit: 3,
      query: {
        metadata: { purpose: "worker", region: "test" },
        state: ["running"],
      },
    }]);
    assert.equal(calls.nextItems, 1, "must stop before fetching a later page");
  });

  it("must-not-fire: an excluded first result cannot hide a valid result on the next page", async () => {
    const { statics, calls } = fakeStatics({
      pages: [
        [sandboxInfo("sbx-excluded", "running")],
        [sandboxInfo("sbx-next", "running")],
      ],
    });
    const runtime = createRuntime(statics);

    const handle = await runtime.findByLabels(
      { purpose: "worker" },
      { excludeIds: ["sbx-excluded"], limit: 1 },
    );

    assert.equal(handle?.id, "sbx-next");
    assert.equal(calls.nextItems, 2);
  });

  it("must-fire: findAll drains every page and treats limit as page size rather than total results", async () => {
    const startedAt = new Date("2026-08-20T00:00:00.000Z");
    const { statics, calls } = fakeStatics({
      pages: [
        [{ ...sandboxInfo("sbx-1", "running"), startedAt }],
        [sandboxInfo("sbx-2", "running")],
        [sandboxInfo("sbx-3", "running")],
      ],
    });
    const runtime = createRuntime(statics);

    const handles = await runtime.findAllByLabels({ purpose: "worker" }, { limit: 1 });

    assert.deepEqual(handles, [
      { id: "sbx-1", state: "STARTED", createdAt: startedAt.toISOString() },
      { id: "sbx-2", state: "STARTED" },
      { id: "sbx-3", state: "STARTED" },
    ]);
    assert.equal(calls.list[0]!.limit, 1);
    assert.equal(calls.nextItems, 3);
  });

  it("must-fire: null state lookup includes running and paused sandboxes without a state query", async () => {
    const { statics, calls } = fakeStatics({
      pages: [[sandboxInfo("sbx-running", "running"), sandboxInfo("sbx-paused", "paused")]],
    });
    const runtime = createRuntime(statics);

    const handles = await runtime.findAllByLabels({}, { states: null });

    assert.deepEqual(handles.map((handle) => handle.state), ["STARTED", "STOPPED"]);
    assert.deepEqual(calls.list, [{ apiKey: API_KEY, limit: 10 }]);
  });

  it("must-not-fire: unknown-only state filters return no matches without listing", async () => {
    const { statics, calls } = fakeStatics({ pages: [[sandboxInfo("sbx-1", "running")]] });
    const runtime = createRuntime(statics);

    assert.deepEqual(
      await runtime.findAllByLabels({ purpose: "worker" }, { states: ["BROKEN"] }),
      [],
    );
    assert.equal(calls.list.length, 0);
  });

  it("must-fire: countByLabels stops at maxCount while still filtering provider state", async () => {
    const { statics, calls } = fakeStatics({
      pages: [
        [sandboxInfo("sbx-paused", "paused"), sandboxInfo("sbx-1", "running")],
        [sandboxInfo("sbx-2", "running"), sandboxInfo("sbx-3", "running")],
        [sandboxInfo("sbx-must-not-read", "running")],
      ],
    });
    const runtime = createRuntime(statics);

    assert.equal(
      await runtime.countByLabels({ purpose: "worker" }, { maxCount: 2, pageSize: 4 }),
      2,
    );
    assert.equal(calls.nextItems, 2);
    assert.equal(calls.list[0]!.limit, 4);
  });

  it("must-not-fire: countByLabels maxCount zero performs no provider request", async () => {
    const { statics, calls } = fakeStatics();
    const runtime = createRuntime(statics);

    assert.equal(await runtime.countByLabels({}, { maxCount: 0 }), 0);
    assert.equal(calls.list.length, 0);
  });

  it("must-fire: lookup deadline rejects a stalled page", async () => {
    const { statics } = fakeStatics({ stalledList: true });
    const runtime = createRuntime(statics);

    await assert.rejects(
      () => runtime.findAllByLabels({ purpose: "worker" }, { timeoutMs: 10 }),
      /lookup exceeded 10ms while listing matching E2B sandboxes/u,
    );
  });

  it("must-fire: getById inspects state without connecting or resuming a paused sandbox", async () => {
    const { statics, calls } = fakeStatics({
      infos: new Map([["sbx-paused", sandboxInfo("sbx-paused", "paused")]]),
    });
    const runtime = createRuntime(statics);

    const handle = await runtime.getById("sbx-paused", {
      states: ["STOPPED"],
      owned: true,
      homeDir: "/home/e2b",
      workdir: "/workspace",
    });

    assert.deepEqual(handle, {
      id: "sbx-paused",
      state: "STOPPED",
      homeDir: "/home/e2b",
      workdir: "/workspace",
    });
    assert.deepEqual(calls.getInfo, ["sbx-paused"]);
    assert.deepEqual(calls.connect, []);
  });

  it("must-not-fire: getById filters mismatched state and only converts actual not-found errors to null", async () => {
    const upstream = new Error("rate limited");
    const { statics, calls } = fakeStatics({
      infos: new Map([["sbx-paused", sandboxInfo("sbx-paused", "paused")]]),
      getInfoErrors: new Map([
        ["sbx-gone", Object.assign(new Error("not found"), { name: "SandboxNotFoundError" })],
        ["sbx-error", upstream],
      ]),
    });
    const runtime = createRuntime(statics);

    assert.equal(await runtime.getById("sbx-paused", { states: ["STARTED"] }), null);
    assert.equal(await runtime.getById("sbx-gone"), null);
    await assert.rejects(() => runtime.getById("sbx-error"), upstream);
    assert.deepEqual(calls.connect, []);
  });
});

describe("E2BSandboxRuntime command execution", () => {
  it("must-fire: exec/runScript pass cwd, env, and command timeout and merge both output streams", async () => {
    const sandbox = fakeSandbox({
      id: "sbx-run",
      run: async () => ({ exitCode: 0, stdout: "out", stderr: "err" }),
    });
    const { statics } = fakeStatics({ createSandbox: sandbox });
    const runtime = createRuntime(statics);
    const handle = await runtime.launch();

    const result = await runtime.exec(handle, "node runner.mjs", {
      cwd: "/workspace",
      env: { MODE: "test" },
      timeoutMs: 1_234,
    });

    assert.deepEqual(result, { output: "out\nerr", exitCode: 0 });
    assert.deepEqual(sandbox.calls.run[0], {
      command: "node runner.mjs",
      options: { cwd: "/workspace", timeoutMs: 1_234, envs: { MODE: "test" } },
    });
  });

  it("must-fire: normalizes an E2B non-zero command exception into a result", async () => {
    const commandError = Object.assign(new Error("command failed"), {
      exitCode: 17,
      stdout: "before",
      stderr: "after",
    });
    const sandbox = fakeSandbox({ id: "sbx-fail", run: async () => { throw commandError; } });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    assert.deepEqual(await runtime.runScript(handle, { command: "false" }), {
      output: "before\nafter",
      stdout: "before",
      stderr: "after",
      exitCode: 17,
    });
  });

  it("must-not-fire: does not disguise transport/auth failures as command exits", async () => {
    const upstream = new Error("transport unavailable");
    const sandbox = fakeSandbox({ id: "sbx-error", run: async () => { throw upstream; } });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await assert.rejects(() => runtime.runScript(handle, { command: "true" }), upstream);
  });

  it("must-fire: reattaches a handle from another runtime before executing", async () => {
    const sandbox = fakeSandbox({ id: "sbx-existing" });
    const { statics, calls } = fakeStatics({
      connected: new Map([["sbx-existing", sandbox]]),
    });
    const runtime = createRuntime(statics);

    const result = await runtime.exec({ id: "sbx-existing" }, "true");

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.connect, ["sbx-existing"]);
  });

  it("must-not-fire: a missing handle raises a stable unavailable error", async () => {
    const missing = Object.assign(new Error("sandbox not found"), { statusCode: 404 });
    const { statics } = fakeStatics({ connectErrors: new Map([["sbx-gone", missing]]) });
    const runtime = createRuntime(statics);

    await assert.rejects(
      () => runtime.exec({ id: "sbx-gone" }, "true"),
      /is no longer available/u,
    );
  });
});

describe("E2BSandboxRuntime async execution", () => {
  it("must-fire: admits one background command with durable artifacts and separate request/lifetime budgets", async () => {
    const sandbox = fakeSandbox({
      id: "sbx-async",
      run: async (_command, options) => options?.background
        ? { pid: 4242 }
        : { exitCode: 0, stdout: "", stderr: "" },
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics, {
      runBudgetMs: 600_000,
    });
    const handle = await runtime.launch();

    const result = await runtime.startExec(handle, "node runner.mjs", {
      sessionId: "session/one",
      cwd: "/workspace",
      env: { MODE: "async" },
      timeoutMs: 2_500,
    });

    assert.deepEqual(result, { sessionId: "session/one", commandId: "4242" });
    assert.deepEqual(sandbox.calls.setTimeout, [600_000]);
    assert.equal(sandbox.calls.run.length, 2);
    const cleanup = sandbox.calls.run[0]!;
    const admission = sandbox.calls.run[1]!;
    assert.match(cleanup.command, /^rm -rf .* && mkdir -p /u);
    assert.equal(admission.options?.background, true);
    assert.equal(admission.options?.timeoutMs, 600_000);
    assert.equal(admission.options?.requestTimeoutMs, 2_500);
    assert.equal(admission.options?.cwd, "/workspace");
    assert.deepEqual(admission.options?.envs, { MODE: "async" });
    assert.match(admission.command, /admission\.tmp/u);
    assert.match(admission.command, /e2b_run_status/u);
    assert.match(admission.command, /exit "\$e2b_run_status"/u);
  });

  it("must-not-fire: failed stale-artifact cleanup prevents command admission", async () => {
    const sandbox = fakeSandbox({
      id: "sbx-cleanup-fail",
      run: async () => ({ exitCode: 3, stdout: "", stderr: "permission denied" }),
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await assert.rejects(
      () => runtime.startScript(handle, { command: "node runner.mjs", sessionId: "session-cleanup" }),
      /Failed to prepare E2B async session/u,
    );
    assert.equal(sandbox.calls.run.length, 1);
    assert.deepEqual(sandbox.calls.setTimeout, []);
  });

  it("must-fire: reconciles an outcome-unknown admission from the new durable marker without resubmitting", async () => {
    const admissionTimeout = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
    let backgroundCalls = 0;
    const sandbox = fakeSandbox({
      id: "sbx-reconcile",
      run: async (command, options) => {
        if (options?.background) {
          backgroundCalls += 1;
          throw admissionTimeout;
        }
        if (command.includes("/admission'")) {
          return { exitCode: 0, stdout: "8123\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    assert.deepEqual(
      await runtime.startScript(handle, { command: "node runner.mjs", sessionId: "session-reconcile" }),
      { sessionId: "session-reconcile", commandId: "8123", reconciled: true },
    );
    assert.equal(backgroundCalls, 1);
  });

  it("must-not-fire: preserves an explicit admission rejection and never probes a marker", async () => {
    const rejection = new Error("request validation failed");
    const sandbox = fakeSandbox({
      id: "sbx-rejected",
      run: async (_command, options) => {
        if (options?.background) throw rejection;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await assert.rejects(
      () => runtime.startScript(handle, { command: "node runner.mjs", sessionId: "session-rejected" }),
      rejection,
    );
    assert.equal(sandbox.calls.run.filter((call) => call.command.startsWith("tail -c")).length, 0);
    assert.equal(sandbox.calls.run.filter((call) => call.options?.background).length, 1);
  });

  it("must-not-fire: an unreadable reconciliation marker cannot manufacture a command id", async () => {
    const timeout = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    const sandbox = fakeSandbox({
      id: "sbx-unproven",
      run: async (command, options) => {
        if (options?.background) throw timeout;
        return {
          exitCode: 0,
          stdout: command.startsWith("tail -c") ? "not-a-pid" : "",
          stderr: "",
        };
      },
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await assert.rejects(
      () => runtime.startScript(handle, { command: "node runner.mjs", sessionId: "session-unproven" }),
      timeout,
    );
  });

  it("must-fire: status and logs read bounded durable files and preserve a terminal non-zero exit", async () => {
    const sandbox = fakeSandbox({
      id: "sbx-poll",
      run: async (command) => ({
        exitCode: 0,
        stdout: command.includes("/exit'") ? "23\n" : "last log lines",
        stderr: "",
      }),
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    assert.deepEqual(await runtime.getExecStatus(handle, "session-one", "900"), { exitCode: 23 });
    assert.deepEqual(await runtime.getScriptLogs(handle, "session-one", "900"), {
      output: "last log lines",
      exitCode: null,
      cmdId: "900",
    });
    assert.match(sandbox.calls.run[0]!.command, /^tail -c 64 /u);
    assert.match(sandbox.calls.run[1]!.command, /^tail -c 262144 /u);
  });

  it("must-not-fire: missing or malformed status content is never reported as success", async () => {
    const outputs = ["", "7 trailing", "999"];
    const sandbox = fakeSandbox({
      id: "sbx-pending",
      run: async () => ({ exitCode: 0, stdout: outputs.shift() ?? "", stderr: "" }),
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    assert.deepEqual(await runtime.getScriptStatus(handle, "pending", "1"), { exitCode: null });
    assert.deepEqual(await runtime.getScriptStatus(handle, "malformed", "2"), { exitCode: null });
    assert.deepEqual(await runtime.getScriptStatus(handle, "range", "3"), { exitCode: null });
  });

  it("must-not-fire: distinct session ids cannot collide on one durable path", async () => {
    const sandbox = fakeSandbox({ id: "sbx-paths" });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await runtime.getScriptStatus(handle, "a/b", "1");
    await runtime.getScriptStatus(handle, "a_b", "2");

    assert.notEqual(sandbox.calls.run[0]!.command, sandbox.calls.run[1]!.command);
  });
});

describe("E2BSandboxRuntime files and home directory", () => {
  it("must-fire: uploads exact Buffer bytes and reads them back as a Buffer", async () => {
    const sandbox = fakeSandbox({
      id: "sbx-files",
      readBytes: new Uint8Array([0, 255, 7]),
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();
    const backing = Buffer.from([99, 1, 2, 3, 88]);

    await runtime.uploadFile(handle, backing.subarray(1, 4), "/workspace/data.bin");
    const downloaded = await runtime.downloadFile(handle, "/workspace/data.bin");

    assert.deepEqual([...new Uint8Array(sandbox.calls.write[0]!.data)], [1, 2, 3]);
    assert.deepEqual(downloaded, Buffer.from([0, 255, 7]));
    assert.deepEqual(sandbox.calls.read, [{ path: "/workspace/data.bin", options: { format: "bytes" } }]);
  });

  it("must-not-fire: a string upload source is read locally and is not uploaded as the path text", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "e2b-upload-test-"));
    const sourcePath = join(tempDir, "source.txt");
    await writeFile(sourcePath, "file contents", "utf8");
    try {
      const sandbox = fakeSandbox({ id: "sbx-upload-path" });
      const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
      const handle = await runtime.launch();

      await runtime.uploadFile(handle, sourcePath, "/workspace/source.txt");

      assert.equal(Buffer.from(sandbox.calls.write[0]!.data).toString("utf8"), "file contents");
      assert.notEqual(Buffer.from(sandbox.calls.write[0]!.data).toString("utf8"), sourcePath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("must-fire: downloadFile writes bytes to a caller-provided local destination", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "e2b-download-test-"));
    const destination = join(tempDir, "download.bin");
    try {
      const sandbox = fakeSandbox({ id: "sbx-download", readBytes: new Uint8Array([4, 5, 6]) });
      const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
      const handle = await runtime.launch();

      assert.equal(await runtime.downloadFile(handle, "/remote.bin", destination), undefined);
      assert.deepEqual(await readFile(destination), Buffer.from([4, 5, 6]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("must-fire: uploadBundle writes files plus manifest and verifies every destination", async () => {
    const sandbox = fakeSandbox({ id: "sbx-bundle" });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await runtime.uploadBundle(handle, {
      files: [{ source: Buffer.from("runner"), destination: "/workspace/runner.mjs" }],
      manifest: { version: 1 },
      manifestPath: "/workspace/runtime/manifest.json",
    });

    assert.deepEqual(sandbox.calls.write.map((entry) => entry.path), [
      "/workspace/runner.mjs",
      "/workspace/runtime/manifest.json",
    ]);
    assert.equal(
      Buffer.from(sandbox.calls.write[1]!.data).toString("utf8"),
      '{\n  "version": 1\n}',
    );
    assert.match(
      sandbox.calls.run[0]!.command,
      /test -f '\/workspace\/runner\.mjs' && test -f '\/workspace\/runtime\/manifest\.json'/u,
    );
  });

  it("must-not-fire: uploadBundle neither verifies an empty bundle nor hides verification failure", async () => {
    const sandbox = fakeSandbox({
      id: "sbx-verify",
      run: async () => ({ exitCode: 1, stdout: "", stderr: "missing" }),
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await runtime.uploadBundle(handle, { files: [] });
    assert.equal(sandbox.calls.run.length, 0);

    await assert.rejects(
      () => runtime.uploadBundle(handle, {
        files: [{ source: Buffer.from("x"), destination: "/workspace/missing" }],
      }),
      /Failed to verify uploaded E2B bundle files/u,
    );
  });

  it("must-fire: resolves and memoizes the sandbox home directory", async () => {
    const sandbox = fakeSandbox({
      id: "sbx-home",
      run: async () => ({ exitCode: 0, stdout: "/home/e2b\n", stderr: "" }),
    });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    assert.equal(await runtime.getHomeDir(handle), "/home/e2b");
    assert.equal(await runtime.getHomeDir(handle), "/home/e2b");
    assert.equal(sandbox.calls.run.length, 1);
    assert.equal(handle.homeDir, "/home/e2b");
  });

  it("must-not-fire: empty home-directory output is not accepted as a usable path", async () => {
    const sandbox = fakeSandbox({ id: "sbx-no-home" });
    const runtime = createRuntime(fakeStatics({ createSandbox: sandbox }).statics);
    const handle = await runtime.launch();

    await assert.rejects(() => runtime.getHomeDir(handle), /Failed to resolve home directory/u);
  });
});

describe("E2BSandboxRuntime ownership and lifecycle", () => {
  it("must-fire: stops and starts an owned sandbox through pause/connect", async () => {
    const created = fakeSandbox({ id: "sbx-owned" });
    const resumed = fakeSandbox({ id: "sbx-owned" });
    const { statics, calls } = fakeStatics({
      createSandbox: created,
      connected: new Map([["sbx-owned", resumed]]),
    });
    const runtime = createRuntime(statics);
    const handle = await runtime.launch();

    await runtime.stop(handle);
    assert.equal(handle.state, "STOPPED");
    await assert.rejects(() => runtime.exec(handle, "true"), /is paused; call start/u);
    await runtime.start(handle);
    assert.equal(handle.state, "STARTED");
    assert.deepEqual(calls.pause, ["sbx-owned"]);
    assert.deepEqual(calls.connect, ["sbx-owned"]);
    assert.equal((await runtime.exec(handle, "true")).exitCode, 0);
    assert.equal(resumed.calls.run.length, 1);
  });

  it("must-not-fire: lifecycle methods never mutate a default non-owned attachment", async () => {
    const { statics, calls } = fakeStatics({
      infos: new Map([["sbx-attached", sandboxInfo("sbx-attached", "running")]]),
    });
    const runtime = createRuntime(statics);
    const handle = await runtime.getById("sbx-attached");
    assert.ok(handle);

    await runtime.stop(handle);
    await runtime.start(handle);
    await runtime.destroy(handle);

    assert.deepEqual(calls.pause, []);
    assert.deepEqual(calls.connect, []);
    assert.deepEqual(calls.kill, []);
  });

  it("must-fire: destroys an owned sandbox and retains ownership when kill fails so cleanup can retry", async () => {
    const upstream = new Error("kill transport failed");
    const { statics, calls } = fakeStatics({
      killErrors: [upstream],
      createSandbox: fakeSandbox({ id: "sbx-retry-kill" }),
    });
    const runtime = createRuntime(statics);
    const handle = await runtime.launch();

    await assert.rejects(() => runtime.destroy(handle), upstream);
    await runtime.destroy(handle);
    await runtime.destroy(handle);

    assert.deepEqual(calls.kill, ["sbx-retry-kill", "sbx-retry-kill"]);
  });

  it("must-not-fire: destroying an unknown handle never connects to or kills it", async () => {
    const { statics, calls } = fakeStatics();
    const runtime = createRuntime(statics);

    await runtime.destroy({ id: "sbx-unknown" });

    assert.deepEqual(calls.connect, []);
    assert.deepEqual(calls.kill, []);
  });
});

type FakeRunOptions = {
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
};

type FakeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function fakeSandbox(options: {
  id: string;
  run?: (
    command: string,
    runOptions?: FakeRunOptions,
  ) => Promise<FakeCommandResult | { pid: number }>;
  readBytes?: Uint8Array;
}) {
  const calls: {
    run: Array<{ command: string; options?: FakeRunOptions }>;
    write: Array<{ path: string; data: ArrayBuffer }>;
    read: Array<{ path: string; options: { format: "bytes" } }>;
    setTimeout: number[];
  } = {
    run: [],
    write: [],
    read: [],
    setTimeout: [],
  };
  return {
    sandboxId: options.id,
    calls,
    commands: {
      run: async (command: string, runOptions?: FakeRunOptions) => {
        calls.run.push({ command, ...(runOptions ? { options: runOptions } : {}) });
        if (options.run) {
          return options.run(command, runOptions);
        }
        return runOptions?.background
          ? { pid: 1001 }
          : { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    files: {
      write: async (path: string, data: ArrayBuffer) => {
        calls.write.push({ path, data });
        return {};
      },
      read: async (path: string, readOptions: { format: "bytes" }) => {
        calls.read.push({ path, options: readOptions });
        return options.readBytes ?? new Uint8Array();
      },
    },
    setTimeout: async (timeoutMs: number) => {
      calls.setTimeout.push(timeoutMs);
    },
  };
}

type FakeInfo = ReturnType<typeof sandboxInfo>;

function sandboxInfo(id: string, state: "running" | "paused") {
  return { sandboxId: id, state } as const;
}

function fakeStatics(options: {
  createSandbox?: ReturnType<typeof fakeSandbox>;
  createError?: Error;
  connected?: Map<string, ReturnType<typeof fakeSandbox>>;
  connectErrors?: Map<string, Error>;
  infos?: Map<string, FakeInfo>;
  getInfoErrors?: Map<string, Error>;
  pages?: FakeInfo[][];
  stalledList?: boolean;
  killErrors?: Error[];
} = {}) {
  const created = options.createSandbox ?? fakeSandbox({ id: "sbx-default" });
  const calls: {
    create: Array<{ template: string; options: Record<string, unknown> }>;
    connect: string[];
    getInfo: string[];
    list: Array<Record<string, unknown>>;
    nextItems: number;
    pause: string[];
    kill: string[];
  } = {
    create: [],
    connect: [],
    getInfo: [],
    list: [],
    nextItems: 0,
    pause: [],
    kill: [],
  };
  const killErrors = [...(options.killErrors ?? [])];
  const statics = {
    create: async (template: string, createOptions: Record<string, unknown> = {}) => {
      calls.create.push({ template, options: createOptions });
      if (options.createError) throw options.createError;
      return created;
    },
    connect: async (id: string) => {
      calls.connect.push(id);
      const error = options.connectErrors?.get(id);
      if (error) throw error;
      return options.connected?.get(id) ?? fakeSandbox({ id });
    },
    getInfo: async (id: string) => {
      calls.getInfo.push(id);
      const error = options.getInfoErrors?.get(id);
      if (error) throw error;
      return options.infos?.get(id) ?? sandboxInfo(id, "running");
    },
    list: (listOptions: Record<string, unknown>) => {
      calls.list.push(listOptions);
      let index = 0;
      const pages = options.pages ?? [];
      return {
        get hasNext() {
          return options.stalledList ? true : index < pages.length;
        },
        nextItems: async () => {
          calls.nextItems += 1;
          if (options.stalledList) {
            return new Promise<FakeInfo[]>(() => undefined);
          }
          return pages[index++] ?? [];
        },
      };
    },
    pause: async (id: string) => {
      calls.pause.push(id);
      return true;
    },
    kill: async (id: string) => {
      calls.kill.push(id);
      const error = killErrors.shift();
      if (error) throw error;
      return true;
    },
  };
  return { statics: statics as unknown as E2BSandboxStatics, calls };
}

function createRuntime(
  statics: E2BSandboxStatics,
  options: { runBudgetMs?: number; createTimeoutMs?: number } = {},
) {
  return new E2BSandboxRuntime({
    apiKey: API_KEY,
    template: TEMPLATE,
    sandbox: statics,
    ...options,
  });
}

// Compile-time contract guard: the E2B class must remain usable wherever the
// public handle type is expected, without a provider-specific handle subtype.
const _runtimeHandleContract: RuntimeHandle = { id: "compile-only" };
void _runtimeHandleContract;

type InstalledE2BStatics = typeof import("e2b").Sandbox;
const _installedSdkContract: InstalledE2BStatics extends E2BSandboxStatics ? true : false = true;
void _installedSdkContract;
