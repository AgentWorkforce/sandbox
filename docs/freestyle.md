# Freestyle adapter

## Configuration and ownership

Install the exact peer used to validate this adapter:

```bash
npm install freestyle@0.1.63
```

Construct `FreestyleRuntime` with an explicit `apiKey`, `defaultHomeDir`,
`namePrefix`, and `persistence`. The adapter does not read `process.env` and
does not choose a vendor tier on the caller's behalf. Launch-time environment
variables are rejected because the provider create operation has no equivalent
field; silently dropping them would violate the shared port.

Freestyle create has no label field. `findByLabels`, `findAllByLabels`, and
`countByLabels` therefore return no lease match, and `warmLease` is false.
`listOwned` filters the provider's authoritative VM list by the exact configured
name prefix. Mutation methods require an owned handle; external attachments are
read/exec capable but cannot be started, stopped, or deleted by default.

## Lifecycle and cleanup

Provider stop, start, suspend, and delete calls may return before the VM reaches
a settled state. The adapter polls the authoritative list and waits through
transitional states. Start reapplies the caller's exact idle-timeout setting;
it does not invent a one-year timeout or invoke an undocumented suspend
workaround. Deletion succeeds only after the VM is absent or its retained list
row has `deleted: true`.

The lifecycle methods are implemented, but the declared `lifecycle` flag
remains false, because whether they work is a function of the configured
persistence and a single static flag cannot say that. Measured live on
2026-08-22 against `freestyle@0.1.63`:

| Persistence | `stop` | `start` | exec after start | filesystem across stop/start |
| --- | --- | --- | --- | --- |
| `ephemeral` | VM is **destroyed**, not stopped | n/a | n/a | n/a |
| `sticky` | settles to `stopped` | works (5 of 6 attempts) | works | preserved |
| `persistent` | rejected at create: `PERSISTENT_VMS_NOT_ALLOWED` (plan limit) | n/a | n/a | n/a |

Under `ephemeral` — the persistence the adapter was validated with — `stop` does
not stop the VM: the adapter observes it leave the provider listing entirely and
raises `Freestyle VM "<id>" disappeared while waiting for stopped`. Declaring
`lifecycle: true` would therefore be wrong for the configuration most callers
start from.

Under `sticky` the capability is real and was proven end to end: four
consecutive stop → start → exec cycles on one VM all succeeded, with a marker
file written before the first stop still readable after the fourth start. One
earlier `start` in the same session returned a provider-side
`INTERNAL_ERROR: Internal server error` (5 of 6 starts succeeded overall), so
callers driving `sticky` lifecycle should expect to retry `start`.

Promoting the flag honestly requires deriving it from `options.persistence`
rather than flipping the shared constant; that change is deliberately not made
here. Snapshot, fork, PTY survival, and never-idle behavior remain unadvertised
— this package's ports do not reach them. Exec is buffered by the SDK;
`streamingLogs` is false.

Deletion behavior is established. The 2026-08-20 run deleted a clean canary and
seven sequential VMs, reconciled four concurrent VMs plus one late timed-out
allocation through the run ledger, and found zero live resources in a fresh
exact-prefix audit. The 2026-08-22 revalidation repeated this on the final
source: every VM created across the revalidation and the lifecycle probes was
deleted, and an account-wide audit afterwards returned zero VM rows in total.
`freestyleObservedCapabilities.cleanupVerified` records only that measured
fact. A width-five create probe returned four handles
while the fifth encountered burst-quota 429 retries and crossed the explicit
120-second deadline; capacity is not declared as an adapter capability.

## Provider shape and pricing caveat

The official VM documentation describes a default of 4 vCPU, 8 GB memory, and
20 GB storage, and the pricing page says the free tier cannot select custom VM
sizing. The validation run observed 4 vCPU, 8192 MiB memory, and 16000 MiB
rootfs through the SDK list response. Comparisons must preserve that delivered
shape rather than normalize it to the documented 20 GB value.

- VM docs: <https://www.freestyle.sh/docs/vms>
- lifecycle docs: <https://www.freestyle.sh/docs/vms/lifecycle>
- pricing: <https://www.freestyle.sh/pricing>

## Dependency and design provenance

- npm package: `freestyle@0.1.63` (exact, not a range)
- npm integrity:
  `sha512-sNmr4UHr9abaEQeNzOra4csLrU72qjwPm4lA1i3IYM9pbmkvQ8aOOH/61yawNSVIhxqIoYO9xBcrMNwjqZaWMw==`
- published package `gitHead`: `d8cd601120da42348ea1b440b8d2bf9bdce4947b`
- lockfile: `package-lock.json` records the resolved tarball and integrity

The architecture was also compared with Amika's Apache-2.0 sandbox provider
design at commit `1870db202a07eb388cacaec22e681f4c564150eb`:
<https://github.com/gofixpoint/amika/tree/1870db202a07eb388cacaec22e681f4c564150eb/js/sandbox/src/providers>.
The SDK isolation, SDK-free configuration/capabilities, construction-time
capability reconciliation, and provider-neutral provisioning principles were
reimplemented against this repository's existing port; no Amika source was
copied.
