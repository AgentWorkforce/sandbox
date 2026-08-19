import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import * as pkg from "../index.js";
import {
  Agent37ApiError,
  Agent37Client,
  Agent37EnvValidationError,
  Agent37Runtime,
  isRetryableAgent37Code,
  resolveSandboxRuntimeCapabilities,
} from "../index.js";
import type { Agent37Instance, RuntimeHandle } from "../index.js";

// Both are required arguments precisely because neither has a correct default.
const TEST_BASE_URL = "https://control.example.invalid";
const TEST_HOME_DIR = "/home/sandbox";
// A synthetic fixture, deliberately not shaped like a real credential.
const TEST_KEY = "test-key-never-a-real-credential-0123456789";

// --- fake transport -------------------------------------------------------

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  hasSignal: boolean;
};

type ScriptedResponse = {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
};

type Harness = {
  fetch: pkg.Agent37Fetch;
  requests: RecordedRequest[];
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
};

function harness(
  responder: (request: RecordedRequest, index: number) => ScriptedResponse,
): Harness {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const fetchImpl: pkg.Agent37Fetch = async (url, init) => {
    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers ?? {}) },
      body: init?.body,
      hasSignal: init?.signal !== undefined,
    };
    requests.push(recorded);
    const scripted = responder(recorded, requests.length - 1);
    const status = scripted.status ?? 200;
    const text =
      scripted.text ?? (scripted.json === undefined ? "" : JSON.stringify(scripted.json));
    const bytes = scripted.bytes ?? new TextEncoder().encode(text);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
  return {
    fetch: fetchImpl,
    requests,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

function instanceObject(overrides: Partial<Agent37Instance> = {}): Agent37Instance {
  return {
    id: "ab12cd34ef",
    status: "running",
    url: "https://ab12cd34ef.instances.example.invalid",
    metadata: { purpose: "test-purpose", agentId: "agent-1" },
    created: 1781222400,
    ...overrides,
  };
}

function makeRuntime(h: Harness, overrides: Partial<pkg.Agent37RuntimeOptions> = {}) {
  return new Agent37Runtime({
    apiKey: TEST_KEY,
    baseUrl: TEST_BASE_URL,
    defaultHomeDir: TEST_HOME_DIR,
    fetch: h.fetch,
    sleep: h.sleep,
    ...overrides,
  });
}

const RUNNING_HANDLE: RuntimeHandle = { id: "ab12cd34ef", state: "STARTED" };

function bodyText(request: RecordedRequest): string {
  const body = request.body;
  if (body === undefined) {
    return "";
  }
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

function execCommand(request: RecordedRequest): string {
  const parsed = JSON.parse(bodyText(request)) as { command?: string };
  assert.equal(typeof parsed.command, "string", "exec body must carry a command");
  return parsed.command as string;
}

/** Recover the payload of `printf %s '<b64>' | base64 -d > '<path>'`. */
function decodeWrittenFile(command: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`printf %s '([A-Za-z0-9+/=]*)' \\| base64 -d > '${escaped}'`).exec(
    command,
  );
  assert.ok(match, `expected a base64 write of ${path} in:\n${command}`);
  return Buffer.from(match[1] as string, "base64").toString("utf8");
}

// --- barrel ---------------------------------------------------------------

describe("public barrel", () => {
  it("exports the Agent37 adapter surface as values", () => {
    assert.equal(typeof pkg.Agent37Runtime, "function");
    assert.equal(typeof pkg.Agent37Client, "function");
    assert.equal(typeof pkg.Agent37ApiError, "function");
    assert.equal(typeof pkg.Agent37EnvValidationError, "function");
    assert.equal(typeof pkg.isRetryableAgent37Code, "function");
  });
});

// --- capability declarations ---------------------------------------------

describe("Agent37Runtime capabilities", () => {
  it("declares async exec, reattach, warm lease, and lifecycle", () => {
    const runtime = makeRuntime(harness(() => ({ json: {} })));
    const capabilities = resolveSandboxRuntimeCapabilities(runtime);
    assert.equal(capabilities.asyncExec, true);
    assert.equal(capabilities.reattach, true);
    assert.equal(capabilities.warmLease, true);
    assert.equal(capabilities.lifecycle, true);
  });

  it("does NOT claim detached launch: create returns only once the instance is running", () => {
    const runtime = makeRuntime(harness(() => ({ json: {} })));
    assert.equal(
      (runtime as { launchDetached?: unknown }).launchDetached,
      undefined,
      "launchDetached must be absent, not a stub that pretends to detach",
    );
    assert.equal(resolveSandboxRuntimeCapabilities(runtime).detachedLaunch, false);
  });

  it("declares the bootstrap plane honestly: no pty, no snapshots, no streaming logs", () => {
    const runtime = makeRuntime(harness(() => ({ json: {} })));
    assert.deepEqual(runtime.capabilities, {
      pty: false,
      snapshots: false,
      isolation: "strong",
      persistentHandle: true,
      streamingLogs: false,
    });
  });
});

// --- configuration safety -------------------------------------------------

describe("Agent37Runtime configuration", () => {
  it("requires an explicit baseUrl, apiKey, and home directory", () => {
    assert.throws(
      () =>
        new Agent37Runtime({
          apiKey: TEST_KEY,
          baseUrl: "",
          defaultHomeDir: TEST_HOME_DIR,
          fetch: harness(() => ({ json: {} })).fetch,
        }),
      /baseUrl/,
    );
    assert.throws(
      () =>
        new Agent37Runtime({
          apiKey: "   ",
          baseUrl: TEST_BASE_URL,
          defaultHomeDir: TEST_HOME_DIR,
          fetch: harness(() => ({ json: {} })).fetch,
        }),
      /apiKey/,
    );
    assert.throws(
      () =>
        new Agent37Runtime({
          apiKey: TEST_KEY,
          baseUrl: TEST_BASE_URL,
          defaultHomeDir: "",
          fetch: harness(() => ({ json: {} })).fetch,
        }),
      /defaultHomeDir/,
    );
  });

  it("does NOT fall back to provider environment variables for key or endpoint", async () => {
    const previousKey = process.env.AGENT37_API_KEY;
    const previousUrl = process.env.AGENT37_API_URL;
    process.env.AGENT37_API_KEY = "env-key-FROM_ENV-must-not-be-used";
    process.env.AGENT37_API_URL = "https://from-env.example.invalid";
    try {
      assert.throws(
        () =>
          new Agent37Runtime({
            apiKey: "",
            baseUrl: "",
            defaultHomeDir: TEST_HOME_DIR,
          } as pkg.Agent37RuntimeOptions),
        /baseUrl|apiKey/,
      );
      const h = harness(() => ({ json: { data: [] } }));
      await makeRuntime(h).findAllByLabels({});
      assert.equal(h.requests.length, 1);
      assert.ok(
        (h.requests[0] as RecordedRequest).url.startsWith(TEST_BASE_URL),
        "requests must go to the injected baseUrl",
      );
      assert.ok(!(h.requests[0] as RecordedRequest).url.includes("from-env"));
      assert.ok(
        !JSON.stringify(h.requests[0]).includes("FROM_ENV"),
        "the environment key must never reach a request",
      );
    } finally {
      if (previousKey === undefined) delete process.env.AGENT37_API_KEY;
      else process.env.AGENT37_API_KEY = previousKey;
      if (previousUrl === undefined) delete process.env.AGENT37_API_URL;
      else process.env.AGENT37_API_URL = previousUrl;
    }
  });

  it("bakes no provider hostname into the adapter source", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["client.ts", "runtime.ts"]) {
      const source = await readFile(join(dir, file), "utf8");
      assert.ok(
        !/agent37\.(com|app)/i.test(source),
        `${file} must not hard-code a provider hostname; endpoints are injected`,
      );
    }
  });
});

