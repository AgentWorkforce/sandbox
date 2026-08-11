import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Acquire the one Chief senses supervisor lease.
 *
 * Atomic directory rename is the election primitive. A dead owner's lease is
 * first renamed to a durable checkpoint, so two replacements cannot both
 * believe they won and the prior
 * owner's final state survives the takeover. Every mutation checks the random
 * fence token before touching the lease owned by a newer process.
 */
export function acquireSupervisorLease({
  lockDir,
  checkpointDir,
  owner,
  pid = process.pid,
  nowMs = Date.now(),
  ttlMs = 90_000,
  token = randomUUID(),
  isProcessAlive = () => false,
}) {
  const leasePath = join(lockDir, "lease.json");
  const candidateDir = `${lockDir}.candidate-${token}`;
  const candidateLeasePath = join(candidateDir, "lease.json");
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });

  function leaseValue(atMs) {
    return {
      owner,
      pid,
      token,
      renewedAt: new Date(atMs).toISOString(),
      expiresAt: new Date(atMs + ttlMs).toISOString(),
    };
  }

  // Build the complete candidate before the atomic rename. A contender can
  // therefore never observe a winning lock directory without its lease.
  rmSync(candidateDir, { recursive: true, force: true });
  mkdirSync(candidateDir, { mode: 0o700 });
  writeJson(candidateLeasePath, leaseValue(nowMs));
  try {
    renameSync(candidateDir, lockDir);
  } catch (error) {
    rmSync(candidateDir, { recursive: true, force: true });
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    const existing = readJson(leasePath);
    if (!existing) {
      // Present but unreadable/corrupted lease: ambiguous, not a confirmed
      // live owner. Surface as a real fault (uncoded) rather than silently
      // treating it as ordinary contention, so callers can retry instead of
      // permanently standing down.
      throw new Error(
        `Chief senses supervisor lease file at ${leasePath} is missing or unreadable; refusing takeover`,
      );
    }
    const pidAlive = Number.isInteger(existing.pid) && isProcessAlive(existing.pid);
    // A PID can be recycled by the OS across a reboot; trusting liveness
    // alone can permanently wedge takeover. Fall back to the lease's own
    // expiresAt so a recycled-but-expired PID is still treated as stale.
    const expiresAtMs = existing.expiresAt ? Date.parse(existing.expiresAt) : NaN;
    const leaseExpired = Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs;
    const live = pidAlive && !leaseExpired;
    if (live) {
      const heldError = new Error(
        `Chief senses supervisor lease is held by ${existing.owner ?? "unknown"} ` +
          `(pid ${existing.pid ?? "unknown"})`,
      );
      heldError.code = "LEASE_CONTENDED";
      throw heldError;
    }

    mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
    const checkpoint = join(
      checkpointDir,
      `${String(nowMs)}-${existing?.token ?? "unknown"}`,
    );
    try {
      // rename is atomic: exactly one contender can checkpoint the stale owner.
      renameSync(lockDir, checkpoint);
    } catch (checkpointError) {
      // The exact race this module exists to handle: another contender
      // already won the takeover and moved lockDir out from under us.
      const raceError = new Error(
        `Chief senses supervisor lease takeover raced with another contender: ${checkpointError.message}`,
      );
      raceError.code = "LEASE_CONTENDED";
      throw raceError;
    }
    mkdirSync(candidateDir, { mode: 0o700 });
    writeJson(candidateLeasePath, leaseValue(nowMs));
    try {
      renameSync(candidateDir, lockDir);
    } catch (replacementError) {
      rmSync(candidateDir, { recursive: true, force: true });
      const lostError = new Error(
        `Chief senses supervisor replacement lost election: ${replacementError.message}`,
      );
      lostError.code = "LEASE_CONTENDED";
      throw lostError;
    }
  }

  function writeLease(atMs) {
    writeJson(leasePath, leaseValue(atMs));
  }

  return {
    token,
    renew(atMs = Date.now()) {
      if (readJson(leasePath)?.token !== token) {
        throw new Error("Chief senses supervisor lease fence was lost");
      }
      writeLease(atMs);
    },
    release() {
      if (readJson(leasePath)?.token !== token) return false;
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    },
  };
}

/** Deterministic backoff/circuit policy; callers inject random in tests. */
export function createRestartPolicy({
  baseMs = 5_000,
  maxMs = 5 * 60_000,
  maxFailures = 5,
  windowMs = 10 * 60_000,
  jitterRatio = 0.2,
  random = Math.random,
} = {}) {
  let failures = [];
  return {
    recordFailure(nowMs = Date.now()) {
      failures = failures.filter((time) => nowMs - time < windowMs);
      failures.push(nowMs);
      if (failures.length >= maxFailures) {
        return { action: "open", failures: failures.length };
      }
      const exponent = Math.max(0, failures.length - 1);
      const uncapped = baseMs * 2 ** exponent;
      const capped = Math.min(maxMs, uncapped);
      const jitter = (random() * 2 - 1) * jitterRatio;
      return {
        action: "restart",
        failures: failures.length,
        delayMs: Math.min(maxMs, Math.max(0, Math.round(capped * (1 + jitter)))),
      };
    },
    recordHealthy() {
      failures = [];
    },
  };
}

/** Coalesce duplicate subscriptions and refuse unbounded distinct work. */
export function createBoundedCoalescer({ maxPending = 2 } = {}) {
  const pending = new Map();
  return {
    run(key, task) {
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= maxPending) {
        throw new Error(`Supervisor queue ceiling reached (${maxPending})`);
      }
      const promise = Promise.resolve().then(task).finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },
    get size() {
      return pending.size;
    },
  };
}

export function parseResidentSetBytes(output) {
  const kibibytes = Number(String(output).trim());
  return Number.isFinite(kibibytes) && kibibytes >= 0
    ? kibibytes * 1024
    : null;
}

export function resourceCeilingDecision(rssBytes, ceilingBytes) {
  if (!Number.isFinite(rssBytes) || rssBytes < 0) return "unknown";
  return rssBytes > ceilingBytes ? "terminate" : "within-ceiling";
}

// launchd's SuccessfulExit=false contract keeps the service down only on 0.
export function circuitOpenExitCode(decision) {
  return decision?.action === "open" ? 0 : null;
}
