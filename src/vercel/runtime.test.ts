import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import * as pkg from "../index.js";
import { resolveSandboxRuntimeCapabilities } from "../port.js";
import type { RuntimeHandle } from "../types.js";
import {
  vercelObservedCapabilities,
  vercelSandboxCapabilities,
  vercelWorkflowCapabilities,
} from "./capabilities.js";
import type { VercelRuntimeOptions } from "./config.js";
import type {
  VercelCommandLike,
  VercelCreateParams,
  VercelListParams,
  VercelRunCommandParams,
  VercelSandboxApiLike,
  VercelSandboxLike,
  VercelSandboxListItem,
  VercelSandboxListPage,
} from "./internal/sdk.js";
import {
  reconcileVercelCapabilities,
  VercelCapabilityMismatchError,
  VercelDestroyVerificationError,
  VercelForeignSandboxError,
  VercelListPageLimitError,
  VercelOperationTimeoutError,
  VercelSandboxRuntime,
  VercelTagLimitError,
  VercelUnknownExitCodeError,
} from "./runtime.js";

const HOME_DIR = "/vercel/sandbox";
const PREFIX = "awf-test";

// --- fake provider -----------------------------------------------------------

type Row = {
  name: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  tags?: Record<string, string>;
  vcpus?: number;
  memory?: number;
  totalActiveCpuDurationMs?: number;
  totalDurationMs?: number;
};

