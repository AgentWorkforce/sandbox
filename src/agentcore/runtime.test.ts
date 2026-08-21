import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import * as pkg from "../index.js";
import {
  AgentCoreDestroyVerificationError,
  AgentCoreInterpreterNotReadyError,
  AgentCoreNetworkConfigError,
  AgentCoreSandboxRuntime,
  AgentCoreUnregisteredHandleError,
} from "../index.js";
import type {
  AgentCoreApi,
  AgentCoreControlApiLike,
  AgentCoreDataApiLike,
  AgentCoreGetInterpreterResult,
  AgentCoreGetSessionResult,
  AgentCoreInvokeResult,
} from "./internal/sdk.js";

const TEST_HOME_DIR = "/home/sandbox";
const TEST_REGION = "us-east-1";
const OWNED_VPC = {
  type: "owned" as const,
  name: "agentTestEnv",
  network: {
    vpc: { subnetIds: ["subnet-abc"], securityGroupIds: ["sg-abc"] },
  },
};

function fakeApi(overrides: Partial<{
  control: Partial<AgentCoreControlApiLike>;
  data: Partial<AgentCoreDataApiLike>;
}> = {}): { api: AgentCoreApi; calls: { control: string[]; data: string[] } } {
  const calls = { control: [] as string[], data: [] as string[] };
  let interpreterCounter = 0;
  let sessionCounter = 0;
  const interpreters = new Map<string, AgentCoreGetInterpreterResult>();
  const sessions = new Map<string, AgentCoreGetSessionResult & { codeInterpreterIdentifier: string }>();

  const control: AgentCoreControlApiLike = {
    createCodeInterpreter: async (params) => {
      calls.control.push("createCodeInterpreter");
      const id = `ci-${++interpreterCounter}`;
      interpreters.set(id, { codeInterpreterId: id, status: "READY" });
      return { codeInterpreterArn: `arn:aws:bedrock-agentcore:${TEST_REGION}::code-interpreter/${id}`, codeInterpreterId: id, status: "READY" };
    },
    getCodeInterpreter: async ({ codeInterpreterId }) => {
      calls.control.push("getCodeInterpreter");
      const found = interpreters.get(codeInterpreterId);
      if (!found) {
        const err = new Error("not found");
        (err as { name?: string }).name = "ResourceNotFoundException";
        throw err;
      }
      return found;
    },
    deleteCodeInterpreter: async ({ codeInterpreterId }) => {
      calls.control.push("deleteCodeInterpreter");
      interpreters.delete(codeInterpreterId);
      return { status: "DELETED" };
    },
    listCodeInterpreters: async () => {
      calls.control.push("listCodeInterpreters");
      return { items: [] };
    },
    ...overrides.control,
  };

  const data: AgentCoreDataApiLike = {
    startSession: async ({ codeInterpreterIdentifier, name }) => {
      calls.data.push("startSession");
      const sessionId = `sess-${++sessionCounter}`;
      sessions.set(sessionId, {
        codeInterpreterIdentifier,
        sessionId,
        ...(name ? { name } : {}),
        status: "READY",
        createdAt: new Date("2026-08-21T00:00:00Z"),
      });
      return { codeInterpreterIdentifier, sessionId, createdAt: new Date("2026-08-21T00:00:00Z") };
    },
    getSession: async ({ codeInterpreterIdentifier, sessionId }) => {
      calls.data.push("getSession");
      const found = sessions.get(sessionId);
      if (!found || found.codeInterpreterIdentifier !== codeInterpreterIdentifier) {
        const err = new Error("not found");
        (err as { name?: string }).name = "ResourceNotFoundException";
        throw err;
      }
      return found;
    },
    stopSession: async ({ sessionId }) => {
      calls.data.push("stopSession");
      const found = sessions.get(sessionId);
      if (found) {
        found.status = "TERMINATED";
      }
    },
    invoke: async (params) => {
      calls.data.push(`invoke:${params.name}`);
      const result: AgentCoreInvokeResult = {
        isError: false,
        content: [{ type: "text", text: "" }],
        structuredContent: { stdout: "", stderr: "", exitCode: 0, executionTime: 1 },
      };
      return result;
    },
    ...overrides.data,
  };

  return { api: { control, data }, calls };
}

