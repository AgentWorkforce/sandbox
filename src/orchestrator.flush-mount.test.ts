import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  SandboxOrchestrator,
  type SandboxRunScriptOptions,
} from "./orchestrator.js";

function recordingOrchestrator(): {
  orchestrator: SandboxOrchestrator<string>;
  calls: SandboxRunScriptOptions[];
} {
  const calls: SandboxRunScriptOptions[] = [];
  return {
    calls,
    orchestrator: new SandboxOrchestrator<string>({
      runScript: async (_handle, options) => {
        calls.push(options);
        return { output: "", exitCode: 0 };
      },
    }),
  };
}

describe("flushMount exact-root timeout budget", () => {
  it("keeps the pathless mount at one default allowance", async () => {
    const { orchestrator, calls } = recordingOrchestrator();

    await orchestrator.flushMount("sandbox-1", {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/home/daytona/workspace",
      stateDir: "/home/daytona/.relayfile-mount-state",
      token: "relay_pa_test",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.timeoutMs, 120_000);
  });

  it("budgets the requested allowance for every sequential exact root", async () => {
    const { orchestrator, calls } = recordingOrchestrator();

    await orchestrator.flushMount(
      "sandbox-1",
      {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        localDir: "/home/daytona/workspace",
        stateDir: "/home/daytona/.relayfile-mount-state",
        token: "relay_pa_test",
        paths: [
          "/slack/channels/C123/**",
          "/github/repos/acme/cloud/**",
          "/linear/issues/TEAM/**",
        ],
      },
      { timeoutMs: 120_000 },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.timeoutMs, 360_000);
  });
});
