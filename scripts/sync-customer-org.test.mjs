import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { syncCustomerOrg } from "./sync-customer-org.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture({ members, overlays }) {
  const root = mkdtempSync(join(tmpdir(), "chief-customer-org-"));
  const customerAgentsRepo = join(root, "watchdog-agents");
  const teamDirectory = join(customerAgentsRepo, "customer-success");
  mkdirSync(teamDirectory, { recursive: true });
  writeJson(join(teamDirectory, "team.json"), {
    team: "customer-success",
    members,
  });
  const orgChartPath = join(root, "org.json");
  writeJson(orgChartPath, { overlays });
  return { customerAgentsRepo, orgChartPath, teamDirectory };
}

test("creates a Watchdog hierarchy and is byte-stable on the second run", () => {
  const willOverlay = {
    principal: { name: "Will" },
    agents: [{ name: "chief", reportsTo: "Will", custom: "untouched" }],
  };
  const khaliqOverlay = {
    principal: { name: "Khaliq" },
    agents: [{ name: "chief-khaliq", reportsTo: "Khaliq" }],
  };
  const { customerAgentsRepo, orgChartPath } = fixture({
    members: ["intake-triage", "churn-digest"],
    overlays: [willOverlay, khaliqOverlay],
  });
  const originalWillBytes = JSON.stringify(willOverlay);

  const first = syncCustomerOrg({ customerAgentsRepo, orgChartPath });
  const firstBytes = readFileSync(orgChartPath, "utf8");
  const firstOrg = JSON.parse(firstBytes);
  assert.equal(first.changed, true);
  assert.equal(JSON.stringify(firstOrg.overlays[0]), originalWillBytes);
  assert.deepEqual(firstOrg.overlays[1], khaliqOverlay);
  assert.deepEqual(firstOrg.overlays[2], {
    principal: { name: "Watchdog" },
    agents: [
      {
        name: "chief-watchdog",
        title: "Watchdog Chief",
        reportsTo: "Watchdog",
        repo: resolve(customerAgentsRepo),
        status: "unseated",
      },
      {
        name: "intake-triage",
        title: "Intake Triage",
        reportsTo: "chief-watchdog",
        repo: resolve(customerAgentsRepo),
        status: "unverified",
      },
      {
        name: "churn-digest",
        title: "Churn Digest",
        reportsTo: "chief-watchdog",
        repo: resolve(customerAgentsRepo),
        status: "unverified",
      },
    ],
  });

  const second = syncCustomerOrg({ customerAgentsRepo, orgChartPath });
  assert.equal(second.changed, false);
  assert.equal(readFileSync(orgChartPath, "utf8"), firstBytes);
});

test("preserves verified statuses and adds new members as unverified", () => {
  const unrelatedOverlay = {
    principal: { name: "Will", note: "preserve me" },
    agents: [{ name: "voice", reportsTo: "chief" }],
  };
  const watchdogOverlay = {
    principal: { name: "Watchdog", account: "watchdog.no" },
    display: { color: "orange" },
    agents: [
      {
        name: "chief-watchdog",
        title: "Old title",
        reportsTo: "Someone else",
        repo: "/old/repo",
        status: "unseated",
        note: "keep chief note",
      },
      {
        name: "intake-triage",
        title: "Old member title",
        reportsTo: "Someone else",
        repo: "/old/repo",
        status: "resident",
        note: "keep member note",
      },
      {
        name: "churn-digest",
        title: "Old churn title",
        reportsTo: "Someone else",
        repo: "/old/repo",
        note: "keep statusless member note",
      },
      {
        name: "historical-agent",
        reportsTo: "chief-watchdog",
        status: "parked",
        note: "not team-managed",
      },
    ],
  };
  const { customerAgentsRepo, orgChartPath, teamDirectory } = fixture({
    members: ["intake-triage", "churn-digest"],
    overlays: [unrelatedOverlay, watchdogOverlay],
  });

  syncCustomerOrg({ customerAgentsRepo, orgChartPath });
  writeJson(join(teamDirectory, "team.json"), {
    team: "customer-success",
    members: ["intake-triage", "churn-digest", "deadline-watcher"],
  });
  const result = syncCustomerOrg({ customerAgentsRepo, orgChartPath });
  const org = JSON.parse(readFileSync(orgChartPath, "utf8"));
  const watchdog = org.overlays[1];
  assert.equal(result.changed, true);
  assert.deepEqual(org.overlays[0], unrelatedOverlay);
  assert.equal(watchdog.principal.account, "watchdog.no");
  assert.deepEqual(watchdog.display, { color: "orange" });
  assert.equal(watchdog.agents[0].title, "Watchdog Chief");
  assert.equal(watchdog.agents[0].note, "keep chief note");
  assert.equal(watchdog.agents[1].title, "Intake Triage");
  assert.equal(watchdog.agents[1].note, "keep member note");
  assert.equal(watchdog.agents[1].status, "resident");
  assert.equal(watchdog.agents[2].title, "Churn Digest");
  assert.equal(watchdog.agents[2].note, "keep statusless member note");
  assert.equal(watchdog.agents[2].status, "unverified");
  assert.deepEqual(watchdog.agents[3], watchdogOverlay.agents[3]);
  assert.deepEqual(watchdog.agents[4], {
    name: "deadline-watcher",
    title: "Deadline Watcher",
    reportsTo: "chief-watchdog",
    repo: resolve(customerAgentsRepo),
    status: "unverified",
  });

  const progressiveBytes = readFileSync(orgChartPath, "utf8");
  const stable = syncCustomerOrg({ customerAgentsRepo, orgChartPath });
  assert.equal(stable.changed, false);
  assert.equal(readFileSync(orgChartPath, "utf8"), progressiveBytes);
});

test("rejects duplicate members instead of creating an ambiguous hierarchy", () => {
  const { customerAgentsRepo, orgChartPath } = fixture({
    members: ["churn-digest", "churn-digest"],
    overlays: [],
  });

  assert.throws(
    () => syncCustomerOrg({ customerAgentsRepo, orgChartPath }),
    /duplicate member churn-digest/u,
  );
});
