import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  candidateFromAgent37Instance,
  classifyCandidate,
  extractInstanceArray,
  type ReapCandidate,
} from "./reap-ephemeral.js";

const NOW = 1_700_000_000_000;
const PAST = NOW - 60_000;
const FUTURE = NOW + 60_000;

function cand(over: Partial<ReapCandidate> = {}): ReapCandidate {
  return {
    id: "inst_test",
    attributionTag: null,
    ephemeralUntilMs: null,
    status: null,
    raw: null,
    ...over,
  };
}

describe("classifyCandidate — reap contract", () => {
  it("reaps when BOTH tag and past deadline are present", () => {
    const v = classifyCandidate(cand({ attributionTag: "bench:x", ephemeralUntilMs: PAST }), { nowMs: NOW });
    assert.equal(v.kind, "reap");
  });

  it("skips when the attribution tag is missing (the incident guard)", () => {
    const v = classifyCandidate(cand({ attributionTag: null, ephemeralUntilMs: PAST }), { nowMs: NOW });
    assert.equal(v.kind, "skip-no-attribution");
  });

  it("skips when the attribution tag is an empty string", () => {
    const v = classifyCandidate(cand({ attributionTag: "", ephemeralUntilMs: PAST }), { nowMs: NOW });
    assert.equal(v.kind, "skip-no-attribution");
  });

  it("skips when the deadline is missing even with a valid tag", () => {
    const v = classifyCandidate(cand({ attributionTag: "bench:x", ephemeralUntilMs: null }), { nowMs: NOW });
    assert.equal(v.kind, "skip-no-deadline");
  });

  it("skips when the deadline is malformed (NaN)", () => {
    const v = classifyCandidate(cand({ attributionTag: "bench:x", ephemeralUntilMs: NaN }), { nowMs: NOW });
    assert.equal(v.kind, "skip-malformed-deadline");
  });

  it("skips when the deadline is still in the future", () => {
    const v = classifyCandidate(cand({ attributionTag: "bench:x", ephemeralUntilMs: FUTURE }), { nowMs: NOW });
    assert.equal(v.kind, "skip-not-yet-past");
  });

  it("skips at exact equality (deadline == now is not yet past)", () => {
    const v = classifyCandidate(cand({ attributionTag: "bench:x", ephemeralUntilMs: NOW }), { nowMs: NOW });
    assert.equal(v.kind, "skip-not-yet-past");
  });

  it("skips when the tag does not match the expected filter", () => {
    const v = classifyCandidate(
      cand({ attributionTag: "bench:x", ephemeralUntilMs: PAST }),
      { nowMs: NOW, expectedTag: "bench:y" },
    );
    assert.equal(v.kind, "skip-tag-mismatch");
  });

  it("reaps when the tag matches the expected filter and deadline is past", () => {
    const v = classifyCandidate(
      cand({ attributionTag: "bench:y", ephemeralUntilMs: PAST }),
      { nowMs: NOW, expectedTag: "bench:y" },
    );
    assert.equal(v.kind, "reap");
  });
});

describe("candidateFromAgent37Instance — metadata parsing", () => {
  it("extracts both fields from the expected metadata keys", () => {
    const c = candidateFromAgent37Instance({
      id: "abc",
      status: "running",
      metadata: {
        "_sandbox.attributionTag": "bench:foo",
        "_sandbox.ephemeralUntil": String(PAST),
      },
    });
    assert.equal(c.id, "abc");
    assert.equal(c.attributionTag, "bench:foo");
    assert.equal(c.ephemeralUntilMs, PAST);
    assert.equal(c.status, "running");
  });

  it("returns nulls (not undefined) when the reserved keys are absent", () => {
    const c = candidateFromAgent37Instance({ id: "abc", metadata: { unrelated: "v" } });
    assert.equal(c.attributionTag, null);
    assert.equal(c.ephemeralUntilMs, null);
  });

  it("does NOT treat a caller-set metadata.ephemeral=true as reap-eligible (the incident guard)", () => {
    // This is exactly the 2026-08-22 Agent37 leak shape: caller-set label,
    // no reserved keys. Must NOT be reaped.
    const c = candidateFromAgent37Instance({
      id: "4mrt16bu6v",
      metadata: {
        bench: "agent37-",
        owner: "sandbox-provider-comparison-0819",
        ephemeral: "true",
        probe: "exec-latency",
      },
    });
    assert.equal(c.attributionTag, null);
    assert.equal(c.ephemeralUntilMs, null);
    const v = classifyCandidate(c, { nowMs: NOW });
    assert.equal(v.kind, "skip-no-attribution");
  });

  it("handles numeric ephemeralUntil field (if a provider ever returns one)", () => {
    const c = candidateFromAgent37Instance({
      id: "x",
      metadata: {
        "_sandbox.attributionTag": "t",
        "_sandbox.ephemeralUntil": PAST,
      },
    });
    assert.equal(c.ephemeralUntilMs, PAST);
  });

  it("returns NaN for a non-numeric string deadline so the classifier can report malformed", () => {
    const c = candidateFromAgent37Instance({
      id: "x",
      metadata: {
        "_sandbox.attributionTag": "t",
        "_sandbox.ephemeralUntil": "not-a-timestamp",
      },
    });
    assert.ok(Number.isNaN(c.ephemeralUntilMs));
    const v = classifyCandidate(c, { nowMs: NOW });
    assert.equal(v.kind, "skip-malformed-deadline");
  });
});

describe("extractInstanceArray — list-shape tolerance", () => {
  it("returns an array as-is", () => {
    assert.deepEqual(extractInstanceArray([{ id: "a" }]), [{ id: "a" }]);
  });
  it("unwraps { data: [...] }", () => {
    assert.deepEqual(extractInstanceArray({ data: [{ id: "a" }] }), [{ id: "a" }]);
  });
  it("unwraps { instances: [...] }", () => {
    assert.deepEqual(extractInstanceArray({ instances: [{ id: "a" }] }), [{ id: "a" }]);
  });
  it("returns [] for null / non-object", () => {
    assert.deepEqual(extractInstanceArray(null), []);
    assert.deepEqual(extractInstanceArray("not an array"), []);
  });
});
