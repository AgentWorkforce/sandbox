import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildRelayfileMountStartShell,
  buildRelayfileMountFlushShell,
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
