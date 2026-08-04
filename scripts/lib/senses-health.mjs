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
