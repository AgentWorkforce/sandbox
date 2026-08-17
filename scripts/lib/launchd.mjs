import { chmodSync, writeFileSync } from "node:fs";

export function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Resident services restart on crash or non-zero exit and stay down after a
// clean exit (relay#1416: with RunAtLoad alone, one transient `node up`
// failure leaves every node down until a human intervenes). ThrottleInterval
// spaces the respawns so a persistent failure — `node up` exiting 1 because a
// manually started broker already holds the project — cannot hot-loop.
// One-shot jobs omit KeepAlive so launchd never resurrects them.
const RESIDENT_KEYS = `    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
`;

// Periodic jobs (the fleet watchdog) re-run on a timer rather than being kept
// alive. StartInterval is what makes them recur: with RunAtLoad alone the job
// fires once at login and never again, which is silent — the plist installs,
// launchd reports it loaded, and nothing ever runs it a second time.
const periodicKeys = (seconds) => `    <key>StartInterval</key>
    <integer>${Number(seconds)}</integer>
`;

// Logs may carry sensitive runtime output, so they are owner-only. Creation
// mode only applies to new files; the chmod covers files that already exist.
export function ensurePrivateLog(path) {
  if (path === "/dev/null") return;
  writeFileSync(path, "", { flag: "a", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function plist({
  label,
  args,
  workingDirectory,
  stdout,
  stderr,
  environment = {},
  resident = false,
  startInterval = null,
  exitTimeout = null,
}) {
  if (resident && (!stderr || stderr === "/dev/null")) {
    throw new Error(
      `${label}: a resident service must route stderr to a log file — ` +
        "KeepAlive respawns it forever, so a discarded stderr hides a persistent failure.",
    );
  }
  if (resident && startInterval != null) {
    throw new Error(
      `${label}: a service is either resident or periodic, not both — ` +
        "KeepAlive restarts on exit while StartInterval re-runs on a timer.",
    );
  }
  const array = args.map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
  const environmentEntries = Object.entries(environment)
    .map(([key, value]) =>
      `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${array}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environmentEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
${resident ? RESIDENT_KEYS : ""}${startInterval == null ? "" : periodicKeys(startInterval)}${exitTimeout == null ? "" : `    <key>ExitTimeOut</key>\n    <integer>${Number(exitTimeout)}</integer>\n`}    <key>StandardOutPath</key>
    <string>${xml(stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(stderr)}</string>
  </dict>
</plist>
`;
}
