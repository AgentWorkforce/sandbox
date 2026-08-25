/**
 * Shell snippets that close the gaps between a bare sandbox image and a box an
 * agent can actually work on.
 *
 * These exist because a measured Agent37 run found three things missing that
 * every provider is otherwise expected to have supplied: `relayfile-mount` was
 * not on PATH, `gh` was not installed at all (`exit 127`), and a clean
 * `~/.claude.json` auto-*rejected* a perfectly valid API key so the agent came
 * up on a login screen. None of the three needs root, and none of the three is
 * a provider fault — the same `gh` gap is `exit 127` on Daytona too, and the
 * Claude config trap is image-independent.
 *
 * Two constraints shape every snippet here, and both are measured rather than
 * assumed:
 *
 *  - **POSIX `sh`, not bash.** Agent37's exec plane runs `dash`. A bashism such
 *    as `${PIPESTATUS[0]}` fails there with `Bad substitution`, silently
 *    turning a working step into a broken one. Nothing below uses arrays,
 *    `[[`, or `local`.
 *  - **No root.** The Agent37 template user is `node` (uid 1000), `sudo` is
 *    inert (`effective uid is not 0 … nosuid`), and `mkdir /opt` is denied —
 *    as it is on Daytona, so that is not an Agent37 property. Everything
 *    installs under `$HOME`, where npm's global prefix already points.
 *
 * The contract matches `mount-script.ts`: helpers take primitives, do their own
 * shell quoting, and return ready-to-run shell. Callers must not re-quote.
 */

/** Single-quote a value so no byte in it is parsed as shell syntax. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Reject a value that would be interpreted rather than used.
 *
 * Quoting already stops shell injection; this stops a subtler class of bug
 * where a newline or a `..` segment produces a snippet that runs cleanly and
 * does the wrong thing — the same reasoning `mount-script.ts` applies to
 * remote paths.
 */
function requireAbsolutePath(value: string | undefined, field: string): string {
  const path = requireNonEmpty(value, field);
  if (!path.startsWith("/")) {
    throw new Error(`${field} must be an absolute path; got ${JSON.stringify(path)}`);
  }
  if (path.includes("\n") || path.includes("\0")) {
    throw new Error(`${field} must not contain a newline or NUL`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`${field} must not contain a ".." segment; got ${JSON.stringify(path)}`);
  }
  return path;
}

// ---------------------------------------------------------------------------
// relayfile-mount
// ---------------------------------------------------------------------------

export type RelayfileMountLinkShellOptions = {
  /**
   * Directory the symlink is created in — for example `/home/node/.local/bin`.
   * It is created if absent. It must already be on PATH; this builder does not
   * edit a profile, because which profile a sandbox's exec plane reads is
   * image-specific.
   */
  binDir: string;
  /**
   * Name to link as. Defaults to `relayfile-mount`, which is the name every
   * caller in this package invokes (see `mount-script.ts`).
   */
  linkName?: string;
  /**
   * Roots to search for the vendored binary, in order. Omitted, the snippet
   * asks npm for its global root, which is where a `npm install -g agent-relay`
   * puts the package.
   */
  searchRoots?: readonly string[];
};

/**
 * Shell that puts `relayfile-mount` on PATH from the copy already vendored
 * inside the installed `agent-relay` package, and verifies the result.
 *
 * **No download and no root.** `agent-relay` ships the daemon as an optional
 * per-platform dependency (`@relayfile/mount-<platform>-<arch>`), so a box that
 * has the CLI already has the binary — it just is not on PATH, which is why
 * `command -v relayfile-mount` comes back empty on an Agent37 box while
 * Daytona's image has it at `/usr/local/bin/relayfile-mount`.
 *
 * Resolution walks up from the `agent-relay` package directory looking for
 * `node_modules/@relayfile/mount-<platform>-<arch>/bin/relayfile-mount`, rather
 * than joining a fixed path, because npm is free to hoist that dependency to a
 * higher `node_modules`. The walk is the same shape the sandbox image's own
 * entrypoint uses to find the broker binary.
 *
 * The snippet exits non-zero with a specific message when the binary cannot be
 * found, so a bootstrap fails loudly instead of leaving a box whose mount will
 * fail later for a reason nobody will connect to this step.
 */
