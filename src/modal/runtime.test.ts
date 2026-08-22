import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import {
  MODAL_MAX_LIFETIME_MS,
  MODAL_MIN_CPU_CORES,
  MODAL_STRUCTURALLY_FALSE,
  ModalCapabilityMismatchError,
  ModalDeadlineExceededError,
  ModalForeignSandboxError,
  ModalRuntime,
  ModalTagCollisionError,
  isPendingEvidence,
  modalCapabilityModes,
  modalObservedCapabilities,
  modalSandboxCapabilities,
  modalWorkflowCapabilities,
  reconcileModalCapabilities,
  resolveModalRuntimeOptions,
  resolveSandboxRuntimeCapabilities,
} from "../index.js";
import type {
  ModalClientLike,
  ModalContainerProcessLike,
  ModalExecParams,
  ModalRuntimeOptions,
  ModalSandboxCreateParams,
  ModalSandboxLike,
  ModalSandboxListParams,
  SandboxRuntime,
} from "../index.js";

// Synthetic fixtures, deliberately not shaped like real credentials.
const TOKEN_ID = "ak-test-never-a-real-credential-000";
const TOKEN_SECRET = "as-test-never-a-real-credential-000";
const APP_NAME = "agent-relay-test";
const IMAGE_TAG = "python:3.13";
const HOME_DIR = "/home/sandbox";
const PREFIX = "relay-test";
const OWNER_TAG = "agentRelayOwner";

// --- fake SDK -------------------------------------------------------------

type ExecCall = { command: string[]; params: ModalExecParams | undefined };

type FakeSandboxSpec = {
  id: string;
  tags?: Record<string, string>;
  /** Successive `poll()` results; the last one repeats. */
  poll?: Array<number | null>;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** When set, `terminate` resolves with this rather than `undefined`. */
  terminateExitCode?: number;
  execDelayMs?: number;
};

class FakeSandbox implements ModalSandboxLike {
  readonly sandboxId: string;
  tags: Record<string, string>;
  readonly execCalls: ExecCall[] = [];
  readonly writes: Array<{ path: string; bytes: Uint8Array }> = [];
  terminateCalls: Array<{ wait?: boolean } | undefined> = [];
  pollCalls = 0;
  getTagsCalls = 0;
  private readonly spec: FakeSandboxSpec;
  private pollIndex = 0;

  constructor(spec: FakeSandboxSpec) {
    this.spec = spec;
    this.sandboxId = spec.id;
    this.tags = { ...(spec.tags ?? {}) };
  }

  get filesystem() {
    return {
      writeBytes: async (data: Uint8Array, remotePath: string) => {
        this.writes.push({ path: remotePath, bytes: data });
      },
      readBytes: async () => new Uint8Array(),
      makeDirectory: async () => {},
    };
  }

  async exec(
    command: string[],
    params?: ModalExecParams,
  ): Promise<ModalContainerProcessLike> {
    this.execCalls.push({ command, params });
    const spec = this.spec;
    if (spec.execDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, spec.execDelayMs));
    }
    return {
      stdout: { readText: async () => spec.stdout ?? "" },
      stderr: { readText: async () => spec.stderr ?? "" },
      wait: async () => spec.exitCode ?? 0,
    };
  }

  async terminate(params?: { wait?: boolean }): Promise<number | void> {
    this.terminateCalls.push(params);
    if (this.spec.terminateExitCode !== undefined) {
      return this.spec.terminateExitCode;
    }
    return undefined;
  }

  async poll(): Promise<number | null> {
    this.pollCalls += 1;
    const sequence = this.spec.poll ?? [null];
    const value = sequence[Math.min(this.pollIndex, sequence.length - 1)];
    this.pollIndex += 1;
    return value ?? null;
  }

  async wait(): Promise<number> {
    return this.spec.exitCode ?? 0;
  }

  async setTags(tags: Record<string, string>): Promise<void> {
    this.tags = { ...this.tags, ...tags };
  }

  async getTags(): Promise<Record<string, string>> {
    this.getTagsCalls += 1;
    return { ...this.tags };
  }
}

class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

type FakeClientSpec = {
  sandboxes?: FakeSandboxSpec[];
  appId?: string;
  createResult?: FakeSandboxSpec;
  createError?: Error;
  fromIdError?: Error;
  appError?: Error;
  createDelayMs?: number;
  /**
   * Simulate a provider whose server-side tag filter is silently ignored:
   * `list` yields every sandbox regardless of the requested tags.
   */
  listIgnoresTagFilter?: boolean;
};

type Harness = {
  client: ModalClientLike;
  creates: Array<{ params: ModalSandboxCreateParams | undefined }>;
  lists: ModalSandboxListParams[];
  appLookups: Array<{ name: string; params: unknown }>;
  imageLookups: string[];
  sandboxes: Map<string, FakeSandbox>;
  closed: number;
};

