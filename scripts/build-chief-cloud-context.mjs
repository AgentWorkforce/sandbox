#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "personas/chief-khaliq/context.manifest.json",
);
export const DEFAULT_OUTPUT_PATH = path.join(
  REPO_ROOT,
  "personas/chief-khaliq/context.generated.mjs",
);

const EXPECTED_TENANT = "khaliq";
const EXPECTED_AGENT = "chief-khaliq";
const EXPECTED_REPOSITORY = "https://github.com/AgentWorkforce/chief.git";
const EXPECTED_COMMIT = "004472f27f65940313ce9348a503124baa2184b7";
const ALLOWED_SELECTIONS = new Map([
  ["teams.khaliq.json", "khaliq-team-metadata"],
  ["principals/khaliq/memory/learnings.md", "text"],
  ["principals/khaliq/memory/preferences.md", "text"],
  ["principals/khaliq/workstreams/chief-onboarding.md", "workstream-current"],
  ["principals/khaliq/workstreams/workspace-convergence.md", "workstream-current"],
]);
const SECRET_PATTERN = /(?:br_|rk_live_|at_live_|cld_at_)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRepositoryUrl(value) {
  if (value === "git@github.com:AgentWorkforce/chief.git") {
    return EXPECTED_REPOSITORY;
  }
  return value;
}

function assertManifest(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1) {
    throw new Error("context manifest must use schemaVersion 1");
  }
  if (manifest.tenant !== EXPECTED_TENANT || manifest.agent !== EXPECTED_AGENT) {
    throw new Error("context manifest must be scoped to khaliq/chief-khaliq");
  }
  if (!isRecord(manifest.source)) {
    throw new Error("context manifest source is required");
  }
  if (
    manifest.source.repository !== EXPECTED_REPOSITORY ||
    manifest.source.commit !== EXPECTED_COMMIT ||
    manifest.source.ref !== "refs/pull/13/head"
  ) {
    throw new Error("context provenance must remain pinned to reviewed Chief PR #13 head");
  }
  if (!Array.isArray(manifest.selections) || manifest.selections.length !== ALLOWED_SELECTIONS.size) {
    throw new Error("context manifest must contain the complete explicit allowlist");
  }
  const seen = new Set();
  for (const selection of manifest.selections) {
    if (!isRecord(selection)) throw new Error("context selection must be an object");
    const expectedMode = ALLOWED_SELECTIONS.get(selection.path);
    if (!expectedMode || selection.mode !== expectedMode) {
      throw new Error(`context path is not allowlisted: ${String(selection.path)}`);
    }
    if (seen.has(selection.path)) throw new Error(`duplicate context path: ${selection.path}`);
    seen.add(selection.path);
    if (!/^[a-f0-9]{64}$/.test(String(selection.sha256))) {
      throw new Error(`context selection has an invalid sha256: ${selection.path}`);
    }
  }
  for (const required of ALLOWED_SELECTIONS.keys()) {
    if (!seen.has(required)) throw new Error(`context allowlist is missing ${required}`);
  }
}

