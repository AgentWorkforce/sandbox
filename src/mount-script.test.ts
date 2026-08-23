import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildRelayfileMountStartShell,
  buildRelayfileMountFlushShell,
  buildRelayfileMountInitialSyncShell,
} from "./mount-script.js";

const TOKEN = "relay_pa_thisisasecrettoken_do_not_leak";
const BASE = {
  baseUrl: "https://relayfile.example",
  workspaceId: "wsp_abc",
  localDir: "/home/user/workspace",
  stateDir: "/var/run/relayfile-mount",
  token: TOKEN,
} as const;

describe("mount-script token ingress", () => {
  describe("default ('argv') — backwards-compatible with older daemons", () => {
    it("emits --token <literal> in the rendered start command", () => {
      const start = buildRelayfileMountStartShell({ ...BASE });
      assert.match(start, /--token '?relay_pa_thisisasecrettoken_do_not_leak'?/);
    });

    it("emits --token <literal> in the rendered flush command", () => {
      const flush = buildRelayfileMountFlushShell({ ...BASE });
      assert.match(flush, /--token '?relay_pa_thisisasecrettoken_do_not_leak'?/);
    });

    it("does not add RELAYFILE_MOUNT_TOKEN to the env prefix", () => {
      const start = buildRelayfileMountStartShell({ ...BASE });
      assert.doesNotMatch(start, /RELAYFILE_MOUNT_TOKEN=/);
    });
  });

  describe("'env' — token via RELAYFILE_MOUNT_TOKEN, never in argv (sandbox#21 mitigation)", () => {
    it("keeps the literal token out of --token argv", () => {
      const start = buildRelayfileMountStartShell({ ...BASE, tokenIngress: "env" });
      assert.doesNotMatch(
        start,
        /--token/,
        "when tokenIngress is 'env', --token must not appear in argv at all",
      );
    });

    it("carries the token in the env prefix as RELAYFILE_MOUNT_TOKEN", () => {
      const start = buildRelayfileMountStartShell({ ...BASE, tokenIngress: "env" });
      assert.match(
        start,
        /env [^;]*RELAYFILE_MOUNT_TOKEN=/,
        "RELAYFILE_MOUNT_TOKEN must be part of the env prefix",
      );
    });

    it("still emits the token literal (in env, not argv)", () => {
      // The literal has to reach the daemon somehow — the mitigation is that
      // env values are not printed by `ps aux` by default (they live in
      // /proc/<pid>/environ, not /proc/<pid>/cmdline). That is the whole point.
      const start = buildRelayfileMountStartShell({ ...BASE, tokenIngress: "env" });
      assert.match(start, /relay_pa_thisisasecrettoken_do_not_leak/);
    });

    it("applies to the flush command too", () => {
      const flush = buildRelayfileMountFlushShell({ ...BASE, tokenIngress: "env" });
      assert.doesNotMatch(flush, /--token/);
      assert.match(flush, /env [^;]*RELAYFILE_MOUNT_TOKEN=/);
    });

    it("composes with credsFilePath in the same env prefix", () => {
      const start = buildRelayfileMountStartShell({
        ...BASE,
        tokenIngress: "env",
        credsFilePath: "/etc/relayfile/creds.json",
      });
      assert.match(start, /RELAYFILE_MOUNT_CREDS_FILE=/);
      assert.match(start, /RELAYFILE_MOUNT_TOKEN=/);
      assert.match(start, /RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped/);
      assert.doesNotMatch(start, /--token/);
    });

    it("keeps RELAYFILE_MOUNT_LOCAL_LAYOUT scoped when only tokenIngress is set", () => {
      const start = buildRelayfileMountStartShell({ ...BASE, tokenIngress: "env" });
      assert.match(start, /RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped/);
    });
  });
});

/**
 * The idle watchdog arms itself with `set -- <file> [<file>...];` — the exact
 * list of paths whose mtime it reads as "the sync is still making progress".
 */
