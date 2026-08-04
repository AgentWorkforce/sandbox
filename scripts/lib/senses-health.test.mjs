import assert from "node:assert/strict";
import test from "node:test";
import { credentialHealth } from "./senses-health.mjs";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

test("credential health fails closed when expiry is absent", () => {
  assert.deepEqual(credentialHealth(null, NOW), {
    healthy: false,
    problem: "missing-expiry",
  });
});

test("credential health fails closed when expiry is malformed", () => {
  assert.deepEqual(credentialHealth("not-a-date", NOW), {
    healthy: false,
    problem: "invalid-expiry",
  });
});

test("credential health rejects expired and boundary credentials", () => {
  assert.equal(
    credentialHealth("2026-08-04T11:59:59.999Z", NOW).problem,
    "expired",
  );
  assert.equal(
    credentialHealth("2026-08-04T12:00:00.000Z", NOW).problem,
    "expired",
  );
});

test("credential health accepts a parseable future expiry", () => {
  assert.deepEqual(
    credentialHealth("2026-08-04T12:00:00.001Z", NOW),
    { healthy: true, problem: null },
  );
});