type CommandRecord = {
  cmdId: string;
  params: VercelRunCommandParams;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type FakeOptions = {
  rows?: Row[];
  /** Called for each `list`; return a page to take over pagination entirely. */
  listPages?: VercelSandboxListPage[];
  /** Ignore the `tags` filter, emulating a provider that drops the parameter. */
  ignoreTagFilter?: boolean;
  exec?: (params: VercelRunCommandParams) => Partial<CommandRecord>;
  onDelete?: (name: string) => void;
  hangOnList?: boolean;
};

class FakeVercel {
  readonly rows = new Map<string, Row>();
  readonly creates: VercelCreateParams[] = [];
  readonly gets: Array<{ name: string; resume?: boolean }> = [];
  readonly lists: VercelListParams[] = [];
  readonly commands: CommandRecord[] = [];
  readonly writes: Array<Array<{ path: string; content: string | Uint8Array }>> =
    [];
  readonly mkdirs: string[] = [];
  readonly stops: string[] = [];
  readonly deletes: string[] = [];
  private listPageIndex = 0;
  private cmdSeq = 0;

  constructor(private readonly options: FakeOptions = {}) {
    for (const row of options.rows ?? []) {
      this.rows.set(row.name, { ...row });
    }
  }

  get api(): VercelSandboxApiLike {
    return {
      create: async (params) => {
        this.creates.push(params);
        const row: Row = {
          name: params.name,
          status: "running",
          createdAt: 1_700_000_000_000 + this.creates.length,
          tags: params.tags ? { ...params.tags } : undefined,
          vcpus: params.resources?.vcpus,
        };
        this.rows.set(row.name, row);
        return this.handle(row.name);
      },
      get: async ({ name, resume }) => {
        this.gets.push({ name, resume });
        const row = this.rows.get(name);
        if (!row) {
          throw notFound(name);
        }
        if (resume) {
          row.status = "running";
        }
        return this.handle(name);
      },
      list: async (params) => {
        this.lists.push(params);
        if (this.options.hangOnList) {
          return new Promise<VercelSandboxListPage>(() => {});
        }
        if (this.options.listPages) {
          const page = this.options.listPages[this.listPageIndex];
          this.listPageIndex += 1;
          return page ?? { sandboxes: [], pagination: { count: 0, next: null } };
        }
        const sandboxes = [...this.rows.values()]
          .filter((row) =>
            params.namePrefix ? row.name.startsWith(params.namePrefix) : true,
          )
          .filter((row) => {
            if (!params.tags || this.options.ignoreTagFilter) {
              return true;
            }
            return Object.entries(params.tags).every(
              ([key, value]) => row.tags?.[key] === value,
            );
          })
          .map((row) => ({ ...row })) as VercelSandboxListItem[];
        return { sandboxes, pagination: { count: sandboxes.length, next: null } };
      },
    };
  }

  private handle(name: string): VercelSandboxLike {
    const fake = this;
    const row = () => {
      const found = fake.rows.get(name);
      if (!found) {
        throw notFound(name);
      }
      return found;
    };
    return {
      get name() {
        return name;
      },
      get status() {
        return row().status;
      },
      get createdAt() {
        return new Date(row().createdAt);
      },
      get updatedAt() {
        return new Date(row().updatedAt ?? row().createdAt);
      },
      get vcpus() {
        return row().vcpus;
      },
      get memory() {
        return row().memory;
      },
      currentSession: () => ({ sessionId: `session-${name}` }),
      runCommand: async (params) => {
        fake.cmdSeq += 1;
        const override = fake.options.exec?.(params) ?? {};
        const record: CommandRecord = {
          cmdId: `cmd-${fake.cmdSeq}`,
          params,
          exitCode: params.detached ? null : 0,
          stdout: "",
          stderr: "",
          ...override,
        };
        fake.commands.push(record);
        return toCommand(record);
      },
      getCommand: async (cmdId) => {
        const found = fake.commands.find((entry) => entry.cmdId === cmdId);
        if (!found) {
          throw notFound(cmdId);
        }
        return toCommand(found);
      },
      writeFiles: async (files) => {
        fake.writes.push(files.map((file) => ({ ...file })));
      },
      readFileToBuffer: async ({ path }) =>
        path === "/missing" ? null : Buffer.from(`contents:${path}`),
      mkDir: async (path) => {
        fake.mkdirs.push(path);
      },
      stop: async () => {
        fake.stops.push(name);
        row().status = "stopped";
        return {};
      },
      delete: async () => {
        fake.deletes.push(name);
        if (fake.options.onDelete) {
          fake.options.onDelete(name);
        } else {
          fake.rows.delete(name);
        }
      },
    };
  }
}

function toCommand(record: CommandRecord): VercelCommandLike {
  return {
    cmdId: record.cmdId,
    get exitCode() {
      return record.exitCode;
    },
    output: async (stream = "both") => {
      if (stream === "stdout") return record.stdout;
      if (stream === "stderr") return record.stderr;
      return `${record.stdout}${record.stderr}`;
    },
  };
}

function notFound(what: string): Error {
  const error = new Error(`not found: ${what}`) as Error & {
    response: { status: number };
  };
  error.response = { status: 404 };
  return error;
}

function options(
  overrides: Partial<VercelRuntimeOptions> = {},
): VercelRuntimeOptions {
  return {
    token: "tok",
    teamId: "team_1",
    projectId: "prj_1",
    namePrefix: PREFIX,
    defaultHomeDir: HOME_DIR,
    pollIntervalMs: 1,
    lifecycleTimeoutMs: 200,
    deleteTimeoutMs: 200,
    ...overrides,
  };
}

function makeRuntime(
  fake: FakeVercel,
  overrides: Partial<VercelRuntimeOptions> = {},
): VercelSandboxRuntime {
  return new VercelSandboxRuntime(options(overrides), {
    apiFactory: () => fake.api,
  });
}

// --- tests -------------------------------------------------------------------

describe("public barrel", () => {
  it("exports the Vercel runtime and its typed errors", () => {
    assert.equal(typeof pkg.VercelSandboxRuntime, "function");
    assert.equal(typeof pkg.VercelDestroyVerificationError, "function");
    assert.equal(typeof pkg.VercelForeignSandboxError, "function");
    assert.equal(typeof pkg.VercelUnknownExitCodeError, "function");
    assert.equal(typeof pkg.VercelOperationTimeoutError, "function");
  });
});

describe("VercelSandboxRuntime construction", () => {
  it("requires token, team, project, prefix and home directory", () => {
    for (const field of [
      "token",
      "teamId",
      "projectId",
      "namePrefix",
      "defaultHomeDir",
    ] as const) {
      assert.throws(
        () => new VercelSandboxRuntime(options({ [field]: "  " })),
        /required|must be/i,
        `expected ${field} to be required`,
      );
    }
  });

  it("rejects a name prefix that is not a safe lowercase label", () => {
    for (const bad of ["Awf_Test", "awf test", "-awf", "awf-"]) {
      assert.throws(
        () => new VercelSandboxRuntime(options({ namePrefix: bad })),
        /lowercase alphanumeric/,
      );
    }
  });

  it("rejects non-positive vcpus and out-of-range ports", () => {
    assert.throws(
      () => new VercelSandboxRuntime(options({ vcpus: 0 })),
      /positive integer/,
    );
    assert.throws(
      () => new VercelSandboxRuntime(options({ ports: [70_000] })),
      /Invalid Vercel port/,
    );
  });

  it("rejects more than the provider's 15-port limit", () => {
    // A configuration the provider will reject at create time is caught here
    // so the failure is visible against the port that set it, not the launch.
    const tooMany = Array.from({ length: 16 }, (_, i) => 3_000 + i);
    assert.throws(
      () => new VercelSandboxRuntime(options({ ports: tooMany })),
      /at most 15 ports/,
    );
    // The exact 15 must still pass.
    const okay = Array.from({ length: 15 }, (_, i) => 3_000 + i);
    assert.doesNotThrow(() => new VercelSandboxRuntime(options({ ports: okay })));
  });

  it("rejects a name prefix that leaves no room for the generated suffix", () => {
    // The bare launch appends `-<16 hex>` (17 chars) to the prefix. A prefix
    // longer than 46 characters would push a generated name past the 63-char
    // budget, so validation catches it here rather than at the provider.
    const tooLong = "a".repeat(47);
    assert.throws(
      () => new VercelSandboxRuntime(options({ namePrefix: tooLong })),
      /leave 17 characters of room/,
    );
    // The exact 46-character boundary must still pass.
    const okay = "a".repeat(46);
    assert.doesNotThrow(
      () => new VercelSandboxRuntime(options({ namePrefix: okay })),
    );
  });

  it("declares capabilities conservatively pending live evidence", () => {
    assert.deepEqual(vercelSandboxCapabilities, {
      warmLease: false,
      lifecycle: false,
    });
    assert.equal(vercelWorkflowCapabilities.isolation, "strong");
    assert.equal(vercelWorkflowCapabilities.persistentHandle, true);
    assert.equal(vercelWorkflowCapabilities.pty, false);
    assert.equal(vercelWorkflowCapabilities.snapshots, false);
    assert.equal(vercelWorkflowCapabilities.streamingLogs, false);
    // Every observed cell stays false until a dated live probe promotes it.
    for (const [key, value] of Object.entries(vercelObservedCapabilities)) {
      assert.equal(value, false, `${key} must not be claimed without evidence`);
    }
  });

  it("throws when an observed capability is claimed without an implementation", () => {
    // `fork` has no implementation behind it, so claiming it must fail at
    // construction rather than at some later call site.
    vercelObservedCapabilities.fork = true;
    try {
      assert.throws(
        () => makeRuntime(new FakeVercel()),
        /capability declaration mismatch: fork/,
      );
    } finally {
      vercelObservedCapabilities.fork = false;
    }
  });

  it("rejects a fake runtime that claims a capability it does not implement", () => {
    const complete = {
      getById() {},
      findAllByLabels() {},
      start() {},
      stop() {},
      destroy() {},
      listOwned() {},
    };
    // The real declarations are all conservative, so a complete surface passes.
    reconcileVercelCapabilities(complete);

    // persistentHandle is declared true, so losing getById must be caught.
    const { getById, ...withoutGetById } = complete;
    assert.throws(
      () => reconcileVercelCapabilities(withoutGetById),
      VercelCapabilityMismatchError,
    );

    // cleanupVerified is the cell queued for promotion. Prove the check that
    // will gate that promotion actually bites before we rely on it.
    vercelObservedCapabilities.cleanupVerified = true;
    try {
      reconcileVercelCapabilities(complete); // implemented: allowed
      const { listOwned, ...withoutAudit } = complete;
      assert.throws(
        () => reconcileVercelCapabilities(withoutAudit),
        VercelCapabilityMismatchError,
        "cleanupVerified must not be claimable without an audit surface",
      );
    } finally {
      vercelObservedCapabilities.cleanupVerified = false;
    }
  });

  it("permits a conservative under-claim, which is how evidence gating works", () => {
    // start/stop are implemented while `lifecycle` declares false. That is
    // deliberate: the orchestrator reads the declaration, not the methods, so
    // an under-claim is safe and is the only way a capability can wait for live
    // evidence. Forbidding it would make the evidence discipline impossible.
    assert.equal(vercelSandboxCapabilities.lifecycle, false);
    const runtime = makeRuntime(new FakeVercel());
    assert.equal(typeof runtime.start, "function");
    assert.equal(typeof runtime.stop, "function");
    assert.equal(resolveSandboxRuntimeCapabilities(runtime).lifecycle, false);
  });

  it("resolves port capabilities from the implemented surface", () => {
    const runtime = makeRuntime(new FakeVercel());
    const capabilities = resolveSandboxRuntimeCapabilities(runtime);
    // Async submit + poll would be reachable through the SDK, but Vercel's
    // `runCommand` has no admission key, so a `startScript` retry after a lost
    // response cannot be reconciled with the first submission and would
    // duplicate the workload. The adapter deliberately omits the trio until
    // that guarantee exists.
    assert.equal(capabilities.asyncExec, false);
    assert.equal(capabilities.reattach, true);
    // Create resolves only when the sandbox is running, so there is no
    // mid-boot handle and the method is deliberately absent.
    assert.equal(capabilities.detachedLaunch, false);
    assert.equal(capabilities.warmLease, false);
    assert.equal(capabilities.lifecycle, false);
  });
});

describe("VercelSandboxRuntime launch", () => {
  it("creates a prefixed sandbox with tags, merged env and resources", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake, {
      vcpus: 4,
      sandboxTimeoutMs: 600_000,
      persistent: true,
      ports: [3000],
      env: { BASE: "1" },
      source: { type: "image", image: "vercel/sandbox/universal" },
    });

    const handle = await runtime.launch({
      labels: { job: "build" },
      env: { EXTRA: "2" },
    });

    assert.equal(fake.creates.length, 1);
    const params = fake.creates[0]!;
    assert.equal(params.name.startsWith(`${PREFIX}-`), true);
    assert.deepEqual(params.tags, { job: "build" });
    assert.deepEqual(params.env, { BASE: "1", EXTRA: "2" });
    assert.deepEqual(params.resources, { vcpus: 4 });
    assert.equal(params.timeout, 600_000);
    assert.equal(params.persistent, true);
    assert.deepEqual(params.ports, [3000]);
    assert.equal(params.image, "vercel/sandbox/universal");
    assert.equal("runtime" in params, false);
    assert.equal(handle.id, params.name);
    assert.equal(handle.state, "STARTED");
    assert.equal(handle.homeDir, HOME_DIR);
  });

  it("slugs a caller-supplied name under the owned prefix and salts collisions", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);

    await runtime.launch({ name: "Issue Greeter!" });
    await runtime.launch({ name: "issue/greeter" });

    const [first, second] = fake.creates.map((entry) => entry.name);
    assert.match(first!, /^awf-test-issue-greeter-[0-9a-f]{8}$/);
    assert.match(second!, /^awf-test-issue-greeter-[0-9a-f]{8}$/);
    // Two names that slug identically must not collide onto one sandbox.
    assert.notEqual(first, second);
  });

  it("keeps a name that is already inside the owned prefix", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    await runtime.launch({ name: `${PREFIX}-explicit` });
    assert.equal(fake.creates[0]!.name, `${PREFIX}-explicit`);
  });

  it("honours createTimeoutSeconds as the create deadline", async () => {
    const fake = new FakeVercel({ hangOnList: true });
    const runtime = new VercelSandboxRuntime(options(), {
      apiFactory: () => ({
        ...fake.api,
        create: () => new Promise(() => {}),
      }),
    });
    await assert.rejects(
      runtime.launch({ createTimeoutSeconds: 0.02 }),
      (error: unknown) =>
        error instanceof VercelOperationTimeoutError
        && error.operation === "create"
        && error.timeoutMs === 20,
    );
  });

  it("rejects more tags than the provider accepts", async () => {
    const runtime = makeRuntime(new FakeVercel());
    await assert.rejects(
      runtime.launch({
        labels: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" },
      }),
      VercelTagLimitError,
    );
  });

  it("rejects environment variable names a shell could not export", async () => {
    const runtime = makeRuntime(new FakeVercel());
    await assert.rejects(
      runtime.launch({ env: { "BAD-NAME": "x" } }),
      /Invalid Vercel environment variable name/,
    );
  });

  it("destroys the sandbox when an acquired lease leaves scope", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    let leased = "";
    {
      await using lease = await runtime.acquire({ labels: { job: "scoped" } });
      leased = lease.handle.id;
      assert.equal(fake.rows.has(leased), true);
    }
    assert.deepEqual(fake.deletes, [leased]);
    assert.equal(fake.rows.has(leased), false);
  });
});

