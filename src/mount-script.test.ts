import { describe, it, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRelayfileMountCleanupFlushShell,
  buildRelayfileMountStartShell,
  buildRelayfileMountFlushShell,
  buildRelayfileMountInitialSyncShell,
  buildRelayfileMountInitialSyncCompletionGuardShell,
  buildRelayfileMountInitialSyncBackgroundShell,
  buildRelayfileMountInitialSyncStatusShell,
  buildRelayfileMountPathArgsShell,
  buildRelayfileMountShellTemplate,
  parseRelayfileMountInitialSyncStatus,
  type RelayfileMountInitialSyncStatus,
  RELAYFILE_INITIAL_SYNC_EXIT_PATH,
  RELAYFILE_INITIAL_SYNC_INCOMPLETE_EXIT_CODE,
  RELAYFILE_INITIAL_SYNC_LOG_PATH,
  RELAYFILE_INITIAL_SYNC_PID_PATH,
  RELAYFILE_INITIAL_SYNC_REAPED_PATH,
  RELAYFILE_INITIAL_SYNC_SCRIPT_PATH,
} from "./mount-script.js";

const TOKEN = "relay_pa_thisisasecrettoken_do_not_leak";
const BASE = {
  baseUrl: "https://relayfile.example",
  workspaceId: "wsp_abc",
  localDir: "/home/user/workspace",
  stateDir: "/var/run/relayfile-mount",
  token: TOKEN,
} as const;

function fakeExactMount(t: TestContext): {
  binDir: string;
  localRoot: string;
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "sandbox-mount-layout-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const binDir = join(fixtureRoot, "bin");
  const localRoot = join(fixtureRoot, "workspace");
  const fakeMount = join(binDir, "relayfile-mount");

  const mkdir = spawnSync("mkdir", ["-p", binDir]);
  assert.equal(mkdir.status, 0, mkdir.stderr?.toString());
  writeFileSync(
    fakeMount,
    `#!/bin/sh
layout="\${RELAYFILE_MOUNT_LOCAL_LAYOUT:-exact}"
if [ "$layout" = scoped ]; then
  echo 'unsupported local layout: --local-layout=scoped; use --local-layout=exact' >&2
  exit 1
fi
local_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-layout) layout="$2"; shift 2 ;;
    --local-dir) local_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$layout" != exact ] || [ -z "$local_dir" ]; then exit 2; fi
if [ -n "\${FAKE_MOUNT_CALLS:-}" ]; then
  printf '%s\n' "$local_dir" >> "$FAKE_MOUNT_CALLS"
fi
if [ -n "\${FAKE_MOUNT_FAIL_LOCAL_DIR:-}" ] && [ "$local_dir" = "$FAKE_MOUNT_FAIL_LOCAL_DIR" ]; then
  echo "simulated mount failure: $local_dir" >&2
  exit 23
fi
if [ -n "\${FAKE_MOUNT_FAIL_LATER_LOCAL_DIR:-}" ] && [ "$local_dir" = "$FAKE_MOUNT_FAIL_LATER_LOCAL_DIR" ]; then
  echo "simulated later mount failure: $local_dir" >&2
  exit 41
fi
mkdir -p "$local_dir"
printf mounted > "$local_dir/.mounted"
mkdir -p "$local_dir/.relay"
if [ "\${FAKE_MOUNT_INCOMPLETE:-}" = 1 ]; then
  printf '%s' '{"bootstrap":{"cursor":"resume-here"}}' > "$local_dir/.relay/state.json"
else
  printf '%s' '{"lastSuccessfulReconcileAt":"2026-08-30T00:00:00Z"}' > "$local_dir/.relay/state.json"
fi
`,
  );
  chmodSync(fakeMount, 0o755);
  return { binDir, localRoot };
}

function mountCalls(callsPath: string): string[] {
  return readFileSync(callsPath, "utf8").trim().split("\n");
}

function testShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
      assert.match(start, /--local-layout 'exact'/);
      assert.doesNotMatch(start, /--token/);
    });

    it("keeps exact local layout when only tokenIngress is set", () => {
      const start = buildRelayfileMountStartShell({ ...BASE, tokenIngress: "env" });
      assert.match(start, /--local-layout 'exact'/);
      assert.doesNotMatch(start, /RELAYFILE_MOUNT_LOCAL_LAYOUT=/);
    });
  });
});

