import { isAbsolute, join, resolve, sep } from "node:path";

function assertInside(root, candidate, label) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (
    normalizedCandidate !== normalizedRoot
    && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error(`${label} escapes its configured root`);
  }
  return normalizedCandidate;
}

function remoteSegments(remotePath) {
  if (typeof remotePath !== "string" || !isAbsolute(remotePath)) {
    throw new Error(`Chief senses remote path must be absolute: ${remotePath}`);
  }
  const segments = remotePath.split("/").filter(Boolean);
  if (
    segments.length === 0
    || segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Chief senses remote path is not an exact subtree: ${remotePath}`);
  }
  return segments;
}

/**
 * Plan one exact Relayfile mount per configured subtree.
 *
 * Pear uses independently supervised exact mounts instead of one scoped
 * multi-path process. The separation gives every mount its own watcher,
 * private state, health, and restart boundary while preserving the existing
 * `senses/<scope>` projection consumed by Chief.
 */
export function exactSensesMountPlan({ remotePaths, localRoot, stateRoot }) {
  if (!Array.isArray(remotePaths) || remotePaths.length === 0) {
    throw new Error("Chief senses requires at least one remote path");
  }

  const seenRemotePaths = new Set();
  const seenLocalDirs = new Set();
  return remotePaths.map((remotePath) => {
    if (seenRemotePaths.has(remotePath)) {
      throw new Error(`Chief senses remote path is duplicated: ${remotePath}`);
    }
    seenRemotePaths.add(remotePath);

    const segments = remoteSegments(remotePath);
    const localDir = assertInside(
      localRoot,
      join(localRoot, ...segments),
      `Local mount for ${remotePath}`,
    );
    const stateDir = assertInside(
      stateRoot,
      join(stateRoot, ...segments),
      `Private mount state for ${remotePath}`,
    );
    if (seenLocalDirs.has(localDir)) {
      throw new Error(`Chief senses paths collide at ${localDir}`);
    }
    seenLocalDirs.add(localDir);
    return { remotePath, localDir, stateDir };
  });
}

export function mountPidsFromGeneration(generation) {
  if (!generation || generation.ended) return {};
  return Object.fromEntries(
    [...generation.children].map(([remotePath, child]) => [remotePath, child.pid]),
  );
}

export function mountProcessesHealthy(state, remotePaths, processIsAlive) {
  if (state?.status !== "running") return false;
  const expected = Array.isArray(remotePaths) ? remotePaths : [];
  if (state.mountPids && typeof state.mountPids === "object") {
    return expected.length > 0 && expected.every((remotePath) =>
      processIsAlive(state.mountPids[remotePath] ?? null));
  }
  // Backward compatibility while an older single-process supervisor is still
  // running during an upgrade.
  return processIsAlive(state?.mountPid ?? null);
}