describe("VercelSandboxRuntime lookup", () => {
  const rows: Row[] = [
    {
      name: `${PREFIX}-a`,
      status: "running",
      createdAt: 10,
      tags: { job: "build" },
    },
    {
      name: `${PREFIX}-b`,
      status: "stopped",
      createdAt: 20,
      tags: { job: "build" },
    },
    {
      name: `${PREFIX}-c`,
      status: "running",
      createdAt: 30,
      tags: { job: "other" },
    },
    { name: "someone-else-a", status: "running", createdAt: 40, tags: { job: "build" } },
  ];

  it("queries by owned prefix and tags, defaulting to running sandboxes", async () => {
    const fake = new FakeVercel({ rows });
    const runtime = makeRuntime(fake);

    const found = await runtime.findAllByLabels({ job: "build" });

    assert.deepEqual(fake.lists[0]!.namePrefix, PREFIX);
    assert.deepEqual(fake.lists[0]!.tags, { job: "build" });
    assert.deepEqual(
      found.map((handle) => handle.id),
      [`${PREFIX}-a`],
    );
    assert.equal(found[0]!.state, "STARTED");
  });

  it("re-verifies tags locally so an ignored server filter cannot leak a foreign sandbox", async () => {
    // The provider here accepts the `tags` parameter and ignores it.
    const fake = new FakeVercel({ rows, ignoreTagFilter: true });
    const runtime = makeRuntime(fake);

    const found = await runtime.findAllByLabels({ job: "build" });

    assert.deepEqual(
      found.map((handle) => handle.id),
      [`${PREFIX}-a`],
      "unfiltered rows must be rejected client-side",
    );
  });

  it("honours explicit states, excludeIds and limit", async () => {
    const fake = new FakeVercel({ rows });
    const runtime = makeRuntime(fake);

    const stopped = await runtime.findAllByLabels(
      { job: "build" },
      { states: ["STOPPED"] },
    );
    assert.deepEqual(
      stopped.map((handle) => handle.id),
      [`${PREFIX}-b`],
    );

    const all = await runtime.findAllByLabels({}, { states: null });
    assert.deepEqual(
      all.map((handle) => handle.id),
      [`${PREFIX}-a`, `${PREFIX}-b`, `${PREFIX}-c`],
      "foreign names are never returned even with no tag filter",
    );

    const excluded = await runtime.findAllByLabels(
      {},
      { states: null, excludeIds: [`${PREFIX}-a`], limit: 1 },
    );
    assert.deepEqual(
      excluded.map((handle) => handle.id),
      [`${PREFIX}-b`],
    );
  });

  it("returns null and zero when nothing matches", async () => {
    const fake = new FakeVercel({ rows });
    const runtime = makeRuntime(fake);
    assert.equal(await runtime.findByLabels({ job: "absent" }), null);
    assert.equal(await runtime.countByLabels({ job: "absent" }), 0);
    assert.equal(await runtime.countByLabels({ job: "build" }), 1);
  });

  it("re-resolves by name through list, never resuming the sandbox", async () => {
    const fake = new FakeVercel({ rows });
    const runtime = makeRuntime(fake);

    const handle = await runtime.getById(`${PREFIX}-b`);

    assert.equal(handle?.id, `${PREFIX}-b`);
    assert.equal(handle?.state, "STOPPED");
    assert.equal(handle?.createdAt, new Date(20).toISOString());
    assert.deepEqual(
      fake.gets,
      [],
      "getById must not call Sandbox.get, which resumes and bills the sandbox",
    );
  });

  it("returns null for an absent name or a state mismatch", async () => {
    const fake = new FakeVercel({ rows });
    const runtime = makeRuntime(fake);
    assert.equal(await runtime.getById(`${PREFIX}-missing`), null);
    assert.equal(
      await runtime.getById(`${PREFIX}-b`, { states: ["STARTED"] }),
      null,
    );
  });

  it("lists owned sandboxes, hiding terminated ones unless asked", async () => {
    const fake = new FakeVercel({
      rows: [
        ...rows,
        {
          name: `${PREFIX}-dead`,
          status: "aborted",
          createdAt: 50,
          vcpus: 2,
          memory: 4096,
          totalActiveCpuDurationMs: 1_234,
          totalDurationMs: 60_000,
        },
      ],
    });
    const runtime = makeRuntime(fake);

    const live = await runtime.listOwned();
    assert.equal(
      live.some((entry) => entry.name === `${PREFIX}-dead`),
      false,
    );

    const all = await runtime.listOwned({ includeTerminated: true });
    const dead = all.find((entry) => entry.name === `${PREFIX}-dead`)!;
    assert.equal(dead.terminated, true);
    assert.equal(dead.state, "FAILED");
    assert.equal(dead.providerStatus, "aborted");
    assert.equal(dead.activeCpuMs, 1_234);
    assert.equal(dead.wallClockMs, 60_000);
    assert.equal(
      all.some((entry) => entry.name === "someone-else-a"),
      false,
    );
  });

  it("walks cursor pages and refuses to truncate silently past the cap", async () => {
    const page = (name: string, next: string | null): VercelSandboxListPage => ({
      sandboxes: [
        { name, status: "running", createdAt: 1 } as VercelSandboxListItem,
      ],
      pagination: { count: 1, next },
    });
    const paged = new FakeVercel({
      listPages: [
        page(`${PREFIX}-p1`, "cursor-2"),
        page(`${PREFIX}-p2`, null),
      ],
    });
    const runtime = makeRuntime(paged);
    const found = await runtime.findAllByLabels({}, { states: null });
    assert.deepEqual(
      found.map((handle) => handle.id),
      [`${PREFIX}-p1`, `${PREFIX}-p2`],
    );
    assert.equal(paged.lists[1]!.cursor, "cursor-2");

    const endless = new FakeVercel({
      listPages: Array.from({ length: 10 }, () => page(`${PREFIX}-x`, "more")),
    });
    const capped = makeRuntime(endless, { maxListPages: 3 });
    await assert.rejects(
      capped.findAllByLabels({}, { states: null }),
      VercelListPageLimitError,
    );
  });

  it("rejects a malformed list payload rather than treating it as empty", async () => {
    const runtime = new VercelSandboxRuntime(options(), {
      apiFactory: () => ({
        create: async () => {
          throw new Error("unused");
        },
        get: async () => {
          throw new Error("unused");
        },
        list: async () => ({
          sandboxes: [{ name: `${PREFIX}-x` } as VercelSandboxListItem],
          pagination: { count: 1, next: null },
        }),
      }),
    });
    await assert.rejects(
      runtime.findAllByLabels({}, { states: null }),
      /list item 0 is malformed/,
    );
  });
});

