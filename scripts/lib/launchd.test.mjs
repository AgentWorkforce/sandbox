import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateLog, plist } from "./launchd.mjs";

const base = {
  label: "com.agentworkforce.example.node",
  args: ["/usr/local/bin/agent-relay", "node", "up"],
  workingDirectory: "/repo/example",
  environment: { PATH: "/usr/bin:/bin" },
  stdout: "/dev/null",
  stderr: "/Users/example/Library/Logs/example-node.log",
};

test("a resident node job restarts on failure and stays down on clean exit", () => {
  const output = plist({ ...base, resident: true, exitTimeout: 20 });
  assert.match(
    output,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/u,
  );
  assert.match(output, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/u);
  assert.match(output, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(output, /<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/u);
});

test("a resident job logs stderr to a file so a respawn loop stays observable", () => {
  const output = plist({ ...base, resident: true });
  assert.match(
    output,
    /<key>StandardErrorPath<\/key>\s*<string>\/Users\/example\/Library\/Logs\/example-node\.log<\/string>/u,
  );
});

test("a resident job refuses a discarded stderr", () => {
  assert.throws(() => plist({ ...base, resident: true, stderr: "/dev/null" }), /stderr/u);
  assert.throws(() => plist({ ...base, resident: true, stderr: undefined }), /stderr/u);
});

test("a one-shot job carries no KeepAlive and no throttle", () => {
  const output = plist({
    ...base,
    label: "com.agentworkforce.chief.digest",
    args: ["/usr/local/bin/node", "digest.mjs"],
  });
  assert.doesNotMatch(output, /KeepAlive/u);
  assert.doesNotMatch(output, /ThrottleInterval/u);
  assert.match(output, /<key>RunAtLoad<\/key>\s*<true\/>/u);
});

test("resident jobs default off", () => {
  assert.doesNotMatch(plist(base), /KeepAlive/u);
});

test("a periodic job re-runs on its interval instead of once at login", () => {
  const output = plist({
    ...base,
    label: "com.agentworkforce.fleet-watchdog",
    args: ["/usr/local/bin/node", "tools/watchdog/fleet-watchdog.mjs", "--quiet"],
    startInterval: 600,
  });
  assert.match(output, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/u);
  assert.match(output, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.doesNotMatch(output, /KeepAlive/u);
});

test("periodic jobs default off", () => {
  assert.doesNotMatch(plist(base), /StartInterval/u);
});

test("a job is either resident or periodic, not both", () => {
  assert.throws(
    () => plist({ ...base, resident: true, startInterval: 600 }),
    /resident or periodic/u,
  );
});

test("label, args, working directory, and environment are XML-escaped", () => {
  const output = plist({
    ...base,
    label: 'a<b>&"c',
    args: ["/bin/echo", 'x<&>"y'],
    workingDirectory: "/repo/a&b",
    environment: { NOTE: '<&>"' },
  });
  assert.match(output, /<string>a&lt;b&gt;&amp;&quot;c<\/string>/u);
  assert.match(output, /<string>x&lt;&amp;&gt;&quot;y<\/string>/u);
  assert.match(output, /<string>\/repo\/a&amp;b<\/string>/u);
  assert.match(output, /<string>&lt;&amp;&gt;&quot;<\/string>/u);
});

test("ensurePrivateLog creates the log owner-only and tightens existing files", () => {
  const directory = mkdtempSync(join(tmpdir(), "launchd-log-test-"));
  const path = join(directory, "example-node.log");
  ensurePrivateLog(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  writeFileSync(path, "existing line\n");
  chmodSync(path, 0o644);
  ensurePrivateLog(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("ensurePrivateLog leaves /dev/null untouched", () => {
  assert.doesNotThrow(() => ensurePrivateLog("/dev/null"));
});