function harness(spec: FakeClientSpec = {}): Harness {
  const sandboxes = new Map<string, FakeSandbox>();
  for (const s of spec.sandboxes ?? []) {
    sandboxes.set(s.id, new FakeSandbox(s));
  }
  const h: Harness = {
    client: null as unknown as ModalClientLike,
    creates: [],
    lists: [],
    appLookups: [],
    imageLookups: [],
    sandboxes,
    closed: 0,
  };

  h.client = {
    apps: {
      fromName: async (name, params) => {
        h.appLookups.push({ name, params });
        if (spec.appError) {
          throw spec.appError;
        }
        return spec.appId === undefined ? {} : { appId: spec.appId };
      },
    },
    images: {
      fromRegistry: (tag) => {
        h.imageLookups.push(tag);
        return { imageId: `im-${tag}` };
      },
    },
    sandboxes: {
      create: async (_app, _image, params) => {
        h.creates.push({ params });
        if (spec.createDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, spec.createDelayMs));
        }
        if (spec.createError) {
          throw spec.createError;
        }
        const created = new FakeSandbox(
          spec.createResult ?? { id: `sb-${h.creates.length}`, tags: params?.tags ?? {} },
        );
        sandboxes.set(created.sandboxId, created);
        return created;
      },
      fromId: async (id) => {
        if (spec.fromIdError) {
          throw spec.fromIdError;
        }
        const found = sandboxes.get(id);
        if (!found) {
          throw new NotFoundError(`no sandbox ${id}`);
        }
        return found;
      },
      list: (params) => {
        h.lists.push(params ?? {});
        const wanted = params?.tags ?? {};
        const matching = spec.listIgnoresTagFilter
          ? [...sandboxes.values()]
          : [...sandboxes.values()].filter((sb) =>
            Object.entries(wanted).every(([k, v]) => sb.tags[k] === v)
          );
        return (async function* () {
          for (const sb of matching) {
            yield sb;
          }
        })();
      },
    },
    close: () => {
      h.closed += 1;
    },
  };
  return h;
}

function options(overrides: Partial<ModalRuntimeOptions> = {}): ModalRuntimeOptions {
  return {
    credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET },
    appName: APP_NAME,
    imageTag: IMAGE_TAG,
    defaultHomeDir: HOME_DIR,
    namePrefix: PREFIX,
    maxLifetimeMs: 600_000,
    ...overrides,
  };
}

function runtime(h: Harness, overrides: Partial<ModalRuntimeOptions> = {}): ModalRuntime {
  return new ModalRuntime({ ...options(overrides), clientFactory: () => h.client });
}

// --- config -----------------------------------------------------------------

describe("Modal config", () => {
  it("requires an explicit maxLifetimeMs, because Modal's default is 5 minutes", () => {
    const bad = { ...options() } as Partial<ModalRuntimeOptions>;
    delete bad.maxLifetimeMs;
    assert.throws(
      () => resolveModalRuntimeOptions(bad as ModalRuntimeOptions),
      /requires an explicit maxLifetimeMs/,
    );
  });

  it("requires both halves of the Modal token pair", () => {
    assert.throws(
      () => resolveModalRuntimeOptions(options({
        credentials: { tokenId: "", tokenSecret: TOKEN_SECRET },
      })),
      /credentials\.tokenId/,
    );
    assert.throws(
      () => resolveModalRuntimeOptions(options({
        credentials: { tokenId: TOKEN_ID, tokenSecret: "  " },
      })),
      /credentials\.tokenSecret/,
    );
  });

  it("requires appName and imageTag, since Modal has no appless or imageless sandbox", () => {
    assert.throws(() => resolveModalRuntimeOptions(options({ appName: "" })), /appName/);
    assert.throws(() => resolveModalRuntimeOptions(options({ imageTag: "" })), /imageTag/);
  });

  it("rejects an idle timeout that could never fire before the hard lifetime", () => {
    assert.throws(
      () => resolveModalRuntimeOptions(options({ maxLifetimeMs: 1_000, idleTimeoutMs: 5_000 })),
      /could never fire/,
    );
  });

  it("rejects a lifetime beyond Modal's documented 24-hour ceiling", () => {
    assert.throws(
      () => resolveModalRuntimeOptions(options({ maxLifetimeMs: MODAL_MAX_LIFETIME_MS + 1 })),
      /24-hour ceiling/,
    );
    // Exactly 24 hours is allowed: it is a ceiling, not an exclusive bound.
    assert.doesNotThrow(
      () => resolveModalRuntimeOptions(options({ maxLifetimeMs: MODAL_MAX_LIFETIME_MS })),
    );
  });

  it("rejects a CPU reservation below Modal's documented floor", () => {
    assert.throws(
      () => resolveModalRuntimeOptions(options({
        resources: { cpu: MODAL_MIN_CPU_CORES / 2 },
      })),
      /physical cores/,
    );
  });

  it("rejects limits below their reservations", () => {
    assert.throws(
      () => resolveModalRuntimeOptions(options({ resources: { cpu: 2, cpuLimit: 1 } })),
      /cpuLimit/,
    );
    assert.throws(
      () => resolveModalRuntimeOptions(options({
        resources: { memoryMiB: 4096, memoryLimitMiB: 2048 },
      })),
      /memoryLimitMiB/,
    );
  });

  it("rejects non-finite deadlines rather than coercing them", () => {
    assert.throws(
      () => resolveModalRuntimeOptions(options({ createTimeoutMs: Number.NaN })),
      /createTimeoutMs/,
    );
    assert.throws(
      () => resolveModalRuntimeOptions(options({ lookupTimeoutMs: -1 })),
      /lookupTimeoutMs/,
    );
  });

  it("accepts blockNetwork combined with region pinning", () => {
    // Modal supports both flags independently. A sandbox can legitimately
    // need outbound isolation *and* placement in a specific region for data
    // residency, latency, or capacity reasons, and both values are forwarded
    // to `sandboxes.create` on their own.
    assert.doesNotThrow(
      () => resolveModalRuntimeOptions(options({ blockNetwork: true, regions: ["us-east-1"] })),
    );
  });

  it("rejects a hard limit that is finite-but-non-positive on its own", () => {
    // Independent of the reservation: `cpuLimit: 0` and `memoryLimitMiB: -1`
    // reach `sandboxes.create` untouched today because the resolver only
    // compares each limit against its matching reservation. Reject them here
    // so the failure names the real cause.
    assert.throws(
      () => resolveModalRuntimeOptions(options({ resources: { cpuLimit: Number.NaN } })),
      /cpuLimit/,
    );
    assert.throws(
      () => resolveModalRuntimeOptions(options({ resources: { memoryLimitMiB: -1 } })),
      /memoryLimitMiB/,
    );
  });

  it("defaults workdir to the home directory and keeps an explicit one", () => {
    assert.equal(resolveModalRuntimeOptions(options()).workdir, HOME_DIR);
    assert.equal(
      resolveModalRuntimeOptions(options({ workdir: "/srv/app" })).workdir,
      "/srv/app",
    );
  });
});

