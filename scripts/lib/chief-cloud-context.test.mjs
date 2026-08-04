import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildContextArtifact,
  DEFAULT_OUTPUT_PATH,
} from "../build-chief-cloud-context.mjs";
import { CHIEF_CONTEXT } from "../../personas/chief-khaliq/context.generated.mjs";

test("pinned Khaliq context generation is deterministic and committed", async () => {
  const first = await buildContextArtifact();
  const second = await buildContextArtifact();
  const committed = await readFile(DEFAULT_OUTPUT_PATH, "utf8");
  assert.equal(first, second);
  assert.equal(first, committed);
  assert.match(first, /004472f27f65940313ce9348a503124baa2184b7/);
});

test("context artifact enforces the tenant allowlist", async () => {
  const artifact = await buildContextArtifact();
  for (const expected of [
    "teams.khaliq.json",
    "principals/khaliq/memory/learnings.md",
    "principals/khaliq/memory/preferences.md",
    "principals/khaliq/workstreams/chief-onboarding.md",
    "principals/khaliq/workstreams/workspace-convergence.md",
  ]) {
    assert.match(artifact, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const forbidden of [
    "principals/will",
    "principals/khaliq/memory/people.md",
    "Will Washburn",
    "Will's brain",
    "marketing-lead",
    "Watchdog",
    "factory.khaliq.config.json",
    "sage-nightcto-factory-program",
    "open-threads.md",
    "journal/daily",
    "rk_live_",
    "at_live_",
    "cld_at_",
  ]) {
    assert.equal(artifact.includes(forbidden), false, forbidden);
  }
});

test("team metadata is reduced to the chief-khaliq seat", async () => {
  const teamSection = CHIEF_CONTEXT.sections.find(
    (section) => section.sourcePath === "teams.khaliq.json",
  );
  assert.ok(teamSection);
  const team = JSON.parse(teamSection.content);
  assert.equal(team.team, "chief-khaliq");
  assert.equal(team.agent.name, "chief-khaliq");
  assert.deepEqual(Object.keys(team).sort(), ["agent", "principal", "team"]);
  assert.deepEqual(Object.keys(team.agent).sort(), ["name", "role"]);
  assert.equal("autoSpawn" in team, false);
  assert.equal("senses" in team, false);
  assert.equal("recipes" in team, false);
});