async function git(repoRoot, args, options = {}) {
  const result = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function readPinnedFile(repoRoot, commit, selection) {
  const raw = await git(repoRoot, ["show", `${commit}:${selection.path}`]);
  const actualHash = sha256(raw);
  if (actualHash !== selection.sha256) {
    throw new Error(
      `pinned content hash mismatch for ${selection.path}: expected ${selection.sha256}, got ${actualHash}`,
    );
  }
  if (SECRET_PATTERN.test(raw)) {
    throw new Error(`pinned context contains a secret-shaped value: ${selection.path}`);
  }
  return raw;
}

function selectKhaliqTeamMetadata(raw) {
  const source = JSON.parse(raw);
  if (!isRecord(source) || !isRecord(source.principal) || !Array.isArray(source.agents)) {
    throw new Error("teams.khaliq.json does not match the expected roster shape");
  }
  if (source.principal.slug !== EXPECTED_TENANT || source.team !== EXPECTED_AGENT) {
    throw new Error("teams.khaliq.json does not select the expected tenant/team");
  }
  const chief = source.agents.find((agent) => isRecord(agent) && agent.name === EXPECTED_AGENT);
  if (!isRecord(chief)) throw new Error("teams.khaliq.json is missing chief-khaliq");
  return JSON.stringify(
    {
      principal: {
        slug: source.principal.slug,
        name: source.principal.name,
        handle: source.principal.handle,
        timezone: source.principal.timezone,
      },
      team: source.team,
      agent: {
        name: chief.name,
        role: chief.role,
      },
    },
    null,
    2,
  );
}

function selectCurrentWorkstream(raw) {
  const historyIndex = raw.indexOf("\n## History");
  const selected = historyIndex >= 0 ? raw.slice(0, historyIndex) : raw;
  if (!selected.includes("**Goal:**") || !selected.includes("**Now:**") || !selected.includes("**Next:**")) {
    throw new Error("workstream-current selection requires Goal, Now, and Next sections");
  }
  return `${selected.trim()}\n`;
}

function renderContextText(bundle) {
  const header = [
    "# Allowlisted Chief context",
    "",
    `Tenant: ${bundle.tenant}`,
    `Agent: ${bundle.agent}`,
    `Repository: ${bundle.provenance.repository}`,
    `Reviewed ref: ${bundle.provenance.ref}`,
    `Pinned commit: ${bundle.provenance.commit}`,
    "",
    "This context is read-only. It excludes other principal profiles, journals, customer data, secrets, local dirt, and unrelated integration or factory wiring.",
  ];
  for (const section of bundle.sections) {
    header.push("", `## ${section.sourcePath}`, "", section.content.trim());
  }
  return `${header.join("\n")}\n`;
}

function renderModule(bundle) {
  const contextText = renderContextText(bundle);
  return [
    "// Generated by scripts/build-chief-cloud-context.mjs from a pinned reviewed commit.",
    "// Do not edit. Run `npm run cloud:context:build`.",
    `export const CHIEF_CONTEXT = Object.freeze(${JSON.stringify(bundle, null, 2)});`,
    `export const CHIEF_CONTEXT_TEXT = ${JSON.stringify(contextText)};`,
    "",
  ].join("\n");
}

export async function buildContextArtifact({
  repoRoot = REPO_ROOT,
  manifestPath = DEFAULT_MANIFEST_PATH,
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifest(manifest);

  const resolvedCommit = (await git(repoRoot, ["rev-parse", `${manifest.source.commit}^{commit}`])).trim();
  if (resolvedCommit !== manifest.source.commit) {
    throw new Error(`context commit did not resolve exactly: ${resolvedCommit}`);
  }
  const remote = normalizeRepositoryUrl((await git(repoRoot, ["remote", "get-url", "origin"])).trim());
  if (remote !== manifest.source.repository) {
    throw new Error(`context repository mismatch: expected ${manifest.source.repository}, got ${remote}`);
  }

  const sections = [];
  for (const selection of manifest.selections) {
    const raw = await readPinnedFile(repoRoot, manifest.source.commit, selection);
    const content = selection.mode === "khaliq-team-metadata"
      ? selectKhaliqTeamMetadata(raw)
      : selection.mode === "workstream-current"
        ? selectCurrentWorkstream(raw)
        : raw;
    sections.push({
      sourcePath: selection.path,
      sha256: selection.sha256,
      content,
    });
  }

  const bundle = {
    schemaVersion: 1,
    tenant: manifest.tenant,
    agent: manifest.agent,
    provenance: { ...manifest.source },
    sections,
  };
  const artifact = renderModule(bundle);
  if (SECRET_PATTERN.test(artifact)) {
    throw new Error("generated context contains a secret-shaped value");
  }
  return artifact;
}

async function writeAtomic(outputPath, contents) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, outputPath);
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const outputIndex = args.indexOf("--output");
  const outputPath = outputIndex >= 0 ? path.resolve(args[outputIndex + 1]) : DEFAULT_OUTPUT_PATH;
  if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error("--output requires a path");
  const artifact = await buildContextArtifact();
  if (check) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== artifact) {
      throw new Error("generated Chief context is missing or stale; run npm run cloud:context:build");
    }
    process.stdout.write("chief cloud context: deterministic and current\n");
    return;
  }
  await writeAtomic(outputPath, artifact);
  process.stdout.write(`chief cloud context: wrote ${path.relative(REPO_ROOT, outputPath)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`chief cloud context failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
