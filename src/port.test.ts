import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPendingEvidence,
  resolveSandboxRuntimeCapabilities,
  type ResolvedSandboxRuntimeCapabilities,
  type SandboxRuntime,
  type SandboxRuntimeCapabilities,
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
      interactive: "unknown",
      snapshots: "unknown",
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

  it("separates nobody-checked from not-exposed from provider-cannot", () => {
    // The three-way distinction is the point. A boolean gave all three the
    // same answer, and that is how a capability gets promoted on nothing.
    const notChecked = resolveSandboxRuntimeCapabilities(runtime());
    const portGap = resolveSandboxRuntimeCapabilities(
      runtime({ declaredCapabilityModes: { interactive: "not-exposed" } }),
    );
    const providerCannot = resolveSandboxRuntimeCapabilities(
      runtime({ declaredCapabilityModes: { interactive: "unsupported" } }),
    );
    const all = [
      notChecked.modes.interactive,
      portGap.modes.interactive,
      providerCannot.modes.interactive,
    ];
    assert.equal(new Set(all).size, 3, "all three must be distinguishable");
  });

  it("marks only unknown as pending evidence, so a probe cannot promote the rest", () => {
    assert.equal(isPendingEvidence("unknown"), true);
    // Proving the provider CAN do the thing is not grounds for promoting
    // either of these: one is a fact about our port, the other about the
    // provider. This is the guard that replaces hand-maintained
    // "structurally false" lists.
    assert.equal(isPendingEvidence("not-exposed"), false);
    assert.equal(isPendingEvidence("unsupported"), false);
    // Positive values are established, not pending.
    assert.equal(isPendingEvidence("separate-streams"), false);
    assert.equal(isPendingEvidence("deadline"), false);
  });

  it("lets a deadline lifetime state that never-idle is impossible", () => {
    // Both the Vercel and Modal adapters currently spend a paragraph of prose
    // saying their neverIdle:false is settled rather than unproven. Declaring
    // a deadline lifetime says it in the type instead.
    const resolved = resolveSandboxRuntimeCapabilities(
      runtime({ declaredCapabilityModes: { lifetime: "deadline" } }),
    );
    assert.equal(resolved.modes.lifetime, "deadline");
    assert.equal(isPendingEvidence(resolved.modes.lifetime), false);
  });

  it("memoizes the resolved descriptor per runtime", () => {
    const instance = runtime();
    assert.equal(
      resolveSandboxRuntimeCapabilities(instance),
      resolveSandboxRuntimeCapabilities(instance),
    );
  });

  it(
    "lets a consumer literal-construct SandboxRuntimeCapabilities without modes",
    () => {
      // Source-compat contract: the exported base shape must still accept the
      // five pre-modes fields alone. External TypeScript consumers that built
      // fixtures like this before modes existed compile unchanged.
      const preModesFixture: SandboxRuntimeCapabilities = {
        asyncExec: false,
        reattach: false,
        detachedLaunch: false,
        warmLease: true,
        lifecycle: true,
      };
      assert.equal(preModesFixture.modes, undefined);
    },
  );

  it(
    "resolver returns the stricter ResolvedSandboxRuntimeCapabilities with modes populated",
    () => {
      // The resolver's return type has modes required. Assign into the strict
      // type without a cast: the compiler enforces that modes is present, and
      // the runtime confirms it's populated (with unknowns by default).
      const resolved: ResolvedSandboxRuntimeCapabilities =
        resolveSandboxRuntimeCapabilities(runtime());
      assert.equal(resolved.modes.outputStreams, "unknown");
      assert.equal(resolved.modes.filesystem, "unknown");
    },
  );
});
