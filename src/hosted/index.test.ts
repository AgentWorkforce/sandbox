import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import {
  createHostedSandbox,
  getHostedSandboxSetupUrl,
  HostedSandboxError,
  withHostedSandbox,
} from "./index.js";

const workspaceId = "00000000-0000-4000-8000-000000000000";
const sessionId = "11111111-1111-4111-8111-111111111111";

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const encoded = Buffer.concat(chunks).toString("utf8");
  return encoded.length === 0 ? undefined : JSON.parse(encoded) as unknown;
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const httpServer = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/cloud`,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  };
}

function options(baseUrl: string) {
  return { baseUrl, token: "user-token-not-provider-key", workspaceId, providerId: "e2b" as const };
}

function json(response: ServerResponse, statusCode: number, value: unknown) {
  const encoded = JSON.stringify(value);
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

test("flow sends scoped headers and bodies, applies defaults, and drops response extras", async () => {
  const requests: Array<{ method?: string; url?: string; authorization?: string; body: unknown }> = [];
  const fixture = await server(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: await body(request) });
    if (request.url?.endsWith("sandbox-sessions")) json(response, 201, { id: sessionId, secret: "drop-me" });
    else if (request.url?.endsWith("/run")) json(response, 200, { output: "all", stdout: "out", stderr: "", exitCode: 3, truncated: true, private: "drop-me" });
    else { response.writeHead(204); response.end(); }
  });
  try {
    const session = await createHostedSandbox(options(fixture.baseUrl));
    assert.deepEqual(await session.run("printf hi", { cwd: "/tmp", env: { A: "b" } }), { output: "all", stdout: "out", stderr: "", exitCode: 3, truncated: true });
    await session.destroy();
    assert.deepEqual(requests.map((request) => [request.method, request.url]), [
      ["POST", "/cloud/api/v1/workspaces/00000000-0000-4000-8000-000000000000/sandbox-sessions"],
      ["POST", `/cloud/api/v1/workspaces/${workspaceId}/sandbox-sessions/${sessionId}/run`],
      ["DELETE", `/cloud/api/v1/workspaces/${workspaceId}/sandbox-sessions/${sessionId}`],
    ]);
    assert.equal(requests[0]?.authorization, "Bearer user-token-not-provider-key");
    assert.deepEqual(requests[0]?.body, { appKey: "sandbox", environment: "development", providerId: "e2b", intentKey: requests[0]?.body && (requests[0].body as { intentKey: string }).intentKey });
    assert.deepEqual(requests[1]?.body, { command: "printf hi", cwd: "/tmp", env: { A: "b" }, timeoutMs: 30000 });
    assert.equal(getHostedSandboxSetupUrl({ baseUrl: fixture.baseUrl, workspaceId }), `${fixture.baseUrl}/dashboard/integrations?workspaceId=${workspaceId}&appKey=sandbox&environment=development#sandbox-providers`);
  } finally {
    await fixture.close();
  }
});