// --- capabilities -----------------------------------------------------------

describe("Modal capabilities", () => {
  it("declares lifecycle false because Modal has no stop/start at all", () => {
    assert.equal(modalSandboxCapabilities.lifecycle, false);
    const rt = runtime(harness()) as SandboxRuntime;
    assert.equal(typeof rt.start, "undefined");
    assert.equal(typeof rt.stop, "undefined");
  });

  it("resolves asyncExec false: the async trio is absent, not stubbed", () => {
    const rt = runtime(harness()) as SandboxRuntime;
    const caps = resolveSandboxRuntimeCapabilities(rt);
    assert.equal(caps.asyncExec, false);
    assert.equal(typeof rt.startScript, "undefined");
    assert.equal(typeof rt.getScriptStatus, "undefined");
    assert.equal(typeof rt.getScriptLogs, "undefined");
  });

  it("resolves reattach true and detachedLaunch false", () => {
    const caps = resolveSandboxRuntimeCapabilities(runtime(harness()) as SandboxRuntime);
    assert.equal(caps.reattach, true);
    assert.equal(caps.detachedLaunch, false);
  });

  it("keeps warmLease unpromoted until a live probe proves it", () => {
    const caps = resolveSandboxRuntimeCapabilities(runtime(harness()) as SandboxRuntime);
    assert.equal(caps.warmLease, false);
    assert.equal(caps.lifecycle, false);
  });

  it("reports snapshots and pty as unreachable through this port", () => {
    assert.equal(modalWorkflowCapabilities.snapshots, false);
    assert.equal(modalWorkflowCapabilities.pty, false);
    assert.equal(modalWorkflowCapabilities.isolation, "strong");
    assert.equal(modalWorkflowCapabilities.persistentHandle, true);
  });

  it("promotes no observed capability before a live run", () => {
    for (const [name, value] of Object.entries(modalObservedCapabilities)) {
      assert.equal(value, false, `${name} must not be promoted without a live observation`);
    }
  });

  it("rejects start/stop on Modal specifically, since no real one could exist", () => {
    const lying = {
      ...(runtime(harness()) as unknown as Record<string, unknown>),
      declaredCapabilities: { lifecycle: false },
      start: async () => ({ id: "x" }),
      stop: async () => {},
      findByLabels: async () => null,
      findAllByLabels: async () => [],
      countByLabels: async () => 0,
      launch: async () => ({ id: "x" }),
      uploadBundle: async () => {},
      runScript: async () => ({ output: "", exitCode: 0 }),
      destroy: async () => {},
    } as unknown as SandboxRuntime;
    assert.throws(
      () => reconcileModalCapabilities(lying),
      (error: unknown) =>
        error instanceof ModalCapabilityMismatchError
        && error.mismatches.some((m) => m.includes("only a no-op or a fabrication")),
    );
  });

  it("construction-time reconciliation rejects a partial async-exec trio", () => {
    const partial = {
      declaredCapabilities: {},
      findByLabels: async () => null,
      findAllByLabels: async () => [],
      countByLabels: async () => 0,
      launch: async () => ({ id: "x" }),
      uploadBundle: async () => {},
      runScript: async () => ({ output: "", exitCode: 0 }),
      destroy: async () => {},
      startScript: async () => ({ sessionId: "s", commandId: "c" }),
    } as unknown as SandboxRuntime;
    assert.throws(
      () => reconcileModalCapabilities(partial),
      (error: unknown) =>
        error instanceof ModalCapabilityMismatchError
        && error.mismatches.some((m) => m.includes("all-or-nothing")),
    );
  });

  it("the real adapter passes its own reconciliation", () => {
    assert.doesNotThrow(() => reconcileModalCapabilities(runtime(harness()) as SandboxRuntime));
  });
});

