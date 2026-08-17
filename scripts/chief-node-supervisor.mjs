#!/usr/bin/env node

import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  clearOwnedBrokerState,
  isBrokerProcess,
  isProcessAlive,
  readRecordedPid,
  terminateOwnedBrokerProcess,
  writeOwnerRecord,
} from "./lib/broker-supervisor.mjs";

const [agentRelay, ...relayArgs] = process.argv.slice(2);
if (!agentRelay || relayArgs.length === 0) {
  console.error("usage: chief-node-supervisor.mjs <agent-relay> <args...>");
  process.exit(64);
}

const relayRoot = join(process.cwd(), ".agentworkforce", "relay");
const connectionPath = join(relayRoot, "connection.json");
const ownerPath = join(relayRoot, "chief-node-owner.json");
let ownedPid;
let child;
let stopping;

function discoverBroker() {
  const candidate = readRecordedPid(connectionPath);
  if (!candidate || !isProcessAlive(candidate) || !isBrokerProcess(candidate)) return;
  if (ownedPid !== candidate) {
    ownedPid = candidate;
    writeOwnerRecord(ownerPath, candidate);
    console.error(`[chief-node] supervising broker pid ${candidate}`);
  }
}

let discoveryTimer;

async function waitForBrokerDiscovery(timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!ownedPid && Date.now() < deadline) {
    discoverBroker();
    if (!ownedPid) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function cleanup(exitCode) {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(discoveryTimer);
    discoverBroker();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    // The CLI can fork the broker just before launchd delivers SIGTERM. Give
    // that child a bounded window to publish connection.json so it cannot
    // escape ownership in the wrapper/broker creation race.
    await waitForBrokerDiscovery();
    if (ownedPid) {
      const result = await terminateOwnedBrokerProcess(ownedPid);
      if (!result.exited) {
        console.error(`[chief-node] broker pid ${ownedPid} survived ${result.signal}`);
        exitCode = 1;
      }
      clearOwnedBrokerState({ connectionPath, ownerPath, ownedPid });
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    process.exitCode = exitCode;
  })();
  return stopping;
}

// Adopt a broker left by the previous launchd generation. This is deliberate:
// the service owns this project-scoped broker even when the CLI wrapper died.
discoverBroker();
if (!ownedPid) {
  child = spawn(agentRelay, relayArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(`[chief-node] failed to start Agent Relay: ${error.message}`);
    void cleanup(1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(
        `[chief-node] Agent Relay wrapper exited (${signal ?? code ?? "unknown"}); cleaning broker`,
      );
      void cleanup(code === 0 ? 1 : (code ?? 1));
    }
  });
} else {
  console.error(`[chief-node] adopted broker pid ${ownedPid} from the project connection file`);
}

discoveryTimer = setInterval(() => {
  discoverBroker();
  if (ownedPid && !isProcessAlive(ownedPid)) {
    console.error(`[chief-node] broker pid ${ownedPid} exited`);
    void cleanup(1);
  }
}, 250);

process.once("SIGTERM", () => void cleanup(0));
process.once("SIGINT", () => void cleanup(0));
