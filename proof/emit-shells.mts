/**
 * Emits the EXACT shell `SandboxOrchestrator.startMount` runs for the initial
 * sync, from whatever src/mount-script.ts is currently checked out. Lets the
 * before/after proof drive the real command over a plain Daytona exec instead
 * of the session-based runScript path.
 */
import {
  buildRelayfileMountInitialSyncBackgroundShell,
  buildRelayfileMountInitialSyncStatusShell,
  buildRelayfileMountInitialSyncLogTailShell,
  buildRelayfileMountStartShell,
} from "../src/mount-script.js";
import fs from "node:fs";

const creds = JSON.parse(fs.readFileSync(process.env.PROOF_CREDS!, "utf8"));
const IDLE = 60;
const runId = process.env.PROOF_RUN_ID!;
const config = {
  baseUrl: creds.relayfileUrl,
  workspaceId: creds.relayfileWorkspaceId,
  localDir: "/home/daytona/workspace",
  stateDir: "/home/daytona/.relayfile-mount-state",
  token: creds.relayfileToken,
  credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
};
const run = { runId };
// startMount's exact composition: env pin + the backgrounded idle-watched sync.
const launch = `export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=${IDLE}s\n` +
  buildRelayfileMountInitialSyncBackgroundShell({ ...config, idleTimeoutSeconds: IDLE }, run);
fs.writeFileSync(process.env.PROOF_OUT!, JSON.stringify({
  daemon: `export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=${IDLE}s\n` + buildRelayfileMountStartShell(config),
  launch,
  status: buildRelayfileMountInitialSyncStatusShell(run),
  logTail: buildRelayfileMountInitialSyncLogTailShell(40, run),
}, null, 2));
console.log("wrote", process.env.PROOF_OUT);
