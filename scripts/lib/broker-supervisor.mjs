import { execFileSync } from "node:child_process";
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export const BROKER_TERM_GRACE_MS = 8_000;
export const BROKER_KILL_GRACE_MS = 2_000;

export function readRecordedPid(path) {
  try {
    const pid = JSON.parse(readFileSync(path, "utf8"))?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid, signal = process.kill) {
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function isBrokerProcess(pid, inspect = (candidate) =>
  execFileSync("ps", ["-p", String(candidate), "-o", "command="], {
    encoding: "utf8",
  })) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const command = String(inspect(pid));
    return /(?:^|\/)agent-relay-broker\s+init(?:\s|$)/u.test(command);
  } catch {
    return false;
  }
}

export async function waitForProcessExit(
  pid,
  timeoutMs,
  {
    alive = isProcessAlive,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(100);
  }
  return !alive(pid);
}

/**
 * Pear-style owned-process teardown: ask the exact broker PID to exit, then
 * force-stop only that same PID when the grace period expires.
 */
export async function terminateOwnedBrokerProcess(
  pid,
  {
    termGraceMs = BROKER_TERM_GRACE_MS,
    killGraceMs = BROKER_KILL_GRACE_MS,
    alive = isProcessAlive,
    signal = process.kill,
    wait = waitForProcessExit,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) {
    return { signal: "none", exited: true };
  }

  try {
    signal(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return { signal: "SIGTERM", exited: true };
  }
  if (await wait(pid, termGraceMs, { alive })) {
    return { signal: "SIGTERM", exited: true };
  }

  try {
    signal(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return {
    signal: "SIGKILL",
    exited: await wait(pid, killGraceMs, { alive }),
  };
}

export function writeOwnerRecord(path, pid, supervisorPid = process.pid) {
  const temporary = `${path}.${supervisorPid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    pid,
    supervisorPid,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Remove state only while it still names the broker this supervisor owns. */
export function clearOwnedBrokerState({ connectionPath, ownerPath, ownedPid }) {
  let connectionCleared = false;
  let ownerCleared = false;
  if (readRecordedPid(connectionPath) === ownedPid) {
    rmSync(connectionPath, { force: true });
    connectionCleared = true;
  }
  if (readRecordedPid(ownerPath) === ownedPid) {
    rmSync(ownerPath, { force: true });
    ownerCleared = true;
  }
  return { connectionCleared, ownerCleared };
}