describe("public barrel", () => {
  it("exports AgentCoreSandboxRuntime and its errors as classes", () => {
    assert.equal(typeof pkg.AgentCoreSandboxRuntime, "function");
    assert.equal(typeof AgentCoreSandboxRuntime, "function");
    assert.equal(typeof pkg.AgentCoreDestroyVerificationError, "function");
    assert.equal(typeof pkg.AgentCoreNetworkConfigError, "function");
  });

  it("exports SDK-free capability descriptors", () => {
    assert.equal(pkg.agentCoreSandboxCapabilities.warmLease, false);
    assert.equal(pkg.agentCoreSandboxCapabilities.lifecycle, false);
    assert.equal(pkg.agentCoreWorkflowCapabilities.isolation, "strong");
    assert.equal(pkg.agentCoreObservedCapabilities.cleanupVerified, false);
  });
});

describe("construction / network mode validation", () => {
  it("defaults to VPC and requires vpc details when mode is omitted", () => {
    assert.throws(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: { type: "owned", name: "noNetwork", network: {} as never },
      });
    }, AgentCoreNetworkConfigError);
  });

  it("accepts VPC mode with subnet and security group ids", () => {
    assert.doesNotThrow(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: OWNED_VPC,
      });
    });
  });

  it("rejects VPC mode with an empty subnet list", () => {
    assert.throws(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: {
          type: "owned",
          name: "badVpc",
          network: { vpc: { subnetIds: [], securityGroupIds: ["sg-1"] } },
        },
      });
    }, AgentCoreNetworkConfigError);
  });

  it("accepts explicit SANDBOX mode and warns about the DNS escape hazard", () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      assert.doesNotThrow(() => {
        new AgentCoreSandboxRuntime({
          credentials: { type: "default-chain" },
          region: TEST_REGION,
          defaultHomeDir: TEST_HOME_DIR,
          interpreter: { type: "owned", name: "sandboxMode", network: { mode: "SANDBOX" } },
        });
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /DNS/);
    assert.match(String(warnings[0][0]), /SANDBOX/);
  });

  it("accepts explicit PUBLIC mode without a warning", () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: { type: "owned", name: "publicMode", network: { mode: "PUBLIC" } },
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 0);
  });

  it("rejects an owned interpreter name outside the vendor pattern", () => {
    assert.throws(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: { type: "owned", name: "bad name!", network: { mode: "PUBLIC" } },
      });
    });
  });

  it("rejects a missing region", () => {
    assert.throws(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: "",
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: OWNED_VPC,
      });
    });
  });

  it("rejects a sessionTimeoutSeconds above the 8-hour ceiling", () => {
    assert.throws(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: OWNED_VPC,
        sessionTimeoutSeconds: 28_801,
      });
    });
  });

  it("system interpreter source does not require network config", () => {
    assert.doesNotThrow(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: { type: "system" },
      });
    });
  });
});

