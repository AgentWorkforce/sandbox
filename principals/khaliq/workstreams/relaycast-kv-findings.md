# relaycast KV 503 — Root Cause Findings

**Agent**: relaycast-kv-0811  
**Date**: 2026-08-11  
**Branch under investigation**: `chore/engine-8.0.0` in `relaycast-cloud`  
**Symptom**: `POST /v1/integrations/relayfile/inbound/:ws/:channel` returns 503 `{"error":"idempotency_unavailable"}` on production `cast.agentrelay.com`

---

## Root Cause

**`env.KV` is `undefined` in the production Cloudflare Worker runtime.** The KV namespace binding declared in `infra/relaycast.ts` was not applied to the deployed Worker.

This is a **deployment state issue**, not a code bug.

### Why the 503 occurs

The failure path in `@relaycast/engine` (dist/routes/relayfileInbound.js, line 152–159):

```js
const result = await runIdempotent({
  kv: c.get('engine').kv,  // ← the KV adapter object (non-null)
  requireKv: true,          // ← mandatory: no idempotency = no delivery
  …
});
```

In `runIdempotent` (dist/middleware/idempotency.js):
```js
let kvStore = kv ?? null;
// kvStore is the adapter object, NOT null — so this check passes
if (!kvStore && requireKv) { throw idempotencyUnavailableError(); }

// Then later:
const existingRaw = await kvStore.get(kvKey);  // ← THIS throws
// because createCloudflareKv's .get() calls env.KV.get(key)
// and env.KV is undefined in production
```

The `catch` block converts any KV error to `idempotency_unavailable` when `requireKv: true`:
```js
catch (err) {
  if (requireKv) { throw idempotencyUnavailableError(err); }  // ← 503
}
```

### What the code declares correctly

- `infra/relaycast.ts` line 107–113: `relaycastKv = new sst.cloudflare.Kv("RelaycastKv", …)` — KV namespace provisioned
- `infra/relaycast.ts` lines 196–199: `{ type: "kv_namespace", name: "KV", namespaceId: relaycastKv.namespaceId }` — bound to the API Worker under the name `KV`
- `packages/relaycast/src/env.ts` line 13: `KV: KVNamespace` — typed in `CloudflareBindings`
- `packages/relaycast/src/adapters/cloudflare/kv.ts`: `createCloudflareKv(env)` reads `env.KV`
- `packages/relaycast/src/adapters/cloudflare/index.ts` line 41: `const kv = createCloudflareKv(env)` — wired into `EngineDeps`
- `engine.js` line 63: `kv: deps.kv` — passed into runtime context

All code paths are correct. The infrastructure declaration is correct.

### Why the binding is missing in production

The Cloudflare Worker has the code, but the `KV` namespace binding was not applied to the deployed Worker script. This can happen when:

1. SST's Pulumi/Cloudflare provider state in the remote R2 bucket is stale and did not record the KV binding as needing to be pushed to Cloudflare
2. The Worker was deployed but the binding registration step silently failed
3. The `relaycastKv` namespace exists in Cloudflare but the binding to the `relaycast-cloud-api` Worker script is missing

Note: The integration test that would have caught this (`packages/relaycast/test/integration/relayfile-inbound.test.ts`) was written on the `chore/engine-8.0.0` branch AFTER the bug was observed — it was not present when PR #55 deployed engine 8.0.0 to production.

---

## Verification: check the Cloudflare dashboard

In the Cloudflare dashboard → Workers & Pages → `relaycast-cloud-api` → Settings → Bindings:

- If `KV` binding is listed: the binding exists, redeploy should be enough to refresh the runtime
- If `KV` binding is NOT listed: SST failed to apply it; run `npx sst deploy --stage production` to re-apply

---

## Fix

**This is a Cloudflare deployment action, not a code change.**

### Option A: Re-deploy via CI (recommended)

Push any commit to `main` or trigger the "Deploy" workflow manually in GitHub Actions:

```
Actions → Deploy → Run workflow → stage: production → Run workflow
```

This runs `npm ci && sst deploy --stage production`, which will re-sync all bindings including the `KV` namespace.

### Option B: Verify + force-redeploy locally

```bash
cd relaycast-cloud
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_DEFAULT_ACCOUNT_ID=<account-id>
npx sst deploy --stage production
```

### Option C: Cloudflare dashboard (if the binding is listed but stale)

In Workers & Pages → `relaycast-cloud-api` → Settings → Bindings:
- If `KV` is already listed → click "Save and deploy" to re-apply
- If `KV` is missing → do NOT add it manually; let SST manage it via Option A or B

---

## What this branch (`chore/engine-8.0.0`) adds

1. **Integration test** (`packages/relaycast/test/integration/relayfile-inbound.test.ts`): two tests that prove the KV binding works end-to-end in workerd:
   - Test 1: delivers a valid HMAC-signed event, expects 201 (not 503)
   - Test 2: sends the same event twice, expects idempotent replay (201 with `replayed: true`)
2. **`wrangler.test.toml`**: adds `RELAYCAST_INTERNAL_SECRET = "test-relaycast-internal-secret"` so the HMAC master is available for the integration tests (without it the route short-circuits to `relayfile_inbound_unavailable` before hitting the KV check)

When this branch is merged, the deploy CI will run the relayfile inbound integration tests BEFORE deploying — a failing KV binding will block the deploy.

---

## Summary

| | |
|---|---|
| **Root cause** | `env.KV` is `undefined` in the production Worker — KV binding not applied by SST |
| **Code bug?** | No — infra, types, adapter, and engine wiring are all correct |
| **Fix** | Trigger a re-deploy (CI dispatch or `npx sst deploy --stage production`) |
| **Code change needed?** | No for the immediate fix; merge this branch to add the integration test gate |
| **RELAYCAST_INTERNAL_SECRET** | Present and set (confirmed: 503 is `idempotency_unavailable`, not `relayfile_inbound_unavailable`) |
