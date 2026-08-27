import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const entrypoints = [
  "core",
  "agent37",
  "agentcore",
  "blaxel",
  "daytona",
  "depot",
  "e2b",
  "freestyle",
  "local",
  "kernel",
  "microsandbox",
  "modal",
  "runloop",
  "vercel",
];
const optionalPeers = [
  "@aws-sdk/client-bedrock-agentcore",
  "@aws-sdk/client-bedrock-agentcore-control",
  "@daytonaio/sdk",
  "@blaxel/core",
  "@depot/sandbox",
  "@onkernel/sdk",
  "@runloop/api-client",
  "@vercel/sandbox",
  "e2b",
  "freestyle",
  "microsandbox",
  "modal",
];

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sandbox-package-smoke-"));
try {
  const packedDirectory = path.join(temporaryRoot, "packed");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  await mkdir(packedDirectory);
  await mkdir(consumerDirectory);

  const packedJson = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packedDirectory],
    { cwd: repositoryRoot, encoding: "utf8" },
  ));
  // npm 11 returns an array; npm 12 keys the same record by package name.
  const packResult = Array.isArray(packedJson)
    ? packedJson[0]
    : Object.values(packedJson)[0];
  assert.ok(packResult, "npm pack did not return package metadata");
  const packedFiles = new Set(packResult.files.map(({ path: file }) => file));
  for (const entrypoint of entrypoints) {
    assert.ok(packedFiles.has(`dist/${entrypoint}/index.js`));
    assert.ok(packedFiles.has(`dist/${entrypoint}/index.d.ts`));
  }

  const tarball = path.join(packedDirectory, packResult.filename);
  await writeFile(path.join(consumerDirectory, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@agent-relay/sandbox": `file:${tarball}` },
  }));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund", "--no-package-lock"],
    { cwd: consumerDirectory, stdio: "inherit" },
  );

  for (const peer of optionalPeers) {
    await assert.rejects(access(path.join(consumerDirectory, "node_modules", peer)));
  }

  const importScript = [
    'await import("@agent-relay/sandbox");',
    ...entrypoints.map((entrypoint) =>
      `await import("@agent-relay/sandbox/${entrypoint}");`
    ),
  ].join("\n");
  execFileSync("node", ["--input-type=module", "--eval", importScript], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });

  const installedManifest = JSON.parse(await readFile(
    path.join(consumerDirectory, "node_modules", "@agent-relay", "sandbox", "package.json"),
    "utf8",
  ));
  assert.deepEqual(installedManifest.exports["./*"], {
    types: "./dist/*/index.d.ts",
    import: "./dist/*/index.js",
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
