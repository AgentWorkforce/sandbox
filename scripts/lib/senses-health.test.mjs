import assert from "node:assert/strict";
import test from "node:test";
import { credentialHealth, scopeFreshness } from "./senses-health.mjs";

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

test("scope freshness fails closed on missing or unusable state", () => {
  assert.equal(scopeFreshness(null, NOW).problem, "missing-state");
  assert.equal(scopeFreshness({}, NOW).problem, "never-reconciled");
  assert.equal(
    scopeFreshness({ lastSuccessfulReconcileAt: "nope" }, NOW).problem,
    "invalid-reconcile-time",
  );
});

// The 2026-08-05 regression: the loop retried on schedule and failed every
// time, so the attempt cursor stayed current while the data went twelve hours
// stale. Freshness must ignore `lastReconcileAt` entirely.
test("scope freshness ignores a live attempt cursor over a stale success", () => {
  const state = {
    lastSuccessfulReconcileAt: "2026-08-04T00:00:00.000Z",
    lastReconcileAt: "2026-08-04T11:59:59.000Z",
    staleAfter: "2026-08-04T00:01:00.000Z",
    lastError: { kind: "offline", message: "context deadline exceeded" },
  };
  const verdict = scopeFreshness(state, NOW);
  assert.equal(verdict.fresh, false);
  assert.equal(verdict.problem, "stale");
  assert.equal(verdict.ageMs, 12 * 60 * 60 * 1000);
});

// A healthy scope still skips cycles when DNS to the file host flakes, so a
// deadline built from the mount's own one-minute `staleAfter` would flag
// working scopes and train the reader to ignore the warning.
test("scope freshness tolerates skipped cycles well past staleAfter", () => {
  const verdict = scopeFreshness({
    lastSuccessfulReconcileAt: "2026-08-04T11:55:00.000Z",
    lastReconcileAt: "2026-08-04T11:59:50.000Z",
    staleAfter: "2026-08-04T11:56:00.000Z",
    lastError: { kind: "offline", message: "no such host" },
  }, NOW);
  assert.equal(verdict.fresh, true);
  assert.equal(verdict.ageMs, 5 * 60 * 1000);
});

test("scope freshness draws the line at maxAgeMs", () => {
  assert.equal(
    scopeFreshness({ lastSuccessfulReconcileAt: "2026-08-04T11:45:00.001Z" }, NOW).fresh,
    true,
  );
  assert.equal(
    scopeFreshness({ lastSuccessfulReconcileAt: "2026-08-04T11:44:59.999Z" }, NOW).fresh,
    false,
  );
});