// --- authentication planes ------------------------------------------------

describe("Agent37 authentication", () => {
  it("sends Bearer auth on the hosting plane and never the instance header", async () => {
    const h = harness(() => ({ json: { data: [] } }));
    await makeRuntime(h).findAllByLabels({});
    const request = h.requests[0] as RecordedRequest;
    assert.equal(request.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.equal(request.headers["X-Agent37-Key"], undefined);
  });

  it("sends the instance-key header on the instance plane and never Bearer", async () => {
    const h = harness((request) =>
      request.method === "GET" ? { json: instanceObject() } : { json: { name: "a.txt" } },
    );
    await makeRuntime(h).uploadFile(RUNNING_HANDLE, "hello", "/work/a.txt");
    const put = h.requests.find((r) => r.method === "PUT") as RecordedRequest;
    assert.equal(put.headers["X-Agent37-Key"], TEST_KEY);
    assert.equal(put.headers.Authorization, undefined);
  });

  it("never places the credential in a URL", async () => {
    const h = harness((request) =>
      request.method === "GET" && request.url.includes("/v1/instances/ab12cd34ef")
        ? { json: instanceObject() }
        : { json: { data: [], name: "a.txt" } },
    );
    const runtime = makeRuntime(h);
    await runtime.findAllByLabels({ purpose: "test-purpose" });
    await runtime.uploadFile(RUNNING_HANDLE, "hello", "/work/a.txt");
    assert.ok(h.requests.length >= 2);
    for (const request of h.requests) {
      assert.ok(!request.url.includes(TEST_KEY), `credential leaked into URL: ${request.url}`);
      assert.ok(!request.url.includes("sk_live_"));
    }
  });
});

// --- error mapping --------------------------------------------------------

describe("Agent37ApiError", () => {
  it("parses the hosting/agent object envelope", async () => {
    const h = harness(() => ({
      status: 403,
      json: { error: { code: "tier_limit", message: "shape exceeds plan" } },
    }));
    await assert.rejects(makeRuntime(h).findAllByLabels({}), (error: unknown) => {
      assert.ok(error instanceof Agent37ApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "tier_limit");
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it("parses the flat transport envelope", async () => {
    const h = harness(() => ({ status: 502, json: { error: "container_unavailable" } }));
    await assert.rejects(makeRuntime(h).findAllByLabels({}), (error: unknown) => {
      assert.ok(error instanceof Agent37ApiError);
      assert.equal(error.code, "container_unavailable");
      assert.equal(error.retryable, false, "a stopped container is not fixed by retrying");
      return true;
    });
  });

  it("synthesizes a non-retryable code for an unparseable body", async () => {
    const h = harness(() => ({ status: 500, text: "<html>gateway</html>" }));
    await assert.rejects(makeRuntime(h).findAllByLabels({}), (error: unknown) => {
      assert.ok(error instanceof Agent37ApiError);
      assert.equal(error.code, "http_500");
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it("never leaks the credential into the error message or stack", async () => {
    const h = harness(() => ({
      status: 401,
      json: { error: { code: "invalid_api_key", message: "revoked" } },
    }));
    await assert.rejects(makeRuntime(h).findAllByLabels({}), (error: unknown) => {
      assert.ok(error instanceof Agent37ApiError);
      assert.ok(!error.message.includes(TEST_KEY));
      assert.ok(!error.message.includes("sk_live_"));
      assert.ok(!String(error.stack ?? "").includes(TEST_KEY));
      return true;
    });
  });
});

// --- retry policy ---------------------------------------------------------

describe("Agent37 retry policy", () => {
  it("retries a documented transient code and returns the eventual success", async () => {
    const h = harness((_request, index) =>
      index === 0
        ? { status: 409, json: { error: { code: "try_again", message: "state conflict" } } }
        : { json: { data: [instanceObject()] } },
    );
    const handles = await makeRuntime(h).findAllByLabels({ purpose: "test-purpose" });
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.sleeps, [250]);
    assert.equal(handles.length, 1);
  });

  it("backs off exponentially and gives up after maxAttempts", async () => {
    const h = harness(() => ({ status: 503, json: { error: { code: "no_capacity" } } }));
    await assert.rejects(
      makeRuntime(h, { maxAttempts: 3 }).findAllByLabels({}),
      /no_capacity/,
    );
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.sleeps, [250, 500]);
  });

  it("does NOT retry a client error the caller must fix", async () => {
    const h = harness(() => ({
      status: 400,
      json: { error: { code: "validation_error", message: "bad field", param: "template" } },
    }));
    await assert.rejects(makeRuntime(h).findAllByLabels({}), /validation_error/);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it("does NOT retry provisioning_failed, which is also how exec reports its time cap", async () => {
    // Retrying here would run the caller's command a second time while the
    // first copy is still executing inside the instance.
    const h = harness(() => ({
      status: 502,
      json: { error: { code: "provisioning_failed", message: "command exceeded 280s" } },
    }));
    await assert.rejects(
      makeRuntime(h).runScript(RUNNING_HANDLE, { command: "sleep 600" }),
      /provisioning_failed/,
    );
    assert.equal(h.requests.length, 1);
    assert.equal(isRetryableAgent37Code("provisioning_failed"), false);
  });

  it("does NOT retry a thrown transport failure, whose outcome is unknown", async () => {
    let calls = 0;
    const fetchImpl: pkg.Agent37Fetch = async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    };
    const runtime = new Agent37Runtime({
      apiKey: TEST_KEY,
      baseUrl: TEST_BASE_URL,
      defaultHomeDir: TEST_HOME_DIR,
      fetch: fetchImpl,
      maxAttempts: 5,
    });
    await assert.rejects(
      runtime.runScript(RUNNING_HANDLE, { command: "deploy.sh" }),
      /ECONNRESET/,
    );
    assert.equal(calls, 1, "an unacknowledged POST must never be re-sent");
  });
});

// --- launch ---------------------------------------------------------------

describe("Agent37Runtime.launch", () => {
  it("creates an instance with template, shape, labels, env, and attribution", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    const runtime = makeRuntime(h, {
      template: "my-agent@2",
      resources: { cpu: 4, memory: 8, disk: 20 },
      type: "dedicated",
      user: "u_882",
      budget: { credit_micros: 1_000_000 },
      autoSleep: true,
      idleTimeoutSeconds: 600,
    });

    const handle = await runtime.launch({
      name: "issue-greeter",
      labels: { purpose: "test-purpose", agentId: "agent-1" },
      env: { SANDBOX_AGENT_ID: "agent-1" },
      createTimeoutSeconds: 120,
      workdir: "/work",
    });

    const request = h.requests[0] as RecordedRequest;
    assert.equal(request.method, "POST");
    assert.equal(request.url, `${TEST_BASE_URL}/v1/instances`);
    assert.deepEqual(JSON.parse(bodyText(request)), {
      template: "my-agent@2",
      resources: { cpu: 4, memory: 8, disk: 20 },
      type: "dedicated",
      budget: { credit_micros: 1_000_000 },
      auto_sleep: true,
      idle_timeout_seconds: 600,
      user: "u_882",
      name: "issue-greeter",
      metadata: { purpose: "test-purpose", agentId: "agent-1" },
      env: { SANDBOX_AGENT_ID: "agent-1" },
    });
    assert.equal(request.hasSignal, true, "createTimeoutSeconds must bound the create request");
    assert.deepEqual(handle, {
      id: "ab12cd34ef",
      state: "STARTED",
      createdAt: new Date(1781222400 * 1000).toISOString(),
      homeDir: TEST_HOME_DIR,
      workdir: "/work",
    });
  });

  it("omits template entirely when none is configured, substituting no default", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    await makeRuntime(h).launch();
    const body = JSON.parse(bodyText(h.requests[0] as RecordedRequest)) as Record<string, unknown>;
    assert.equal("template" in body, false);
    assert.equal("resources" in body, false);
    assert.equal("type" in body, false);
    assert.equal("budget" in body, false);
    assert.deepEqual(body, {});
  });

  it("rejects env the provider would reject, before any request is sent", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    const runtime = makeRuntime(h);
    await assert.rejects(
      runtime.launch({ env: { "bad-key": "SUPER_SECRET_VALUE" } }),
      (error: unknown) => {
        assert.ok(error instanceof Agent37EnvValidationError);
        assert.ok(
          !error.message.includes("SUPER_SECRET_VALUE"),
          "the value must not appear in the error",
        );
        return true;
      },
    );
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_v, index) => [`K${index}`, "v"]),
    );
    await assert.rejects(runtime.launch({ env: tooMany }), Agent37EnvValidationError);
    await assert.rejects(
      runtime.launch({ env: { LONG: "x".repeat(4097) } }),
      Agent37EnvValidationError,
    );
    assert.equal(h.requests.length, 0, "validation must short-circuit the round trip");
  });

  it("accepts env at the documented limits", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    const atLimit = Object.fromEntries(
      Array.from({ length: 32 }, (_v, index) => [`K${index}`, "x".repeat(4096)]),
    );
    await makeRuntime(h).launch({ env: atLimit });
    assert.equal(h.requests.length, 1);
  });
});

// --- discovery ------------------------------------------------------------

describe("Agent37Runtime label lookup", () => {
  const fleet: Agent37Instance[] = [
    instanceObject({ id: "aaaaaaaaaa", metadata: { purpose: "test-purpose", agentId: "a" } }),
    instanceObject({ id: "bbbbbbbbbb", metadata: { purpose: "other", agentId: "b" } }),
    instanceObject({ id: "cccccccccc", metadata: null, status: "running" }),
    instanceObject({
      id: "dddddddddd",
      status: "sleeping",
      metadata: { purpose: "test-purpose", agentId: "d" },
    }),
    instanceObject({ id: "eeeeeeeeee", metadata: { purpose: "test-purpose", agentId: "e" } }),
  ];

  it("matches on a metadata subset and defaults to running instances only", async () => {
    const h = harness(() => ({ json: { data: fleet } }));
    const handles = await makeRuntime(h).findAllByLabels({ purpose: "test-purpose" });
    assert.deepEqual(
      handles.map((handle) => handle.id),
      ["aaaaaaaaaa", "eeeeeeeeee"],
    );
    assert.equal((h.requests[0] as RecordedRequest).url, `${TEST_BASE_URL}/v1/instances`);
  });

  it("does NOT match an instance missing the label or carrying no metadata", async () => {
    const h = harness(() => ({ json: { data: fleet } }));
    const handles = await makeRuntime(h).findAllByLabels({
      purpose: "test-purpose",
      agentId: "a",
    });
    assert.deepEqual(
      handles.map((handle) => handle.id),
      ["aaaaaaaaaa"],
    );
    const none = await makeRuntime(h).findAllByLabels({ purpose: "absent" });
    assert.deepEqual(none, []);
  });

  it("includes non-running instances only when the caller clears the state filter", async () => {
    const h = harness(() => ({ json: { data: fleet } }));
    const handles = await makeRuntime(h).findAllByLabels(
      { purpose: "test-purpose" },
      { states: null },
    );
    assert.deepEqual(
      handles.map((handle) => handle.id),
      ["aaaaaaaaaa", "dddddddddd", "eeeeeeeeee"],
    );
    assert.equal(handles[1]?.state, "STOPPED", "a sleeping instance is not STARTED");
  });

  it("honours limit and excludeIds", async () => {
    const h = harness(() => ({ json: { data: fleet } }));
    const runtime = makeRuntime(h);
    const limited = await runtime.findAllByLabels({ purpose: "test-purpose" }, { limit: 1 });
    assert.deepEqual(
      limited.map((handle) => handle.id),
      ["aaaaaaaaaa"],
    );
    const skipped = await runtime.findByLabels(
      { purpose: "test-purpose" },
      { excludeIds: ["aaaaaaaaaa"] },
    );
    assert.equal(skipped?.id, "eeeeeeeeee");
  });

  it("counts matches and stops at maxCount", async () => {
    const h = harness(() => ({ json: { data: fleet } }));
    const runtime = makeRuntime(h);
    assert.equal(await runtime.countByLabels({ purpose: "test-purpose" }), 2);
    assert.equal(await runtime.countByLabels({ purpose: "test-purpose" }, { maxCount: 1 }), 1);
    assert.equal(await runtime.countByLabels({ purpose: "test-purpose" }, { maxCount: 0 }), 0);
  });

  it("does NOT issue a request when maxCount is zero", async () => {
    const h = harness(() => ({ json: { data: fleet } }));
    await makeRuntime(h).countByLabels({ purpose: "x" }, { maxCount: 0 });
    assert.equal(h.requests.length, 0);
  });

  it("tolerates a response with no data array", async () => {
    const h = harness(() => ({ json: {} }));
    assert.deepEqual(await makeRuntime(h).findAllByLabels({}), []);
  });
});

describe("Agent37Runtime.getById", () => {
  it("resolves an instance in any state by default, for reattach", async () => {
    const h = harness(() => ({ json: instanceObject({ status: "stopped" }) }));
    const handle = await makeRuntime(h).getById("ab12cd34ef");
    assert.equal(handle?.id, "ab12cd34ef");
    assert.equal(handle?.state, "STOPPED");
    assert.equal(
      (h.requests[0] as RecordedRequest).url,
      `${TEST_BASE_URL}/v1/instances/ab12cd34ef`,
    );
  });

  it("returns null rather than throwing on a 404", async () => {
    const h = harness(() => ({ status: 404, json: { error: { code: "not_found" } } }));
    assert.equal(await makeRuntime(h).getById("ab12cd34ef"), null);
  });

  it("does NOT swallow a non-404 failure", async () => {
    const h = harness(() => ({ status: 403, json: { error: { code: "ip_not_allowed" } } }));
    await assert.rejects(makeRuntime(h).getById("ab12cd34ef"), /ip_not_allowed/);
  });

  it("applies an explicit state filter", async () => {
    const h = harness(() => ({ json: instanceObject({ status: "sleeping" }) }));
    assert.equal(await makeRuntime(h).getById("ab12cd34ef", { states: ["STARTED"] }), null);
  });
});

// --- synchronous execution ------------------------------------------------

describe("Agent37Runtime.runScript", () => {
  it("composes cwd and env into the script, because exec accepts neither", async () => {
    const h = harness(() => ({
      json: { exit_code: 0, stdout: "ok\n", stderr: "", truncated: false },
    }));
    const result = await makeRuntime(h).runScript(RUNNING_HANDLE, {
      command: "npm test",
      cwd: "/work/repo",
      env: { TOKEN_NAME: "it's fine" },
    });

    const request = h.requests[0] as RecordedRequest;
    assert.equal(request.url, `${TEST_BASE_URL}/v1/instances/ab12cd34ef/exec`);
    const parsed = JSON.parse(bodyText(request)) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed),
      ["command"],
      "exec takes exactly one field; anything else is rejected by the API",
    );
    assert.equal(
      parsed.command,
      "cd '/work/repo' || exit 1\nexport TOKEN_NAME='it'\\''s fine'\nnpm test\n",
    );
    assert.deepEqual(result, { output: "ok\n", stdout: "ok\n", exitCode: 0 });
  });

  it("falls back to the handle's workdir and omits cd when there is none", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "", stderr: "" } }));
    const runtime = makeRuntime(h);
    await runtime.runScript({ ...RUNNING_HANDLE, workdir: "/from/handle" }, { command: "ls" });
    assert.match(execCommand(h.requests[0] as RecordedRequest), /^cd '\/from\/handle' \|\| exit 1\n/);
    await runtime.runScript(RUNNING_HANDLE, { command: "ls" });
    assert.equal(execCommand(h.requests[1] as RecordedRequest), "ls\n");
  });

  it("reports a nonzero exit as a result, not an error, and combines the streams", async () => {
    const h = harness(() => ({
      json: { exit_code: 2, stdout: "partial", stderr: "boom", truncated: true },
    }));
    const result = await makeRuntime(h).runScript(RUNNING_HANDLE, { command: "false" });
    assert.deepEqual(result, {
      output: "partial\nboom",
      stdout: "partial",
      stderr: "boom",
      exitCode: 2,
    });
  });

  it("maps a missing exit code to null on the port and to 0 on the bootstrap plane", async () => {
    const h = harness(() => ({ json: { stdout: "hi" } }));
    const runtime = makeRuntime(h);
    assert.equal(
      (await runtime.runScript(RUNNING_HANDLE, { command: "x" })).exitCode,
      null,
      "an omitted exit_code is an unknown outcome, not a success",
    );
    assert.deepEqual(await runtime.exec(RUNNING_HANDLE, "x"), { output: "hi", exitCode: 0 });
  });

  it("rejects invalid env names before they can reach a shell", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "" } }));
    await assert.rejects(
      makeRuntime(h).runScript(RUNNING_HANDLE, {
        command: "id",
        env: { "PATH; rm -rf /": "x" },
      }),
      Agent37EnvValidationError,
    );
    assert.equal(h.requests.length, 0);
  });
});