describe("Modal capability modes", () => {
  /** A reconcilable Modal-shaped runtime with the modes swapped out. */
  const withModes = (
    modes: Record<string, string>,
  ): SandboxRuntime =>
    ({
      ...(runtime(harness()) as unknown as Record<string, unknown>),
      declaredCapabilities: modalSandboxCapabilities,
      declaredCapabilityModes: modes,
      findByLabels: async () => null,
      findAllByLabels: async () => [],
      countByLabels: async () => 0,
      launch: async () => ({ id: "x" }),
      uploadBundle: async () => {},
      runScript: async () => ({ output: "", exitCode: 0 }),
      destroy: async () => {},
    }) as unknown as SandboxRuntime;

  const mismatch = (modes: Record<string, string>, needle: string) => {
    assert.throws(
      () => reconcileModalCapabilities(withModes(modes)),
      (error: unknown) =>
        error instanceof ModalCapabilityMismatchError
        && error.mismatches.some((m) => m.includes(needle)),
    );
  };

  it("resolves every mode the adapter declares, none left unknown", () => {
    const caps = resolveSandboxRuntimeCapabilities(runtime(harness()) as SandboxRuntime);
    assert.deepEqual(caps.modes, {
      outputStreams: "buffered",
      filesystem: "ephemeral",
      lifetime: "deadline",
      interactive: "not-exposed",
      snapshots: "not-exposed",
    });
  });

  it("states buffered output, because runScript drains before it returns", () => {
    // Modal's exec really does hand back separate live ReadableStreams; the
    // adapter reads both to completion first, so the port's shape is buffered.
    assert.equal(modalCapabilityModes.outputStreams, "buffered");
    assert.equal(modalWorkflowCapabilities.streamingLogs, false);
  });

  it("states the deadline lifetime that MODAL_STRUCTURALLY_FALSE.neverIdle encodes", () => {
    assert.equal(modalCapabilityModes.lifetime, "deadline");
    assert.ok(MODAL_STRUCTURALLY_FALSE.includes("neverIdle"));
    assert.equal(modalObservedCapabilities.neverIdle, false);
  });

  it("marks pty and snapshots not-exposed, so no canary can promote them", () => {
    // The distinction the absence vocabulary exists for: these are facts about
    // this package's port, not pending observations about Modal. A live probe
    // proving Modal has PTY must not move either cell.
    assert.equal(modalCapabilityModes.interactive, "not-exposed");
    assert.equal(modalCapabilityModes.snapshots, "not-exposed");
    assert.equal(isPendingEvidence(modalCapabilityModes.interactive), false);
    assert.equal(isPendingEvidence(modalCapabilityModes.snapshots), false);
  });

  it("leaves warmLease a pending boolean rather than laundering it through a mode", () => {
    // Modes describe shape, not verification state. warmLease stays false until
    // the live canary, and nothing in the mode table asserts otherwise.
    assert.equal(modalSandboxCapabilities.warmLease, false);
    assert.equal(
      resolveSandboxRuntimeCapabilities(runtime(harness()) as SandboxRuntime).warmLease,
      false,
    );
  });

  it("rejects a never-idle lifetime: Modal always terminates at a deadline", () => {
    mismatch({ lifetime: "never-idle" }, "no no-deadline setting");
  });

  it("rejects a streaming outputStreams mode this port cannot honor", () => {
    mismatch({ outputStreams: "separate-streams" }, 'the honest value is "buffered"');
    mismatch({ outputStreams: "combined-stream" }, 'the honest value is "buffered"');
  });

  it("rejects a persistent filesystem: there is no stop/start to survive", () => {
    mismatch({ filesystem: "persistent" }, "no stop/start pair for state to survive");
  });

  it("rejects promoting pty or snapshots above not-exposed", () => {
    mismatch({ snapshots: "snapshot" }, "declares no snapshot operation");
    mismatch({ snapshots: "snapshot-and-fork" }, "declares no snapshot operation");
  });

  it("the real adapter's own modes pass reconciliation", () => {
    assert.doesNotThrow(() => reconcileModalCapabilities(runtime(harness()) as SandboxRuntime));
  });
});

// --- launch -----------------------------------------------------------------

