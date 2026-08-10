/**
 * A mount credential is healthy only when its expiry is known, parseable, and
 * strictly in the future. Unknown expiry must fail closed: otherwise a live
 * mount process can make stale projections look current.
 */
export function credentialHealth(expiresAt, nowMs = Date.now()) {
  if (typeof expiresAt !== "string" || expiresAt.trim().length === 0) {
    return { healthy: false, problem: "missing-expiry" };
  }

  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    return { healthy: false, problem: "invalid-expiry" };
  }
  if (expiryMs <= nowMs) {
    return { healthy: false, problem: "expired" };
  }
  return { healthy: true, problem: null };
}

/**
 * How stale a single scope's projection is.
 *
 * The field that carries the meaning is `lastSuccessfulReconcileAt`, not
 * `lastReconcileAt`. The attempt cursor advancing proves only that the sync
 * loop is alive; on 2026-08-05 every mount was retrying on schedule and
 * failing, and `senses/github` sat twelve hours behind while the doctor
 * reported OK. A scope is fresh only when a reconcile actually *succeeded*
 * recently.
 *
 * The tolerance is deliberately much looser than the mount's own `staleAfter`,
 * which is stamped about a minute past the last reconcile. Observed behaviour
 * on 2026-08-05 is that a healthy scope still skips cycles — DNS resolution
 * for the file host fails intermittently and recovers — so judging against
 * `staleAfter` marks healthy scopes stale within a minute and the warning
 * becomes noise. This check exists to catch the failure that cost five days,
 * which was measured in hours. `staleAfter` is reported for context, not used
 * as the deadline.
 */
export function scopeFreshness(state, nowMs = Date.now(), maxAgeMs = 900_000) {
  if (!state || typeof state !== "object") {
    return { fresh: false, problem: "missing-state", ageMs: null };
  }

  const lastOk = state.lastSuccessfulReconcileAt;
  if (typeof lastOk !== "string" || lastOk.trim().length === 0) {
    return { fresh: false, problem: "never-reconciled", ageMs: null };
  }

  const lastOkMs = Date.parse(lastOk);
  if (!Number.isFinite(lastOkMs)) {
    return { fresh: false, problem: "invalid-reconcile-time", ageMs: null };
  }

  const ageMs = nowMs - lastOkMs;
  if (ageMs > maxAgeMs) {
    return { fresh: false, problem: "stale", ageMs };
  }
  return { fresh: true, problem: null, ageMs };
}
