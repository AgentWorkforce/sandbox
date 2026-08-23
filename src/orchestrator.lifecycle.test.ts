import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import {
  buildRelayfileMountCleanupInvocationShell,
  buildRelayfileMountLifecycleShell,
} from "./orchestrator.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fakeLifecycleMount(t: TestContext): { binDir: string; localRoot: string } {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "sandbox-mount-lifecycle-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const binDir = join(fixtureRoot, "bin");
  const localRoot = join(fixtureRoot, "workspace");
  mkdirSync(binDir, { recursive: true });
  const fakeMount = join(binDir, "relayfile-mount");
  writeFileSync(
    fakeMount,
    `#!/bin/sh
if [ "\${1:-}" = --help ]; then
  echo '  --flush-outbox-once'
  echo '  --push-local-once'
  exit 0
fi
local_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-dir) local_dir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$local_dir" ]; then exit 2; fi
mkdir -p "$local_dir"
exit 0
`,
  );
  chmodSync(fakeMount, 0o755);
  return { binDir, localRoot };
}

describe("relayfile exact-root lifecycle observability", () => {
  it("aggregates writeback state and receipt scans from joined mount roots", (t) => {
    const { binDir, localRoot } = fakeLifecycleMount(t);
    const slackRoot = join(localRoot, "slack/channels/C123");
    const commandRoot = join(slackRoot, "messages");
    const stateDir = join(slackRoot, ".relay");
    const outboxDir = join(stateDir, "outbox");
    const lifecycle = buildRelayfileMountLifecycleShell({
      localDir: localRoot,
      mount: {
        baseUrl: "https://relayfile.example",
        workspaceId: "wsp_abc",
        stateDir: join(localRoot, ".state"),
        token: "relay_pa_test",
        paths: ["/github/repos/acme/cloud/**", "/slack/channels/C123/**"],
        websocket: false,
      },
      commandRootLocalDirs: [commandRoot],
      cleanupStatusMessage: "relayfile.mount.cleanup",
    });
    const cleanup = buildRelayfileMountCleanupInvocationShell({ pid: "test" });
    assert.match(
      lifecycle,
      /timeout 150s sh -c/,
      "the outer cleanup budget must scale across two sequential exact roots",
    );
    const script = [
      lifecycle,
      'touch -t 200001010000 "$RELAYFILE_MOUNT_FLUSH_MARKER"',
      `mkdir -p ${shellQuote(join(outboxDir, "pending"))} ${shellQuote(join(outboxDir, "acked"))} ${shellQuote(commandRoot)}`,
      `printf '%s' '{"pendingWriteback":3,"states":{"hasPendingWriteback":true,"outboxNeedsAttention":true}}' > ${shellQuote(join(stateDir, "state.json"))}`,
      `printf '%s' '{"schemaVersion":2,"dispatchReceipts":true}' > ${shellQuote(join(outboxDir, "capabilities.json"))}`,
      `printf '%s' '{"remotePath":"/slack/channels/C123/messages/draft.json","needsAttention":true}' > ${shellQuote(join(outboxDir, "pending", "command.json"))}`,
      `printf '%s' '{"text":"hello"}' > ${shellQuote(join(commandRoot, "draft.json"))}`,
      cleanup,
      'exit "$MOUNT_EXIT"',
    ].join("\n");

    const result = spawnSync("/bin/sh", ["-c", script], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /"pendingWriteback":3/);
    assert.match(result.stderr, /"hasPendingWriteback":true/);
    assert.match(result.stderr, /"outboxNeedsAttention":true/);
    assert.match(result.stderr, /"commandDraftWrittenThisRun":true/);
    assert.match(result.stderr, /"commandDraftsUndeliverable":1/);
  });
});
