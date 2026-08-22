/** Provisions a FRESH sandbox, seeds creds, runs the emitted initial-sync shell, polls, reports. */
import { Daytona } from "@daytonaio/sdk";
import fs from "node:fs";

const creds = JSON.parse(fs.readFileSync(process.env.PROOF_CREDS!, "utf8"));
const shells = JSON.parse(fs.readFileSync(process.env.PROOF_SHELLS!, "utf8"));
const LABEL = process.env.PROOF_LABEL!;
const SNAPSHOT = "relay-orchestrator-sdk-11.8.0-relayfile-v0.10.35-runtime-4.1.41";
const CWD = "/home/daytona";
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);

const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });
let sb: Awaited<ReturnType<typeof d.create>> | undefined;
try {
  log(`creating sandbox (${LABEL})…`);
  sb = await d.create({
    snapshot: SNAPSHOT,
    labels: { owner: "relayfile-mount-500", purpose: "mount-500-proof", label: LABEL },
    autoStopInterval: 20,
  });
  log(`sandbox ${sb.id} ready`);
  const exec = async (cmd: string, timeout = 180) =>
    sb!.process.executeCommand(cmd, CWD, undefined, timeout);

  // Same creds seeding the fleet bridge does before startMount.
  await exec(
    `node -e 'const fs=require("node:fs");fs.writeFileSync(process.env.F,JSON.stringify({token:process.env.T,expiresAt:process.env.E}),{mode:0o600})'`
      .replace("process.env.F", JSON.stringify("/home/daytona/.relayfile-mount-creds.json"))
      .replace("process.env.T", JSON.stringify(creds.relayfileToken))
      .replace("process.env.E", JSON.stringify(creds.relayfileTokenExpiresAt)),
  );
  await exec("mkdir -p /home/daytona/workspace");
  log("daemon start…");
  await exec(shells.daemon);
  log("initial sync launch…");
  await exec(shells.launch);

  const startedAt = Date.now();
  let verdict = "TIMED OUT (harness deadline)";
  for (;;) {
    const status = (await exec(shells.status, 60)).result ?? "";
    const m = status.match(/relayfile-initial-sync-exit:(-?\d+)/);
    if (m) { verdict = `initial sync EXITED code=${m[1]}`; break; }
    if (Date.now() - startedAt > Number(process.env.PROOF_DEADLINE_MS ?? 300_000)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`${verdict} after ${seconds}s`);
  console.log("=== initial sync log ===");
  console.log((await exec(shells.logTail, 60)).result);
  console.log("=== evidence ===");
  console.log((await exec([
    `echo '--- PHANTOM path the unscoped watchdog watched:'`,
    `ls -l /home/daytona/.relayfile-mount-state/.relayfile-mount-state.json 2>&1 || true`,
    `echo '--- files the daemon actually wrote under --state-dir:'`,
    `find /home/daytona/.relayfile-mount-state -type f 2>/dev/null | head -10`,
    `echo '--- explicit initial-sync state files in /tmp:'`,
    `ls -l /tmp/relayfile-mount-initial-sync-*.json 2>&1 || true`,
    `echo '--- mirror:'`,
    `du -sh /home/daytona/workspace 2>/dev/null; find /home/daytona/workspace -type f | wc -l`,
    `ls /home/daytona/workspace | head -20`,
  ].join("\n"), 120)).result);
} finally {
  if (sb && process.env.PROOF_KEEP !== "1") {
    log(`destroying ${sb.id}…`);
    await sb.delete().catch((e) => log("destroy failed", e));
    log("destroyed");
  }
}
