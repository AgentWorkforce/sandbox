---
status: active
owner: unassigned
previous_owner: relayscribe-lead-0811
reports_to: chief
updated: 2026-08-11
repos: [relayscribe, cloud]
---

Goal: the recorder authenticates as the signed-in user, no shared secret exists in
any client artifact, and an auth failure never destroys a recording.

## Now — 2026-08-11 — the spec is written and reviewable; nothing is implemented

`docs/recorder-auth-spec.md` on branch `docs/recorder-auth-spec`
(`08ff21a`), open as **`relayscribe#9`**. 452 lines, every §1 claim read out of
current source or observed live on 2026-08-10 against relayscribe `main`
(`0d471bc`) and cloud `main`.

**Three stacked defects.** The first makes the product non-functional; the second
makes it insecure; the third makes the failure invisible.

1. **Transcription cannot succeed from any build of current source.** The worker
   compares the bearer against one shared secret
   (`transcription-worker/src/index.ts:232,1005`); the sidecar sends the
   signed-in user's Relay access token (`sidecar/src/server.ts:107`). Every
   request returns `401`. Proven live: a valid unexpired credential, correct
   request shape, healthy worker — `HTTP 401 in 0.1s`. The commit
   `fix(auth): push the signed-in credential to the sidecar` moved the client and
   never moved the worker; the unused import at `server.ts:44` is the seam where
   the change stopped.
2. **The shared secret ships in plaintext inside every distributed `.app`.** One
   `grep` against a downloaded DMG yields a working backend credential with no
   per-user attribution, no rate limit, and no revocation short of rotating for
   everyone. Injected at `release-mac-app.yml:138`.
3. **A `401` burns all three retries and the recording is skipped forever.**
   `transcribeAudio` throws a generic `transcribe_failed` for any non-OK status
   (`brainstorm-pipeline.ts:105`); `MAX_RETRIES = 3` with `2^(n-1) × 2min`
   backoff (`recording-persistence.ts:28,69`). The user sees a recording that
   never became a transcript and an app that still says they are signed in.

**Tenancy rides on a body claim.** Because the token carries no identity, the
ingest route takes the workspace from `relay_workspace_id` in the request body
(`transcripts/route.ts:21-23,39`). The caller asserts its own tenancy — survivable
only while the token is secret, and it is not secret.

**The client never refreshes on the path that needs it.** `validCredential()`
refreshes within 120s of expiry but is called only from the integrations UI
(`RelayAccount.swift:192,221`); `workspaceCredential` — the value pushed to the
sidecar — reads `accessToken` with no expiry check (`:52-56`). Observed lifetimes:
access ≈22h, refresh ≈7d. **A menu-bar app running past ~22 hours hands the
sidecar a dead token**, and no existing test covers it.

## RULED — 2026-08-11 — disclosure accepted, containment deferred

**Khaliq: "its fine we can contain that token later."** Disclosure risk from
§1.4 (the repo is public, the spec names the DMG-extraction recipe, and the
secret it targets was not yet rotated) is **accepted, not mitigated**. Same
shape as the `opencode.json` call — a bounded, deliberate risk acceptance, not
an oversight. `relayscribe#9` is no longer held on this question.

**What this does and does not change.** It clears the *content* hold — the
spec can stay published and normal work on this workstream can proceed. It
does **not** grant merge authority: Khaliq owns every merge gate per standing
rule, and this ruling was about the disclosure, not about who presses merge.
It also does not cancel Phase 0 — "contain later" means the rotation below is
still the acceptance criterion for closing the exposure, just not a
precondition for anything else in this workstream.

## Next

1. **Phase 0 — rotate `RECORDER_TRANSCRIBE_TOKEN`** across worker, ingest route
   and release secret, ship one build carrying the new value. No longer
   blocking, but it is the deferred containment Khaliq's ruling promised — do
   not let it drift indefinitely.
2. Cloud: `POST /api/v1/auth/introspect` + the `recorder:transcribe` scope,
   delegating to `resolveApiTokenSession()` (`api-token-store.ts:211`).
   `{active:false}` identically for unknown, revoked and expired — the difference
   is an oracle.
3. Cloud: `authenticateRecorder` with **dual accept**, SHA-256-keyed cache
   (60s positive / 10s negative), `auth_path` logging.
