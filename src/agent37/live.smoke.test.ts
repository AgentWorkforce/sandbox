import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Agent37ApiError, Agent37Client } from "../index.js";

// ---------------------------------------------------------------------------
// Live contract smoke test against the real Agent37 hosting API.
//
// Gated three ways and READ-ONLY by construction. It lists instances and
// probes the authentication failure path; it never creates, starts, resizes,
// or deletes anything, so running it provisions nothing and meters nothing.
//
// Run it with the credential injected into the process environment at the
// moment of the check and nowhere else, for example:
//
//   AGENT37_LIVE_SMOKE=1 AGENT37_API_URL=<hosting-api-origin> \
//     op run --env-file=<(echo 'AGENT37_API_KEY=op://<vault>/<item>/API_KEY') -- \
//     npm test
//
// The key is read from `process.env` here and is never asserted on, printed,
// interpolated into a URL, or included in an assertion message.
// ---------------------------------------------------------------------------

const enabled = process.env.AGENT37_LIVE_SMOKE === "1";
const apiKey = process.env.AGENT37_API_KEY ?? "";
const baseUrl = process.env.AGENT37_API_URL ?? "";

const skip = !enabled
  ? "AGENT37_LIVE_SMOKE is not 1"
  : !apiKey
    ? "AGENT37_API_KEY is not set"
    : !baseUrl
      ? "AGENT37_API_URL is not set"
      : false;

const DOCUMENTED_STATUSES = new Set([
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "starting",
  "restarting",
  "updating",
  "sleeping",
  "waking",
  "failed",
  "deleting",
  "deleted",
]);

describe("Agent37 live contract smoke (read-only)", () => {
  it("lists instances in the documented envelope", { skip }, async () => {
    const client = new Agent37Client({ apiKey, baseUrl, maxAttempts: 2 });
    const response = await client.hosting<{ data?: unknown }>("GET", "/v1/instances", {
      timeoutMs: 30_000,
    });

    assert.ok(Array.isArray(response.data), "GET /v1/instances must return { data: [...] }");
    for (const raw of response.data as unknown[]) {
      const instance = raw as { id?: unknown; status?: unknown };
      assert.equal(typeof instance.id, "string");
      assert.match(instance.id as string, /^[a-z0-9]{10}$/, "instance ids are 10 lowercase alphanumerics");
      assert.ok(
        DOCUMENTED_STATUSES.has(instance.status as string),
        `undocumented status: ${String(instance.status)}`,
      );
    }
  });

  it("rejects a bogus credential with invalid_api_key", { skip }, async () => {
    // Deliberately not a real key: this asserts the failure contract without
    // ever sending, comparing, or revealing the live credential.
    const client = new Agent37Client({
      apiKey: "not-a-real-key-contract-probe",
      baseUrl,
      maxAttempts: 1,
    });
    await assert.rejects(
      client.hosting("GET", "/v1/instances", { timeoutMs: 30_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Agent37ApiError);
        assert.equal(error.status, 401);
        assert.equal(error.code, "invalid_api_key");
        return true;
      },
    );
  });
});