// --- asynchronous execution ----------------------------------------------

describe("Agent37Runtime.startScript", () => {
  it("detaches the run and returns the background pid as the command id", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "4213\n", stderr: "" } }));
    const started = await makeRuntime(h).startScript(RUNNING_HANDLE, {
      command: "npm run build",
      sessionId: "lease/42",
      cwd: "/work",
      env: { CI: "1" },
    });

    assert.deepEqual(started, { sessionId: "lease/42", commandId: "4213" });
    const command = execCommand(h.requests[0] as RecordedRequest);
    const dir = "/tmp/agent37-run/lease_42";
    assert.match(command, new RegExp(`^mkdir -p '${dir}'\n`));
    assert.match(command, new RegExp(`nohup sh '${dir}/run\\.sh' >/dev/null 2>&1 &`));
    assert.match(command, /\necho \$!$/);

    // The caller's program is carried as base64, so no caller byte is ever
    // parsed as shell syntax.
    assert.equal(
      decodeWrittenFile(command, `${dir}/cmd.sh`),
      "cd '/work' || exit 1\nexport CI='1'\nnpm run build\n",
    );
    assert.equal(
      decodeWrittenFile(command, `${dir}/run.sh`),
      `sh '${dir}/cmd.sh' > '${dir}/out' 2>&1\necho $? > '${dir}/exit'\n`,
    );
  });

  it("carries a hostile command through base64 without letting it escape", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "1\n" } }));
    const hostile = "echo '; rm -rf /' \"$(whoami)\" `id` \\\n";
    await makeRuntime(h).startScript(RUNNING_HANDLE, { command: hostile, sessionId: "s1" });
    const command = execCommand(h.requests[0] as RecordedRequest);
    assert.ok(!command.includes("rm -rf /"), "the payload must not appear as shell text");
    assert.equal(
      decodeWrittenFile(command, "/tmp/agent37-run/s1/cmd.sh"),
      `${hostile}\n`,
    );
  });

  it("defaults the session id when the caller supplies none", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "9\n" } }));
    const started = await makeRuntime(h).startScript(RUNNING_HANDLE, { command: "x" });
    assert.match(started.sessionId, /^run-ab12cd34ef-\d+$/);
  });

  it("fails loudly when the bootstrap exec itself fails", async () => {
    const h = harness(() => ({ json: { exit_code: 1, stdout: "", stderr: "no space left" } }));
    await assert.rejects(
      makeRuntime(h).startScript(RUNNING_HANDLE, { command: "x", sessionId: "s1" }),
      /no space left/,
    );
  });

  it("treats a bootstrap reply with no exit code as a failure, not a launch", async () => {
    const h = harness(() => ({ json: { stdout: "4213\n" } }));
    await assert.rejects(
      makeRuntime(h).startScript(RUNNING_HANDLE, { command: "x", sessionId: "s1" }),
      /exit null/,
      "an unknown bootstrap outcome must not be reported as a started run",
    );
  });

  it("routes startExec through the same durable path", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "77\n" } }));
    const started = await makeRuntime(h).startExec(RUNNING_HANDLE, "x", { sessionId: "s2" });
    assert.deepEqual(started, { sessionId: "s2", commandId: "77" });
  });
});