describe("exact local-layout contract", () => {
  it("fails the initial readiness barrier when persisted bootstrap is incomplete", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    for (const timing of [
      {},
      { timeoutSeconds: 30 },
      { idleTimeoutSeconds: 30 },
    ]) {
      const shell = buildRelayfileMountInitialSyncShell({
        ...BASE,
        ...timing,
        localDir: localRoot,
      });
      const result = spawnSync("/bin/sh", ["-c", shell], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_MOUNT_INCOMPLETE: "1",
        },
        encoding: "utf8",
      });

      assert.equal(result.status, RELAYFILE_INITIAL_SYNC_INCOMPLETE_EXIT_CODE);
      assert.match(result.stderr, /paused before complete readiness/u);
    }
  });

  it("requires every exact-layout root to have a completed public state", (t) => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-mount-ready-state-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const first = join(root, "github/repos/acme/cloud/.relay");
    const second = join(root, "slack/channels/C123/.relay");
    for (const stateDir of [first, second]) {
      const mkdir = spawnSync("mkdir", ["-p", stateDir]);
      assert.equal(mkdir.status, 0, mkdir.stderr?.toString());
      writeFileSync(
        join(stateDir, "state.json"),
        '{"lastSuccessfulReconcileAt":"2026-08-30T00:00:00Z"}',
      );
    }
    const guard = buildRelayfileMountInitialSyncCompletionGuardShell({
      localDir: root,
      paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
    });

    const complete = spawnSync("/bin/sh", ["-c", guard], { encoding: "utf8" });
    assert.equal(complete.status, 0, complete.stderr);

    writeFileSync(join(second, "state.json"), '{"bootstrap":{"cursor":"next"}}');
    const incomplete = spawnSync("/bin/sh", ["-c", guard], { encoding: "utf8" });
    assert.equal(incomplete.status, RELAYFILE_INITIAL_SYNC_INCOMPLETE_EXIT_CODE);
  });

  it("pins the single-path on-disk mirror root explicitly", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);

    const shell = buildRelayfileMountFlushShell({
      ...BASE,
      localDir: localRoot,
      paths: ["/github/repos/acme/cloud/**"],
    });
    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(join(localRoot, "github/repos/acme/cloud/.mounted")),
      true,
      "the exact mirror root must include the normalized remote path",
    );
    assert.equal(
      existsSync(join(localRoot, ".mounted")),
      false,
      "a successful process at the unscoped base would silently mirror at the wrong depth",
    );
  });

  it("starts one exact-layout daemon per remote root", () => {
    const shell = buildRelayfileMountStartShell({
      ...BASE,
      paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
    });

    assert.doesNotMatch(shell, /RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped/);
    assert.doesNotMatch(shell, /paths-file/);
    assert.equal(shell.match(/relayfile-mount --local-layout 'exact'/g)?.length, 2);
    assert.match(
      shell,
      /--local-dir '\/home\/user\/workspace\/github\/repos\/acme\/cloud'.*--remote-path '\/github\/repos\/acme\/cloud'/,
    );
    assert.match(
      shell,
      /--local-dir '\/home\/user\/workspace\/slack\/channels\/C123'.*--remote-path '\/slack\/channels\/C123'/,
    );
  });

  it("does not double-join an already joined local directory", () => {
    const shell = buildRelayfileMountStartShell({
      ...BASE,
      localDir: "/home/user/workspace/github/repos/acme/cloud/issues/42",
      paths: ["/github/repos/acme/cloud/issues/42/**"],
    });

    assert.match(
      shell,
      /--local-dir '\/home\/user\/workspace\/github\/repos\/acme\/cloud\/issues\/42'/,
    );
    assert.doesNotMatch(shell, /issues\/42\/github\/repos/);
  });

  it("fails closed when a remote root could escape the local mount root", () => {
    assert.throws(
      () => buildRelayfileMountFlushShell({
        ...BASE,
        paths: ["/../../tmp/**"],
      }),
      /traversal segment/,
    );
  });

  it("keeps a multi-root cleanup flush inside one timeout-compatible command", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const shell = buildRelayfileMountCleanupFlushShell({
      ...BASE,
      localDir: localRoot,
      paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
    });

    assert.match(shell, /^sh -c /);
    assert.equal(shell.match(/relayfile-mount "\$1"/g)?.length, 2);
    assert.match(shell, /--local-layout/);
    assert.match(shell, /workspace\/github\/repos\/acme\/cloud/);
    assert.match(shell, /workspace\/slack\/channels\/C123/);
    assert.match(shell, /relayfile-mount-cleanup "\$relayfile_mount_flush_mode"$/);

    const result = spawnSync(
      "/bin/sh",
      ["-c", `relayfile_mount_flush_mode=--once; ${shell}`],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(join(localRoot, "github/repos/acme/cloud/.mounted")),
      true,
    );
    assert.equal(
      existsSync(join(localRoot, "slack/channels/C123/.mounted")),
      true,
    );
  });

  it("attempts every cleanup root and returns the first failure", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const firstRoot = join(localRoot, "github/repos/acme/cloud");
    const laterRoot = join(localRoot, "slack/channels/C123");
    const callsPath = join(binDir, "cleanup-calls.log");
    const shell = buildRelayfileMountCleanupFlushShell({
      ...BASE,
      localDir: localRoot,
      paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
    });

    const result = spawnSync(
      "/bin/sh",
      ["-c", `relayfile_mount_flush_mode=--once; ${shell}`],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_MOUNT_CALLS: callsPath,
          FAKE_MOUNT_FAIL_LOCAL_DIR: firstRoot,
          FAKE_MOUNT_FAIL_LATER_LOCAL_DIR: laterRoot,
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 23, result.stderr);
    assert.equal(existsSync(join(firstRoot, ".mounted")), false);
    assert.equal(existsSync(join(laterRoot, ".mounted")), false);
    assert.deepEqual(mountCalls(callsPath), [firstRoot, laterRoot]);
  });

  it("attempts every ordinary flush root and returns the first failure", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const firstRoot = join(localRoot, "github/repos/acme/cloud");
    const laterRoot = join(localRoot, "slack/channels/C123");
    const callsPath = join(binDir, "ordinary-flush-calls.log");
    const shell = buildRelayfileMountFlushShell({
      ...BASE,
      localDir: localRoot,
      paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
    });

    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_MOUNT_CALLS: callsPath,
        FAKE_MOUNT_FAIL_LOCAL_DIR: firstRoot,
        FAKE_MOUNT_FAIL_LATER_LOCAL_DIR: laterRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 23, result.stderr);
    assert.equal(existsSync(join(firstRoot, ".mounted")), false);
    assert.equal(existsSync(join(laterRoot, ".mounted")), false);
    assert.deepEqual(mountCalls(callsPath), [firstRoot, laterRoot]);
  });

  it("attempts every initial-sync root and returns the first failure", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const firstRoot = join(localRoot, "github/repos/acme/cloud");
    const laterRoot = join(localRoot, "slack/channels/C123");
    const callsPath = join(binDir, "initial-sync-calls.log");
    const shell = buildRelayfileMountInitialSyncShell({
      ...BASE,
      localDir: localRoot,
      paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
    });

    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_MOUNT_CALLS: callsPath,
        FAKE_MOUNT_FAIL_LOCAL_DIR: firstRoot,
        FAKE_MOUNT_FAIL_LATER_LOCAL_DIR: laterRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 23, result.stderr);
    assert.equal(existsSync(join(firstRoot, ".mounted")), false);
    assert.equal(existsSync(join(laterRoot, ".mounted")), false);
    assert.deepEqual(mountCalls(callsPath), [firstRoot, laterRoot]);
  });

  it("attempts every timeout-wrapped initial-sync root", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const firstRoot = join(localRoot, "github/repos/acme/cloud");
    const laterRoot = join(localRoot, "slack/channels/C123");
    const callsPath = join(binDir, "timed-initial-sync-calls.log");
    const shell = buildRelayfileMountInitialSyncShell({
      ...BASE,
      localDir: localRoot,
      paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
      timeoutSeconds: 2,
    });

    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_MOUNT_CALLS: callsPath,
        FAKE_MOUNT_FAIL_LOCAL_DIR: firstRoot,
        FAKE_MOUNT_FAIL_LATER_LOCAL_DIR: laterRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 23, result.stderr);
    assert.equal(existsSync(join(firstRoot, ".mounted")), false);
    assert.equal(existsSync(join(laterRoot, ".mounted")), false);
    assert.deepEqual(mountCalls(callsPath), [firstRoot, laterRoot]);
  });

  it("renders late-bound shell templates as separate exact mounts", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const template = buildRelayfileMountShellTemplate({}, {
      stateDir: join(localRoot, ".state"),
      websocket: false,
    });
    for (const renderedTemplate of [
      template.startShellTemplate,
      template.flushShellTemplate,
    ]) {
      assert.match(
        renderedTemplate,
        /--remote-path "\$relayfile_mount_remote_path"/,
        "late-bound exact mounts must retain their remote-path filter",
      );
    }
    const values = {
      baseUrl: BASE.baseUrl,
      workspaceId: BASE.workspaceId,
      localDir: localRoot,
      token: BASE.token,
    };
    let shell = template.flushShellTemplate;
    for (const [key, value] of Object.entries(values)) {
      const placeholder = template.placeholders[key as keyof typeof values];
      shell = shell.replace(testShellQuote(placeholder), testShellQuote(value));
    }
    shell = shell.replace(
      template.pathArgsPlaceholderArg,
      buildRelayfileMountPathArgsShell([
        "/github/repos/acme/cloud/**",
        "/slack/channels/C123/**",
      ]),
    );

    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(join(localRoot, "github/repos/acme/cloud/.mounted")),
      true,
    );
    assert.equal(
      existsSync(join(localRoot, "slack/channels/C123/.mounted")),
      true,
    );
    assert.equal(existsSync(join(localRoot, ".mounted")), false);
  });

  it("attempts every late-bound flush root and returns the first failure", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const firstRoot = join(localRoot, "github/repos/acme/cloud");
    const laterRoot = join(localRoot, "slack/channels/C123");
    const callsPath = join(binDir, "late-bound-flush-calls.log");
    const template = buildRelayfileMountShellTemplate({}, {
      stateDir: join(localRoot, ".state"),
      websocket: false,
    });
    const values = {
      baseUrl: BASE.baseUrl,
      workspaceId: BASE.workspaceId,
      localDir: localRoot,
      token: BASE.token,
    };
    let shell = template.flushShellTemplate;
    for (const [key, value] of Object.entries(values)) {
      const placeholder = template.placeholders[key as keyof typeof values];
      shell = shell.replace(testShellQuote(placeholder), testShellQuote(value));
    }
    shell = shell.replace(
      template.pathArgsPlaceholderArg,
      buildRelayfileMountPathArgsShell([
        "/github/repos/acme/cloud/**",
        "/slack/channels/C123/**",
      ]),
    );

    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_MOUNT_CALLS: callsPath,
        FAKE_MOUNT_FAIL_LOCAL_DIR: firstRoot,
        FAKE_MOUNT_FAIL_LATER_LOCAL_DIR: laterRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 23, result.stderr);
    assert.equal(existsSync(join(firstRoot, ".mounted")), false);
    assert.equal(existsSync(join(laterRoot, ".mounted")), false);
    assert.deepEqual(mountCalls(callsPath), [firstRoot, laterRoot]);
  });

  it("surfaces late-bound daemon argument validation failures", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const template = buildRelayfileMountShellTemplate({}, {
      stateDir: join(localRoot, ".state"),
      websocket: false,
    });
    const values = {
      baseUrl: BASE.baseUrl,
      workspaceId: BASE.workspaceId,
      localDir: localRoot,
      token: BASE.token,
    };
    for (const testCase of [
      {
        pathArgs: " --not-a-path '/bad'",
        message: /invalid relayfile mount path args/,
      },
      {
        pathArgs: " --remote-path '/github/../secrets'",
        message: /relayfile remote root contains a traversal segment/,
      },
      {
        pathArgs: " --remote-path 'github/repos/acme/cloud'",
        message: /relayfile remote root must be absolute/,
      },
      {
        pathArgs: " --remote-path '/'",
        message: /relayfile remote root must not be empty/,
      },
    ]) {
      let shell = template.startShellTemplate;
      for (const [key, value] of Object.entries(values)) {
        const placeholder = template.placeholders[key as keyof typeof values];
        shell = shell.replace(testShellQuote(placeholder), testShellQuote(value));
      }
      shell = shell.replace(template.pathArgsPlaceholderArg, testCase.pathArgs);

      const result = spawnSync("/bin/sh", ["-c", shell], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      assert.equal(result.status, 2);
      assert.match(result.stderr, testCase.message);
    }
  });

  it("does not mutate an embedding shell's positional parameters", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const template = buildRelayfileMountShellTemplate({}, {
      stateDir: join(localRoot, ".state"),
      websocket: false,
    });
    const values = {
      baseUrl: BASE.baseUrl,
      workspaceId: BASE.workspaceId,
      localDir: localRoot,
      token: BASE.token,
    };
    let shell = template.flushShellTemplate;
    for (const [key, value] of Object.entries(values)) {
      const placeholder = template.placeholders[key as keyof typeof values];
      shell = shell.replace(testShellQuote(placeholder), testShellQuote(value));
    }
    shell = shell.replace(
      template.pathArgsPlaceholderArg,
      buildRelayfileMountPathArgsShell(["/slack/channels/C123/**"]),
    );

    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        `set -- original arguments; ${shell}; [ "$#" -eq 2 ] && [ "$1" = original ] && [ "$2" = arguments ]`,
      ],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
  });

  it("does not double-join a late-bound already joined local directory", (t) => {
    const { binDir, localRoot } = fakeExactMount(t);
    const joinedRoot = join(localRoot, "github/repos/acme/cloud");
    const template = buildRelayfileMountShellTemplate({}, {
      stateDir: join(localRoot, ".state"),
      websocket: false,
    });
    const values = {
      baseUrl: BASE.baseUrl,
      workspaceId: BASE.workspaceId,
      localDir: joinedRoot,
      token: BASE.token,
    };
    let shell = template.flushShellTemplate;
    for (const [key, value] of Object.entries(values)) {
      const placeholder = template.placeholders[key as keyof typeof values];
      shell = shell.replace(testShellQuote(placeholder), testShellQuote(value));
    }
    shell = shell.replace(
      template.pathArgsPlaceholderArg,
      buildRelayfileMountPathArgsShell(["/github/repos/acme/cloud/**"]),
    );

    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(joinedRoot, ".mounted")), true);
    assert.equal(
      existsSync(join(joinedRoot, "github/repos/acme/cloud/.mounted")),
      false,
    );
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
    const normalizedShell = shell.replaceAll("'\\''", "'");

    assert.equal(armed.length, 2);
    assert.equal(
      normalizedShell.match(/relayfile-mount --once --local-layout 'exact'/g)?.length,
      2,
    );
    assert.match(
      normalizedShell,
      /--local-dir '\/home\/user\/workspace\/github\/agentworkforce'.*--remote-path '\/github\/agentworkforce'/,
    );
    assert.match(
      normalizedShell,
      /--local-dir '\/home\/user\/workspace\/slack\/C0BBTBC1RCM'.*--remote-path '\/slack\/C0BBTBC1RCM'/,
    );
    for (const file of armed) {
      assert.ok(
        normalizedShell.includes(`--state-file '${file}'`),
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

/**
 * Regression guard for AgentWorkforce/sandbox#30.
 *
 * The detached initial-sync launcher generates a shell script under /tmp and
 * hands it to a background process. Two things went wrong at once:
 *
 *   - `cat > <script>` created the file at the process umask default, so under
 *     the production sandbox's 022 umask the script landed group/world
 *     readable; and
 *   - the default `argv` ingress rendered the path-scoped token into that
 *     script as a `--token` literal.
 *
 * Together those left a reusable credential readable by any sibling process in
 * the sandbox, even though a mode-0600 creds file was already being supplied
 * alongside the launch command. The script also outlived the sync that used it.
 *
 * These tests execute the real launcher through /bin/sh under an explicit 022
 * umask and assert against the file that actually lands on disk — a string
 * assertion on the generated shell would not have caught the umask defect.
 */
describe("detached initial-sync script credential hygiene (sandbox#30)", () => {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(
    predicate: () => boolean,
    { timeoutMs = 15_000, stepMs = 25 } = {},
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) {
        return true;
      }
      await sleep(stepMs);
    }
    return predicate();
  }

  /**
   * Read the mode of the file that actually landed the way the launcher itself
   * does — through `stat`, asserted by the exit code of the comparison rather
   * than by a string match in JS. GNU/busybox spell it `stat -c %a`, BSD
   * `stat -f %Lp`.
   */
  function assertLandedMode(path: string, expected: string): void {
    const check = spawnSync(
      "/bin/sh",
      [
        "-c",
        'mode=$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null)' +
          ' || exit 2; printf %s "$mode"; [ "$mode" = "$2" ]',
        "sh",
        path,
        expected,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(
      check.status,
      2,
      `could not stat the file the launcher actually created: ${path}`,
    );
    assert.equal(
      check.status,
      0,
      `expected ${path} to land at mode ${expected}, got ${check.stdout}`,
    );
  }

  /**
   * The launcher tolerates `unknown` when neither `stat` spelling exists, so
   * the refusal path below can only be exercised where one of them works.
   */
  function statSupported(): boolean {
    const probe = spawnSync("/bin/sh", [
      "-c",
      "stat -c %a /tmp >/dev/null 2>&1 || stat -f %Lp /tmp >/dev/null 2>&1",
    ]);
    return probe.status === 0;
  }

  /**
   * Paths the launcher owns for a given run id. Registered for removal so a
   * failing assertion cannot leave a credential-bearing file behind in /tmp.
   */
  function runPaths(t: TestContext, runId: string): {
    scriptPath: string;
    exitPath: string;
    logPath: string;
    pidPath: string;
    reapedPath: string;
  } {
    const paths = {
      scriptPath: `${RELAYFILE_INITIAL_SYNC_SCRIPT_PATH}.${runId}`,
      exitPath: `${RELAYFILE_INITIAL_SYNC_EXIT_PATH}.${runId}`,
      logPath: `${RELAYFILE_INITIAL_SYNC_LOG_PATH}.${runId}`,
      pidPath: `${RELAYFILE_INITIAL_SYNC_PID_PATH}.${runId}`,
      reapedPath: `${RELAYFILE_INITIAL_SYNC_REAPED_PATH}.${runId}`,
    };
    t.after(() => {
      for (const path of Object.values(paths)) {
        rmSync(path, { force: true });
      }
    });
    return paths;
  }

  /**
   * A relayfile-mount stand-in that blocks until a release file appears, so the
   * generated script is guaranteed to still be on disk while the test stats it.
   * The bounded spin means a wedged test cannot leave the fake running forever.
   */
  function blockingFakeMount(t: TestContext): {
    binDir: string;
    root: string;
    release: () => void;
  } {
    const root = mkdtempSync(join(tmpdir(), "sandbox-sec30-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const binDir = join(root, "bin");
    const mkdir = spawnSync("mkdir", ["-p", binDir]);
    assert.equal(mkdir.status, 0, mkdir.stderr?.toString());

    const releasePath = join(root, "release");
    const fakeMount = join(binDir, "relayfile-mount");
    writeFileSync(
      fakeMount,
      `#!/bin/sh
local_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-dir) local_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
attempts=0
while [ ! -f '${releasePath}' ] && [ "$attempts" -lt 400 ]; do
  attempts=$((attempts + 1))
  sleep 0.05
done
mkdir -p "$local_dir/.relay"
printf '%s' '{"lastSuccessfulReconcileAt":"2026-08-30T00:00:00Z"}' > "$local_dir/.relay/state.json"
exit 0
`,
    );
    chmodSync(fakeMount, 0o755);
    return {
      binDir,
      root,
      release: () => writeFileSync(releasePath, "go"),
    };
  }

  function launch(
    launcher: string,
    binDir: string,
  ): ReturnType<typeof spawnSync> {
    // The explicit 022 umask is the point: it is the production sandbox's
    // umask, and it is what made `cat >` produce a 0644 script.
    return spawnSync("/bin/sh", ["-c", `umask 022; ${launcher}`], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
  }

  it("creates the generated script at mode exactly 0600 under a 022 umask", async (t) => {
    const runId = "sec30-mode";
    const { scriptPath } = runPaths(t, runId);
    const { binDir, root, release } = blockingFakeMount(t);

    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      {
        ...BASE,
        localDir: join(root, "workspace"),
        stateDir: join(root, "state"),
        credsFilePath: join(root, "creds.json"),
      },
      { runId },
    );
    const result = launch(launcher, binDir);
    assert.equal(result.status, 0, result.stderr);

    assert.equal(
      await waitFor(() => existsSync(scriptPath)),
      true,
      "launcher never produced the generated initial-sync script",
    );

    // The property under test is the mode of the file on disk, so it is read
    // back off the real file: once by `stat` (exit code), once through node.
    assertLandedMode(scriptPath, "600");
    const mode = statSync(scriptPath).mode & 0o777;
    assert.equal(
      mode.toString(8),
      "600",
      "the generated script may carry a credential and must never be readable " +
        "by another user or process in the sandbox",
    );
    // ...and this is why the mode is the whole fix: under the default argv
    // ingress the credential really is sitting in that file.
    assert.ok(
      readFileSync(scriptPath, "utf8").includes(TOKEN),
      "expected the default ingress to put the credential in the script, " +
        "which is what makes the 0600 mode load-bearing",
    );

    release();
  });

  it("keeps the token literal out of the generated script under creds-file ingress", async (t) => {
    const runId = "sec30-no-literal";
    const { scriptPath } = runPaths(t, runId);
    const { binDir, root, release } = blockingFakeMount(t);

    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      {
        ...BASE,
        localDir: join(root, "workspace"),
        stateDir: join(root, "state"),
        credsFilePath: join(root, "creds.json"),
        tokenIngress: "creds-file",
      },
      { runId },
    );

    assert.doesNotMatch(
      launcher,
      /--token/,
      "creds-file ingress must not render --token anywhere in the launcher",
    );
    assert.ok(
      !launcher.includes(TOKEN),
      "creds-file ingress must not render the token literal in the launcher",
    );
    assert.match(launcher, /RELAYFILE_MOUNT_CREDS_FILE=/);

    const result = launch(launcher, binDir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await waitFor(() => existsSync(scriptPath)),
      true,
      "launcher never produced the generated initial-sync script",
    );

    const contents = readFileSync(scriptPath, "utf8");
    assert.ok(
      !contents.includes(TOKEN),
      "the on-disk generated script still contains the credential literal",
    );
    assertLandedMode(scriptPath, "600");
    assert.equal(statSync(scriptPath).mode & 0o777, 0o600);

    release();
  });

  it("still renders --token for the default argv ingress (older daemons)", () => {
    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      { ...BASE, credsFilePath: "/etc/relayfile/creds.json" },
      { runId: "sec30-compat" },
    );
    // A creds file alone must NOT silently drop the flag: pre-creds binaries
    // ignore RELAYFILE_MOUNT_CREDS_FILE, so dropping --token for them would
    // turn a working mount into a silent authentication failure. Removing the
    // literal is opt-in via tokenIngress.
    assert.match(launcher, /--token/);
    assert.ok(launcher.includes(TOKEN));
  });

  it("rejects creds-file ingress that has no creds file to read", () => {
    assert.throws(
      () =>
        buildRelayfileMountInitialSyncBackgroundShell(
          { ...BASE, tokenIngress: "creds-file" },
          { runId: "sec30-guard" },
        ),
      /credsFilePath/,
      "creds-file ingress renders no token by any route, so a missing creds " +
        "file must fail loudly at build time",
    );
  });

  it("removes the generated script once the detached sync exits", async (t) => {
    const runId = "sec30-cleanup";
    const { scriptPath, exitPath, logPath } = runPaths(t, runId);
    const { binDir, root, release } = blockingFakeMount(t);

    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      {
        ...BASE,
        localDir: join(root, "workspace"),
        stateDir: join(root, "state"),
        credsFilePath: join(root, "creds.json"),
        tokenIngress: "creds-file",
      },
      { runId },
    );
    const result = launch(launcher, binDir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await waitFor(() => existsSync(scriptPath)),
      true,
      "launcher never produced the generated initial-sync script",
    );

    release();

    assert.equal(
      await waitFor(() => existsSync(exitPath)),
      true,
      "detached sync never wrote its exit sentinel",
    );
    // The script is removed BEFORE the exit sentinel lands, so a poller that
    // has observed completion can never race back and read the script.
    assert.equal(
      existsSync(scriptPath),
      false,
      "the generated script outlived the sync that used it",
    );
    // Non-secret diagnostics are deliberately preserved for failure analysis.
    assert.equal(readFileSync(exitPath, "utf8").trim(), "0");
    assert.equal(existsSync(logPath), true, "the sync log must be preserved");
  });

  /**
   * The gating test for the mode check: it runs the check rather than reading
   * it. The launcher is mutated back to the pre-fix creation mode (`umask 022`
   * in place of `umask 077`), which is the exact regression the check exists to
   * catch, and then executed — so a check that is present in the generated text
   * but broken at runtime fails here instead of passing a string match.
   */
  it("refuses to launch, at runtime, when the script does not land at 0600", async (t) => {
    if (!statSupported()) {
      t.skip("no stat -c/-f available; the launcher tolerates an unknown mode");
      return;
    }
    const runId = "sec30-refuse";
    const { scriptPath, exitPath, pidPath, logPath } = runPaths(t, runId);
    const { binDir, root, release } = blockingFakeMount(t);

    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      {
        ...BASE,
        localDir: join(root, "workspace"),
        stateDir: join(root, "state"),
        credsFilePath: join(root, "creds.json"),
      },
      { runId },
    );
    const defective = launcher.replace(
      "(umask 077 && cat > ",
      "(umask 022 && cat > ",
    );
    assert.notEqual(
      defective,
      launcher,
      "the mode must be constrained at creation by `umask 077`, not by a " +
        "chmod after the write, which would leave a readable window",
    );

    const result = launch(defective, binDir);

    assert.notEqual(
      result.status,
      0,
      "a script that landed group/world readable must abort the launch",
    );
    assert.match(
      result.stderr ?? "",
      /is mode 644, not 600; refusing to launch/,
      "expected the refusal to name the mode that actually landed",
    );
    assert.equal(
      existsSync(scriptPath),
      false,
      "the readable script must be removed, not left in /tmp",
    );
    // Nothing may have been handed to a detached process: no pid, no log, no
    // exit sentinel, because the sync never started.
    assert.equal(existsSync(pidPath), false, "a sync was started anyway");
    assert.equal(existsSync(logPath), false, "a sync was started anyway");
    assert.equal(
      await waitFor(() => existsSync(exitPath), { timeoutMs: 500 }),
      false,
      "a sync was started anyway",
    );

    // Nothing should be holding the fake mount, but release it the way the
    // other launching tests do so a surprise child cannot outlive the test.
    release();
  });

  /**
   * A relayfile-mount stand-in that exits immediately with a chosen status, so
   * the runner reaches its completion window straight away.
   */
  function instantFakeMount(
    t: TestContext,
    exitCode: number,
  ): { binDir: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "sandbox-sec30-window-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const binDir = join(root, "bin");
    const mkdir = spawnSync("mkdir", ["-p", binDir]);
    assert.equal(mkdir.status, 0, mkdir.stderr?.toString());
    const fakeMount = join(binDir, "relayfile-mount");
    writeFileSync(fakeMount, `#!/bin/sh
local_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-dir) local_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ ${exitCode} -eq 0 ]; then
  mkdir -p "$local_dir/.relay"
  printf '%s' '{"lastSuccessfulReconcileAt":"2026-08-30T00:00:00Z"}' > "$local_dir/.relay/state.json"
fi
exit ${exitCode}
`);
    chmodSync(fakeMount, 0o755);
    return { binDir, root };
  }

  /**
   * Wedge the runner open inside its completion window. The runner removes the
   * generated script between reaping the child and publishing the exit
   * sentinel; a `rm` that performs the removal and then blocks holds that
   * window open for as long as the test needs, so the window is observed
   * rather than raced for.
   *
   * Only the runner's own `rm -f <script>` is intercepted: the launcher's
   * pre-run sweep passes five paths, and the sync script's idle-marker removal
   * names a different file.
   */
  function installHoldingRm(
    binDir: string,
    scriptPath: string,
    enteredPath: string,
    releasePath: string,
  ): void {
    const rm = join(binDir, "rm");
    writeFileSync(
      rm,
      `#!/bin/sh
if [ "$#" -eq 2 ] && [ "$2" = '${scriptPath}' ]; then
  /bin/rm -f "$2"
  : > '${enteredPath}'
  attempts=0
  while [ ! -f '${releasePath}' ] && [ "$attempts" -lt 400 ]; do
    attempts=$((attempts + 1))
    sleep 0.05
  done
  exit 0
fi
exec /bin/rm "$@"
`,
    );
    chmodSync(rm, 0o755);
  }

  /** Run the real status probe the way the orchestrator's poll loop does. */
  function probeStatus(runId: string): RelayfileMountInitialSyncStatus {
    const probe = spawnSync(
      "/bin/sh",
      ["-c", buildRelayfileMountInitialSyncStatusShell({ runId })],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    return parseRelayfileMountInitialSyncStatus(probe.stdout);
  }

  /**
   * Removing the script after the sync is done with it (the credential fix
   * above) put a fork+exec between reaping the child and publishing its exit
   * status. Inside that interval the pid file names a dead process, so the
   * probe's dead-PID heuristic called a healthy sync a crash — `exit 127`,
   * which `startMount` turns into a failed mount. Reported by CodeRabbit on
   * PR #39.
   *
   * This must-fire holds the window open and polls the real probe inside it.
   * Before the completion marker it fails on the first poll.
   */
  it("does not report a failure inside the completion window", async (t) => {
    const runId = "sec30-window";
    const { scriptPath, exitPath, reapedPath, pidPath } = runPaths(t, runId);
    const { binDir, root } = instantFakeMount(t, 0);
    const enteredPath = join(root, "rm-entered");
    const releasePath = join(root, "rm-release");
    installHoldingRm(binDir, scriptPath, enteredPath, releasePath);

    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      {
        ...BASE,
        localDir: join(root, "workspace"),
        stateDir: join(root, "state"),
        credsFilePath: join(root, "creds.json"),
        tokenIngress: "creds-file",
      },
      { runId },
    );
    const result = launch(launcher, binDir);
    assert.equal(result.status, 0, result.stderr);

    assert.equal(
      await waitFor(() => existsSync(enteredPath)),
      true,
      "the runner never reached the script removal",
    );

    // Confirm this really is the window before asserting anything about it:
    // child reaped, script gone, exit status not yet published.
    assert.equal(existsSync(reapedPath), true, "the window was never marked");
    assert.equal(existsSync(scriptPath), false, "the script was not removed");
    assert.equal(existsSync(pidPath), true, "the pid file is what misleads the probe");
    assert.equal(existsSync(exitPath), false, "the exit sentinel landed too early");

    for (let poll = 0; poll < 25; poll += 1) {
      const status = probeStatus(runId);
      assert.deepEqual(
        status,
        { state: "running" },
        `probe reported ${JSON.stringify(status)} inside the completion ` +
          "window; startMount turns a non-zero exit here into a failed mount " +
          "for a sync that is finishing normally",
      );
      await sleep(10);
    }

    assert.equal(
      existsSync(exitPath),
      false,
      "the window closed on its own, so those polls proved nothing",
    );

    writeFileSync(releasePath, "go");
    assert.equal(
      await waitFor(() => existsSync(exitPath)),
      true,
      "the exit sentinel never landed after the window closed",
    );
    assert.deepEqual(probeStatus(runId), { state: "exited", exitCode: 0 });
  });

  /**
   * The must-not-fire. Same on-disk state as the window above, minus the
   * completion marker: a sync whose runner died without ever publishing an
   * exit status is still a failure, and the marker must not soften that.
   */
  it("still reports a failure for a sync that died before completion", (t) => {
    const runId = "sec30-died";
    const { pidPath, reapedPath } = runPaths(t, runId);
    // Above both Linux's default pid_max and macOS's, so it names no process
    // on any host and cannot be reused out from under the assertion.
    writeFileSync(pidPath, "4194305\n");

    assert.deepEqual(
      probeStatus(runId),
      { state: "exited", exitCode: 127 },
      "a dead sync with no exit status must still read as a failure",
    );

    // The marker is the only difference between the two states.
    writeFileSync(reapedPath, "");
    assert.deepEqual(probeStatus(runId), { state: "running" });
  });

  it("still reports a genuinely failed sync as a failure end to end", async (t) => {
    const runId = "sec30-failed";
    const { exitPath } = runPaths(t, runId);
    const { binDir, root } = instantFakeMount(t, 3);

    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      {
        ...BASE,
        localDir: join(root, "workspace"),
        stateDir: join(root, "state"),
        credsFilePath: join(root, "creds.json"),
        tokenIngress: "creds-file",
      },
      { runId },
    );
    const result = launch(launcher, binDir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await waitFor(() => existsSync(exitPath)),
      true,
      "the exit sentinel never landed",
    );

    const status = probeStatus(runId);
    assert.equal(status.state, "exited");
    assert.notEqual(
      status.state === "exited" ? status.exitCode : 0,
      0,
      "a sync whose mount failed must not be reported as a success",
    );
  });

  it("clears a stale completion marker before a new run", (t) => {
    // A marker left by a previous run would make this run's dead-PID check
    // unreachable, so the launcher's pre-run sweep has to take it.
    const runId = "sec30-stale";
    const { reapedPath } = runPaths(t, runId);
    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      { ...BASE, credsFilePath: "/etc/relayfile/creds.json" },
      { runId },
    );
    const sweep = launcher.split("\n").find((line) => line.startsWith("rm -f "));
    assert.ok(sweep, "expected a pre-run sweep");
    assert.ok(
      sweep.includes(reapedPath),
      "the pre-run sweep must clear a stale completion marker",
    );
  });

  it("constrains the mode at creation rather than by a chmod after the write", () => {
    // Fast unit alongside the executing test above: creation order is a
    // property of the generated text, and a chmod-after-write would leave a
    // readable window that a mode assertion on the finished file cannot see.
    const launcher = buildRelayfileMountInitialSyncBackgroundShell(
      { ...BASE, credsFilePath: "/etc/relayfile/creds.json" },
      { runId: "sec30-order" },
    );
    assert.match(launcher, /\(umask 077 && cat > /);
    const verifyAt = launcher.indexOf("relayfile_initial_sync_mode=");
    const launchAt = launcher.indexOf("nohup sh -c");
    assert.ok(verifyAt > 0, "expected a post-write mode verification");
    assert.ok(
      verifyAt < launchAt,
      "the mode check must run before the script is handed to the detached process",
    );
  });
});
