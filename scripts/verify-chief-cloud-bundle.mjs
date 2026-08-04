#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const personaPath = path.join(repoRoot, "personas/chief-khaliq/persona.json");
const artifactNames = ["agent.bundle.mjs", "runner.mjs", "persona.json", "package.json"];
const forbidden = [
  "principals/will",
  "marketing-lead",
  "Watchdog",
  "factory.khaliq.config.json",
  "sage-nightcto-factory-program",
  "open-threads.md",
  "journal/daily",
];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function stage(outDir) {
  const { stdout, stderr } = await execFileAsync(
    "agentworkforce",
    ["deploy", personaPath, "--mode", "cloud", "--bundle-out", outDir, "--no-prompt"],
    { cwd: repoRoot, env: process.env, maxBuffer: 8 * 1024 * 1024 },
  );
  return { stdout, stderr };
}

async function readArtifacts(outDir) {
  return Object.fromEntries(
    await Promise.all(
      artifactNames.map(async (name) => [name, await readFile(path.join(outDir, name), "utf8")]),
    ),
  );
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chief-cloud-bundle-"));
const first = path.join(tempRoot, "first");
const second = path.join(tempRoot, "second");
try {
  await stage(first);
  await stage(second);
  const firstArtifacts = await readArtifacts(first);
  const secondArtifacts = await readArtifacts(second);
  for (const name of artifactNames) {
    const firstDigest = digest(firstArtifacts[name]);
    const secondDigest = digest(secondArtifacts[name]);
    if (firstDigest !== secondDigest) {
      throw new Error(`bundle is not deterministic for ${name}: ${firstDigest} != ${secondDigest}`);
    }
  }
  const joined = Object.values(firstArtifacts).join("\n");
  for (const marker of forbidden) {
    if (joined.includes(marker)) throw new Error(`bundle contains excluded context marker: ${marker}`);
  }
  if (!joined.includes("004472f27f65940313ce9348a503124baa2184b7")) {
    throw new Error("bundle is missing pinned Chief context provenance");
  }
  process.stdout.write("chief cloud bundle: deterministic, pinned, and boundary-clean\n");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
