import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveSandboxRuntimeCapabilities,
  type SandboxRuntime,
} from "./port.js";

/** Minimal runtime: only what the resolver actually inspects. */
function runtime(overrides: Partial<SandboxRuntime> = {}): SandboxRuntime {
  return {
    id: "fake",
    findByLabels: async () => null,
    findAllByLabels: async () => [],
    countByLabels: async () => 0,
    launch: async () => ({ id: "s" }),
    uploadBundle: async () => {},
    runScript: async () => ({ output: "", exitCode: 0 }),
    destroy: async () => {},
    ...overrides,
  } as SandboxRuntime;
}

describe("capability modes", () => {
  it("defaults every mode to unknown rather than to a plausible value", () => {
    const resolved = resolveSandboxRuntimeCapabilities(runtime());
    assert.deepEqual(resolved.modes, {
      outputStreams: "unknown",
      filesystem: "unknown",
      lifetime: "unknown",
    });
  });

  it("keeps the existing boolean defaults untouched for an undeclared runtime", () => {
    // The whole point of an additive change: a runtime that declares nothing
    // must behave exactly as it did before modes existed.
    const resolved = resolveSandboxRuntimeCapabilities(runtime());
    assert.equal(resolved.warmLease, true);
    assert.equal(resolved.lifecycle, true);
    assert.equal(resolved.asyncExec, false);
    assert.equal(resolved.reattach, false);
    assert.equal(resolved.detachedLaunch, false);
  });

  it("carries the modes a provider does declare", () => {
    const resolved = resolveSandboxRuntimeCapabilities(
      runtime({
        declaredCapabilityModes: {
          outputStreams: "separate-streams",
          lifetime: "deadline",
        },
      }),
    );
    assert.equal(resolved.modes.outputStreams, "separate-streams");
    assert.equal(resolved.modes.lifetime, "deadline");
    // Undeclared stays unknown even when a sibling is declared.
    assert.equal(resolved.modes.filesystem, "unknown");
  });

  it("distinguishes the three things a false boolean used to conflate", () => {
    // "cannot stream" and "nobody checked" are different answers to a caller
    // picking a provider, and the boolean gave them the same one.
    const cannot = resolveSandboxRuntimeCapabilities(
      runtime({ declaredCapabilityModes: { outputStreams: "buffered" } }),
    );
    const unchecked = resolveSandboxRuntimeCapabilities(runtime());
    assert.notEqual(cannot.modes.outputStreams, unchecked.modes.outputStreams);
  });

  it("memoizes the resolved descriptor per runtime", () => {
    const instance = runtime();
    assert.equal(
      resolveSandboxRuntimeCapabilities(instance),
      resolveSandboxRuntimeCapabilities(instance),
    );
  });
});
