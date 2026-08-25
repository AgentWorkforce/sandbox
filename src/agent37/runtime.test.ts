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
  Agent37CommandTimeoutUnsupportedError,
  Agent37CreateTimeoutUnsupportedError,
  Agent37EnvValidationError,
  Agent37ForeignHandleError,
  Agent37MalformedResponseError,
  Agent37Runtime,
  Agent37UnknownExitCodeError,
  isRetryableAgent37Code,
  resolveSandboxRuntimeCapabilities,
} from "../index.js";
import type {
  Agent37Instance,
  LaunchOptions,
  RuntimeHandle,
  SandboxRuntime,
} from "../index.js";

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

/**
 * Pull the per-invocation workdir-unusable marker out of a recorded exec body.
 *
 * Tests that want to simulate a `cd` failure must echo back the exact marker
 * the runtime chose for that call — the shared prefix alone will no longer
 * trigger reclassification, which is precisely the collision the nonce closes.
 */
function extractWorkdirUnusableMarker(request: RecordedRequest): string {
  const cmd = execCommand(request);
  const match = cmd.match(/__agent37_workdir_unusable__[0-9a-f]{32}/);
  assert.ok(match, `expected a workdir-unusable marker in composed script:\n${cmd}`);
  return match[0];
}

/** Strip comments so a source scan reads code, not the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
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
    assert.equal(typeof pkg.Agent37ForeignHandleError, "function");
    assert.equal(typeof pkg.Agent37UnknownExitCodeError, "function");
    assert.equal(typeof pkg.Agent37CommandTimeoutUnsupportedError, "function");
    assert.equal(typeof pkg.Agent37CreateTimeoutUnsupportedError, "function");
    assert.equal(typeof pkg.Agent37MalformedResponseError, "function");
    assert.equal(typeof pkg.isRetryableAgent37Code, "function");
  });
});

// --- capability declarations ---------------------------------------------

describe("Agent37Runtime capabilities", () => {
  it("declares reattach, warm lease, and lifecycle; NOT async exec", () => {
    const runtime = makeRuntime(harness(() => ({ json: {} })));
    const capabilities = resolveSandboxRuntimeCapabilities(runtime);
    // asyncExec is false: nohup+/tmp emulation cannot provide durable guarantees.
    // /tmp state is lost on stop/restart/update; instance crashes leave exit
    // sentinels unwritten (indefinite null); no deduplication guard for duplicate
    // startScript calls with the same sessionId.
    assert.equal(capabilities.asyncExec, false);
    assert.equal(capabilities.reattach, true);
    assert.equal(capabilities.warmLease, true);
    assert.equal(capabilities.lifecycle, true);
  });

  it("does NOT expose startScript, getScriptStatus, getScriptLogs, startExec, getExecStatus, or getExecLogs", () => {
    const runtime = makeRuntime(harness(() => ({ json: {} })));
    const r = runtime as Record<string, unknown>;
    assert.equal(r["startScript"], undefined, "startScript must be absent");
    assert.equal(r["getScriptStatus"], undefined, "getScriptStatus must be absent");
    assert.equal(r["getScriptLogs"], undefined, "getScriptLogs must be absent");
    assert.equal(r["startExec"], undefined, "startExec must be absent");
    assert.equal(r["getExecStatus"], undefined, "getExecStatus must be absent");
    assert.equal(r["getExecLogs"], undefined, "getExecLogs must be absent");
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

  it("keeps the async emulation and the hosted-agent plane out of the source", async () => {
    // Comments still *describe* why the nohup+/tmp emulation was removed, so the
    // scan runs over code only. A regression here would be a silent return of
    // the exact construct that could not survive an instance restart.
    const dir = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["client.ts", "runtime.ts"]) {
      const code = withoutComments(await readFile(join(dir, file), "utf8"));
      for (const [pattern, why] of [
        [/nohup/, "the nohup background emulation cannot survive a restart"],
        [/\/tmp\/agent37-run/, "the /tmp run-state root went with the async emulation"],
        [
          /\/v1\/responses/,
          "hosted-agent responses are a separate plane, excluded from the sandbox-command adapter",
        ],
      ] as const) {
        assert.ok(!pattern.test(code), `${file} must not reference ${pattern}: ${why}`);
      }
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

  it("maps the singular label option to a metadata entry", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    await makeRuntime(h).launch({ label: "my-run" });
    const body = JSON.parse(bodyText(h.requests[0] as RecordedRequest)) as Record<string, unknown>;
    assert.deepEqual(body.metadata, { label: "my-run" });
  });

  it("merges singular label with plural labels, plural entries taking precedence", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    await makeRuntime(h).launch({ label: "base", labels: { purpose: "test", label: "override" } });
    const body = JSON.parse(bodyText(h.requests[0] as RecordedRequest)) as Record<string, unknown>;
    assert.deepEqual(body.metadata, { purpose: "test", label: "override" });
  });

  it("omits metadata entirely when neither label nor labels are provided", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    await makeRuntime(h).launch({ name: "x" });
    const body = JSON.parse(bodyText(h.requests[0] as RecordedRequest)) as Record<string, unknown>;
    assert.equal("metadata" in body, false);
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

// --- ownership enforcement ------------------------------------------------

// Ownership is *caller-declared attachment*, not in-process provenance. `launch`
// owns what it created; every other resolver hands back an attached (unowned)
// handle unless the caller says `owned: true`. That is what lets a process that
// crashed and restarted reclaim the right to delete its own instance — a
// provenance-only set could never express it.
describe("Agent37Runtime ownership", () => {
  it("refuses to start, stop, or destroy a handle it was never told about", async () => {
    const h = harness(() => ({ json: {} }));
    const runtime = makeRuntime(h);
    for (const [name, operation] of [
      ["start", () => runtime.start(RUNNING_HANDLE)],
      ["stop", () => runtime.stop(RUNNING_HANDLE)],
      ["destroy", () => runtime.destroy(RUNNING_HANDLE)],
    ] as const) {
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(
          error instanceof Agent37ForeignHandleError,
          `${name}: expected Agent37ForeignHandleError, got ${String(error)}`,
        );
        assert.match(error.message, /ab12cd34ef/);
        return true;
      });
    }
    assert.equal(h.requests.length, 0, "an unknown handle must not reach the hosting plane");
  });

  it("mutates and deletes an instance it launched", async () => {
    const launched = instanceObject({ id: "owned_inst" });
    const h = harness((request) =>
      request.method === "POST" && request.url.endsWith("/v1/instances")
        ? { status: 201, json: launched }
        : { json: { id: "owned_inst", status: "running" } },
    );
    const runtime = makeRuntime(h);
    const handle = await runtime.launch();
    assert.equal((await runtime.start(handle)).state, "STARTED");
    await runtime.stop(handle);
    await runtime.destroy(handle);
    assert.deepEqual(
      h.requests.slice(1).map((r) => `${r.method} ${r.url.slice(TEST_BASE_URL.length)}`),
      [
        "POST /v1/instances/owned_inst/start",
        "POST /v1/instances/owned_inst/stop",
        "DELETE /v1/instances/owned_inst",
      ],
    );
  });

  it("does NOT mutate an instance it merely attached to", async () => {
    const h = harness(() => ({ json: instanceObject() }));
    const runtime = makeRuntime(h);
    const attached = await runtime.getById("ab12cd34ef");
    assert.ok(attached, "an unowned lookup still resolves; ownership is not a search filter");
    const afterLookup = h.requests.length;

    await runtime.stop(attached);
    const started = await runtime.start(attached);
    assert.equal(started.state, attached.state, "start must not invent a state change");
    await runtime.destroy(attached);

    assert.equal(
      h.requests.length,
      afterLookup,
      "an attached instance is caller-managed: no start, stop, or DELETE is ever issued",
    );
  });

  it("reclaims delete rights across a restart when the caller declares ownership", async () => {
    // A brand-new runtime, exactly as after a crash: it launched nothing, but
    // the caller knows this id is its own and says so. A provenance-only set
    // would make this instance permanently undeletable.
    const h = harness((request) =>
      request.method === "DELETE" ? { json: { deleted: true } } : { json: instanceObject() },
    );
    const runtime = makeRuntime(h);
    const handle = await runtime.getById("ab12cd34ef", { owned: true });
    assert.ok(handle, "owned: true must resolve the instance, not filter it away");
    await runtime.destroy(handle);
    assert.equal((h.requests[1] as RecordedRequest).method, "DELETE");
  });

  it("adopts ownership through label lookup only when the caller asks for it", async () => {
    const h = harness((request) =>
      request.method === "DELETE"
        ? { json: { deleted: true } }
        : { json: { data: [instanceObject()] } },
    );
    const runtime = makeRuntime(h);

    const [attached] = await runtime.findAllByLabels({ purpose: "test-purpose" });
    assert.ok(attached, "a default lookup still returns matches");
    await runtime.destroy(attached);
    assert.equal(h.requests.length, 1, "an attached match is never deleted");

    const [owned] = await runtime.findAllByLabels({ purpose: "test-purpose" }, { owned: true });
    assert.ok(owned);
    await runtime.destroy(owned);
    assert.equal((h.requests[2] as RecordedRequest).method, "DELETE");
  });

  it("does NOT let a later read-only lookup strip ownership the caller declared", async () => {
    const h = harness((request) =>
      request.method === "DELETE"
        ? { json: { deleted: true } }
        : request.url.endsWith("/v1/instances")
          ? { json: { data: [instanceObject()] } }
          : { json: instanceObject() },
    );
    const runtime = makeRuntime(h);
    const owned = await runtime.getById("ab12cd34ef", { owned: true });
    assert.ok(owned);
    await runtime.findAllByLabels({ purpose: "test-purpose" }); // unowned re-listing
    await runtime.destroy(owned);
    assert.equal(
      (h.requests.at(-1) as RecordedRequest).method,
      "DELETE",
      "ownership is monotonic per id; a plain listing must not revoke it",
    );
  });

  it("keeps ownership when a delete fails, so teardown stays retryable", async () => {
    let deletes = 0;
    const h = harness((request) => {
      if (request.method !== "DELETE") {
        return { status: 201, json: instanceObject() };
      }
      deletes += 1;
      return deletes === 1
        ? { status: 500, json: { error: { code: "internal" } } }
        : { json: { deleted: true } };
    });
    const runtime = makeRuntime(h);
    const handle = await runtime.launch();
    await assert.rejects(runtime.destroy(handle), /internal/);
    await runtime.destroy(handle);
    assert.equal(deletes, 2, "a failed delete must leave the registration intact for a retry");
  });

  it("drops the registration once the instance is gone, in both terminal cases", async () => {
    for (const terminal of [
      { json: { deleted: true } },
      { status: 404, json: { error: { code: "not_found" } } },
    ]) {
      const h = harness((request) =>
        request.method === "DELETE" ? terminal : { status: 201, json: instanceObject() },
      );
      const runtime = makeRuntime(h);
      const handle = await runtime.launch();
      await runtime.destroy(handle);
      await assert.rejects(
        runtime.destroy(handle),
        Agent37ForeignHandleError,
        "a torn-down id is no longer known, so a repeat destroy is refused, not re-sent",
      );
      assert.equal(h.requests.length, 2);
    }
  });

  it("does NOT swallow a non-404 delete failure", async () => {
    const h = harness((request) =>
      request.method === "DELETE"
        ? { status: 500, json: { error: { code: "internal" } } }
        : { status: 201, json: instanceObject() },
    );
    const runtime = makeRuntime(h);
    await assert.rejects(runtime.destroy(await runtime.launch()), /internal/);
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

  it("returns an empty list without probing when limit is non-positive", async () => {
    const h = harness(() => ({ json: { data: fleet } }));
    const runtime = makeRuntime(h);
    for (const bad of [0, -1]) {
      const result = await runtime.findAllByLabels(
        { purpose: "test-purpose" },
        { limit: bad },
      );
      assert.deepEqual(result, []);
    }
    assert.equal(h.requests.length, 0, "no lookup should be issued for a zero/negative limit");
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

  it("refuses a response with no data array rather than reporting no matches", async () => {
    const h = harness(() => ({ json: {} }));
    await assert.rejects(
      () => makeRuntime(h).findAllByLabels({}),
      Agent37MalformedResponseError,
    );
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
    // The sentinel marker carries a per-invocation nonce so command output
    // cannot spoof the workdir-unusable signal; everything else is fixed.
    assert.match(
      parsed.command as string,
      /^cd '\/work\/repo' \|\| \{ printf '%s\\n' '__agent37_workdir_unusable__[0-9a-f]{32}' >&2; exit 191; \}\nexport TOKEN_NAME='it'\\''s fine'\nnpm test\n$/,
    );
    assert.deepEqual(result, { output: "ok\n", stdout: "ok\n", exitCode: 0 });
  });

  it("falls back to the handle's workdir and omits cd when there is none", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "", stderr: "" } }));
    const runtime = makeRuntime(h);
    await runtime.runScript({ ...RUNNING_HANDLE, workdir: "/from/handle" }, { command: "ls" });
    assert.match(execCommand(h.requests[0] as RecordedRequest), /^cd '\/from\/handle' \|\| \{ printf /);
    await runtime.runScript(RUNNING_HANDLE, { command: "ls" });
    assert.equal(execCommand(h.requests[1] as RecordedRequest), "ls\n");
  });

  it("names an unusable workdir instead of reporting it as a failed command", async () => {
    // The regression this guards: ten unrelated probes against `workdir:
    // '/root'` all came back exit 1, and the lane concluded /root did not
    // exist. It exists — root-owned, mode 0700, unreachable by the template's
    // `node` user — and every exit 1 was the `cd`.
    const h = harness((request, index) => {
      if (index === 0) {
        // Main script: cd failed, sentinel + marker present.
        return {
          json: {
            exit_code: pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE,
            stdout: "",
            stderr: `${extractWorkdirUnusableMarker(request)}\nsh: 1: cd: can't cd to /root\n`,
          },
        };
      }
      // Out-of-band verification probe: cd would also fail here.
      return {
        json: { exit_code: 1, stdout: "", stderr: "sh: 1: cd: can't cd to /root\n" },
      };
    });
    const runtime = makeRuntime(h);
    await assert.rejects(
      runtime.runScript(RUNNING_HANDLE, { command: "id", cwd: "/root" }),
      (error: unknown) => {
        assert.ok(error instanceof pkg.Agent37WorkdirUnusableError);
        assert.equal(error.instanceId, "ab12cd34ef");
        assert.equal(error.workdir, "/root");
        assert.match(error.output, /can't cd to \/root/);
        return true;
      },
    );
    // Two exec calls: the composed script, then the out-of-band cd probe.
    assert.equal(h.requests.length, 2);
    assert.equal(execCommand(h.requests[1] as RecordedRequest), "cd '/root'\n");
  });

  it("does not reclassify when a command forges the nonce but the workdir is actually usable", async () => {
    // The in-band signals are a fast filter, not the whole answer: a hostile
    // command can recover the nonce from its own /proc/self/cmdline and print
    // it back, then exit 191. The out-of-band cd probe is what closes the
    // gap — the probe runs no user command, so the sandbox has no material
    // with which to forge its exit code.
    const spoof = harness((request, index) => {
      if (index === 0) {
        return {
          json: {
            exit_code: pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE,
            stdout: "",
            stderr: `${extractWorkdirUnusableMarker(request)}\n`,
          },
        };
      }
      // Probe: cd succeeds; the workdir is fine.
      return { json: { exit_code: 0, stdout: "", stderr: "" } };
    });
    const result = await makeRuntime(spoof).runScript(RUNNING_HANDLE, {
      command: "grep __agent37_workdir_unusable__ /proc/self/cmdline >&2; exit 191",
      cwd: "/work",
    });
    assert.equal(result.exitCode, pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE);
    // The probe still ran — that is what the fix is; the two exec calls prove
    // the runtime did not accept the in-band pair on faith.
    assert.equal(spoof.requests.length, 2);
    assert.equal(execCommand(spoof.requests[1] as RecordedRequest), "cd '/work'\n");
  });

  it("requires BOTH the sentinel status and the marker before reclassifying", async () => {
    // Either signal alone belongs to the command, not to the `cd`. A command
    // is free to exit 191, and a command is free to print the marker.
    const statusOnly = harness(() => ({
      json: { exit_code: pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE, stdout: "", stderr: "boom" },
    }));
    const first = await makeRuntime(statusOnly).runScript(RUNNING_HANDLE, {
      command: "exit 191",
      cwd: "/work",
    });
    assert.equal(first.exitCode, pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE);

    const markerOnly = harness(() => ({
      json: { exit_code: 1, stdout: pkg.AGENT37_WORKDIR_UNUSABLE_MARKER, stderr: "" },
    }));
    const second = await makeRuntime(markerOnly).runScript(RUNNING_HANDLE, {
      command: "echo marker",
      cwd: "/work",
    });
    assert.equal(second.exitCode, 1);
  });

  it("does not reclassify when a command reproduces the fixed prefix and exits 191", async () => {
    // Requiring both signals is not enough on its own: a valid command can
    // print the bare marker string AND exit 191 in the same run. The
    // per-invocation nonce is what makes the pair spoofproof.
    const collide = harness(() => ({
      json: {
        exit_code: pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE,
        stdout: "",
        // Marker prefix without the nonce the composed script actually chose.
        stderr: `${pkg.AGENT37_WORKDIR_UNUSABLE_MARKER}\ncommand output that happens to include the prefix\n`,
      },
    }));
    const result = await makeRuntime(collide).runScript(RUNNING_HANDLE, {
      command: `printf '%s\\n' '${pkg.AGENT37_WORKDIR_UNUSABLE_MARKER}' >&2; exit 191`,
      cwd: "/work",
    });
    assert.equal(result.exitCode, pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE);
  });

  it("does not reclassify when no cwd was requested, because no cd was emitted", async () => {
    const h = harness(() => ({
      json: {
        exit_code: pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE,
        stdout: "",
        stderr: pkg.AGENT37_WORKDIR_UNUSABLE_MARKER,
      },
    }));
    const runtime = makeRuntime(h, { defaultHomeDir: "/home/node" });
    const result = await runtime.runScript(RUNNING_HANDLE, { command: "sh -c 'exit 191'" });
    assert.equal(result.exitCode, pkg.AGENT37_WORKDIR_UNUSABLE_EXIT_CODE);
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
      truncated: true,
    });
  });

  it("surfaces the 512 KB-per-stream truncation on BOTH planes, with no cast", async () => {
    const capped = "x".repeat(512 * 1024);
    const h = harness(() => ({ json: { exit_code: 0, stdout: capped, truncated: true } }));
    const runtime = makeRuntime(h);

    // No `as { truncated?: boolean }` anywhere here on purpose: `truncated` has
    // to be part of the declared result types, or a caller cannot see it.
    const script = await runtime.runScript(RUNNING_HANDLE, { command: "cat big" });
    assert.equal(script.truncated, true);
    assert.equal(script.output.length, capped.length, "the captured bytes are still returned");

    const result = await runtime.exec(RUNNING_HANDLE, "cat big");
    assert.equal(result.truncated, true, "exec must not discard the truncation flag");
  });

  it("omits truncated entirely when the provider reports complete output", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "ok", truncated: false } }));
    const runtime = makeRuntime(h);
    assert.equal((await runtime.runScript(RUNNING_HANDLE, { command: "x" })).truncated, undefined);
    assert.equal((await runtime.exec(RUNNING_HANDLE, "x")).truncated, undefined);
  });

  it("maps a missing exit_code to null (unknown outcome, not a success)", async () => {
    const h = harness(() => ({ json: { stdout: "hi" } }));
    const result = await makeRuntime(h).runScript(RUNNING_HANDLE, { command: "x" });
    assert.equal(result.exitCode, null, "an omitted exit_code is an unknown outcome");
  });

  it("exec throws a typed error on a missing exit_code rather than projecting it to 0", async () => {
    const h = harness(() => ({ json: { stdout: "hi" } }));
    await assert.rejects(makeRuntime(h).exec(RUNNING_HANDLE, "x"), (error: unknown) => {
      assert.ok(
        error instanceof Agent37UnknownExitCodeError,
        `expected Agent37UnknownExitCodeError, got ${String(error)}`,
      );
      assert.match(error.message, /ab12cd34ef/);
      return true;
    });
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

// --- command lifetime -----------------------------------------------------

// `timeoutMs` on the port means *command lifetime*: after it elapses the command
// is no longer running. Agent37's exec takes no timeout, and aborting the HTTP
// request leaves the command running inside the instance — so an AbortSignal is
// not that guarantee, it only hides the fact that nothing was cancelled. The
// one lifetime bound Agent37 genuinely enforces is its own 280-second cap.
describe("Agent37 command lifetime", () => {
  it("refuses a timeoutMs it cannot honour, before the command is ever submitted", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "" } }));
    const runtime = makeRuntime(h);
    await assert.rejects(
      runtime.runScript(RUNNING_HANDLE, { command: "sleep 600", timeoutMs: 120_000 }),
      (error: unknown) => {
        assert.ok(
          error instanceof Agent37CommandTimeoutUnsupportedError,
          `expected Agent37CommandTimeoutUnsupportedError, got ${String(error)}`,
        );
        assert.match(error.message, /280/, "the error must name the cap the caller has to live with");
        assert.match(error.message, /requestTimeoutMs/, "and point at the option that does work");
        return true;
      },
    );
    await assert.rejects(
      runtime.exec(RUNNING_HANDLE, "sleep 600", { timeoutMs: 1_000 }),
      Agent37CommandTimeoutUnsupportedError,
    );
    assert.equal(h.requests.length, 0, "a timeout that cannot be honoured must not run the command");
  });

  it("accepts a timeoutMs the 280s cap already satisfies, and does NOT abort the request", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "" } }));
    await makeRuntime(h).runScript(RUNNING_HANDLE, { command: "x", timeoutMs: 280_000 });
    assert.equal(h.requests.length, 1);
    assert.equal(
      (h.requests[0] as RecordedRequest).hasSignal,
      false,
      "the provider cap does the bounding; an HTTP abort would not stop the command",
    );
  });

  it("bounds only the HTTP wait under requestTimeoutMs, which is a separate budget", async () => {
    const h = harness(() => ({ json: { exit_code: 0, stdout: "" } }));
    const runtime = makeRuntime(h);
    await runtime.runScript(RUNNING_HANDLE, { command: "x", requestTimeoutMs: 5_000 });
    assert.equal((h.requests[0] as RecordedRequest).hasSignal, true);
    await runtime.runScript(RUNNING_HANDLE, { command: "x" });
    assert.equal(
      (h.requests[1] as RecordedRequest).hasSignal,
      false,
      "no request budget means no abort signal",
    );
  });

  it("does NOT retry the cap failure, which would run the caller's command twice", async () => {
    const h = harness(() => ({ status: 502, json: { error: { code: "provisioning_failed" } } }));
    await assert.rejects(makeRuntime(h).exec(RUNNING_HANDLE, "sleep 600"), /provisioning_failed/);
    assert.equal(h.requests.length, 1, "one submitted command must never become two");
  });
});

// --- malformed 2xx responses ----------------------------------------------

// A 2xx whose body is not the documented shape is a broken response, not a
// negative answer. The distinction is load-bearing for the warm-lease path:
// an empty list means "launch a new instance", so decoding garbage into `[]`
// spends money and abandons a running lease on every malformed reply.
describe("Agent37 malformed 2xx responses", () => {
  it("refuses a list whose body is not JSON instead of reading it as no matches", async () => {
    const h = harness(() => ({ status: 200, text: "<html>502 Bad Gateway</html>" }));
    const runtime = makeRuntime(h);

    await assert.rejects(
      () => runtime.findAllByLabels({ purpose: "test-purpose" }),
      (error: unknown) => {
        assert.ok(error instanceof Agent37MalformedResponseError, `got ${String(error)}`);
        assert.match(error.message, /GET \/v1\/instances/);
        return true;
      },
    );
  });

  it("refuses a list whose `data` is missing, null, or not an array", async () => {
    for (const json of [{}, { data: null }, { data: {} }, { data: "nope" }, []]) {
      const h = harness(() => ({ status: 200, json }));
      const runtime = makeRuntime(h);
      await assert.rejects(
        () => runtime.findAllByLabels({ purpose: "test-purpose" }),
        Agent37MalformedResponseError,
        `data=${JSON.stringify(json)} must fail closed, not read as zero matches`,
      );
    }
  });

  it("refuses a list entry with no usable id or status", async () => {
    for (const entry of [
      {},
      { id: "", status: "running" },
      { id: "ab12cd34ef" },
      { id: "ab12cd34ef", status: "" },
      { id: "   ", status: "running" },
      { id: "ab12cd34ef", status: "\t\n" },
      { id: 7, status: "running" },
      null,
    ]) {
      const h = harness(() => ({ status: 200, json: { data: [entry] } }));
      const runtime = makeRuntime(h);
      await assert.rejects(
        () => runtime.findAllByLabels({}),
        Agent37MalformedResponseError,
        `entry=${JSON.stringify(entry)} must fail closed`,
      );
    }
  });

  it("accepts an empty list as a genuine no-match", async () => {
    const h = harness(() => ({ status: 200, json: { data: [] } }));
    const handles = await makeRuntime(h).findAllByLabels({ purpose: "test-purpose" });
    assert.deepEqual(handles, []);
  });

  it("accepts an unknown status string, which is forward-compatible, not malformed", async () => {
    const h = harness(() => ({
      status: 200,
      json: { data: [instanceObject({ status: "hibernating" as never })] },
    }));
    const handles = await makeRuntime(h).findAllByLabels({}, { states: null });
    assert.equal(handles.length, 1);
    // Anything that is not `running` normalizes to STOPPED, so an unrecognized
    // status can never be handed out as ready to exec.
    assert.equal((handles[0] as RuntimeHandle).state, "STOPPED");
  });

  it("refuses a launch whose reply carries no id, so ownership is never keyed on undefined", async () => {
    const h = harness(() => ({ status: 201, json: { status: "running" } }));
    const runtime = makeRuntime(h);

    await assert.rejects(
      () => runtime.launch({ labels: { purpose: "test-purpose" } }),
      (error: unknown) => {
        assert.ok(error instanceof Agent37MalformedResponseError, `got ${String(error)}`);
        assert.match(error.message, /POST \/v1\/instances/);
        return true;
      },
    );
    // The decisive part: a launch that could not be identified must not leave a
    // registration behind, or a later destroy would issue DELETE on a garbage id.
    await assert.rejects(
      () => runtime.destroy({ id: "undefined", state: "STARTED" }),
      Agent37ForeignHandleError,
    );
  });

  it("refuses a getById reply that is not an instance object", async () => {
    for (const json of [{}, { id: "ab12cd34ef" }, { status: "running" }, []]) {
      const h = harness(() => ({ status: 200, json }));
      await assert.rejects(
        () => makeRuntime(h).getById("ab12cd34ef", { owned: true }),
        Agent37MalformedResponseError,
        `body=${JSON.stringify(json)} must fail closed, not resolve a half-instance`,
      );
    }
  });

  it("keeps a real 404 as null rather than turning it into a malformed error", async () => {
    const h = harness(() => ({ status: 404, json: { error: { code: "not_found", message: "gone" } } }));
    assert.equal(await makeRuntime(h).getById("ab12cd34ef"), null);
  });

  it("refuses a start acknowledgement with no status instead of reporting STOPPED", async () => {
    const h = harness((request) =>
      request.url.endsWith("/start")
        ? { status: 200, json: {} }
        : { status: 201, json: instanceObject({ status: "stopped" }) },
    );
    const runtime = makeRuntime(h);
    const handle = await runtime.launch({});

    await assert.rejects(
      () => runtime.start(handle),
      Agent37MalformedResponseError,
      "an ack with no status must not be normalized into a confident STOPPED",
    );
  });
});

// --- create timeout -------------------------------------------------------

// See the HOLD note on Agent37CreateTimeoutUnsupportedError: aborting the
// create request cannot un-allocate an instance, and without an identifying
// handle the adapter cannot find one to clean up afterwards.
describe("Agent37 create timeout", () => {
  it("refuses createTimeoutSeconds rather than aborting a create that may still allocate", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    const runtime = makeRuntime(h);

    await assert.rejects(
      () =>
        runtime.launch({
          labels: { purpose: "test-purpose" },
          createTimeoutSeconds: 120,
        } as pkg.Agent37LaunchOptions),
      (error: unknown) => {
        assert.ok(error instanceof Agent37CreateTimeoutUnsupportedError, `got ${String(error)}`);
        assert.match(error.message, /leak|orphan/i);
        return true;
      },
    );
    assert.equal(h.requests.length, 0, "the create must be refused before it is sent");
  });

  it("sends no abort signal on create, because an abort would not be a cancellation", async () => {
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    await makeRuntime(h).launch({ labels: { purpose: "test-purpose" } });
    assert.equal(
      (h.requests[0] as RecordedRequest).hasSignal,
      false,
      "create must not carry a timeout signal that reads as cancellation",
    );
  });

  it("rejects the option arriving through the shared LaunchOptions type, not a compile error", async () => {
    // The honest statement of the guarantee. `createTimeoutSeconds` is part of
    // the shared cross-provider LaunchOptions (src/types.ts) because Daytona,
    // e2b, and local all implement it, so it typechecks against Agent37 too and
    // NO compile error is available to stop it.
    //
    // The `LaunchOptions` annotation below documents that path; it does not
    // police it. tsconfig.json excludes src/**/*.test.ts, so no test file in
    // this repo is typechecked — tsx strips these annotations without checking
    // them. What this test actually proves is the runtime behaviour, which is
    // the only thing enforcing the refusal, and which is exactly why the
    // refusal had to be a runtime one.
    const shared: LaunchOptions = {
      labels: { purpose: "test-purpose" },
      createTimeoutSeconds: 120,
    };
    const h = harness(() => ({ status: 201, json: instanceObject() }));

    await assert.rejects(
      () => makeRuntime(h).launch(shared),
      Agent37CreateTimeoutUnsupportedError,
      "the shared option must be refused at runtime; no compile error stops it",
    );
    assert.equal(h.requests.length, 0);
  });

  it("reaches the same refusal through a caller holding only the port interface", async () => {
    // Parameter bivariance means narrowing Agent37's own signature would not
    // stop this path, which is why the refusal is a runtime one.
    const h = harness(() => ({ status: 201, json: instanceObject() }));
    const port: SandboxRuntime = makeRuntime(h);

    await assert.rejects(
      () => port.launch({ labels: { purpose: "test-purpose" }, createTimeoutSeconds: 5 }),
      Agent37CreateTimeoutUnsupportedError,
    );
    assert.equal(h.requests.length, 0);
  });

  it("attaches no timeout to the create request anywhere in the source", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const code = withoutComments(await readFile(join(dir, "runtime.ts"), "utf8"));
    const launchCall = /"POST", "\/v1\/instances", \{[\s\S]*?\}\);/.exec(code);
    assert.ok(launchCall, "the create call must still be findable");
    assert.ok(
      !launchCall[0].includes("timeoutMs"),
      "the create request must not carry a timeout that reads as cancellation",
    );
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

  it("falls back to base64 over exec on download when the instance exposes no URL", async () => {
    const payload = Buffer.from([9, 8, 7, 6, 0, 255]);
    const h = harness((request) =>
      request.method === "GET"
        ? { json: instanceObject({ url: null }) }
        : { json: { exit_code: 0, stdout: payload.toString("base64") } },
    );
    const buffer = await makeRuntime(h).downloadFile(RUNNING_HANDLE, "/work/a.bin");
    assert.deepEqual(Array.from(buffer as Buffer), Array.from(payload));
    const post = h.requests.find((request) => request.method === "POST") as RecordedRequest;
    const command = execCommand(post);
    assert.match(command, /wc -c < '\/work\/a\.bin'/);
    assert.match(command, /base64 -w0 < '\/work\/a\.bin'/);
  });

  it("rejects a truncated exec download rather than decoding partial bytes", async () => {
    const h = harness((request) =>
      request.method === "GET"
        ? { json: instanceObject({ url: null }) }
        : { json: { exit_code: 0, stdout: "AAAA", truncated: true } },
    );
    await assert.rejects(
      makeRuntime(h).downloadFile(RUNNING_HANDLE, "/work/a.bin"),
      /truncated by the exec plane/,
    );
  });

  it("surfaces a non-zero exec download exit rather than returning empty bytes", async () => {
    const h = harness((request) =>
      request.method === "GET"
        ? { json: instanceObject({ url: null }) }
        : { json: { exit_code: 67, stderr: "agent37: file exceeds exec download cap" } },
    );
    await assert.rejects(
      makeRuntime(h).downloadFile(RUNNING_HANDLE, "/work/big.bin"),
      /exit 67/,
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
  it("starts and stops through the hosting plane (for owned instances)", async () => {
    const launchedInstance = instanceObject({ id: "owned" });
    const h = harness((request) =>
      request.method === "POST" && request.url.endsWith("/v1/instances")
        ? { status: 201, json: launchedInstance }
        : { json: { id: "owned", status: "running" } },
    );
    const runtime = makeRuntime(h);
    const handle = await runtime.launch();
    const started = await runtime.start({ ...handle, state: "STOPPED" });
    assert.equal(started.state, "STARTED");
    assert.ok(
      (h.requests[1] as RecordedRequest).url.includes("/owned/start"),
      "POST /start must target the owned instance",
    );
    await runtime.stop(handle);
    const stopRequest = h.requests[2] as RecordedRequest;
    assert.ok(stopRequest.url.includes("/owned/stop"));
    assert.equal(stopRequest.method, "POST");
  });

  it("deletes an owned instance", async () => {
    const launchedInstance = instanceObject({ id: "owned" });
    const h = harness((request) =>
      request.method === "POST" ? { status: 201, json: launchedInstance } : { json: {} },
    );
    const runtime = makeRuntime(h);
    const handle = await runtime.launch();
    await runtime.destroy(handle);
    const deleteRequest = h.requests.find((r) => r.method === "DELETE") as RecordedRequest;
    assert.ok(deleteRequest.url.includes("/owned"));
  });

  it("treats an already-deleted owned instance as torn down", async () => {
    const launchedInstance = instanceObject({ id: "owned" });
    const h = harness((request) =>
      request.method === "POST" && request.url.endsWith("/v1/instances")
        ? { status: 201, json: launchedInstance }
        : { status: 404, json: { error: { code: "not_found" } } },
    );
    const runtime = makeRuntime(h);
    const handle = await runtime.launch();
    await runtime.destroy(handle);
    assert.equal(h.requests.length, 2);
  });

  it("does NOT swallow a non-404 delete failure", async () => {
    const launchedInstance = instanceObject({ id: "owned" });
    const h = harness((request) =>
      request.method === "POST" && request.url.endsWith("/v1/instances")
        ? { status: 201, json: launchedInstance }
        : { status: 500, json: { error: { code: "internal" } } },
    );
    const runtime = makeRuntime(h);
    const handle = await runtime.launch();
    await assert.rejects(runtime.destroy(handle), /internal/);
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

  it("rejects a non-finite maxAttempts so the retry loop cannot spin forever", () => {
    const h = harness(() => ({ json: {} }));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(
        () =>
          new Agent37Client({
            apiKey: TEST_KEY,
            baseUrl: TEST_BASE_URL,
            fetch: h.fetch,
            maxAttempts: bad,
          }),
        /maxAttempts must be a finite number/,
      );
    }
  });

  it("rejects a non-finite or negative retryBaseDelayMs", () => {
    const h = harness(() => ({ json: {} }));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.throws(
        () =>
          new Agent37Client({
            apiKey: TEST_KEY,
            baseUrl: TEST_BASE_URL,
            fetch: h.fetch,
            retryBaseDelayMs: bad,
          }),
        /retryBaseDelayMs must be a finite, non-negative number/,
      );
    }
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