describe("VercelSandboxRuntime exec", () => {
  async function launched(fake: FakeVercel, overrides = {}) {
    const runtime = makeRuntime(fake, overrides);
    const handle = await runtime.launch({});
    return { runtime, handle };
  }

  it("runs a script through sh -c and passes cwd and env as provider fields", async () => {
    const fake = new FakeVercel({
      exec: () => ({ stdout: "hi\n", exitCode: 0 }),
    });
    const { runtime, handle } = await launched(fake);

    const result = await runtime.runScript(handle, {
      command: "echo hi; echo 'quoted $HOME'",
      cwd: "/work",
      env: { TOKEN: "a'b" },
      timeoutMs: 5_000,
    });

    const command = fake.commands[0]!;
    assert.equal(command.params.cmd, "sh");
    assert.deepEqual(command.params.args, [
      "-c",
      "echo hi; echo 'quoted $HOME'",
    ]);
    assert.equal(command.params.cwd, "/work");
    // The value is handed over as data, never spliced into the script text.
    assert.deepEqual(command.params.env, { TOKEN: "a'b" });
    assert.equal(command.params.timeoutMs, 5_000);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "hi\n");
    assert.equal(result.cmdId, "cmd-1");
    assert.equal(
      "truncated" in result,
      false,
      "truncation must stay unreported rather than claimed complete",
    );
  });

  it("combines stdout and stderr with a separating newline", async () => {
    const fake = new FakeVercel({
      exec: () => ({ stdout: "out", stderr: "err", exitCode: 3 }),
    });
    const { runtime, handle } = await launched(fake);
    const result = await runtime.runScript(handle, { command: "x" });
    assert.equal(result.output, "out\nerr");
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.exitCode, 3);
  });

  it("refuses to report success when the provider reports no exit code", async () => {
    const fake = new FakeVercel({ exec: () => ({ exitCode: null }) });
    const { runtime, handle } = await launched(fake);
    await assert.rejects(
      runtime.exec(handle, "true"),
      VercelUnknownExitCodeError,
    );
  });

  it("rejects an exec on a handle this runtime never attached", async () => {
    const runtime = makeRuntime(new FakeVercel());
    await assert.rejects(
      runtime.exec({ id: `${PREFIX}-ghost` } as RuntimeHandle, "true"),
      /is not attached/,
    );
  });

  it("does not expose detached submit + poll until admission is idempotent", async () => {
    // Vercel's `runCommand` has no admission key, so a `startScript` retry
    // after a lost response would submit a second command against the same
    // sandbox rather than reconcile with the first. Until the SDK offers
    // idempotent submission — or this adapter builds reconciliation on top of
    // it — the trio is omitted so the resolver reports `asyncExec: false`
    // rather than promising a guarantee we cannot keep.
    const runtime = makeRuntime(new FakeVercel());
    assert.equal((runtime as unknown as { startScript?: unknown }).startScript, undefined);
    assert.equal(
      (runtime as unknown as { getScriptStatus?: unknown }).getScriptStatus,
      undefined,
    );
    assert.equal(
      (runtime as unknown as { getScriptLogs?: unknown }).getScriptLogs,
      undefined,
    );
  });
});

