# Agent37 adapter

Everything below was measured on a live Agent37 instance on 2026-08-25, on the
provider's default system template. Where a fact is shared with another
provider it says so, because two of the things previously logged as "Agent37
defects" are not properties of Agent37 at all.

## The template, and the one setting that matters

```
user      node (uid 1000, gid 1000)
HOME      /home/node
cwd       /            (the exec plane's default when no cwd is given)
os        Debian GNU/Linux 12 (bookworm)
kernel    4.19.0-gvisor
shape     2 vCPU · 4096 MB · 10 GB
shell     sh (dash) — NOT bash
```

**Construct `Agent37Runtime` with `defaultHomeDir: "/home/node"`.** This is the
single most consequential line in an Agent37 integration.

`/root` **exists** — as `drwx------ root root` — and the template user cannot
enter it. So a launch that sets `workdir: '/root'` does not fail once, it fails
*every command on the box*, identically:

```
$ id; echo PWD=$PWD          →  exit 1
sh: 1: cd: can't cd to /root
```

Ten unrelated probes were run that way and all ten returned exit 1. Re-pointed
at `/home/node`, all ten passed. Note the correction to an earlier note: `/root`
is **unreachable, not missing**, and the distinction matters because "missing"
sends you looking at the image while "unreachable" sends you to the one line of
caller configuration that actually causes it.

Since a bare `cd … || exit 1` is indistinguishable from the command's own exit
1, the adapter no longer emits one. A failed `cd` now raises
`Agent37WorkdirUnusableError`, which names the directory and the instance. See
`AGENT37_WORKDIR_UNUSABLE_EXIT_CODE`.

## The exec plane is dash

`agent37`'s exec runs POSIX `sh`, not bash. A bashism does not error usefully —
`${PIPESTATUS[0]}` comes back as `Bad substitution`, so a step that looks like
it succeeded quietly did nothing. Anything this package generates for an
Agent37 box is POSIX; anything a caller generates should be too.

## There is no root, and that is not an Agent37 property

`sudo` is inert (`effective uid is not 0 … nosuid`) and `mkdir /opt/<anything>`
returns `Permission denied`.

**The same `mkdir /opt` is denied on Daytona**, measured in the same run, so it
should stop being recorded as an Agent37 defect. Nothing needs root: npm's
global prefix is already `/home/node/.npm-global` and already on PATH, and
`/home/node`, `/home/node/.local/bin` and `/tmp` are all writable.

## What the image does not ship

| | Agent37 | Daytona |
| --- | --- | --- |
| `node` / `npm` | v24.19.0 / 11.17.0 | present |
| `git`, `curl`, `ssh`, `python3` | present | present |
| `gh` | **absent** — `gh --version` → **exit 127** | **absent** — **exit 127** |
| `relayfile-mount` | **absent from PATH** | `/usr/local/bin/relayfile-mount` |
| `agent-relay` | absent (installs from npm in ~46 s) | present in the image |

Egress is open: `registry.npmjs.org` and the Agent Relay control plane both
answered `200`.

Both gaps close in userspace with no root — see `src/bootstrap.ts`:

- `buildRelayfileMountLinkShell` symlinks the daemon that `agent-relay` already
  vendors as `@relayfile/mount-<platform>-<arch>`. No download.
- `buildGhInstallShell` drops a release tarball into `~/.local/bin`; measured at
  about three seconds, moving `gh --version` from exit 127 to exit 0.

`gh auth status` then returns **exit 1** ("not logged into any GitHub hosts").
Keep the two apart when reporting: a present binary with no credential is a
different failure from a missing binary, and only the second is exit 127.

## Relayfile mount: `mount | grep` is not a test

`relayfile-mount` is a **userspace sync daemon**, not a kernel or FUSE mount.
On a completely healthy Agent37 box:

```
$ mount | grep -i relayfile     →  exit 1, no output
```

The identical empty result comes back on Daytona, where the mount is in daily
production use. Two lanes drew a false conclusion from this check.

Test it by moving bytes instead. Measured end to end on Agent37: a file written
inside the instance was read on a laptop (`exit 0`, byte-identical), a file
written on the laptop was read inside the instance (`exit 0`), and a third
machine on the same scope saw both. The daemon's own
`<localDir>/.relay/state.json` is the honest instrument — `status`, the `files`
map, and `outbox` (`pending` / `failed` / `acked`).

The gVisor kernel is the reason this shape is right: a FUSE mount is not
available, and a userspace mirror is unaffected.

## Placing an agent

A targeted spawn must name its working directory. `worker_cwd` is node-relative
and a `--node` spawn sets none, so without `--cwd` the agent lands at the
broker's project root rather than its workspace — and a tree at a path the
agent was never placed in is indistinguishable, from inside, from a missing
tree. With `--cwd` passed, `readlink /proc/<pid>/cwd` confirmed the requested
directory for both the broker's PTY process and the agent process.

Cross-node attach works with no ssh, but needs a **real PTY**: `script` fails on
non-tty stdin with `tcgetattr/ioctl: Operation not supported on socket`.
Allocate one (Python's `pty.fork()` will do) and read the bytes — 18,323 bytes
of live screen came back over a `--mode view` attach.

Two harness gaps to expect on any fresh box, neither provider-specific:

- A clean `~/.claude.json` records a valid API key's tail under
  `customApiKeyResponses.rejected`, so the agent boots to an OAuth screen while
  holding a working credential. `buildClaudeConfigSeedShell` approves the tail
  and completes onboarding, and repairs an already-poisoned config.
- `relay node up` may resolve a different workspace than the one
  `relay cloud enroll` bound the node to, which makes an in-box roster read
  return a single entry — the node's own name. That is a platform issue, not a
  provider one; it reproduces on Daytona.

## Teardown

Delete is synchronous enough to verify immediately: `destroy` returned in
7,242 ms and `GET /v1/instances` was empty 317 ms later, across three separate
runs with no leaked instance.

**Daytona is not**: `destroy` returned in 131 ms there and an immediate
`getById` still resolved the sandbox, which was gone from the provider's list
moments later. A read-back straight after delete is not a valid "verified gone"
check on that provider.
