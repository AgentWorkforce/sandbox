import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BoxdRuntime,
  FreestyleRuntime,
  PACKAGE_NAME,
  resolveSandboxRuntimeCapabilities,
} from "./index.js";

test("package entry point is importable", () => {
  assert.equal(PACKAGE_NAME, "@agent-relay/sandbox");
});

test("must-fire: public Freestyle adapter resolves supported unified capabilities", () => {
  const runtime = new FreestyleRuntime({
    apiKey: "structural-only-never-sent",
    defaultHomeDir: "/root",
    namePrefix: "freestyle-public-contract",
    persistence: { type: "ephemeral" },
  });

  assert.equal(runtime.id, "freestyle");
  assert.equal(resolveSandboxRuntimeCapabilities(runtime).reattach, true);
});

test("must-not-fire: public Freestyle adapter never promotes unsupported unified capabilities", () => {
  const runtime = new FreestyleRuntime({
    apiKey: "structural-only-never-sent",
    defaultHomeDir: "/root",
    namePrefix: "freestyle-public-contract",
    persistence: { type: "ephemeral" },
  });
  const capabilities = resolveSandboxRuntimeCapabilities(runtime);

  assert.equal(capabilities.asyncExec, false);
  assert.equal(capabilities.detachedLaunch, false);
  assert.equal(capabilities.warmLease, false);
  assert.equal(capabilities.lifecycle, false);
});

test("must-fire: public boxd adapter resolves its supported unified capabilities", () => {
  const runtime = new BoxdRuntime({
    apiKey: "structural-only-never-sent",
    namePrefix: "boxd-public-contract",
  });
  const capabilities = resolveSandboxRuntimeCapabilities(runtime);

  assert.equal(runtime.id, "boxd");
  assert.equal(capabilities.reattach, true);
  assert.equal(capabilities.warmLease, true);
  assert.equal(capabilities.lifecycle, true);
  assert.equal(capabilities.modes.filesystem, "persistent");
});

test("must-not-fire: public boxd adapter never promotes capabilities the port does not reach", () => {
  const runtime = new BoxdRuntime({
    apiKey: "structural-only-never-sent",
    namePrefix: "boxd-public-contract",
  });
  const capabilities = resolveSandboxRuntimeCapabilities(runtime);

  assert.equal(capabilities.asyncExec, false);
  assert.equal(capabilities.detachedLaunch, false);
  assert.equal(capabilities.modes.interactive, "not-exposed");
  assert.equal(capabilities.modes.snapshots, "not-exposed");
  assert.equal(runtime.capabilities.pty, false);
  assert.equal(runtime.capabilities.snapshots, false);
});