describe("VercelSandboxRuntime files", () => {
  it("creates parents, writes one batch and verifies the destinations landed", async () => {
    const fake = new FakeVercel({ exec: () => ({ exitCode: 0 }) });
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});

    await runtime.uploadBundle(handle, {
      files: [
        { source: Buffer.from("a"), destination: "/work/one/a.txt" },
        { source: Buffer.from("b"), destination: "/work/one/b.txt" },
      ],
      manifest: { ok: true },
      manifestPath: "/work/two/manifest.json",
    });

    assert.deepEqual(fake.mkdirs, ["/work/one", "/work/two"]);
    assert.equal(fake.writes.length, 1, "files go up in a single batched call");
    assert.deepEqual(
      fake.writes[0]!.map((file) => file.path),
      ["/work/one/a.txt", "/work/one/b.txt", "/work/two/manifest.json"],
    );
    const verification = fake.commands.at(-1)!;
    assert.match(verification.params.args![1]!, /test -f '\/work\/one\/a.txt'/);
    assert.match(
      verification.params.args![1]!,
      /test -f '\/work\/two\/manifest.json'/,
    );
  });

  it("fails the upload when verification cannot confirm the files", async () => {
    const fake = new FakeVercel({ exec: () => ({ exitCode: 1 }) });
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});
    await assert.rejects(
      runtime.uploadFile(handle, Buffer.from("x"), "/work/x.txt"),
      /Failed to verify uploaded Vercel bundle files/,
    );
  });

  it("downloads to a buffer and reports a missing source instead of returning empty", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});

    const bytes = await runtime.downloadFile(handle, "/present");
    assert.equal(Buffer.isBuffer(bytes), true);
    assert.equal((bytes as Buffer).toString("utf8"), "contents:/present");

    await assert.rejects(
      runtime.downloadFile(handle, "/missing"),
      /has no file at "\/missing"/,
    );
  });

  it("returns the configured home directory", async () => {
    const runtime = makeRuntime(new FakeVercel());
    const handle = await runtime.launch({});
    assert.equal(await runtime.getHomeDir(handle), HOME_DIR);
  });
});

