/**
 * The dispatch ledger — an interim durable carrier for delegation identity.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE DESTINATION
 * ==================================================
 * `delegation-identity.mjs` explains that identity belongs on the Relaycast
 * agent record's `metadata` bag. That is still the right home. It is simply
 * not reachable from a dispatcher on the installed platform, which was
 * established by probing the live workspace rather than by reading source:
 *
 *   - relay CLI 11.2.0 (the binary actually installed on this machine).
 *   - The fleet `spawn` action's input schema has no metadata parameter, so
 *     identity cannot be supplied at spawn.
 *   - `register_agent` *does* take a `metadata` argument, and discards it. A
 *     probe call supplying the full identity bag returned success with no
 *     warnings; reading the record back afterwards showed only the platform's
 *     own `metadata.fleet` block. The identity keys were never written.
 *   - "Strict worker identity" additionally pins `register_agent` to the
 *     caller's own name, so a dispatcher cannot register on a worker's behalf.
 *   - There is no `update_agent` on the MCP surface at all.
 *
 * So there is no post-spawn write either. Chief cannot stamp a worker today,
 * atomically or otherwise. The fix is a relay-repo change — carry `metadata`
 * through the spawn action, or make `register_agent`'s metadata persist. Until
 * that lands, this ledger is the nearest durable contract Chief can own.
 *
 * Be clear-eyed about what it does and does not buy. It is durable (a file
 * that outlives every process), it is queryable, and it is written before the
 * spawn so the gate can fail closed. It is *not* readable by the Cloud
 * dashboard, which reads Relaycast metadata. It closes the loop on Chief's
 * side only. Shipping it and calling the metadata contract done would be
 * exactly the silent substitution this project was created to stop.
 *
 * The overlay below is what makes the transition free: `readAgentIdentity`
 * already prefers identity declared on the agent record and only falls back.
 * When the platform starts carrying metadata natively, records arrive already
 * declared, the overlay stops finding anything to fill in, and the ledger
 * quietly stops being load-bearing — with no code change at the call sites.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LEDGER_VERSION = 1;

/** Where the active ledger lives, relative to Chief's repo root. */
export function ledgerPath(repoRoot) {
  return join(repoRoot, "state", "delegation-ledger.json");
}

function emptyLedger() {
  return { version: LEDGER_VERSION, agents: {} };
}

export function readLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // A corrupt ledger is not an empty ledger. Treating it as empty would
    // silently un-appoint every lead and re-open every claimed dispatch.
    throw new Error(`delegation ledger at ${path} is unreadable: ${error.message}`);
  }
  if (parsed?.version !== LEDGER_VERSION) {
    throw new Error(
      `delegation ledger at ${path} is version ${parsed?.version}; this build writes ${LEDGER_VERSION}`,
    );
  }
  return { version: LEDGER_VERSION, agents: parsed.agents ?? {} };
}

/** Atomic-ish write: a torn ledger is worse than a stale one. */
export function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temp, path);
}

/**
 * Claim a name and record its identity **before** the spawn is attempted.
 *
 * This is the fail-closed gate. If the ledger cannot be written, the caller
 * must abort rather than spawn — a worker running with no recorded identity is
 * precisely the unattributed agent this project exists to prevent, and a queue
 * that stalls beats one that silently re-offers claimed work (AR-448).
 */
export function recordDispatch(path, { name, identity, spawnedAt = null }) {
  if (!name) throw new Error("recordDispatch needs an agent name");
  if (!identity?.role) throw new Error("recordDispatch needs a built identity");

  const ledger = readLedger(path);
  const existing = ledger.agents[name];
  if (existing && existing.status === "claimed") {
    throw new Error(
      `"${name}" is already claimed by ${existing.identity?.dispatch?.runId ?? "an earlier dispatch"}`,
    );
  }
  ledger.agents[name] = { identity, spawnedAt, status: "claimed" };
  writeLedger(path, ledger);
  return ledger.agents[name];
}

/** Release a claim — the worker finished, or the spawn failed and was reaped. */
export function releaseDispatch(path, name, { reason = null } = {}) {
  const ledger = readLedger(path);
  if (!ledger.agents[name]) return null;
  ledger.agents[name] = { ...ledger.agents[name], status: "released", reason };
  writeLedger(path, ledger);
  return ledger.agents[name];
}

/**
 * Overlay ledger identity onto live roster entries.
 *
 * Only fills gaps: an agent record that already declares its identity wins,
 * because the record is the contract and the ledger is the stand-in. Claims
 * for agents that are no longer live are dropped rather than resurrected — a
 * ledger entry is a record of a dispatch, not evidence that it is still alive.
 */
export function applyLedgerIdentity(roster = [], ledger = emptyLedger()) {
  return roster.map((agent) => {
    const claim = ledger.agents?.[agent?.name];
    if (!claim || claim.status !== "claimed") return agent;
    const metadata = agent?.metadata ?? {};
    if (metadata.organization && metadata.project && metadata.role) return agent;
    return { ...agent, metadata: { ...metadata, ...claim.identity } };
  });
}

/**
 * Claim every worker in a fan-out before a single one is spawned.
 *
 * All-or-nothing on purpose. A partially-claimed fan-out is the worst of both
 * states: some workers attributable, some not, and no record of which. If any
 * claim fails, the ones already written are released and the error is
 * re-thrown so the caller aborts the whole dispatch rather than spawning the
 * half it managed to claim.
 *
 * @param {{dispatches: Array<{name: string, identity: object}>}} plan from planFanOut
 */
export function claimFanOut(path, plan, { spawnedAt = null } = {}) {
  const claimed = [];
  try {
    for (const dispatch of plan.dispatches) {
      recordDispatch(path, {
        name: dispatch.name,
        identity: dispatch.identity,
        spawnedAt,
      });
      claimed.push(dispatch.name);
    }
  } catch (error) {
    for (const name of claimed) {
      releaseDispatch(path, name, { reason: "fan-out aborted before spawn" });
    }
    throw error;
  }
  return claimed;
}

/**
 * Did the identity actually reach the platform record?
 *
 * Reported so the interim path stays visible. The day this returns true for
 * new spawns is the day the ledger can be deleted; until then it returning
 * false on every agent is the evidence that the relay change is still needed.
 */
export function verifyIdentityLanded(name, roster = []) {
  const agent = roster.find((entry) => entry?.name === name);
  const metadata = agent?.metadata ?? {};
  return Boolean(metadata.organization && metadata.project && metadata.role);
}
