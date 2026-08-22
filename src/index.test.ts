import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
