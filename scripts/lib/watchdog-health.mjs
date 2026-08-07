export const WATCHDOG_INTERVAL_MS = 10 * 60_000;
export const WATCHDOG_MAX_SWEEP_AGE_MS = 25 * 60_000;

export function watchdogHealth({
  installed,
  lastSweepMs,
  now = Date.now(),
  maxAgeMs = WATCHDOG_MAX_SWEEP_AGE_MS,
}) {
  const ageMs = Number.isFinite(lastSweepMs) ? Math.max(0, now - lastSweepMs) : null;
  const fresh = ageMs !== null && ageMs <= maxAgeMs;
  return {
    installed: installed === true,
    fresh,
    healthy: installed === true && fresh,
    lastSweepAt: Number.isFinite(lastSweepMs) ? new Date(lastSweepMs).toISOString() : null,
    ageMinutes: ageMs === null ? null : Math.round(ageMs / 60_000),
    maxAgeMinutes: Math.round(maxAgeMs / 60_000),
  };
}
