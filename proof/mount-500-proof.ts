/**
 * Live end-to-end reproduction for the `mountRelayfile:true` HTTP 500.
 *
 * Provisions a real Daytona sandbox from the fleet snapshot, seeds the same
 * creds file the cloud `ensure` route writes, and runs the real
 * `SandboxOrchestrator.startMount` with the same options the fleet bridge uses
 * (`autoRelayfileMount: {}` — unscoped, whole-workspace).
 *
 * Run it once with src/mount-script.ts at origin/main (buggy) and once with the
 * fix; the mount is the only variable.
 */
import { Daytona } from "@daytonaio/sdk";
import { DaytonaRuntime } from "../src/daytona/runtime.js";
import { SandboxOrchestrator } from "../src/orchestrator.js";
import type { RuntimeHandle } from "../src/types.js";
import fs from "node:fs";

const SNAPSHOT = "relay-orchestrator-sdk-11.8.0-relayfile-v0.10.35-runtime-4.1.41";
const LOCAL_DIR = "/home/daytona/workspace";
const STATE_DIR = "/home/daytona/.relayfile-mount-state";
const CREDS_FILE = "/home/daytona/.relayfile-mount-creds.json";
const LABEL = process.env.PROOF_LABEL ?? "unlabelled";

const creds = JSON.parse(fs.readFileSync(process.env.PROOF_CREDS!, "utf8"));

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });
const runtime = new DaytonaRuntime({ daytona, snapshot: SNAPSHOT, defaultHomeDir: "/home/daytona" });
const orchestrator = new SandboxOrchestrator<RuntimeHandle>({
  provision: (options) => runtime.launch(options),
  uploadBundle: (handle, files) => runtime.uploadBundle(handle, { files: [...files] }),
  runScript: async (handle, options) => {
    const result = await runtime.runScript(handle, options);
    return { output: result.output || result.stdout || result.stderr || "", exitCode: result.exitCode };
  },
  teardown: (handle) => runtime.destroy(handle),
});

let handle: RuntimeHandle | undefined;
const started = Date.now();
try {
  if (process.env.PROOF_SANDBOX) {
    handle = (await runtime.getById(process.env.PROOF_SANDBOX))!;
    log(`reusing sandbox ${handle.id}`);
  } else {
    log(`provisioning sandbox (${LABEL})…`);
    handle = await orchestrator.provision({
      name: `relayfile-mount-500-${LABEL}`,
      labels: { owner: "relayfile-mount-500", purpose: "mount-500-repro", label: LABEL },
    });
    log(`sandbox ${handle.id} up in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  // Same seeding the fleet bridge does before startMount.
  await orchestrator.runScript(handle, {
    command:
      `node -e 'const fs=require("node:fs");fs.writeFileSync(process.env.F,JSON.stringify({token:process.env.T,expiresAt:process.env.E}),{mode:0o600})'`,
    env: { F: CREDS_FILE, T: creds.relayfileToken, E: creds.relayfileTokenExpiresAt },
  });

  const config = {
    baseUrl: creds.relayfileUrl as string,
    workspaceId: creds.relayfileWorkspaceId as string,
    localDir: LOCAL_DIR,
    stateDir: STATE_DIR,
    token: creds.relayfileToken as string,
    credsFilePath: CREDS_FILE,
  };

  const mountStarted = Date.now();
  let outcome: string;
  try {
    const mount = await orchestrator.startMount(handle, config, {
      initialSyncIdleTimeoutMs: 60_000,
      initialSyncDeadlineMs: 240_000,
    });
    outcome = `MOUNT OK pid=${mount.pid ?? "(none)"}`;
  } catch (error) {
    outcome = `MOUNT FAILED: ${error instanceof Error ? error.message : String(error)}`;
  }
  const mountSeconds = ((Date.now() - mountStarted) / 1000).toFixed(1);
  log(`${outcome}\n  (mount stage took ${mountSeconds}s)`);

  const probe = await orchestrator.runScript(handle, {
    command: [
      `echo "--- phantom watched path (what the idle watchdog watches, unscoped):"`,
      `ls -l '${STATE_DIR}/.relayfile-mount-state.json' 2>&1 || true`,
      `echo "--- what the daemon actually wrote under --state-dir:"`,
      `find '${STATE_DIR}' -type f 2>/dev/null | head -20 || true`,
      `echo "--- initial-sync state files in /tmp:"`,
      `ls -l /tmp/relayfile-mount-initial-sync-*.json 2>&1 || true`,
      `echo "--- mirror size / file count:"`,
      `du -sh '${LOCAL_DIR}' 2>/dev/null || true`,
      `find '${LOCAL_DIR}' -type f 2>/dev/null | wc -l`,
      `echo "--- top-level provider roots materialized:"`,
      `ls '${LOCAL_DIR}' 2>&1 | head -30 || true`,
      `echo "--- public mount state:"`,
      `cat '${LOCAL_DIR}/.relay/state.json' 2>/dev/null | head -c 600 || true`,
    ].join("\n"),
  });
  console.log(probe.output);
} finally {
  if (handle && process.env.PROOF_KEEP !== "1") {
    log(`tearing down ${handle.id}…`);
    await runtime.destroy(handle).catch((error) => log("teardown failed:", error));
    log("torn down");
  } else if (handle) {
    log(`KEEPING sandbox ${handle.id} (PROOF_KEEP=1) — remember to destroy it`);
  }
}