export function buildRelayfileMountLinkShell(opts: RelayfileMountLinkShellOptions): string {
  const binDir = requireAbsolutePath(opts.binDir, "binDir");
  const linkName = requireNonEmpty(opts.linkName ?? "relayfile-mount", "linkName");
  // `.` and `..` slip past the `/` check but `ln -sf src ..` follows the
  // directory and creates the link one level up. Reject them explicitly.
  if (linkName.includes("/") || linkName === "." || linkName === "..") {
    throw new Error(
      `linkName must be a bare filename other than "." or ".."; got ${JSON.stringify(linkName)}`,
    );
  }
  for (const root of opts.searchRoots ?? []) {
    requireAbsolutePath(root, "searchRoots entry");
  }

  // `process.argv[1]` carries the roots so no path is interpolated into the JS
  // source itself, and the resolver stays one readable expression.
  const resolver =
    "const fs=require('fs'),path=require('path');" +
    "const pkg='@relayfile/mount-'+process.platform+'-'+process.arch;" +
    "const roots=process.argv.slice(1).filter(Boolean);" +
    "let found='';" +
    "for(const root of roots){" +
    "let dir=path.join(root,'agent-relay');" +
    "if(!fs.existsSync(dir))continue;" +
    "for(let i=0;i<10&&!found;i++){" +
    "const cand=path.join(dir,'node_modules',pkg,'bin','relayfile-mount');" +
    "if(fs.existsSync(cand))found=cand;" +
    "const up=path.dirname(dir);" +
    "if(up===dir)break;" +
    "dir=up;}" +
    "if(found)break;}" +
    "if(!found)process.exit(1);" +
    "process.stdout.write(found);";

  const rootsExpr = (opts.searchRoots ?? []).map((root) => shellQuote(root)).join(" ");
  // Only fall back to npm's global root when the caller did not name their own
  // — otherwise a stale global `agent-relay` wins the search over the roots
  // that were explicitly requested, contradicting the option's documented
  // ordering.
  const useNpmFallback = !opts.searchRoots || opts.searchRoots.length === 0;
  const argsExpr = useNpmFallback
    ? `"$(npm root -g 2>/dev/null)"${rootsExpr ? ` ${rootsExpr}` : ""}`
    : rootsExpr;
  // Strip a trailing slash before joining: `command -v` normalizes the PATH
  // entry that resolves the lookup, so a `binDir` of `/foo/` would otherwise
  // build an expected `linkPath` of `/foo//name` that never matches the
  // normalized `/foo/name` and the post-link verification would fail a
  // perfectly good install.
  const linkPath = `${binDir.replace(/\/+$/, "")}/${linkName}`;

  return [
    `set -e`,
    `mkdir -p ${shellQuote(binDir)}`,
    `__rf_src=$(node -e ${shellQuote(resolver)} -- ${argsExpr}) || {`,
    `  printf '%s\\n' 'relayfile-mount not found: no @relayfile/mount-<platform>-<arch> beside the installed agent-relay package. Install agent-relay first.' >&2`,
    `  exit 1`,
    `}`,
    `ln -sf "$__rf_src" ${shellQuote(linkPath)}`,
    // `command -v` alone is not enough: another `${linkName}` earlier on PATH
    // wins the lookup and the bare invocation silently runs the wrong binary.
    // Verify the resolved path is the one this snippet just created; if PATH
    // is misordered we fail loud rather than leaving a box that looks fine.
    `__rf_which=$(command -v ${shellQuote(linkName)} 2>/dev/null || true)`,
    `if [ -z "$__rf_which" ]; then`,
    `  printf '%s\\n' ${shellQuote(`${linkName} linked into ${binDir} but not on PATH; add ${binDir} to PATH`)} >&2`,
    `  exit 1`,
    `fi`,
    `if [ "$__rf_which" != ${shellQuote(linkPath)} ]; then`,
    `  printf '%s\\n' ${shellQuote(`${linkName} on PATH resolves to a different binary than ${linkPath}; prepend ${binDir} to PATH`)} >&2`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' "$__rf_src"`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

/**
 * The GitHub CLI's own published release host.
 *
 * This package ships no *Agent Relay* endpoint defaults — a base URL for our
 * own control plane is always a required argument, because no default is
 * correct for every consumer. This is a different thing: it is the upstream
 * vendor's canonical download host, the one their install instructions name.
 * It stays overridable for callers behind a mirror.
 */
export const GH_RELEASE_BASE_URL = "https://github.com/cli/cli/releases/download";

export type GhInstallShellOptions = {
  /**
   * Release to install, without a leading `v` — for example `2.82.1`.
   * Required: a pinned default here would rot silently, and a bootstrap that
   * quietly changes which `gh` an agent gets is worse than one that asks.
   */
  version: string;
  /**
   * Directory the `gh` binary is placed in — for example
   * `/home/node/.local/bin`. Created if absent, and must be on PATH.
   */
  binDir: string;
  /** Override the download host. Defaults to {@link GH_RELEASE_BASE_URL}. */
  releaseBaseUrl?: string;
  /**
   * Expected SHA-256 of the downloaded tarball, lowercase hex.
   *
   * Optional but recommended: without it the snippet installs an unverified
   * binary onto an agent's PATH. It is optional rather than required only
   * because the digest is per-version-per-arch, so a caller that pins one arch
   * can supply it and a caller that does not cannot. When supplied, a mismatch
   * aborts before anything is extracted.
   */
  sha256?: string;
  /**
   * Scratch directory for the download. Defaults to `/tmp`, which is writable
   * on both providers measured.
   */
  workDir?: string;
};

/**
 * Shell that installs `gh` into a user-writable directory, no root required.
 *
 * On a measured Agent37 box this took about three seconds and moved
 * `gh --version` from `exit 127` (`gh: not found`) to `exit 0`. Note what it
 * does *not* fix: `gh auth status` then returns `exit 1`
 * ("not logged into any GitHub hosts"). A present binary with no credential is
 * a different failure from a missing binary, and only the first is this
 * snippet's job.
 *
 * The architecture is resolved at run time from `uname -m` rather than baked
 * in, so one built command serves amd64 and arm64 images.
 */
export function buildGhInstallShell(opts: GhInstallShellOptions): string {
  const version = requireNonEmpty(opts.version, "version");
  if (version.startsWith("v")) {
    throw new Error(
      `version must not carry a leading "v"; got ${JSON.stringify(version)} — pass "${version.slice(1)}"`,
    );
  }
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`version is not a plausible release string: ${JSON.stringify(version)}`);
  }
  const binDir = requireAbsolutePath(opts.binDir, "binDir");
  const workDir = requireAbsolutePath(opts.workDir ?? "/tmp", "workDir");
  const baseUrl = requireNonEmpty(
    opts.releaseBaseUrl ?? GH_RELEASE_BASE_URL,
    "releaseBaseUrl",
  ).replace(/\/+$/, "");
  const sha256 = opts.sha256?.trim().toLowerCase();
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("sha256 must be 64 lowercase hex characters");
  }

  const lines = [
    `set -e`,
    `mkdir -p ${shellQuote(binDir)} ${shellQuote(workDir)}`,
    `__gh_ver=${shellQuote(version)}`,
    `case "$(uname -m)" in`,
    `  x86_64|amd64) __gh_arch=amd64 ;;`,
    `  aarch64|arm64) __gh_arch=arm64 ;;`,
    `  *) printf '%s\\n' "unsupported architecture for gh: $(uname -m)" >&2; exit 1 ;;`,
    `esac`,
    `__gh_name="gh_\${__gh_ver}_linux_\${__gh_arch}"`,
    `__gh_tgz=${shellQuote(workDir)}/"\${__gh_name}.tar.gz"`,
    `curl -fsSL -o "$__gh_tgz" ${shellQuote(baseUrl)}/"v\${__gh_ver}"/"\${__gh_name}.tar.gz"`,
  ];

  if (sha256) {
    // `-c` reads "<digest>  <path>" — the two spaces are the format, not a
    // typo. `sha256sum` is coreutils and `shasum` is the perl tool; a minimal
    // image may ship either, so try both rather than assuming. Verified before
    // extraction, so a bad payload is never unpacked.
    lines.push(
      `if command -v sha256sum >/dev/null 2>&1; then __gh_sum="sha256sum"`,
      `elif command -v shasum >/dev/null 2>&1; then __gh_sum="shasum -a 256"`,
      `else printf '%s\\n' 'no sha256sum or shasum available to verify the gh tarball' >&2; rm -f "$__gh_tgz"; exit 1`,
      `fi`,
      `printf '%s  %s\\n' ${shellQuote(sha256)} "$__gh_tgz" | $__gh_sum -c - >/dev/null 2>&1 || {`,
      `  printf '%s\\n' 'gh tarball failed SHA-256 verification; refusing to install' >&2`,
      `  rm -f "$__gh_tgz"`,
      `  exit 1`,
      `}`,
    );
  }

  // Strip a trailing slash before joining: `command -v` normalizes the PATH
  // entry that resolves the lookup, so a `binDir` of `/foo/` would otherwise
  // build an expected `ghPath` of `/foo//gh` that never matches the
  // normalized `/foo/gh` and the post-install verification would fail a
  // perfectly good install.
  const ghPath = `${binDir.replace(/\/+$/, "")}/gh`;
  lines.push(
    `tar -xzf "$__gh_tgz" -C ${shellQuote(workDir)}`,
    `cp ${shellQuote(workDir)}/"\${__gh_name}"/bin/gh ${shellQuote(ghPath)}`,
    `chmod 0755 ${shellQuote(ghPath)}`,
    `rm -rf "$__gh_tgz" ${shellQuote(workDir)}/"\${__gh_name}"`,
    // Presence + resolved-path check: an older `gh` earlier on PATH would
    // otherwise win the lookup and the caller would keep the pre-existing
    // version despite this snippet returning success.
    `__gh_which=$(command -v gh 2>/dev/null || true)`,
    `if [ -z "$__gh_which" ]; then`,
    `  printf '%s\\n' ${shellQuote(`gh installed into ${binDir} but not on PATH; add ${binDir} to PATH`)} >&2`,
    `  exit 1`,
    `fi`,
    `if [ "$__gh_which" != ${shellQuote(ghPath)} ]; then`,
    `  printf '%s\\n' ${shellQuote(`gh on PATH resolves to a different binary than ${ghPath}; prepend ${binDir} to PATH`)} >&2`,
    `  exit 1`,
    `fi`,
    // Capture before piping: `gh --version | head -1` masks a nonzero `gh`
    // exit because dash has no pipefail and `head` still returns 0. Verify
    // status directly, then trim to the first line for the printed sanity
    // check.
    `__gh_ver_out=$(gh --version) || {`,
    `  printf '%s\\n' 'gh --version failed; installed binary is not runnable' >&2`,
    `  exit 1`,
    `}`,
    `printf '%s\\n' "$__gh_ver_out" | head -1`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Claude Code first-run config
// ---------------------------------------------------------------------------

export type ClaudeConfigSeedShellOptions = {
  /**
   * Absolute path to the config file — for example `/home/node/.claude.json`.
   * It is created if absent and **merged** if present, never overwritten: a
   * box may already carry machine ids and migration flags that matter.
   */
  configPath: string;
  /**
   * Environment variable the snippet reads the Anthropic API key from at run
   * time. Defaults to `ANTHROPIC_API_KEY`.
   *
   * The key is read *inside* the sandbox rather than interpolated into the
   * command, so no credential is ever rendered into the built string, an argv
   * list, or a log — the same ingress rule `mount-script.ts` applies to the
   * relayfile token.
   */
  apiKeyEnvVar?: string;
  /**
   * Value recorded as the onboarding version. Optional; omitted, only the
   * boolean flag is written.
   */
  onboardingVersion?: string;
};

/**
 * Shell that marks Claude Code's first-run onboarding complete and pre-approves
 * the API key the agent will actually use.
 *
 * **Why the approval half matters.** A freshly spawned agent came up on the
 * OAuth sign-in screen while holding a valid key in its environment — a live
 * key, verified against the API from inside the same box. The cause was in
 * `~/.claude.json`: the key's identifying tail had been recorded under
 * `customApiKeyResponses.rejected`, so the CLI declined to use it and fell
 * back to interactive login. On a headless box that is a hang, not a prompt.
 *
 * The identifying tail is the key's last 20 characters, which is what the CLI
 * itself stores — never the key. This snippet moves that tail out of
 * `rejected` and into `approved`, so a re-run repairs a box that has already
 * been poisoned rather than only helping a pristine one.
 *
 * `hasCompletedOnboarding` is set in the same write because a clean home needs
 * both: an approved key still lands on the theme-and-welcome screen without it.
 *
 * Nothing here is Agent37-specific. It will bite every fresh box on every
 * provider.
 */
export function buildClaudeConfigSeedShell(opts: ClaudeConfigSeedShellOptions): string {
  const configPath = requireAbsolutePath(opts.configPath, "configPath");
  const apiKeyEnvVar = requireNonEmpty(opts.apiKeyEnvVar ?? "ANTHROPIC_API_KEY", "apiKeyEnvVar");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnvVar)) {
    throw new Error(
      `apiKeyEnvVar must be a valid shell identifier; got ${JSON.stringify(apiKeyEnvVar)}`,
    );
  }
  const onboardingVersion = opts.onboardingVersion?.trim();
  if (onboardingVersion !== undefined && onboardingVersion.includes("\n")) {
    throw new Error("onboardingVersion must not contain a newline");
  }

  // Read/modify/write in one node process so a concurrent bootstrap step
  // cannot interleave between the read and the write.
  //
  // Two subtleties enforced below:
  //   - `JSON.parse(...)||{}` silently coerces `null`, `false`, `0`, and `""`
  //     to `{}`, which would let an invalid config be clobbered instead of
  //     rejected. Let the object-shape validation catch every non-object.
  //   - `fs.writeFileSync({ mode: 0o600 })` only applies the mode when the
  //     file is being created; on the repair path the existing perms survive.
  //     Follow the write with an explicit `chmodSync(0o600)` so the contract
  //     holds for both first-run and rewrite.
  const script =
    "const fs=require('fs'),path=require('path');" +
    "const p=process.env.__CLAUDE_CONFIG_PATH;" +
    "let cfg={};" +
    "try{cfg=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){" +
    "if(e&&e.code!=='ENOENT')throw e;}" +
    "if(typeof cfg!=='object'||cfg===null||Array.isArray(cfg))" +
    "throw new Error('existing Claude config is not a JSON object: '+p);" +
    "cfg.hasCompletedOnboarding=true;" +
    "const ver=process.env.__CLAUDE_ONBOARDING_VERSION;" +
    "if(ver)cfg.lastOnboardingVersion=ver;" +
    "const key=process.env.__CLAUDE_API_KEY||'';" +
    "let approved=0;" +
    "if(key){" +
    "const tail=key.slice(-20);" +
    "const r=cfg.customApiKeyResponses;" +
    "const prev=(r&&typeof r==='object'&&!Array.isArray(r))?r:{};" +
    "const keep=(list)=>Array.isArray(list)?list.filter((v)=>typeof v==='string'&&v!==tail):[];" +
    "cfg.customApiKeyResponses={approved:keep(prev.approved).concat([tail])," +
    "rejected:keep(prev.rejected)};" +
    "approved=1;}" +
    "fs.mkdirSync(path.dirname(p),{recursive:true});" +
    "fs.writeFileSync(p,JSON.stringify(cfg,null,2),{mode:0o600});" +
    "fs.chmodSync(p,0o600);" +
    "process.stdout.write('claude-config-seeded onboarding=1 apiKeyApproved='+approved+'\\n');";

  return [
    `set -e`,
    `__CLAUDE_CONFIG_PATH=${shellQuote(configPath)} \\`,
    ...(onboardingVersion ? [`__CLAUDE_ONBOARDING_VERSION=${shellQuote(onboardingVersion)} \\`] : []),
    `__CLAUDE_API_KEY="\${${apiKeyEnvVar}:-}" \\`,
    `node -e ${shellQuote(script)}`,
  ].join("\n");
}