describe("launch", () => {
  it("creates the owned interpreter once, reused across launches", async () => {
    const { api, calls } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const a = await runtime.launch({ name: "a" });
    const b = await runtime.launch({ name: "b" });
    assert.equal(calls.control.filter((c) => c === "createCodeInterpreter").length, 1);
    assert.notEqual(a.id, b.id);
    assert.equal(a.homeDir, TEST_HOME_DIR);
    assert.equal(a.state, "READY");
  });

  it("system interpreter source skips CreateCodeInterpreter entirely", async () => {
    const { api, calls } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: { type: "system" } },
      { apiFactory: () => api },
    );
    await runtime.launch();
    assert.equal(calls.control.length, 0);
    assert.equal(calls.data[0], "startSession");
  });

  it("passes labels through to the in-process registration, not to the vendor API", async () => {
    const { api } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch({ labels: { purpose: "test" } });
    const matches = await runtime.findAllByLabels({ purpose: "test" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, handle.id);
  });

  it("surfaces AgentCoreInterpreterNotReadyError when creation fails", async () => {
    const { api } = fakeApi({
      control: {
        createCodeInterpreter: async () => ({
          codeInterpreterArn: "arn",
          codeInterpreterId: "ci-broken",
          status: "CREATE_FAILED",
        }),
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    await assert.rejects(() => runtime.launch(), AgentCoreInterpreterNotReadyError);
  });

  it("does not offer launchDetached", () => {
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
    );
    assert.equal(runtime.launchDetached, undefined);
  });
});

describe("findAllByLabels / getById", () => {
  it("findAllByLabels only ever returns this instance's own registrations", async () => {
    const { api } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const matches = await runtime.findAllByLabels({ purpose: "never-launched" });
    assert.deepEqual(matches, []);
  });

  it("getById re-resolves a live session and registers it as unowned by default", async () => {
    const { api } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const launched = await runtime.launch();
    const other = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const resolved = await other.getById(launched.id);
    assert.ok(resolved);
    assert.equal(resolved?.id, launched.id);
    // Unowned: destroy() on the attaching instance must not call stopSession.
    await other.destroy(resolved!);
    const stillLive = await runtime.getById(launched.id);
    assert.equal(stillLive?.state, "READY");
  });

  it("getById returns null for a session that does not exist", async () => {
    const { api } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const resolved = await runtime.getById("sess-does-not-exist");
    assert.equal(resolved, null);
  });

  it("getById filters by requested states", async () => {
    const { api } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    const filtered = await runtime.getById(handle.id, { states: ["TERMINATED"] });
    assert.equal(filtered, null);
  });
});

describe("exec / runScript", () => {
  it("throws AgentCoreUnregisteredHandleError for a handle this instance never saw", async () => {
    const { api } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    await assert.rejects(
      () => runtime.exec({ id: "sess-unknown" }, "echo hi"),
      AgentCoreUnregisteredHandleError,
    );
  });

  it("folds cwd and env into the shell command sent to executeCommand", async () => {
    const invoked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { api } = fakeApi({
      data: {
        invoke: async (params) => {
          invoked.push({ name: params.name, arguments: params.arguments });
          return { isError: false, content: [], structuredContent: { stdout: "ok", stderr: "", exitCode: 0 } };
        },
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC, env: { GLOBAL: "1" } },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    const result = await runtime.exec(handle, "pwd", { cwd: "/tmp/work", env: { LOCAL: "2" } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "ok");
    const cmd = invoked[0].arguments.command as string;
    assert.match(cmd, /^cd '\/tmp\/work' && export GLOBAL='1' && export LOCAL='2' && pwd$/);
  });

  it("single-quotes env values so they cannot inject shell syntax", async () => {
    const invoked: string[] = [];
    const { api } = fakeApi({
      data: {
        invoke: async (params) => {
          invoked.push(params.arguments.command as string);
          return { isError: false, content: [], structuredContent: { stdout: "", stderr: "", exitCode: 0 } };
        },
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    await runtime.exec(handle, "true", { env: { HOSTILE: "'; rm -rf /; echo '" } });
    assert.equal(invoked[0], "export HOSTILE=''\\''; rm -rf /; echo '\\''' && true");
  });

  it("reports a nonzero exit code from structuredContent without throwing", async () => {
    const { api } = fakeApi({
      data: {
        invoke: async () => ({
          isError: true,
          content: [],
          structuredContent: { stdout: "", stderr: "boom", exitCode: 7 },
        }),
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    const result = await runtime.exec(handle, "false");
    assert.equal(result.exitCode, 7);
    assert.equal(result.output.includes("boom"), true);
  });
});

describe("files", () => {
  it("uploads a text buffer via writeFiles without a base64 sidecar", async () => {
    const invoked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { api } = fakeApi({
      data: {
        invoke: async (params) => {
          invoked.push({ name: params.name, arguments: params.arguments });
          return { isError: false, content: [], structuredContent: { stdout: "", stderr: "", exitCode: 0 } };
        },
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    await runtime.uploadFile(handle, Buffer.from("hello world", "utf8"), "/tmp/greeting.txt");
    assert.equal(invoked[0].name, "writeFiles");
    const content = invoked[0].arguments.content as Array<{ path: string; text: string }>;
    assert.equal(content[0].path, "/tmp/greeting.txt.__b64__");
    assert.equal(Buffer.from(content[0].text, "base64").toString("utf8"), "hello world");
    // A decode command should have run to materialize the real destination.
    assert.equal(invoked[1].name, "executeCommand");
    assert.match(invoked[1].arguments.command as string, /base64\.b64decode/);
  });

  it("downloads a file by base64-encoding it through executeCommand", async () => {
    const payload = Buffer.from("round trip me", "utf8");
    const { api } = fakeApi({
      data: {
        invoke: async () => ({
          isError: false,
          content: [{ type: "text", text: payload.toString("base64") }],
          structuredContent: { stdout: `${payload.toString("base64")}\n`, stderr: "", exitCode: 0 },
        }),
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    const buffer = await runtime.downloadFile(handle, "/tmp/data.bin");
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal((buffer as Buffer).toString("utf8"), "round trip me");
  });

  it("downloadFile throws when the source file is reported missing", async () => {
    const { api } = fakeApi({
      data: {
        invoke: async () => ({
          isError: true,
          content: [],
          structuredContent: { stdout: "", stderr: "no such file", exitCode: 1 },
        }),
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    await assert.rejects(() => runtime.downloadFile(handle, "/tmp/missing"));
  });
});

describe("destroy / cleanup verification", () => {
  it("stops an owned session and verifies TERMINATED before forgetting it", async () => {
    const { api, calls } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    await runtime.destroy(handle);
    assert.ok(calls.data.includes("stopSession"));
    // Forgotten: a second destroy is a no-op, not a duplicate stopSession call.
    const stopCallsBefore = calls.data.filter((c) => c === "stopSession").length;
    await runtime.destroy(handle);
    assert.equal(calls.data.filter((c) => c === "stopSession").length, stopCallsBefore);
  });

  it("treats an already-absent session as successfully destroyed", async () => {
    const { api } = fakeApi({
      data: {
        stopSession: async () => {
          const err = new Error("gone");
          (err as { name?: string }).name = "ResourceNotFoundException";
          throw err;
        },
        getSession: async () => {
          const err = new Error("gone");
          (err as { name?: string }).name = "ResourceNotFoundException";
          throw err;
        },
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    await assert.doesNotReject(() => runtime.destroy(handle));
  });

  it("raises AgentCoreDestroyVerificationError when the session never reaches TERMINATED", async () => {
    const { api } = fakeApi({
      data: {
        stopSession: async () => {},
        getSession: async ({ codeInterpreterIdentifier, sessionId }) => ({
          codeInterpreterIdentifier,
          sessionId,
          status: "READY",
        }),
      },
    });
    const runtime = new AgentCoreSandboxRuntime(
      {
        credentials: { type: "default-chain" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: OWNED_VPC,
        destroyTimeoutMs: 50,
      },
      { apiFactory: () => api },
    );
    const handle = await runtime.launch();
    await assert.rejects(() => runtime.destroy(handle), AgentCoreDestroyVerificationError);
  });

  it("destroy on an unowned (attached) handle forgets it locally without calling stopSession", async () => {
    const { api, calls } = fakeApi();
    const owner = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const launched = await owner.launch();
    const attacher = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    const attached = await attacher.getById(launched.id);
    await attacher.destroy(attached!);
    assert.equal(calls.data.includes("stopSession"), false);
  });

  it("deleteOwnedCodeInterpreter is a no-op for the system interpreter source", async () => {
    const { api, calls } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: { type: "system" } },
      { apiFactory: () => api },
    );
    await runtime.launch();
    await runtime.deleteOwnedCodeInterpreter();
    assert.equal(calls.control.includes("deleteCodeInterpreter"), false);
  });

  it("deleteOwnedCodeInterpreter deletes the resource this runtime created", async () => {
    const { api, calls } = fakeApi();
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
      { apiFactory: () => api },
    );
    await runtime.launch();
    await runtime.deleteOwnedCodeInterpreter();
    assert.ok(calls.control.includes("deleteCodeInterpreter"));
  });

  it("no start/stop pair is exposed: lifecycle is structurally false", () => {
    const runtime = new AgentCoreSandboxRuntime(
      { credentials: { type: "default-chain" }, region: TEST_REGION, defaultHomeDir: TEST_HOME_DIR, interpreter: OWNED_VPC },
    );
    assert.equal((runtime as unknown as { start?: unknown }).start, undefined);
    assert.equal((runtime as unknown as { stop?: unknown }).stop, undefined);
    assert.equal(runtime.declaredCapabilities.lifecycle, false);
  });
});

describe("credentials", () => {
  it("passes static credentials through to the injected SDK factory boundary, not this file", () => {
    // The static/default-chain split is exercised at the internal/sdk.ts
    // boundary (see internal/sdk.test.ts); this asserts only that
    // construction with static credentials succeeds without touching the
    // network.
    assert.doesNotThrow(() => {
      new AgentCoreSandboxRuntime({
        credentials: { type: "static", accessKeyId: "AKIA...", secretAccessKey: "secret" },
        region: TEST_REGION,
        defaultHomeDir: TEST_HOME_DIR,
        interpreter: OWNED_VPC,
      });
    });
  });
});
