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

  it("makes the readiness sync complete and uses bounded foreground concurrency", async () => {
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
