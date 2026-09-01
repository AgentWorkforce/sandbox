import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { SandboxOrchestrator } from "./orchestrator.js";

const MOUNT = {
  baseUrl: "https://file.agentrelay.com",
  workspaceId: "rw_7ccfea89",
  localDir: "/home/daytona/workspace",
  stateDir: "/home/daytona/.relayfile-mount-state",
  token: "relay_ag_example",
};

/** Records every command; reports the initial sync as already exited 0. */
function recordingRuntime() {
  const commands: string[] = [];
  const orchestrator = new SandboxOrchestrator<{ id: string }>({
    provision: async () => ({ id: "sbx" }),
    uploadBundle: async () => {},
    runScript: async (_handle, options) => {
      commands.push(options.command);
      return { output: "relayfile-initial-sync-exit:0", exitCode: 0 };
    },
    teardown: async () => {},
  });
  return { orchestrator, commands };
}

/**
 * The outer idle watchdog and relayfile-mount's own bootstrap watchdog are a
 * matched pair — `startMount` exports its idle budget as
 * RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT, so this value sets BOTH.
 *
 * It must not sit below relayfile's own `defaultBootstrapIdleTimeout` (90s).
 * The mount's atomic full-tree export is silent for up to its 45s
 * `defaultExportTimeout` before falling back to the resumable tree pull that
 * checkpoints, so the first progress signal a cold mount can emit arrives
 * well after 60s. A 60s budget killed healthy cold mounts a few seconds into
 * their first real page — see AgentWorkforce/sandbox-router#11.
 */