describe("Modal launch", () => {
  it("always sends an explicit lifetime so nothing inherits Modal's 5-minute default", async () => {
    const h = harness();
    await runtime(h, { maxLifetimeMs: 900_000 }).launch();
    assert.equal(h.creates[0]?.params?.timeoutMs, 900_000);
  });

  it("does NOT conflate createTimeoutSeconds with the sandbox lifetime", async () => {
    const h = harness();
    await runtime(h, { maxLifetimeMs: 900_000 }).launch({ createTimeoutSeconds: 30 });
    // 30s was a deadline on the create call, not a 30s-lived sandbox.
    assert.equal(h.creates[0]?.params?.timeoutMs, 900_000);
  });

  it("stamps the ownership tag on every sandbox it creates", async () => {
    const h = harness();
    await runtime(h).launch({ labels: { lane: "bench" } });
    assert.deepEqual(h.creates[0]?.params?.tags, { lane: "bench", [OWNER_TAG]: PREFIX });
  });

  it("refuses a caller label that would overwrite the ownership tag", async () => {
    const h = harness();
    await assert.rejects(
      () => runtime(h).launch({ labels: { [OWNER_TAG]: "someone-else" } }),
      (error: unknown) => error instanceof ModalTagCollisionError,
    );
    assert.equal(h.creates.length, 0, "no sandbox may be created on a collision");
  });

  it("prefixes sandbox names so two lanes cannot collide in one App", async () => {
    const h = harness();
    await runtime(h).launch({ name: "canary" });
    assert.equal(h.creates[0]?.params?.name, `${PREFIX}-canary`);
  });

  it("generates a unique name when the caller supplies none", async () => {
    const h = harness();
    const rt = runtime(h);
    await rt.launch();
    await rt.launch();
    const [first, second] = h.creates.map((c) => c.params?.name);
    assert.ok(first?.startsWith(`${PREFIX}-`));
    assert.notEqual(first, second);
  });

  it("forwards the configured compute shape and placement", async () => {
    const h = harness();
    await runtime(h, {
      resources: { cpu: 1, memoryMiB: 4096 },
      cloud: "aws",
      regions: ["us-east-1"],
    }).launch();
    const params = h.creates[0]?.params;
    assert.equal(params?.cpu, 1);
    assert.equal(params?.memoryMiB, 4096);
    assert.equal(params?.cloud, "aws");
    assert.deepEqual(params?.regions, ["us-east-1"]);
  });

  it("resolves the App and Image once and reuses them across launches", async () => {
    const h = harness();
    const rt = runtime(h);
    await rt.launch();
    await rt.launch();
    assert.equal(h.appLookups.length, 1);
    assert.equal(h.imageLookups.length, 1);
    assert.equal(h.creates.length, 2);
  });

  it("does not create the App unless explicitly allowed to", async () => {
    const h = harness();
    await runtime(h).launch();
    assert.equal(
      (h.appLookups[0]?.params as { createIfMissing?: boolean })?.createIfMissing,
      false,
    );
  });

  it("returns a handle carrying the configured home and work directories", async () => {
    const h = harness();
    const handle = await runtime(h, { workdir: "/srv/app" }).launch();
    assert.equal(handle.homeDir, HOME_DIR);
    assert.equal(handle.workdir, "/srv/app");
    assert.equal(handle.state, "running");
  });

  it("enforces the create deadline", async () => {
    const h = harness({ createDelayMs: 200 });
    await assert.rejects(
      () => runtime(h).launch({ createTimeoutSeconds: 0.05 }),
      (error: unknown) =>
        error instanceof ModalDeadlineExceededError && error.operation === "launch",
    );
  });

  it("reconciles a create that outlives its deadline instead of leaking it", async () => {
    // The failure mode: the client-side deadline fires, `launch` rejects, and
    // the create keeps going. Once it lands, the sandbox is billed with no
    // handle in reach. The runtime must terminate what it eventually got.
    const h = harness({ createDelayMs: 60 });
    const rt = runtime(h);
    await assert.rejects(
      () => rt.launch({ createTimeoutSeconds: 0.02 }),
      (error: unknown) => error instanceof ModalDeadlineExceededError,
    );
    // `close()` drains reconciliations before releasing the channel, so the
    // orphan is terminated once the create finally resolves.
    await rt.close();
    assert.equal(h.creates.length, 1, "the create call was issued");
    const survivors = [...h.sandboxes.values()].filter((s) => s.terminateCalls.length === 0);
    assert.equal(
      survivors.length,
      0,
      "every provisioned sandbox must have been terminated by the orphan reconciler",
    );
  });

  it("does not cache a failed client factory", async () => {
    let attempts = 0;
    const h = harness();
    const rt = new ModalRuntime({
      ...options(),
      clientFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient");
        }
        return h.client;
      },
    });
    await assert.rejects(() => rt.launch(), /transient/);
    await rt.launch();
    assert.equal(attempts, 2, "a transient construction failure must not poison the runtime");
  });
});

// --- lookup -----------------------------------------------------------------

