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
 * The idle watchdog around the initial sync kills the sync with `exit 124`
 * when none of the files it watches changes for `idleTimeoutSeconds`. That is
 * only a liveness signal if the daemon actually writes those files.
 *
 * It did not, for unscoped mounts. The watch list named
 * `<state-dir>/.relayfile-mount-state.json` — the LEGACY *local-root* state
 * filename, written by nothing under a state dir — while the daemon, given
 * only `--state-dir`, checkpoints into a content-hashed
 * `<state-dir>/<mount-id>/state.json` this module cannot compute. The marker
 * never advanced, so a healthy-but-slow first sync (a 202MB cold
 * materialization of a whole workspace) was killed at exactly the idle
 * timeout, surfacing as HTTP 500 from POST /api/v1/fleet/nodes/sandbox/ensure
 * whenever `mountRelayfile: true`.
 */
describe("mount-script initial-sync idle watchdog", () => {
  const IDLE = { idleTimeoutSeconds: 60 } as const;

  /** The watchdog renders its watch list as a positional-parameter set. */
  function watchedProgressFiles(shell: string): string[] {
    const match = shell.match(/set -- ((?:'[^']*'\s*)+);/);
    assert.ok(match, `no watchdog watch list in emitted shell: ${shell.slice(0, 200)}`);
    return [...match[1]!.matchAll(/'([^']*)'/g)].map((entry) => entry[1]!);
  }

  function declaredStateFiles(shell: string): string[] {
    return [...shell.matchAll(/--state-file '([^']*)'/g)].map((entry) => entry[1]!);
  }

  it("watches only files the same command tells the daemon to write (unscoped)", () => {
    const shell = buildRelayfileMountInitialSyncShell({ ...BASE, ...IDLE });
    const watched = watchedProgressFiles(shell);
    const declared = new Set(declaredStateFiles(shell));

    assert.ok(watched.length > 0, "watchdog must watch at least one progress file");
    for (const file of watched) {
      assert.ok(
        declared.has(file),
        `watchdog watches ${file}, which no --state-file in the command declares; ` +
          `declared: ${[...declared].join(", ") || "(none)"}`,
      );
    }
  });

  it("watches only files the same command tells the daemon to write (scoped)", () => {
    const shell = buildRelayfileMountInitialSyncShell({
      ...BASE,
      ...IDLE,
      paths: ["/github/AgentWorkforce/sandbox", "/slack/channels"],
    });
    const watched = watchedProgressFiles(shell);
    const declared = new Set(declaredStateFiles(shell));

    assert.equal(watched.length, 2, "one progress file per emitted per-root sync");
    for (const file of watched) {
      assert.ok(declared.has(file), `watchdog watches undeclared ${file}`);
    }
  });

  it("never names the legacy local-root state file, which no state dir holds", () => {
    const shell = buildRelayfileMountInitialSyncShell({ ...BASE, ...IDLE });
    assert.ok(
      !shell.includes(".relayfile-mount-state.json"),
      "emitted shell still references the legacy local-root state filename",
    );
  });

  it("gives the unscoped initial sync its own state file, not the daemon's", () => {
    const shell = buildRelayfileMountInitialSyncShell({ ...BASE, ...IDLE });
    for (const file of declaredStateFiles(shell)) {
      assert.ok(
        !file.startsWith(BASE.stateDir),
        `initial sync state file ${file} sits inside the daemon's --state-dir; ` +
          "the two processes run concurrently and must not share one state file",
      );
    }
  });
});