describe("startMount initial-sync idle budget", () => {
  it("finishes the one-shot initial sync before starting the daemon", async () => {
    const { orchestrator, commands } = recordingRuntime();
    await orchestrator.startMount({ id: "sbx" }, MOUNT);

    const initialSyncIndex = commands.findIndex((command) =>
      command.includes("relayfile-initial-sync-exit:"),
    );
    const daemonIndex = commands.findIndex((command) =>
      command.includes("nohup relayfile-mount"),
    );

    assert.notEqual(initialSyncIndex, -1, "initial sync was never launched");
    assert.notEqual(daemonIndex, -1, "daemon was never started");
    assert.ok(
      initialSyncIndex < daemonIndex,
      "daemon must not hold the mount lease while one-shot initial sync runs",
    );
  });

  it("defaults to 90s, matching relayfile's own bootstrap idle timeout", async () => {
    const { orchestrator, commands } = recordingRuntime();
    await orchestrator.startMount({ id: "sbx" }, MOUNT);

    const armed = commands.filter((command) =>
      command.includes("RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT="),
    );
    assert.ok(armed.length > 0, "no command exported RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT");
    for (const command of armed) {
      assert.match(
        command,
        /RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=90s/u,
        "idle budget must not drop below relayfile's 90s defaultBootstrapIdleTimeout",
      );
    }
  });

  it("still honours an explicit initialSyncIdleTimeoutMs", async () => {
    const { orchestrator, commands } = recordingRuntime();
    await orchestrator.startMount({ id: "sbx" }, MOUNT, {
      initialSyncIdleTimeoutMs: 150_000,
    });

    assert.ok(
      commands.some((command) =>
        command.includes("RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=150s"),
      ),
      "explicit idle timeout was not propagated",
    );
  });

  it("classifies a rejected readiness status transport as a probe failure", async () => {
    let calls = 0;
    const orchestrator = new SandboxOrchestrator<{ id: string }>({
      provision: async () => ({ id: "sbx" }),
      uploadBundle: async () => {},
      runScript: async () => {
        calls += 1;
        if (calls === 3) throw new Error("status transport unavailable");
        return { output: "ok", exitCode: 0 };
      },
      teardown: async () => {},
    });

    await assert.rejects(
      orchestrator.startMount({ id: "sbx" }, MOUNT),
      /Failed to check relayfile initial sync status: status transport unavailable/u,
    );
    assert.equal(calls, 3);
  });

  it("resumes an incomplete initial sync before starting the daemon", async () => {
    const commands: string[] = [];
    let statusChecks = 0;
    const orchestrator = new SandboxOrchestrator<{ id: string }>({
      provision: async () => ({ id: "sbx" }),
      uploadBundle: async () => {},
      runScript: async (_handle, options) => {
        commands.push(options.command);
        if (
          options.command.includes("relayfile-initial-sync-exit:") &&
          !options.command.includes("nohup sh -c")
        ) {
          statusChecks += 1;
          return {
            output: `relayfile-initial-sync-exit:${statusChecks === 1 ? 75 : 0}`,
            exitCode: 0,
          };
        }
        if (options.command.startsWith("tail -n ")) {
          return {
            output: "relayfile initial sync paused before complete readiness",
            exitCode: 0,
          };
        }
        return { output: "ok", exitCode: 0 };
      },
      teardown: async () => {},
    });

    await orchestrator.startMount({ id: "sbx" }, MOUNT, {
      initialSyncPollIntervalMs: 0,
    });
    assert.equal(statusChecks, 2);
    assert.equal(
      commands.filter((command) => command.includes("nohup sh -c")).length,
      2,
    );
    assert.equal(
      commands.some((command) => command.includes("nohup relayfile-mount")),
      true,
    );
  });

  it("does not resume incomplete readiness beyond the overall deadline", async () => {
    const commands: string[] = [];
    const orchestrator = new SandboxOrchestrator<{ id: string }>({
      provision: async () => ({ id: "sbx" }),
      uploadBundle: async () => {},
      runScript: async (_handle, options) => {
        commands.push(options.command);
        if (
          options.command.includes("relayfile-initial-sync-exit:") &&
          !options.command.includes("nohup sh -c")
        ) {
          return { output: "relayfile-initial-sync-exit:75", exitCode: 0 };
        }
        return { output: "ok", exitCode: 0 };
      },
      teardown: async () => {},
    });

    await assert.rejects(
      orchestrator.startMount({ id: "sbx" }, MOUNT, {
        initialSyncDeadlineMs: 0,
        initialSyncPollIntervalMs: 0,
      }),
      /Relayfile initial sync did not finish within 0s after resumable incomplete readiness/u,
    );
    assert.equal(
      commands.filter((command) => command.includes("nohup sh -c")).length,
      1,
    );
    assert.equal(
      commands.some((command) => command.includes("nohup relayfile-mount")),
      false,
    );
  });

  it("classifies a rejected mount-path transport before replacement starts", async () => {
    const cause = new Error("mkdir transport unavailable");
    const orchestrator = new SandboxOrchestrator<{ id: string }>({
      provision: async () => ({ id: "sbx" }),
      uploadBundle: async () => {},
      runScript: async () => {
        throw cause;
      },
      teardown: async () => {},
    });

    await assert.rejects(
      orchestrator.startMount({ id: "sbx" }, MOUNT, { killExisting: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /Failed to create relayfile mount path: mkdir transport unavailable/u,
        );
        assert.equal(error.cause, cause);
        return true;
      },
    );
  });

  it("classifies a rejected initial-sync launch transport", async () => {
    // The launch exec is the first long-lived call in startMount. Daytona's
    // proxy read timeout is ~120s, so a rejection here is exactly what a
    // wedged mount looks like from the outside — and while this call was
    // unwrapped, the raw transport error matched none of the message prefixes
    // callers classify on, so it fell through to their "unknown" bucket and
    // the real cause was discarded. See AgentWorkforce/sandbox#45.
    const cause = new Error("read ETIMEDOUT after 120000ms");
    let calls = 0;
    const orchestrator = new SandboxOrchestrator<{ id: string }>({
      provision: async () => ({ id: "sbx" }),
      uploadBundle: async () => {},
      runScript: async () => {
        calls += 1;
        if (calls === 2) throw cause;
        return { output: "ok", exitCode: 0 };
      },
      teardown: async () => {},
    });

    await assert.rejects(
      orchestrator.startMount({ id: "sbx" }, MOUNT),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /Failed to launch relayfile initial sync: read ETIMEDOUT after 120000ms/u,
        );
        assert.equal(error.cause, cause);
        return true;
      },
    );
    assert.equal(calls, 2);
  });

  it("classifies a rejected daemon-start transport", async () => {
    // The other formerly-unwrapped exec. Reached only after the initial sync
    // reports a clean exit, so it needs the full happy path in front of it.
    const cause = new Error("read ETIMEDOUT after 120000ms");
    const orchestrator = new SandboxOrchestrator<{ id: string }>({
      provision: async () => ({ id: "sbx" }),
      uploadBundle: async () => {},
      runScript: async (_handle, options) => {
        if (options.command.includes("nohup relayfile-mount")) throw cause;
        if (options.command.includes("relayfile-initial-sync-exit:")) {
          return { output: "relayfile-initial-sync-exit:0", exitCode: 0 };
        }
        return { output: "ok", exitCode: 0 };
      },
      teardown: async () => {},
    });

    await assert.rejects(
      orchestrator.startMount({ id: "sbx" }, MOUNT),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /Failed to start relayfile mount: read ETIMEDOUT after 120000ms/u,
        );
        assert.equal(error.cause, cause);
        return true;
      },
    );
  });

  it("requests a complete readiness traversal with bounded foreground concurrency", async () => {
    const { orchestrator, commands } = recordingRuntime();
    await orchestrator.startMount({ id: "sbx" }, MOUNT);

    const initialSync = commands.find((command) =>
      command.includes("RELAYFILE_BOOTSTRAP_READ_CONCURRENCY="),
    );
    assert.ok(initialSync, "initial sync was never launched");
    assert.match(
      initialSync,
      /export RELAYFILE_BOOTSTRAP_MAX_FILES_PER_CYCLE=-1/u,
    );
    assert.match(
      initialSync,
      /export RELAYFILE_BOOTSTRAP_READ_CONCURRENCY=64/u,
    );

    const daemon = commands.find((command) => command.includes("nohup relayfile-mount"));
    assert.ok(daemon, "daemon was never started");
    assert.doesNotMatch(daemon, /RELAYFILE_BOOTSTRAP_MAX_FILES_PER_CYCLE/u);
    assert.doesNotMatch(daemon, /RELAYFILE_BOOTSTRAP_READ_CONCURRENCY/u);
  });

  it("honours explicit initial-sync traversal controls", async () => {
    const { orchestrator, commands } = recordingRuntime();
    await orchestrator.startMount({ id: "sbx" }, MOUNT, {
      initialSyncMaxFilesPerCycle: 8_000,
      initialSyncReadConcurrency: 32,
    });

    const initialSync = commands.find((command) =>
      command.includes("RELAYFILE_BOOTSTRAP_READ_CONCURRENCY="),
    );
    assert.ok(initialSync, "initial sync was never launched");
    assert.match(
      initialSync,
      /export RELAYFILE_BOOTSTRAP_MAX_FILES_PER_CYCLE=8000/u,
    );
    assert.match(
      initialSync,
      /export RELAYFILE_BOOTSTRAP_READ_CONCURRENCY=32/u,
    );
  });

  it("rejects invalid initial-sync traversal controls before touching the sandbox", async () => {
    for (const options of [
      { initialSyncMaxFilesPerCycle: 0 },
      { initialSyncMaxFilesPerCycle: -2 },
      { initialSyncReadConcurrency: 0 },
      { initialSyncReadConcurrency: 65 },
      { initialSyncReadConcurrency: 1.5 },
    ]) {
      const { orchestrator, commands } = recordingRuntime();
      await assert.rejects(
        orchestrator.startMount({ id: "sbx" }, MOUNT, options),
        /initialSync(?:MaxFilesPerCycle|ReadConcurrency)/u,
      );
      assert.deepEqual(commands, []);
    }
  });
});