describe("VercelSandboxRuntime lifecycle", () => {
  it("stops a running sandbox and waits for it to settle", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});

    await runtime.stop(handle);

    assert.deepEqual(fake.stops, [handle.id]);
    assert.equal(handle.state, "STOPPED");
  });

  it("does not re-issue a stop for an already stopped sandbox", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});
    fake.rows.get(handle.id)!.status = "stopped";

    await runtime.stop(handle);

    assert.deepEqual(fake.stops, []);
    assert.equal(handle.state, "STOPPED");
  });

  it("resumes a stopped sandbox through the provider's resume path", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});
    fake.rows.get(handle.id)!.status = "stopped";

    await runtime.start(handle);

    assert.deepEqual(fake.gets, [{ name: handle.id, resume: true }]);
    assert.equal(handle.state, "STARTED");
  });

  it("refuses to resume a sandbox in a terminal state", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});
    fake.rows.get(handle.id)!.status = "failed";
    await assert.rejects(runtime.start(handle), /is failed and cannot be resumed/);
  });

  it("refuses to mutate a sandbox outside the owned prefix", async () => {
    const fake = new FakeVercel({
      rows: [{ name: "other-teams-box", status: "running", createdAt: 1 }],
    });
    const runtime = makeRuntime(fake);
    // Attach as owned so only the prefix guard can stop the mutation.
    const handle = await runtime.getById("other-teams-box", { owned: true });
    assert.ok(handle);
    await assert.rejects(runtime.stop(handle!), VercelForeignSandboxError);
    await assert.rejects(runtime.destroy(handle!), VercelForeignSandboxError);
    assert.deepEqual(fake.deletes, []);
  });
});

