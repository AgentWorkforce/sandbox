import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "src");
const providerEntrypoints = [
  "agent37",
  "agentcore",
  "daytona",
  "depot",
  "e2b",
  "freestyle",
  "local",
  "microsandbox",
  "modal",
  "runloop",
  "vercel",
] as const;

type PackageManifest = {
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(absolute);
    }
  }
  return files;
}

test("package keeps the root barrel and exposes extensible isolated subpaths", async () => {
  const packageJson = await manifest();
  assert.deepEqual(packageJson.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.deepEqual(packageJson.exports["./*"], {
    types: "./dist/*/index.d.ts",
    import: "./dist/*/index.js",
  });

  for (const provider of providerEntrypoints) {
    const barrel = await readFile(path.join(sourceRoot, provider, "index.ts"), "utf8");
    assert.doesNotMatch(
      barrel,
      /\.\.\/index\.js/u,
      `${provider} must not route back through the root provider barrel`,
    );
  }
});

test("every optional peer is owned by an isolated provider entrypoint", async () => {
  const packageJson = await manifest();
  const directories = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const [peer, metadata] of Object.entries(packageJson.peerDependenciesMeta)) {
    assert.equal(metadata.optional, true, `${peer} must remain an optional peer`);
    assert.ok(packageJson.peerDependencies[peer], `${peer} has peer metadata but no range`);

    const owners: string[] = [];
    for (const directory of directories) {
      const files = await sourceFiles(path.join(sourceRoot, directory));
      const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
      if (contents.some((content) => content.includes(peer))) {
        owners.push(directory);
      }
    }

    assert.ok(owners.length > 0, `${peer} is not referenced by any provider`);
    for (const owner of owners) {
      await assert.doesNotReject(
        readFile(path.join(sourceRoot, owner, "index.ts"), "utf8"),
        `${peer}'s provider ${owner} needs src/${owner}/index.ts so the wildcard export isolates it`,
      );
    }
  }
});

test("every provider runtime directory has an isolated entrypoint", async () => {
  const directories = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const directory of directories) {
    const files = await readdir(path.join(sourceRoot, directory));
    if (!files.includes("runtime.ts")) {
      continue;
    }
    assert.ok(
      files.includes("index.ts"),
      `src/${directory}/runtime.ts needs src/${directory}/index.ts for the wildcard package export`,
    );
  }
});