describe("Modal lookup", () => {
  it("pushes the ownership tag into the server-side filter", async () => {
    const h = harness({ sandboxes: [{ id: "sb-1", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h).findAllByLabels({ lane: "bench" });
    assert.deepEqual(h.lists[0]?.tags, { lane: "bench", [OWNER_TAG]: PREFIX });
  });

  it("never returns another lane's sandbox", async () => {
    const h = harness({
      sandboxes: [
        { id: "mine", tags: { [OWNER_TAG]: PREFIX } },
        { id: "theirs", tags: { [OWNER_TAG]: "other-lane" } },
      ],
    });
    const found = await runtime(h).findAllByLabels({});
    assert.deepEqual(found.map((f) => f.id), ["mine"]);
  });

  it("honours an explicit owned:false audit escape hatch", async () => {
    const h = harness({
      sandboxes: [
        { id: "mine", tags: { [OWNER_TAG]: PREFIX } },
        { id: "theirs", tags: { [OWNER_TAG]: "other-lane" } },
      ],
    });
    const found = await runtime(h).findAllByLabels({}, { owned: false });
    assert.deepEqual(found.map((f) => f.id).sort(), ["mine", "theirs"]);
  });

  it("leaves state undefined rather than guessing when no state filter is asked for", async () => {
    const h = harness({ sandboxes: [{ id: "sb-1", tags: { [OWNER_TAG]: PREFIX } }] });
    const found = await runtime(h).findAllByLabels({});
    assert.equal(found[0]?.state, undefined);
    assert.equal(h.sandboxes.get("sb-1")?.pollCalls, 0, "state must cost nothing unless requested");
  });

  it("derives state by polling only when a state filter is supplied", async () => {
    const h = harness({
      sandboxes: [
        { id: "live", tags: { [OWNER_TAG]: PREFIX }, poll: [null] },
        { id: "dead", tags: { [OWNER_TAG]: PREFIX }, poll: [0] },
      ],
    });
    const found = await runtime(h).findAllByLabels({}, { states: ["running"] });
    assert.deepEqual(found.map((f) => f.id), ["live"]);
    assert.equal(found[0]?.state, "running");
  });

  it("respects excludeIds and limit", async () => {
    const h = harness({
      sandboxes: [
        { id: "a", tags: { [OWNER_TAG]: PREFIX } },
        { id: "b", tags: { [OWNER_TAG]: PREFIX } },
        { id: "c", tags: { [OWNER_TAG]: PREFIX } },
      ],
    });
    const found = await runtime(h).findAllByLabels({}, { excludeIds: ["a"], limit: 1 });
    assert.equal(found.length, 1);
    assert.notEqual(found[0]?.id, "a");
  });

  it("findByLabels returns null rather than throwing when nothing matches", async () => {
    const h = harness();
    assert.equal(await runtime(h).findByLabels({ lane: "absent" }), null);
  });

  it("findByLabels preserves limit:0 rather than coercing it to a one-result lookup", async () => {
    // A caller who asks for zero results is asking a valid question. Overriding
    // that to `limit: 1` would return a match where the caller expected none.
    const h = harness({
      sandboxes: [{ id: "sb-1", tags: { [OWNER_TAG]: PREFIX } }],
    });
    assert.equal(await runtime(h).findByLabels({}, { limit: 0 }), null);
    assert.equal(h.lists.length, 0, "no list call should be issued for a zero-result lookup");
  });

  it("countByLabels stops early at maxCount", async () => {
    const h = harness({
      sandboxes: Array.from({ length: 5 }, (_, i) => ({
        id: `sb-${i}`,
        tags: { [OWNER_TAG]: PREFIX },
      })),
    });
    assert.equal(await runtime(h).countByLabels({}, { maxCount: 2 }), 2);
  });

  it("countByLabels does not treat limit as a count ceiling", async () => {
    // `limit` elsewhere in the port is a page-size hint. Treating it as a
    // count clamp here would silently under-report matching sandboxes.
    const h = harness({
      sandboxes: Array.from({ length: 4 }, (_, i) => ({
        id: `sb-${i}`,
        tags: { [OWNER_TAG]: PREFIX },
      })),
    });
    assert.equal(await runtime(h).countByLabels({}, { limit: 2 }), 4);
  });

  it("treats a sandbox that vanishes before tag verification as a non-match", async () => {
    // The tag-verification round trip races against the sandbox's own
    // termination. If `getTags` throws NotFound, the scan must skip that
    // candidate rather than abort the whole lookup.
    const h = harness({
      sandboxes: [
        { id: "gone", tags: { [OWNER_TAG]: PREFIX } },
        { id: "here", tags: { [OWNER_TAG]: PREFIX } },
      ],
    });
    const gone = h.sandboxes.get("gone")!;
    gone.getTags = async () => {
      throw new NotFoundError("gone between list and tag verify");
    };
    const found = await runtime(h).findAllByLabels({});
    assert.deepEqual(found.map((f) => f.id), ["here"]);
  });

  it("rejects a foreign sandbox even when the server-side filter is ignored", async () => {
    // The attack this guards: a filter that silently stops working would hand
    // back another lane's sandbox as a warm lease, and the caller would exec
    // into it. Worse than returning no lease at all.
    const h = harness({
      listIgnoresTagFilter: true,
      sandboxes: [
        { id: "mine", tags: { [OWNER_TAG]: PREFIX } },
        { id: "theirs", tags: { [OWNER_TAG]: "other-lane" } },
      ],
    });
    const found = await runtime(h).findAllByLabels({});
    assert.deepEqual(found.map((f) => f.id), ["mine"]);
  });

  it("re-checks caller labels too, not just the ownership tag", async () => {
    const h = harness({
      listIgnoresTagFilter: true,
      sandboxes: [
        { id: "right-lane", tags: { [OWNER_TAG]: PREFIX, lane: "bench" } },
        { id: "wrong-lane", tags: { [OWNER_TAG]: PREFIX, lane: "other" } },
      ],
    });
    const found = await runtime(h).findAllByLabels({ lane: "bench" });
    assert.deepEqual(found.map((f) => f.id), ["right-lane"]);
  });

  it("does not miscount when the server-side filter is ignored", async () => {
    const h = harness({
      listIgnoresTagFilter: true,
      sandboxes: [
        { id: "mine", tags: { [OWNER_TAG]: PREFIX } },
        { id: "theirs", tags: { [OWNER_TAG]: "other-lane" } },
      ],
    });
    assert.equal(await runtime(h).countByLabels({}), 1);
  });

  it("skips the verification round trip when there is nothing to check", async () => {
    const h = harness({ sandboxes: [{ id: "any", tags: {} }] });
    // owned:false with no labels cannot reject anything, so it must not pay.
    await runtime(h).findAllByLabels({}, { owned: false });
    assert.equal(h.sandboxes.get("any")?.getTagsCalls, 0);
  });

  it("can be opted out of by a caller who has measured the filter", async () => {
    const h = harness({ sandboxes: [{ id: "mine", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h, { verifyTagsClientSide: false }).findAllByLabels({});
    assert.equal(
      h.sandboxes.get("mine")?.getTagsCalls,
      0,
      "opting out must actually skip the extra round trip",
    );
  });

  it("getById refuses to reattach to a foreign sandbox", async () => {
    const h = harness({ sandboxes: [{ id: "theirs", tags: { [OWNER_TAG]: "other-lane" } }] });
    assert.equal(await runtime(h).getById("theirs"), null);
  });

  it("getById returns null for an unknown id instead of throwing", async () => {
    const h = harness();
    assert.equal(await runtime(h).getById("sb-missing"), null);
  });

  it("getById re-resolves an owned sandbox", async () => {
    const h = harness({ sandboxes: [{ id: "mine", tags: { [OWNER_TAG]: PREFIX } }] });
    const handle = await runtime(h).getById("mine");
    assert.equal(handle?.id, "mine");
  });
});

// --- exec -------------------------------------------------------------------

describe("Modal runScript", () => {
  it("wraps the command in a shell, because Modal exec takes argv not a string", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h).runScript({ id: "sb" }, { command: "echo hi | wc -l" });
    assert.deepEqual(
      h.sandboxes.get("sb")?.execCalls[0]?.command,
      ["sh", "-lc", "echo hi | wc -l"],
    );
  });

  it("hands sandbox.exec the trimmed command, not the raw input", async () => {
    // Trimming validated the command but the original spread the un-trimmed
    // input into exec. Regression pin for that split.
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h).runScript({ id: "sb" }, { command: "  echo trimmed\n" });
    assert.deepEqual(
      h.sandboxes.get("sb")?.execCalls[0]?.command,
      ["sh", "-lc", "echo trimmed"],
    );
  });

  it("refuses to exec against a foreign sandbox", async () => {
    // Without an ownership check on the reattach path, a stale or synthesized
    // handle would let the caller run arbitrary commands in another lane's
    // sandbox.
    const h = harness({ sandboxes: [{ id: "theirs", tags: { [OWNER_TAG]: "other-lane" } }] });
    await assert.rejects(
      () => runtime(h).runScript({ id: "theirs" }, { command: "id" }),
      (error: unknown) => error instanceof ModalForeignSandboxError,
    );
    assert.equal(h.sandboxes.get("theirs")?.execCalls.length, 0);
  });

  it("returns stdout, stderr, and the exit code separately and combined", async () => {
    const h = harness({
      sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX }, stdout: "out", stderr: "err", exitCode: 3 }],
    });
    const result = await runtime(h).runScript({ id: "sb" }, { command: "true" });
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.exitCode, 3);
    assert.equal(result.output, "outerr");
  });

  it("omits truncated rather than claiming output is complete", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    const result = await runtime(h).runScript({ id: "sb" }, { command: "true" });
    assert.equal(result.truncated, undefined);
    assert.equal("truncated" in result, false);
  });

  it("hands the provider the same budget so a runaway command dies without us", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h).runScript({ id: "sb" }, { command: "true", timeoutMs: 5_000 });
    assert.equal(h.sandboxes.get("sb")?.execCalls[0]?.params?.timeoutMs, 5_000);
  });

  it("enforces its own deadline when the provider hangs", async () => {
    const h = harness({
      sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX }, execDelayMs: 200 }],
    });
    await assert.rejects(
      () => runtime(h).runScript({ id: "sb" }, { command: "sleep 10", timeoutMs: 50 }),
      (error: unknown) =>
        error instanceof ModalDeadlineExceededError && error.operation === "runScript",
    );
  });

  it("rejects an empty command", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await assert.rejects(
      () => runtime(h).runScript({ id: "sb" }, { command: "   " }),
      /non-empty command/,
    );
  });

  it("runs in the handle's workdir when one is set", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h).runScript({ id: "sb", workdir: "/tmp/work" }, { command: "pwd" });
    assert.equal(h.sandboxes.get("sb")?.execCalls[0]?.params?.workdir, "/tmp/work");
  });
});