4. Cloud: ingest takes the worker-resolved identity; **delete** the body-claim path.
5. Relayscribe: sidecar 401 taxonomy, **park-not-retry**, drain on new credential,
   `GET /auth/state`.
6. Relayscribe: app refreshes before **every** recording, re-pushes on
   `needs-auth`, shows the state in the menu bar.
7. Relayscribe: drop the release injection, add an entropy gate to the build.
8. Ship, run acceptance **including the 22-hour test**, then drain and remove
   the shared secret.

**Needs a lead.** This is cross-repo (cloud + relayscribe), has a security phase
that must go first, and has three open questions in §9 that are product calls —
who mints `recorder:transcribe`, whether `/recall/create-upload` moves on the
same clock, and what self-hosted backends do without a reachable introspection
target.

## Implementation — 2026-08-11 — code merged, operational acceptance remains

**Lead:** `relayscribe-lead-0811`. Appointed 05:15Z. Preflight complete 05:20Z.

**Defects confirmed** against current source — all three match the spec exactly.

**BLOCKED ON CHIEF — Phase 0 rotation** (per contract §3):
- Rotating `RECORDER_TRANSCRIBE_TOKEN` requires `sst secret set` + worker redeploy + new build.
- New `TRANSCRIPTION_WORKER_SERVICE_TOKEN` (service credential for worker→introspect) also needs provisioning.
- Absent Khaliq's ruling: code prepared, rotation not executed.

**Three open questions surfaced to chief** (product calls):
1. Who mints `recorder:transcribe` — all device tokens or per-workspace entitlement? Default: all.
2. Does `/recall/create-upload` move on the same clock as `/transcribe`? Default: yes.
3. Self-hosted backends without reachable introspection?

**PRs merged by Khaliq:**

- **cloud#2985** merged 09:03Z. It provides `POST /api/v1/auth/introspect`,
  `recorder:transcribe`, dual-accept authentication, cache/logging, ingest
  identity repair, and the service-token SST secret.
- **relayscribe#10** merged 10:17Z with its build, CodeRabbit, and cubic checks
  green. It provides the sidecar 401 taxonomy, park-not-retry behavior,
  credential refresh/drain path, menu state, and entropy gate.

**Verification coverage (from spec §7):**
- ✅ Introspect returns `{active:false}` identically for unknown/revoked/expired
- ✅ Worker rejects: no bearer, wrong token, insufficient_scope, revoked
- ✅ Worker accepts valid scoped token, forwards resolved workspace
- ✅ Ingest rejects body `relay_workspace_id` when user-token auth used
- ✅ Sidecar 401 parks recording, retryCount untouched (and rolled back from pre-attempt bump)
- ✅ Ingest 401 also parks recording (fixed: was consuming a retry)
- ✅ New credential drains parked recordings
- ✅ Sidecar has new token before upload starts (await pushWorkspaceCredential)
- ✅ 503 still consumes a retry
- ✅ Swift: credential refreshed before recording starts
- ✅ Release gate fails on high-entropy string in bundle (python3, not broken grep -P)
- ⬜ Manual acceptance (incl. 22-hour test) — pending Phase 0 rotation, deploy,
  and a shipped build

## History

- **2026-08-11 cleanup checkpoint** — both implementation PRs were verified
  merged. `relayscribe-lead-0811` had been waiting 250 minutes with no pending
  messages and was released. The lane remains active and unassigned because
  Phase 0 secret rotation, deploy/build, the 22-hour test, and eventual removal
  of the shared secret are operational work, not completed by the merges.
- **2026-08-11** — Khaliq ruled: *"its fine we can contain that token later."*
  Disclosure risk accepted, Phase 0 rotation deferred rather than cancelled.
  Workstream unblocked.
- **2026-08-11** — Workstream opened by Chief on Khaliq's instruction to place
  `docs/recorder-auth-spec.md`. Chief's own finding on filing it: the repo is
  public and the spec is an exploit path for an unrotated credential. Raised
  rather than edited.
- **2026-08-10** — Spec written and pushed as `relayscribe#9` (`08ff21a`).
  Evidence gathered live against production with a valid Keychain credential.