describe("VercelSandboxRuntime destroy", () => {
  it("deletes and verifies absence before forgetting the sandbox", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});

    await runtime.destroy(handle);

    assert.deepEqual(fake.deletes, [handle.id]);
    assert.equal(fake.rows.has(handle.id), false);
    // Forgotten: a second destroy is a no-op rather than a second delete.
    await runtime.destroy(handle);
    assert.deepEqual(fake.deletes, [handle.id]);
  });

  it("raises and stays retryable when absence cannot be verified", async () => {
    const fake = new FakeVercel({ onDelete: () => {} });
    const runtime = makeRuntime(fake, { deleteTimeoutMs: 30 });
    const handle = await runtime.launch({});

    await assert.rejects(
      runtime.destroy(handle),
      VercelDestroyVerificationError,
    );

    // The registration survives, so cleanup can be retried instead of the
    // leaked sandbox becoming invisible to this runtime.
    fake.rows.delete(handle.id);
    await runtime.destroy(handle);
    assert.deepEqual(fake.deletes, [handle.id, handle.id]);
  });

  it("treats a same-name sandbox with a different createdAt as proof ours is gone", async () => {
    const fake = new FakeVercel({
      onDelete: (name) => {
        // The name is freed and immediately reused by a different sandbox.
        fake.rows.set(name, { name, status: "running", createdAt: 999_999 });
      },
    });
    const runtime = makeRuntime(fake, { deleteTimeoutMs: 50 });
    const handle = await runtime.launch({});

    await runtime.destroy(handle);

    assert.deepEqual(fake.deletes, [handle.id]);
  });

  it("verifies absence even when the delete call reports not found", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});
    fake.rows.delete(handle.id);

    await runtime.destroy(handle);

    assert.equal(fake.rows.has(handle.id), false);
  });

  it("ignores a handle it never attached", async () => {
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    await runtime.destroy({ id: `${PREFIX}-unknown` } as RuntimeHandle);
    assert.deepEqual(fake.deletes, []);
  });
});