describe("Agent37Runtime background polling", () => {
  it("reads the exit code from the durable file", async () => {
    for (const [raw, expected] of [
      ["", null],
      ["   \n", null],
      ["0\n", 0],
      ["137\n", 137],
      ["not-a-number\n", null],
    ] as const) {
      const h = harness(() => ({ json: { exit_code: 0, stdout: raw } }));
      const status = await makeRuntime(h).getScriptStatus(RUNNING_HANDLE, "s1", "1");
      assert.equal(status.exitCode, expected, `for ${JSON.stringify(raw)}`);
      assert.equal(
        execCommand(h.requests[0] as RecordedRequest),
        "tail -c 64 '/tmp/agent37-run/s1/exit' 2>/dev/null || true",
      );
    }
  });

  it("does NOT invent an exit code when reading logs", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "build output" } }));
    const logs = await makeRuntime(h).getScriptLogs(RUNNING_HANDLE, "s1", "42");
    assert.deepEqual(logs, { output: "build output", exitCode: null, cmdId: "42" });
    assert.equal(
      execCommand(h.requests[0] as RecordedRequest),
      "tail -c 262144 '/tmp/agent37-run/s1/out' 2>/dev/null || true",
    );
  });

  it("bounds the log read at the configured size", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "" } }));
    await makeRuntime(h, { scriptLogReadMaxBytes: 4096 }).getScriptLogs(RUNNING_HANDLE, "s1", "1");
    assert.match(execCommand(h.requests[0] as RecordedRequest), /^tail -c 4096 /);
  });
});