// --- uploads ----------------------------------------------------------------

describe("Modal uploadBundle", () => {
  it("writes string and Buffer sources as bytes", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h).uploadBundle({ id: "sb" }, {
      files: [
        { source: "hello", destination: "/tmp/a.txt" },
        { source: Buffer.from("world"), destination: "/tmp/b.txt" },
      ],
    });
    const writes = h.sandboxes.get("sb")?.writes ?? [];
    assert.equal(writes.length, 2);
    assert.equal(Buffer.from(writes[0]!.bytes).toString("utf8"), "hello");
    assert.equal(Buffer.from(writes[1]!.bytes).toString("utf8"), "world");
  });

  it("rejects a relative destination, naming the offending file", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await assert.rejects(
      () => runtime(h).uploadBundle({ id: "sb" }, {
        files: [{ source: "x", destination: "relative/path.txt" }],
      }),
      /relative\/path\.txt/,
    );
  });

  it("is a no-op for an empty bundle", async () => {
    const h = harness({ sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX } }] });
    await runtime(h).uploadBundle({ id: "sb" }, { files: [] });
    assert.equal(h.sandboxes.get("sb")?.writes.length, 0);
  });

  it("refuses to write to a foreign sandbox", async () => {
    // Without an ownership check on the reattach path, a stale or synthesized
    // handle would let the caller write files into another lane's sandbox.
    const h = harness({ sandboxes: [{ id: "theirs", tags: { [OWNER_TAG]: "other-lane" } }] });
    await assert.rejects(
      () => runtime(h).uploadBundle(
        { id: "theirs" },
        { files: [{ source: "x", destination: "/tmp/a.txt" }] },
      ),
      (error: unknown) => error instanceof ModalForeignSandboxError,
    );
    assert.equal(h.sandboxes.get("theirs")?.writes.length, 0);
  });
});