function armedProgressFiles(shell: string): string[] {
  const match = /\bset -- (.*?);/u.exec(shell);
  assert.ok(match, "idle watchdog did not arm a progress-file list");
  return [...match[1].matchAll(/'((?:[^']|'\\'')*)'/gu)].map((entry) =>
    entry[1].replace(/'\\''/gu, "'"),
  );
}

/**
 * Regression guard for the Relayfile-mount provisioning 500
 * (AgentWorkforce/sandbox-router#11).
 *
 * The unscoped initial sync armed the watchdog with
 * `<state-dir>/.relayfile-mount-state.json`, a path no relayfile-mount build
 * writes — the legacy file of that name lived under the LOCAL root, and the
 * current binary derives `<state-dir>/<sha256(...)[:32]>/state.json` instead.
 * `[ -f ... ]` was therefore always false, the marker was touched once at
 * launch and never again, and the "idle" watchdog degraded into an
 * unconditional hard kill at the idle timeout (exit 124) — killing initial
 * syncs that were demonstrably still pulling. With
 * `autoRelayfileMountRequired: true` that throw tore the sandbox down and
 * surfaced as HTTP 500 `{"error":"internal"}` from
 * POST /api/v1/fleet/nodes/sandbox/ensure.
 *
 * The invariant that makes the watchdog meaningful: every armed progress file
 * must be a path this same command pinned with `--state-file`.
 */
describe("initial-sync idle watchdog progress files", () => {
  const SYNC_BASE = { ...BASE, idleTimeoutSeconds: 60 };

  it("isolates pinned state files by workspace, remote root, and local root", () => {
    const stateFileFor = (
      options: Parameters<typeof buildRelayfileMountInitialSyncShell>[0],
    ): string => {
      const [stateFile] = armedProgressFiles(
        buildRelayfileMountInitialSyncShell(options),
      );
      assert.ok(stateFile, "expected the watchdog to arm a state file");
      return stateFile;
    };
    const rootMount = stateFileFor(SYNC_BASE);

    assert.notEqual(
      rootMount,
      stateFileFor({ ...SYNC_BASE, workspaceId: "wsp_other" }),
      "different workspaces must not share initial-sync traversal state",
    );
    assert.notEqual(
      rootMount,
      stateFileFor({ ...SYNC_BASE, localDir: "/home/other/workspace" }),
      "different local roots must not share initial-sync traversal state",
    );
    assert.notEqual(
      stateFileFor({ ...SYNC_BASE, paths: ["/github/org/one/**"] }),
      stateFileFor({ ...SYNC_BASE, paths: ["/github/org/two/**"] }),
      "different remote roots must not share initial-sync traversal state",
    );
  });

  it("pins every armed progress file with --state-file (unscoped root mount)", () => {
    const shell = buildRelayfileMountInitialSyncShell({ ...SYNC_BASE });
    const armed = armedProgressFiles(shell);

    assert.ok(armed.length > 0, "expected at least one progress file");
    for (const file of armed) {
      assert.ok(
        shell.includes(`--state-file '${file}'`),
        `watchdog watches ${file}, but no --state-file pins the sync to it`,
      );
    }
  });

  it("pins every armed progress file with --state-file (scoped roots)", () => {
    const shell = buildRelayfileMountInitialSyncShell({
      ...SYNC_BASE,
      paths: ["/github/agentworkforce/**", "/slack/C0BBTBC1RCM/**"],
    });
    const armed = armedProgressFiles(shell);

    assert.equal(armed.length, 2);
    for (const file of armed) {
      assert.ok(
        shell.includes(`--state-file '${file}'`),
        `watchdog watches ${file}, but no --state-file pins the sync to it`,
      );
    }
  });

  it("never arms the legacy `.relayfile-mount-state.json` name", () => {
    const shell = buildRelayfileMountInitialSyncShell({ ...SYNC_BASE });
    assert.ok(
      !armedProgressFiles(shell).some((file) =>
        file.endsWith(".relayfile-mount-state.json"),
      ),
      "armed the legacy `.relayfile-mount-state.json` name, which relayfile-mount " +
        "only ever wrote under the LOCAL root — never under --state-dir",
    );
  });
});
