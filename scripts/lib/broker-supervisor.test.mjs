import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearOwnedBrokerState,
  isBrokerProcess,
  readRecordedPid,
  terminateOwnedBrokerProcess,
  writeOwnerRecord,
} from "./broker-supervisor.mjs";

function locations() {
  const root = mkdtempSync(join(tmpdir(), "chief-broker-supervisor-"));
  return {
    connectionPath: join(root, "connection.json"),
    ownerPath: join(root, "chief-node-owner.json"),
  };
}

test("broker process validation rejects a recycled unrelated pid", () => {
  assert.equal(isBrokerProcess(123, () => "/usr/bin/node server.mjs"), false);
  assert.equal(
    isBrokerProcess(123, () => "/opt/bin/agent-relay-broker init --api-port 0"),
    true,
  );
});

test("owned broker teardown escalates from TERM to KILL after a bounded wait", async () => {
  const signals = [];
  let alive = true;
  const result = await terminateOwnedBrokerProcess(123, {
    alive: () => alive,
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    },
    wait: async () => !alive,
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, { signal: "SIGKILL", exited: true });
});

test("owned broker teardown stops after a graceful TERM", async () => {
  const signals = [];
  let alive = true;
  const result = await terminateOwnedBrokerProcess(123, {
    alive: () => alive,
    signal: (_pid, signal) => {
      signals.push(signal);
      alive = false;
    },
    wait: async () => !alive,
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(result, { signal: "SIGTERM", exited: true });
});

test("cleanup never removes a replacement broker connection", () => {
  const paths = locations();
  writeFileSync(paths.connectionPath, '{"pid":456}\n');
  writeOwnerRecord(paths.ownerPath, 123, 99);
  assert.deepEqual(clearOwnedBrokerState({ ...paths, ownedPid: 123 }), {
    connectionCleared: false,
    ownerCleared: true,
  });
  assert.equal(readRecordedPid(paths.connectionPath), 456);
});

test("owner records parse back to the exact pid", () => {
  const paths = locations();
  writeOwnerRecord(paths.ownerPath, 123, 99);
  assert.equal(readRecordedPid(paths.ownerPath), 123);
  assert.equal(JSON.parse(readFileSync(paths.ownerPath, "utf8")).supervisorPid, 99);
  assert.equal(statSync(paths.ownerPath).mode & 0o777, 0o600);
});

test("the installed node job runs through the broker supervisor", () => {
  const installer = readFileSync(new URL("../install.mjs", import.meta.url), "utf8");
  assert.match(installer, /chief-node-supervisor\.mjs/u);
  assert.match(installer, /exitTimeout:\s*20/u);
});