// --- destroy ----------------------------------------------------------------

describe("Modal destroy", () => {
  it("prefers Modal's own verified-terminated signal", async () => {
    const h = harness({
      sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX }, terminateExitCode: 0 }],
    });
    await runtime(h).destroy({ id: "sb" });
    const sb = h.sandboxes.get("sb")!;
    assert.deepEqual(sb.terminateCalls[0], { wait: true });
    assert.equal(sb.pollCalls, 0, "no polling needed when the provider confirms");
  });

  it("falls back to polling until the sandbox is actually gone", async () => {
    const h = harness({
      sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX }, poll: [null, null, 0] }],
    });
    await runtime(h, { pollIntervalMs: 1 }).destroy({ id: "sb" });
    assert.equal(h.sandboxes.get("sb")!.pollCalls, 3, "must not stop at the first poll");
  });

  it("refuses to terminate a sandbox belonging to another lane", async () => {
    const h = harness({ sandboxes: [{ id: "theirs", tags: { [OWNER_TAG]: "other-lane" } }] });
    await assert.rejects(
      () => runtime(h).destroy({ id: "theirs" }),
      (error: unknown) => error instanceof ModalForeignSandboxError,
    );
    assert.equal(h.sandboxes.get("theirs")!.terminateCalls.length, 0);
  });

  it("treats an already-absent sandbox as success", async () => {
    const h = harness();
    await assert.doesNotReject(() => runtime(h).destroy({ id: "sb-gone" }));
  });

  it("rejects a handle with no id rather than guessing", async () => {
    const h = harness();
    await assert.rejects(() => runtime(h).destroy({ id: "  " }), /non-empty sandbox id/);
  });

  it("gives up on verification at the deadline instead of polling forever", async () => {
    const h = harness({
      sandboxes: [{ id: "sb", tags: { [OWNER_TAG]: PREFIX }, poll: [null] }],
    });
    await assert.rejects(
      () => runtime(h, { destroyTimeoutMs: 60, pollIntervalMs: 10 }).destroy({ id: "sb" }),
      (error: unknown) =>
        error instanceof ModalDeadlineExceededError && error.operation === "destroy",
    );
  });
});

// --- teardown ---------------------------------------------------------------

describe("Modal client lifetime", () => {
  it("closes the gRPC channel, which a Node process needs to exit", async () => {
    const h = harness();
    const rt = runtime(h);
    await rt.launch();
    await rt.close();
    assert.equal(h.closed, 1);
  });

  it("close is safe before any client was ever built, and is idempotent", async () => {
    const h = harness();
    const rt = runtime(h);
    await rt.close();
    await rt.close();
    assert.equal(h.closed, 0);
  });
});
