# boxd adapter

[boxd](https://boxd.sh/?ref=relay) runs each sandbox as its own virtual
machine: Ubuntu 24.04 with a persistent disk, Docker, Node.js, Python, git and
the common coding agents preinstalled. `BoxdRuntime` drives it through the
official `@boxd-sh/sdk` client.

## Install and run

```bash
npm install @agent-relay/sandbox @boxd-sh/sdk
```

Create an API key with `boxd auth keys create <name>` (or in the boxd console),
set `BOXD_API_KEY` in your application's environment, and save this as
`hello.mjs`:

```js
import { withSandbox } from "@agent-relay/sandbox/core";
import { BoxdRuntime } from "@agent-relay/sandbox/boxd";

const apiKey = process.env.BOXD_API_KEY;
if (!apiKey) throw new Error("Set BOXD_API_KEY before running this example");

const result = await withSandbox({
  runtime: new BoxdRuntime({ apiKey, namePrefix: "relay-hello", region: "fra" }),
}, (sandbox) => sandbox.run("echo hello from $(hostname)", { timeoutMs: 10_000 }));

console.log(result.output);
if (result.exitCode !== 0) process.exitCode = 1;
```

Run `node hello.mjs`. `withSandbox` creates a machine, runs the command and
deletes the machine again.

## Configuration

The adapter never reads `process.env`; pass everything to the constructor.

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | boxd API key |
| `namePrefix` | required | Prefix for machine names, and the value of the ownership label |
| `org` | the key's organization | Organization that owns and pays for the machines |
| `region` | the endpoint's region | Region to create and look up machines in, e.g. `fra` or `nyc` |
| `size` | the organization's default | `{ vcpu: 1, memory: "4G" }`, `2/8G`, `4/16G` or `8/32G` |
| `isolated` | `true` | Keep machines off the organization's private network, without in-machine credentials |
| `fromSnapshot` | none | Create machines from a snapshot instead of the base image; they get the snapshot's size, so `size` cannot be set with it |
| `autoSuspendTimeoutSeconds` | `0` | Seconds without network traffic before standby; `0` disables it |
| `autoHibernateTimeoutSeconds` | the organization's default | Seconds without network traffic before hibernation; set `0` for long commands that use no network |
| `deleteAfterSeconds` | none | Delete each machine this many seconds after create, whatever its state |
| `ownerLabelKey` | `agent-relay-sandbox` | Label key that marks machines this runtime owns |
| `defaultHomeDir` | `/home/boxd` | Home directory reported on handles |

Timeouts (`requestTimeoutMs`, `createTimeoutMs`, `lookupTimeoutMs`,
`transferTimeoutMs`, `lifecycleSettleTimeoutMs`) and `pollIntervalMs` bound
every call.

## Ownership and lookups

Every machine `launch()` creates carries the label `<ownerLabelKey>=<namePrefix>`
next to the caller's labels. A caller label with the ownership key is
rejected. `findByLabels`, `findAllByLabels` and `countByLabels` use boxd's
server-side label filter, scoped to that ownership label, so a second process
with the same prefix finds the machines the first one launched (`warmLease` is
true). Pass `owned: false` to look up across runtimes; those handles can run
commands but `stop`, `start` and `destroy` leave them alone. `getById` gives
destroy authority only for a machine carrying this runtime's ownership label,
unless the caller passes `owned` explicitly. Authority is kept per machine id
for the life of the runtime: a machine this runtime launched, or attached with
`owned: true`, stays owned even if a later lookup passes `owned: false`.

Lookups default to `STARTED` machines. A machine in standby or hibernation
counts as `STARTED`: it keeps its memory and disk and wakes on the next
command.

## Commands and files

`runScript` and `exec` run the command in `bash -lc`, in the handle's workdir
unless `cwd` is given. Launch env goes with every command this runtime runs,
merged under per-command env. With `timeoutMs`, `timeout` inside the machine
ends the command (and kills it 5 seconds later if it ignores the signal), and
the call rejects with `BoxdCommandTimeoutError`, carrying the output so far. A response without an exit code is never treated as
success.

`uploadFile` creates missing parent directories. Transfers are bounded by
`transferTimeoutMs`. `uploadBundle` writes its manifest to
`<workdir or home>/manifest.json` unless `manifestPath` is given. Paths must be
writable by the machine user (`boxd`, with passwordless sudo). `downloadFile` rejects with
`code: "ENOENT"` for a missing file. Relative paths resolve against the
handle's workdir, then its home directory.

## Lifecycle and cleanup

`stop` stops the machine and keeps its disk. `start`, or the next command on a
stopped machine this runtime owns, boots it again and waits until it answers.
`launch` returns only after a command has run on the new machine, and creates
the launch `workdir` if it does not exist. If either fails within the create
deadline, it deletes the machine before rejecting. A create that completes
after its deadline, or fails without a clear answer, is deleted in the
background (found by id, or by its generated name);
`close()` waits for that and closes the SDK client. `destroy` succeeds only once
boxd reports the machine gone; otherwise the handle stays registered so cleanup
can be retried.

## Capabilities

| Capability | Value | Why |
| --- | --- | --- |
| `warmLease` | true | server-side labels and label filtering |
| `lifecycle` | true | stop keeps the disk; start boots it again |
| `reattach` | true | `getById` |
| `asyncExec`, `detachedLaunch` | false | not implemented; commands run to completion |
| `isolation` | `strong` | each sandbox is its own virtual machine |
| `outputStreams` | `buffered` | results are returned when the command ends |
| `filesystem` | `persistent` | files survive stop and start |
| `lifetime` | `never-idle` | runs until stopped or deleted; `deadline` with `deleteAfterSeconds` |
| `interactive`, `snapshots` | `not-exposed` | boxd has PTY exec, snapshots and forks; this package's ports do not reach them |

## Live evidence

Run on 2026-11-11 against production boxd, region `fra`, `@boxd-sh/sdk` 0.3.1,
Node 22, 2 vCPU / 8 GB machines unless noted.

| Check | Result |
| --- | --- |
| `src/boxd/live.smoke.test.ts` (launch, exit codes and streams, env and cwd, timeout, 5 MiB round trip with sha256, missing file, background process, label and id reattach from a second runtime, stop then exec, wrong key, destroy) | 9 of 9 pass, three runs |
| `launch` to first command | 1.3 to 1.4 s |
| The example above, from a packed tarball | create, command and delete in 1.3 s |
| `createSandbox` plus a Claude Code turn in the machine fixing a failing test | test passes after the turn |
| Machine hibernated, then a fresh runtime reattaches by id and runs a command | `STARTED`, command answered in about 0.2 s |
| Three parallel launches (1 vCPU / 4 GB, `autoHibernateTimeoutSeconds: 0`), label count and lookup, parallel exec, destroy | all ready within 1.2 s; standby and hibernation off on the machine; count 3, then 0 |
| Launch with `workdir: "/workspace"` (not writable by the machine user) | rejects with `BoxdWorkdirError`; the machine is deleted |
| Isolated machine | no organization credentials or metadata endpoint inside |
