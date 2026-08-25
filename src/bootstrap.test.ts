import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  GH_RELEASE_BASE_URL,
  buildClaudeConfigSeedShell,
  buildGhInstallShell,
  buildRelayfileMountLinkShell,
} from "./index.js";

const run = promisify(execFile);

/**
 * These snippets are shipped to run inside a sandbox, so most of them are
 * *executed* here rather than string-matched. A builder whose output only ever
 * gets compared to an expected string will keep passing after it stops working
 * — which is the failure mode this package has already paid for once, when a
 * bad `cd` looked exactly like a bad command.
 *
 * Everything runs under `sh` (not bash) for the same reason the builders target
 * POSIX: Agent37's exec plane is dash.
 */
async function sh(
  script: string,
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run("/bin/sh", ["-c", script], {
      env: { PATH: process.env.PATH ?? "", ...options.env },
      ...(options.cwd ? { cwd: options.cwd } : {}),
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sandbox-bootstrap-"));
}

const PLATFORM_PACKAGE = `@relayfile/mount-${process.platform}-${process.arch}`;

/** Lay down a fake global npm root containing an `agent-relay` install. */
async function fakeGlobalRoot(
  root: string,
  options: { hoisted?: boolean } = {},
): Promise<string> {
  const globalRoot = join(root, "lib", "node_modules");
  // Hoisted: npm lifted the platform package to the top level, beside
  // `agent-relay`, instead of nesting it. Both layouts happen in the wild.
  const packageHost = options.hoisted
    ? globalRoot
    : join(globalRoot, "agent-relay");
  const binDir = join(packageHost, "node_modules", PLATFORM_PACKAGE, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(globalRoot, "agent-relay"), { recursive: true });
  const binary = join(binDir, "relayfile-mount");
  await writeFile(binary, "#!/bin/sh\nprintf 'fake-relayfile-mount\\n'\n");
  await chmod(binary, 0o755);
  return globalRoot;
}

describe("buildRelayfileMountLinkShell", () => {
  it("links the vendored binary onto PATH without downloading anything", async () => {
    const root = await scratch();
    try {
      const globalRoot = await fakeGlobalRoot(root);
      const binDir = join(root, "bin");
      const script = buildRelayfileMountLinkShell({ binDir, searchRoots: [globalRoot] });

      assert.ok(
        !/curl|wget|npm install/.test(script),
        "the whole point is that the binary is already on the box",
      );

      const result = await sh(script, { env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout.trim(), new RegExp(`${PLATFORM_PACKAGE}/bin/relayfile-mount$`));

      // The link is only useful if invoking the bare name works.
      const invoked = await sh("relayfile-mount", {
        env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      assert.equal(invoked.stdout.trim(), "fake-relayfile-mount");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds the binary when npm hoisted it above the agent-relay package", async () => {
    const root = await scratch();
    try {
      const globalRoot = await fakeGlobalRoot(root, { hoisted: true });
      const binDir = join(root, "bin");
      const result = await sh(
        buildRelayfileMountLinkShell({ binDir, searchRoots: [globalRoot] }),
        { env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout.trim(), /bin\/relayfile-mount$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when no vendored binary exists, rather than leaving a broken box", async () => {
    const root = await scratch();
    try {
      const empty = join(root, "empty");
      await mkdir(empty, { recursive: true });
      const binDir = join(root, "bin");
      const result = await sh(
        buildRelayfileMountLinkShell({ binDir, searchRoots: [empty] }),
        { env: { PATH: `${binDir}:/usr/bin:/bin` } },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /relayfile-mount not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a relative bin directory and a link name with a path separator", () => {
    assert.throws(() => buildRelayfileMountLinkShell({ binDir: "bin" }), /absolute path/);
    assert.throws(
      () => buildRelayfileMountLinkShell({ binDir: "/tmp/bin", linkName: "a/b" }),
      /bare filename/,
    );
  });
});

describe("buildGhInstallShell", () => {
  /** A stand-in for a GitHub release tarball, served over `file://`. */
  async function fakeRelease(
    root: string,
    version: string,
  ): Promise<{ baseUrl: string; sha256: string }> {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const name = `gh_${version}_linux_${arch}`;
    const stage = join(root, "stage", name, "bin");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "gh"), `#!/bin/sh\nprintf 'gh version ${version}\\n'\n`);
    await chmod(join(stage, "gh"), 0o755);
    const releases = join(root, "releases", `v${version}`);
    await mkdir(releases, { recursive: true });
    const tarball = join(releases, `${name}.tar.gz`);
    await run("tar", ["-czf", tarball, "-C", join(root, "stage"), name]);
    const { stdout } = await run("/bin/sh", [
      "-c",
      `if command -v sha256sum >/dev/null 2>&1; then sha256sum '${tarball}'; else shasum -a 256 '${tarball}'; fi`,
    ]);
    return { baseUrl: `file://${join(root, "releases")}`, sha256: stdout.trim().split(/\s+/)[0]! };
  }

  it("installs gh into a user directory and leaves it on PATH", async () => {
    const root = await scratch();
    try {
      const { baseUrl } = await fakeRelease(root, "9.9.9");
      const binDir = join(root, "bin");
      const workDir = join(root, "work");
      const result = await sh(
        buildGhInstallShell({ version: "9.9.9", binDir, workDir, releaseBaseUrl: baseUrl }),
        { env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /gh version 9\.9\.9/);
      // No root anywhere in the generated shell: that is the whole constraint.
      assert.ok(!/\bsudo\b/.test(result.stdout));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts before extracting when the checksum does not match", async () => {
    const root = await scratch();
    try {
      const { baseUrl } = await fakeRelease(root, "9.9.9");
      const binDir = join(root, "bin");
      const result = await sh(
        buildGhInstallShell({
          version: "9.9.9",
          binDir,
          workDir: join(root, "work"),
          releaseBaseUrl: baseUrl,
          sha256: "0".repeat(64),
        }),
        { env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /failed SHA-256 verification/);
      const listed = await sh(`ls ${binDir} 2>/dev/null || true`);
      assert.equal(listed.stdout.trim(), "", "nothing may be installed from an unverified tarball");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the matching checksum", async () => {
    const root = await scratch();
    try {
      const { baseUrl, sha256 } = await fakeRelease(root, "9.9.9");
      const binDir = join(root, "bin");
      const result = await sh(
        buildGhInstallShell({
          version: "9.9.9",
          binDir,
          workDir: join(root, "work"),
          releaseBaseUrl: baseUrl,
          sha256,
        }),
        { env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /gh version 9\.9\.9/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults to the vendor's own release host and pins no version", () => {
    assert.equal(GH_RELEASE_BASE_URL, "https://github.com/cli/cli/releases/download");
    assert.match(
      buildGhInstallShell({ version: "2.82.1", binDir: "/home/node/.local/bin" }),
      /https:\/\/github\.com\/cli\/cli\/releases\/download/,
    );
    assert.throws(() => buildGhInstallShell({ version: "", binDir: "/x" }), /required/);
    assert.throws(() => buildGhInstallShell({ version: "v2.82.1", binDir: "/x" }), /leading "v"/);
    assert.throws(
      () => buildGhInstallShell({ version: "2.82.1", binDir: "/x", sha256: "nope" }),
      /64 lowercase hex/,
    );
  });
});

describe("buildClaudeConfigSeedShell", () => {
  async function seed(
    configPath: string,
    env: Record<string, string>,
    options: Parameters<typeof buildClaudeConfigSeedShell>[0] = { configPath },
  ) {
    return sh(buildClaudeConfigSeedShell({ ...options, configPath }), { env });
  }

  it("creates a config that completes onboarding and approves the live key", async () => {
    const root = await scratch();
    try {
      const configPath = join(root, "home", ".claude.json");
      const result = await seed(configPath, { ANTHROPIC_API_KEY: `sk-ant-${"k".repeat(40)}` });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /apiKeyApproved=1/);

      const cfg = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      assert.equal(cfg.hasCompletedOnboarding, true);
      const responses = cfg.customApiKeyResponses as { approved: string[]; rejected: string[] };
      assert.deepEqual(responses.approved, ["k".repeat(20)]);
      assert.deepEqual(responses.rejected, []);
      // The credential itself must never reach disk here.
      assert.ok(!JSON.stringify(cfg).includes("sk-ant-"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never renders the key into the built command", () => {
    const script = buildClaudeConfigSeedShell({ configPath: "/home/node/.claude.json" });
    assert.ok(!script.includes("sk-ant"));
    assert.match(script, /\$\{ANTHROPIC_API_KEY:-\}/);
  });

  it("repairs a box whose config already rejected the key", async () => {
    const root = await scratch();
    try {
      const configPath = join(root, ".claude.json");
      const tail = "z".repeat(20);
      await writeFile(
        configPath,
        JSON.stringify({
          machineID: "keep-me",
          customApiKeyResponses: { approved: [], rejected: [tail, "other-tail"] },
        }),
      );
      const result = await seed(configPath, { ANTHROPIC_API_KEY: `sk-ant-abc${tail}` });
      assert.equal(result.code, 0, result.stderr);

      const cfg = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      assert.equal(cfg.machineID, "keep-me", "existing state must survive the merge");
      const responses = cfg.customApiKeyResponses as { approved: string[]; rejected: string[] };
      assert.deepEqual(responses.approved, [tail]);
      assert.deepEqual(
        responses.rejected,
        ["other-tail"],
        "only this key moves; another key's rejection is not ours to undo",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still completes onboarding when no key is present, and says so", async () => {
    const root = await scratch();
    try {
      const configPath = join(root, ".claude.json");
      const result = await seed(configPath, {});
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /apiKeyApproved=0/);
      const cfg = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      assert.equal(cfg.hasCompletedOnboarding, true);
      assert.equal(cfg.customApiKeyResponses, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes the config 0600 and records the onboarding version when given one", async () => {
    const root = await scratch();
    try {
      const configPath = join(root, ".claude.json");
      const result = await sh(
        buildClaudeConfigSeedShell({ configPath, onboardingVersion: "2.1.245" }),
        { env: { ANTHROPIC_API_KEY: "sk-ant-" + "q".repeat(30) } },
      );
      assert.equal(result.code, 0, result.stderr);
      const cfg = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      assert.equal(cfg.lastOnboardingVersion, "2.1.245");
      const mode = await sh(`ls -l ${configPath} | cut -c1-10`);
      assert.equal(mode.stdout.trim(), "-rw-------");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to clobber a config file that is not a JSON object", async () => {
    const root = await scratch();
    try {
      const configPath = join(root, ".claude.json");
      await writeFile(configPath, "[1,2,3]");
      const result = await seed(configPath, {});
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /not a JSON object/);
      assert.equal(await readFile(configPath, "utf8"), "[1,2,3]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a relative path and an env var that is not an identifier", () => {
    assert.throws(() => buildClaudeConfigSeedShell({ configPath: ".claude.json" }), /absolute/);
    assert.throws(
      () => buildClaudeConfigSeedShell({ configPath: "/x/.claude.json", apiKeyEnvVar: "a-b" }),
      /shell identifier/,
    );
  });

  it("survives a home directory whose name contains shell metacharacters", async () => {
    const root = await scratch();
    try {
      const home = join(root, "it's $(rm -rf); weird");
      await mkdir(home, { recursive: true });
      const configPath = join(home, ".claude.json");
      const result = await seed(configPath, {});
      assert.equal(result.code, 0, result.stderr);
      const cfg = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      assert.equal(cfg.hasCompletedOnboarding, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bootstrap snippets are POSIX sh, not bash", () => {
  it("uses no bashism that dash would reject", () => {
    // Measured: Agent37's exec plane is dash, where `${PIPESTATUS[0]}` is a
    // "Bad substitution" — a step that looks fine and silently does nothing.
    const scripts = [
      buildRelayfileMountLinkShell({ binDir: "/home/node/.local/bin" }),
      buildGhInstallShell({ version: "2.82.1", binDir: "/home/node/.local/bin" }),
      buildClaudeConfigSeedShell({ configPath: "/home/node/.claude.json" }),
    ];
    for (const script of scripts) {
      assert.ok(!script.includes("PIPESTATUS"), script);
      assert.ok(!/\[\[/.test(script), script);
      assert.ok(!/\blocal\s/.test(script), script);
      assert.ok(!/\bfunction\s+\w+\s*\(/.test(script), script);
    }
  });

  it("parses under sh -n", async () => {
    const root = await scratch();
    try {
      const scripts: Record<string, string> = {
        link: buildRelayfileMountLinkShell({ binDir: "/home/node/.local/bin" }),
        gh: buildGhInstallShell({
          version: "2.82.1",
          binDir: "/home/node/.local/bin",
          sha256: "a".repeat(64),
        }),
        claude: buildClaudeConfigSeedShell({
          configPath: "/home/node/.claude.json",
          onboardingVersion: "2.1.245",
        }),
      };
      for (const [name, script] of Object.entries(scripts)) {
        const file = join(root, `${name}.sh`);
        await writeFile(file, script);
        const result = await sh(`sh -n ${file}`);
        assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the symlink target survives being a symlink itself", () => {
  it("re-links over an existing stale link", async () => {
    const root = await scratch();
    try {
      const globalRoot = await fakeGlobalRoot(root);
      const binDir = join(root, "bin");
      await mkdir(binDir, { recursive: true });
      await symlink("/nonexistent/relayfile-mount", join(binDir, "relayfile-mount"));
      const result = await sh(
        buildRelayfileMountLinkShell({ binDir, searchRoots: [globalRoot] }),
        { env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      );
      assert.equal(result.code, 0, result.stderr);
      const invoked = await sh("relayfile-mount", {
        env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      assert.equal(invoked.stdout.trim(), "fake-relayfile-mount");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