// --- files ----------------------------------------------------------------

describe("Agent37Runtime file transfer", () => {
  it("uploads through the instance plane at the URL the instance reports", async () => {
    const h = harness((request) =>
      request.method === "GET" ? { json: instanceObject() } : { json: { name: "a.txt" } },
    );
    await makeRuntime(h).uploadBundle(RUNNING_HANDLE, {
      files: [
        { source: "hello", destination: "/work/a.txt" },
        { source: Buffer.from([0, 1, 2]), destination: "/work/b.bin" },
      ],
    });

    const puts = h.requests.filter((request) => request.method === "PUT");
    assert.equal(puts.length, 2);
    assert.equal(
      (puts[0] as RecordedRequest).url,
      "https://ab12cd34ef.instances.example.invalid/v1/files/content?path=%2Fwork%2Fa.txt",
    );
    assert.equal(bodyText(puts[0] as RecordedRequest), "hello");
    assert.deepEqual(
      Array.from((puts[1] as RecordedRequest).body as Uint8Array),
      [0, 1, 2],
      "binary must go through unencoded",
    );
    assert.equal(
      h.requests.filter((request) => request.method === "GET").length,
      1,
      "the instance URL is resolved once and cached",
    );
  });

  it("downloads bytes, and writes them to disk when a destination is given", async () => {
    const payload = new Uint8Array([9, 8, 7]);
    const h = harness((request) =>
      request.method === "GET" && request.url.includes("/v1/files/content")
        ? { bytes: payload }
        : { json: instanceObject() },
    );
    const runtime = makeRuntime(h);
    const buffer = await runtime.downloadFile(RUNNING_HANDLE, "/work/out.bin");
    assert.deepEqual(Array.from(buffer as Buffer), [9, 8, 7]);

    const dir = await mkdtemp(join(tmpdir(), "agent37-test-"));
    try {
      const target = join(dir, "out.bin");
      assert.equal(await runtime.downloadFile(RUNNING_HANDLE, "/work/out.bin", target), undefined);
      assert.deepEqual(Array.from(await readFile(target)), [9, 8, 7]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to base64 over exec when the instance exposes no URL", async () => {
    const h = harness((request) =>
      request.method === "GET" ? { json: instanceObject({ url: null }) } : { json: { exit_code: 0, stdout: "" } },
    );
    await makeRuntime(h).uploadFile(RUNNING_HANDLE, "payload", "/work/nested/a.txt");
    const post = h.requests.find((request) => request.method === "POST") as RecordedRequest;
    const command = execCommand(post);
    assert.match(command, /^mkdir -p '\/work\/nested'\n/);
    assert.equal(decodeWrittenFile(command, "/work/nested/a.txt"), "payload");
  });

  it("treats an exec upload with no exit code as failed", async () => {
    const h = harness((request) =>
      request.method === "GET" ? { json: instanceObject({ url: null }) } : { json: { stdout: "" } },
    );
    await assert.rejects(
      makeRuntime(h).uploadFile(RUNNING_HANDLE, "payload", "/work/a.txt"),
      /exit null/,
    );
  });

  it("refuses an oversized exec fallback rather than sending an unbounded command", async () => {
    const h = harness((request) =>
      request.method === "GET" ? { json: instanceObject({ url: null }) } : { json: { exit_code: 0 } },
    );
    await assert.rejects(
      makeRuntime(h, { execUploadMaxBytes: 8 }).uploadFile(
        RUNNING_HANDLE,
        "far too many bytes",
        "/work/a.txt",
      ),
      /capped at 8 bytes/,
    );
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 0);
  });

  it("refuses to download from an instance with no URL instead of guessing one", async () => {
    const h = harness(() => ({ json: instanceObject({ url: null }) }));
    await assert.rejects(
      makeRuntime(h).downloadFile(RUNNING_HANDLE, "/work/a.txt"),
      /exposes no URL/,
    );
  });

  it("reports a home directory from the handle, falling back to the configured one", async () => {
    const runtime = makeRuntime(harness(() => ({ json: {} })));
    assert.equal(await runtime.getHomeDir(RUNNING_HANDLE), TEST_HOME_DIR);
    assert.equal(
      await runtime.getHomeDir({ ...RUNNING_HANDLE, homeDir: "/home/node" }),
      "/home/node",
    );
  });
});

// --- lifecycle ------------------------------------------------------------

describe("Agent37Runtime lifecycle", () => {
  it("starts and stops through the hosting plane", async () => {
    const h = harness(() => ({ json: { id: "ab12cd34ef", status: "running" } }));
    const runtime = makeRuntime(h);
    const started = await runtime.start({ ...RUNNING_HANDLE, state: "STOPPED" });
    assert.equal(started.state, "STARTED");
    assert.equal(
      (h.requests[0] as RecordedRequest).url,
      `${TEST_BASE_URL}/v1/instances/ab12cd34ef/start`,
    );
    await runtime.stop(RUNNING_HANDLE);
    assert.equal(
      (h.requests[1] as RecordedRequest).url,
      `${TEST_BASE_URL}/v1/instances/ab12cd34ef/stop`,
    );
    assert.equal((h.requests[1] as RecordedRequest).method, "POST");
  });

  it("deletes the instance", async () => {
    const h = harness(() => ({ json: { id: "ab12cd34ef", deleted: true } }));
    await makeRuntime(h).destroy(RUNNING_HANDLE);
    const request = h.requests[0] as RecordedRequest;
    assert.equal(request.method, "DELETE");
    assert.equal(request.url, `${TEST_BASE_URL}/v1/instances/ab12cd34ef`);
  });

  it("treats an already-deleted instance as torn down", async () => {
    const h = harness(() => ({ status: 404, json: { error: { code: "not_found" } } }));
    await makeRuntime(h).destroy(RUNNING_HANDLE);
    assert.equal(h.requests.length, 1);
  });

  it("does NOT swallow a non-404 delete failure", async () => {
    const h = harness(() => ({ status: 500, json: { error: { code: "internal" } } }));
    await assert.rejects(makeRuntime(h).destroy(RUNNING_HANDLE), /internal/);
  });

  it("fetches container logs in any state, with an optional tail", async () => {
    const h = harness(() => ({ json: { logs: "boot", truncated: false, health: null } }));
    const runtime = makeRuntime(h);
    const logs = await runtime.getContainerLogs(RUNNING_HANDLE, { tail: 100 });
    assert.equal(logs.logs, "boot");
    assert.equal(
      (h.requests[0] as RecordedRequest).url,
      `${TEST_BASE_URL}/v1/instances/ab12cd34ef/logs?tail=100`,
    );
    await runtime.getContainerLogs(RUNNING_HANDLE);
    assert.equal(
      (h.requests[1] as RecordedRequest).url,
      `${TEST_BASE_URL}/v1/instances/ab12cd34ef/logs`,
    );
  });
});

// --- status normalization -------------------------------------------------

describe("Agent37 status normalization", () => {
  it("treats only `running` as STARTED, so no transitional instance is handed out", async () => {
    const statuses: Array<[Agent37Instance["status"], string]> = [
      ["running", "STARTED"],
      ["provisioning", "STOPPED"],
      ["starting", "STOPPED"],
      ["waking", "STOPPED"],
      ["restarting", "STOPPED"],
      ["updating", "STOPPED"],
      ["stopping", "STOPPED"],
      ["stopped", "STOPPED"],
      ["sleeping", "STOPPED"],
      ["failed", "STOPPED"],
      ["deleting", "STOPPED"],
    ];
    for (const [status, expected] of statuses) {
      const h = harness(() => ({ json: instanceObject({ status }) }));
      const handle = await makeRuntime(h).getById("ab12cd34ef");
      assert.equal(handle?.state, expected, `status ${status}`);
    }
  });
});

// --- client directly ------------------------------------------------------

describe("Agent37Client", () => {
  it("normalizes a base URL with a trailing slash", async () => {
    const h = harness(() => ({ json: { data: [] } }));
    const client = new Agent37Client({
      apiKey: TEST_KEY,
      baseUrl: `${TEST_BASE_URL}/`,
      fetch: h.fetch,
    });
    await client.hosting("GET", "/v1/instances");
    assert.equal((h.requests[0] as RecordedRequest).url, `${TEST_BASE_URL}/v1/instances`);
  });

  it("treats an empty response body as an empty object", async () => {
    const h = harness(() => ({ text: "" }));
    const client = new Agent37Client({ apiKey: TEST_KEY, baseUrl: TEST_BASE_URL, fetch: h.fetch });
    assert.deepEqual(await client.hosting("POST", "/v1/instances/x/stop"), {});
  });

  it("classifies the documented retryable codes and nothing else", () => {
    for (const code of [
      "no_capacity",
      "try_again",
      "container_unreachable",
      "upstream_unreachable",
      "host_mesh_not_ready",
      "instance_saturated",
      "wake_timeout",
      "upstream_timeout",
      "rate_limited",
    ]) {
      assert.equal(isRetryableAgent37Code(code), true, code);
    }
    for (const code of [
      "invalid_api_key",
      "insufficient_balance",
      "ip_not_allowed",
      "tier_limit",
      "invalid_request",
      "validation_error",
      "not_found",
      "instance_limit_reached",
      "capacity_unavailable",
      "image_too_large",
      "provisioning_failed",
      "container_unavailable",
      "instance_suspended",
      "session_busy",
      "payload_too_large",
      "http_500",
    ]) {
      assert.equal(isRetryableAgent37Code(code), false, code);
    }
  });
});