test("invalid input is rejected before any request and setup errors expose only a safe link", async () => {
  let requests = 0;
  const fixture = await server((_request, response) => { requests += 1; response.end(); });
  try {
    await assert.rejects(createHostedSandbox({ ...options(fixture.baseUrl), environment: "Development" }), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_INVALID_INPUT");
    await assert.rejects(createHostedSandbox({ ...options(fixture.baseUrl), appKey: "1sandbox" }), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_INVALID_INPUT");
    await assert.rejects(createHostedSandbox({ ...options(fixture.baseUrl), environment: "1development" }), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_INVALID_INPUT");
    await assert.rejects(createHostedSandbox(null as never), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_INVALID_INPUT");
    await assert.rejects(createHostedSandbox([] as never), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_INVALID_INPUT");
    assert.throws(() => getHostedSandboxSetupUrl(null as never), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_INVALID_INPUT");
    const setupFixture = await server(async (_request, response) => json(response, 409, { code: "SANDBOX_PROVIDER_NOT_READY", providerCredential: "secret" }));
    try {
      await assert.rejects(createHostedSandbox({ ...options(setupFixture.baseUrl), token: "private-token" }), (error: unknown) => {
        assert.ok(error instanceof HostedSandboxError);
        assert.equal(error.code, "SANDBOX_PROVIDER_NOT_READY");
        assert.match(error.setupUrl ?? "", /sandbox-providers/);
        assert.doesNotMatch(`${error.message} ${error.stack} ${JSON.stringify(error)}`, /private-token|providerCredential|secret/);
        return true;
      });
    } finally {
      await setupFixture.close();
    }
    assert.equal(requests, 0);
  } finally {
    await fixture.close();
  }
});

test("streamed response cap and body deadline produce safe unknown outcomes", async () => {
  const large = "x".repeat(1024 * 1024 + 1);
  const largeFixture = await server((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.write(JSON.stringify({ id: sessionId, large: large.slice(0, 500_000) }));
    response.end(JSON.stringify({ large: large.slice(500_000) }));
  });
  try {
    await assert.rejects(createHostedSandbox({ ...options(largeFixture.baseUrl), requestTimeoutMs: 500 }), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_CREATE_UNKNOWN");
  } finally {
    await largeFixture.close();
  }
  const slowFixture = await server((_request, response) => { setTimeout(() => json(response, 201, { id: sessionId }), 100); });
  try {
    await assert.rejects(createHostedSandbox({ ...options(slowFixture.baseUrl), requestTimeoutMs: 10 }), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_CREATE_UNKNOWN");
  } finally {
    await slowFixture.close();
  }
});

test("a response body that stalls after headers is bounded by the whole-request deadline", async () => {
  const fixture = await server((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.write(`{"id":"${sessionId.slice(0, 20)}`);
    setTimeout(() => response.end(`${sessionId.slice(20)}"}`), 100);
  });
  const started = Date.now();
  try {
    await assert.rejects(createHostedSandbox({ ...options(fixture.baseUrl), requestTimeoutMs: 20 }), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_CREATE_UNKNOWN");
    assert.ok(Date.now() - started < 500, "body stall exceeded bounded deadline");
  } finally {
    await fixture.close();
  }
});

test("redirects are refused without forwarding the bearer token", async () => {
  let targetRequests = 0;
  const target = await server((request, response) => { targetRequests += 1; assert.equal(request.headers.authorization, undefined); response.end(); });
  const source = await server((_request, response) => {
    response.writeHead(302, { location: `${target.baseUrl}/redirect-target` });
    response.end();
  });
  try {
    await assert.rejects(createHostedSandbox({ ...options(source.baseUrl), token: "do-not-forward" }), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_CREATE_UNKNOWN");
    assert.equal(targetRequests, 0);
  } finally {
    await source.close();
    await target.close();
  }
});

test("command, cwd, and environment limits use UTF-8 bytes", async () => {
  let runs = 0;
  const fixture = await server(async (request, response) => {
    if (request.method === "POST") {
      if (request.url?.endsWith("/run")) runs += 1;
      json(response, request.url?.endsWith("/run") ? 200 : 201, request.url?.endsWith("/run") ? { output: "ok", exitCode: 0 } : { id: sessionId });
    } else { response.writeHead(204); response.end(); }
  });
  try {
    const session = await createHostedSandbox(options(fixture.baseUrl));
    await assert.rejects(session.run("😀".repeat(16_385)), /command is invalid/);
    await assert.rejects(session.run("true", { cwd: `/${"😀".repeat(256)}` }), /cwd is invalid/);
    await assert.rejects(session.run("true", { env: { VALUE: "😀".repeat(2_049) } }), /env is invalid/);
    assert.equal(runs, 0);
    await session.destroy();
  } finally {
    await fixture.close();
  }
});

test("known provider readiness errors are safe for run as well as create", async () => {
  let run = true;
  const fixture = await server(async (request, response) => {
    if (request.method === "POST" && request.url?.endsWith("/run") && run) {
      run = false;
      json(response, 409, { code: "SANDBOX_PROVIDER_NOT_READY", providerId: "private-provider-detail" });
    } else if (request.method === "POST") json(response, 201, { id: sessionId });
    else { response.writeHead(204); response.end(); }
  });
  try {
    const session = await createHostedSandbox(options(fixture.baseUrl));
    await assert.rejects(session.run("true"), (error: unknown) => {
      assert.ok(error instanceof HostedSandboxError);
      assert.equal(error.code, "SANDBOX_PROVIDER_NOT_READY");
      assert.match(error.setupUrl ?? "", /sandbox-providers/);
      assert.doesNotMatch(`${error.message} ${error.stack} ${JSON.stringify(error)}`, /private-provider-detail/);
      return true;
    });
    await session.destroy();
  } finally {
    await fixture.close();
  }
});

test("malformed truncation is rejected while valid false is preserved", async () => {
  let malformed = true;
  const fixture = await server(async (request, response) => {
    if (request.method === "POST" && request.url?.endsWith("/run")) {
      json(response, 200, malformed ? { output: "x", exitCode: 0, truncated: "yes" } : { output: "x", exitCode: 0, truncated: false });
      malformed = false;
    } else if (request.method === "POST") json(response, 201, { id: sessionId });
    else { response.writeHead(204); response.end(); }
  });
  try {
    const session = await createHostedSandbox(options(fixture.baseUrl));
    await assert.rejects(session.run("true"), (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_RUN_UNKNOWN");
    assert.deepEqual(await session.run("true"), { output: "x", exitCode: 0, truncated: false });
    await session.destroy();
  } finally {
    await fixture.close();
  }
});

test("a lost create reply is never retried", async () => {
  let creates = 0;
  const fixture = await server((_request, response) => { creates += 1; response.destroy(); });
  try {
    await assert.rejects(createHostedSandbox(options(fixture.baseUrl)), HostedSandboxError);
    assert.equal(creates, 1);
  } finally {
    await fixture.close();
  }
});

test("destroy is shared, disables run permanently, and can retry after failure", async () => {
  let destroys = 0;
  const fixture = await server(async (request, response) => {
    if (request.method === "POST") json(response, 201, { id: sessionId });
    else if (++destroys === 1) json(response, 500, { token: "secret" });
    else { response.writeHead(204); response.end(); }
  });
  try {
    const session = await createHostedSandbox(options(fixture.baseUrl));
    const first = session.destroy();
    assert.equal(session.destroy(), first);
    await assert.rejects(first, (error: unknown) => error instanceof HostedSandboxError && error.code === "SANDBOX_DESTROY_UNKNOWN");
    await assert.rejects(session.run("echo late"), /closing or destroyed/);
    await session.destroy();
    assert.equal(destroys, 2);
  } finally {
    await fixture.close();
  }
});

test("withHostedSandbox preserves workload and cleanup failures", async () => {
  const fixture = await server(async (request, response) => {
    if (request.method === "POST") json(response, 201, { id: sessionId });
    else json(response, 500, { internal: "secret" });
  });
  try {
    const work = new Error("work failure");
    await assert.rejects(withHostedSandbox(options(fixture.baseUrl), async () => { throw work; }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((item) => item === work ? item : (item as HostedSandboxError).code), [work, "SANDBOX_DESTROY_UNKNOWN"]);
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /secret/);
      return true;
    });
  } finally {
    await fixture.close();
  }
});