describe("VercelSandboxRuntime deadlines", () => {
  it("bounds a lookup that never returns with a typed timeout", async () => {
    const fake = new FakeVercel({ hangOnList: true });
    const runtime = makeRuntime(fake, { lookupTimeoutMs: 25 });
    await assert.rejects(
      runtime.getById(`${PREFIX}-any`),
      (error: unknown) =>
        error instanceof VercelOperationTimeoutError
        && error.timeoutMs === 25,
    );
  });

  it("caps any single operation at the absolute SDK retry deadline", async () => {
    const fake = new FakeVercel({ hangOnList: true });
    // The per-operation deadline is generous; the retry deadline is the real
    // ceiling, and it must win.
    const runtime = makeRuntime(fake, {
      lookupTimeoutMs: 60_000,
      retryDeadlineMs: 25,
    });
    await assert.rejects(
      runtime.getById(`${PREFIX}-any`),
      (error: unknown) =>
        error instanceof VercelOperationTimeoutError
        && error.timeoutMs === 25
        // The error names the cap that actually fired, so 25ms is not reported
        // as a breach of the 60s budget.
        && error.operation.includes("SDK retry ceiling"),
    );
  });

  it("shares one budget across the round trips of a composite operation", async () => {
    // Two round trips (run the command, then fetch its output) against a
    // provider that stalls on the second. A per-call timeout would allow the
    // stall to consume its own fresh 40ms budget; one shared budget must
    // report the whole operation's timeout as the one that fired, and must
    // only invoke `output` once — the same shared deadline that admitted the
    // first call must be already expired for the second.
    let outputCalls = 0;
    const fake = new FakeVercel();
    const runtime = makeRuntime(fake);
    const handle = await runtime.launch({});
    const sandbox = await (runtime as unknown as {
      sandbox(name: string): Promise<{ runCommand: unknown }>;
    }).sandbox(handle.id);
    const original = sandbox.runCommand as (p: unknown) => Promise<unknown>;
    (sandbox as { runCommand: unknown }).runCommand = async (p: unknown) => {
      const command = (await original.call(sandbox, p)) as { output: unknown };
      command.output = async () => {
        outputCalls += 1;
        return new Promise<string>(() => {});
      };
      return command;
    };

    await assert.rejects(
      runtime.runScript(handle, { command: "x", timeoutMs: 40 }),
      (error: unknown) =>
        error instanceof VercelOperationTimeoutError
        // The error must name the shared budget the caller asked for (40ms),
        // not a fresh 40ms budget spawned inside the second round trip.
        && error.timeoutMs === 40
        && error.operation === "command",
    );
    // Exactly one `output` call — the second round trip never got its own
    // 40ms allowance because the first drained the shared deadline.
    assert.equal(
      outputCalls,
      1,
      "output must be attempted once against one shared budget, not twice",
    );
  });
});
